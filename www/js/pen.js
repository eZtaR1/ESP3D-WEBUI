// Pen (servo) panel for FluidNC pen plotters that lift the pen with a
// BESC-type servo spindle, e.g.
//
//   BESC:
//     speed_map: 0=100.00% 1=0.00%
//     min_pulse_us: 1400
//     max_pulse_us: 2100
//
// "M3 S0" moves the pen up and "M3 S1" moves it down.  FluidNC only applies
// min_pulse_us / max_pulse_us / speed_map at startup, so changing them needs
// a restart.  To test positions live, the panel has a calibration mode:
//
//   min_pulse_us: 500, max_pulse_us: 2500
//   speed_map: 0=<up>% 1=<down>% 2=0.00% 2002=100.00%
//
// S0 and S1 still give the current up/down positions, and S2..S2002 give a
// pulse of exactly (S - 2 + 500) us, so any test value is just "M3 S<n>".
// Entering and leaving calibration mode each take one restart.  Only those
// lines of the config file are edited (comments and everything else are left
// untouched) and a one-time .bak of the original is kept.

var pen_up_cmd = "M3 S0";
var pen_down_cmd = "M3 S1";
var pen_min_us = 500;          // calibration range
var pen_max_us = 2500;
var pen_cal_base = 2;          // S value for pen_min_us in calibration mode
var pen_cfg = null;           // last parsed config: {text, up_us, down_us, ...}
var pen_backup_done = false;

function pen_el(name) {
    return document.getElementById(name);
}

function pen_status(msg, isError) {
    var e = pen_el("pen_status");
    if (!e) return;
    e.textContent = msg;
    e.style.color = isError ? "#c9302c" : "";
}

function pen_config_name() {
    var v = pen_el("pen_config_file") ? pen_el("pen_config_file").value.trim() : "";
    if (v === "") v = "config.yaml";
    return v.replace(/^\/+/, "");
}

function pen_section_name() {
    var v = pen_el("pen_section") ? pen_el("pen_section").value.trim() : "";
    return v === "" ? "BESC" : v;
}

function pen_up() {
    SendPrinterCommand(pen_up_cmd, true);
}

function pen_down() {
    SendPrinterCommand(pen_down_cmd, true);
}

// ---- config parsing / editing --------------------------------------------

function pen_indent(line) {
    return line.match(/^[ \t]*/)[0].length;
}

function pen_is_blank(line) {
    return /^\s*(#.*)?$/.test(line);
}

// Returns {start, end, childIndent} for the section's lines (start = header
// line index, end = one past its last child line), or null.
function pen_find_section(lines, section) {
    var header = new RegExp("^([ \\t]*)" + section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":\\s*(#.*)?$");
    for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(header);
        if (!m) continue;
        var base = m[1].length;
        var end = i + 1;
        var childIndent = -1;
        for (var j = i + 1; j < lines.length; j++) {
            if (pen_is_blank(lines[j])) continue;
            var ind = pen_indent(lines[j]);
            if (ind <= base) break;
            if (childIndent < 0) childIndent = ind;
            end = j + 1;
        }
        if (childIndent < 0) childIndent = base + 2;
        return { start: i, end: end, childIndent: childIndent };
    }
    return null;
}

function pen_key_regex(key, indent) {
    return new RegExp("^([ \\t]{" + indent + "}" + key + ":[ \\t]*)([^#\\r\\n]*?)([ \\t]*#.*)?$");
}

function pen_get_key(lines, sec, key) {
    var re = pen_key_regex(key, sec.childIndent);
    for (var i = sec.start + 1; i < sec.end; i++) {
        var m = lines[i].match(re);
        if (m) return { index: i, value: m[2].trim() };
    }
    return null;
}

function pen_set_key(lines, sec, key, value) {
    var re = pen_key_regex(key, sec.childIndent);
    for (var i = sec.start + 1; i < sec.end; i++) {
        var m = lines[i].match(re);
        if (m) {
            lines[i] = m[1] + value + (m[3] || "");
            return;
        }
    }
    var pad = new Array(sec.childIndent + 1).join(" ");
    lines.splice(sec.end, 0, pad + key + ": " + value);
    sec.end++;
}

// Top-level (unindented) key such as planner_blocks
function pen_get_top_key(lines, key) {
    var re = pen_key_regex(key, 0);
    for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(re);
        if (m) return { index: i, value: m[2].trim() };
    }
    return null;
}

function pen_set_top_key(lines, key, value) {
    var re = pen_key_regex(key, 0);
    for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(re);
        if (m) {
            lines[i] = m[1] + value + (m[3] || "");
            return;
        }
    }
    var end = lines.length;
    while (end > 0 && lines[end - 1].trim() === "") end--;
    lines.splice(end, 0, key + ": " + value);
}

// Percent of the [min,max] pulse range that speed S maps to, by linear
// interpolation of speed_map ("0=100.00% 1=0.00%" style).  Speeds outside
// the map clamp to its end points.
function pen_map_percent(speedMap, s) {
    var pts = [];
    speedMap.split(/\s+/).forEach(function(tok) {
        var m = tok.match(/^(-?[\d.]+)=(-?[\d.]+)%?$/);
        if (m) pts.push([parseFloat(m[1]), parseFloat(m[2])]);
    });
    if (pts.length === 0) return null;
    pts.sort(function(a, b) { return a[0] - b[0]; });
    if (s <= pts[0][0]) return pts[0][1];
    for (var i = 1; i < pts.length; i++) {
        if (s <= pts[i][0]) {
            var a = pts[i - 1], b = pts[i];
            return a[1] + (b[1] - a[1]) * (s - a[0]) / (b[0] - a[0]);
        }
    }
    return pts[pts.length - 1][1];
}

function pen_parse(text) {
    var section = pen_section_name();
    var lines = text.split(/\r?\n/);
    var sec = pen_find_section(lines, section);
    if (!sec) throw new Error("No '" + section + ":' section found in " + pen_config_name());
    var minK = pen_get_key(lines, sec, "min_pulse_us");
    var maxK = pen_get_key(lines, sec, "max_pulse_us");
    var mapK = pen_get_key(lines, sec, "speed_map");
    var minUs = minK ? parseFloat(minK.value) : 900;   // FluidNC defaults
    var maxUs = maxK ? parseFloat(maxK.value) : 2200;
    var speedMap = mapK ? mapK.value : "";
    var upK = pen_get_key(lines, sec, "spinup_ms");
    var dnK = pen_get_key(lines, sec, "spindown_ms");
    var pbK = pen_get_top_key(lines, "planner_blocks");
    var pUp = speedMap ? pen_map_percent(speedMap, 0) : null;
    var pDown = speedMap ? pen_map_percent(speedMap, 1) : null;
    if (pUp === null || pDown === null) {
        throw new Error("Could not read speed_map in the " + section + " section");
    }
    return {
        text: text,
        crlf: /\r\n/.test(text),
        min_us: minUs,
        max_us: maxUs,
        speed_map: speedMap,
        up_us: Math.round(minUs + (maxUs - minUs) * pUp / 100),
        down_us: Math.round(minUs + (maxUs - minUs) * pDown / 100),
        simple: (pUp === 0 || pUp === 100) && (pDown === 0 || pDown === 100) && pUp !== pDown,
        spinup_ms: upK ? parseInt(upK.value, 10) : 0,
        spindown_ms: dnK ? parseInt(dnK.value, 10) : 0,
        planner_blocks: pbK ? parseInt(pbK.value, 10) : 16,
        calibrating: minUs === pen_min_us && maxUs === pen_max_us && pen_is_cal_map(speedMap)
    };
}

function pen_is_cal_map(speedMap) {
    var toks = speedMap.trim().split(/\s+/);
    if (toks.length !== 4) return false;
    var p2 = toks[2].match(/^(\d+)=([\d.]+)%?$/);
    var p3 = toks[3].match(/^(\d+)=([\d.]+)%?$/);
    return !!(p2 && p3 && parseInt(p2[1], 10) === pen_cal_base && parseFloat(p2[2]) === 0 &&
        parseInt(p3[1], 10) === pen_cal_base + (pen_max_us - pen_min_us) && parseFloat(p3[2]) === 100);
}

function pen_cal_percent(us) {
    return (100 * (us - pen_min_us) / (pen_max_us - pen_min_us)).toFixed(2) + "%";
}

// S value that produces a pulse of us microseconds in calibration mode
function pen_cal_speed(us) {
    return pen_cal_base + Math.round(us - pen_min_us);
}

// Config text for calibration mode, keeping S0/S1 at the given positions.
function pen_build_cal(cfg, upUs, downUs) {
    var lines = cfg.text.split(/\r?\n/);
    var sec = pen_find_section(lines, pen_section_name());
    pen_set_key(lines, sec, "min_pulse_us", String(pen_min_us));
    pen_set_key(lines, sec, "max_pulse_us", String(pen_max_us));
    pen_set_key(lines, sec, "speed_map", "0=" + pen_cal_percent(upUs) + " 1=" + pen_cal_percent(downUs) +
        " " + pen_cal_base + "=0.00% " + pen_cal_speed(pen_max_us) + "=100.00%");
    return lines.join(cfg.crlf ? "\r\n" : "\n");
}

// Produces the new config text with the given up/down pulse widths.
// min_pulse_us/max_pulse_us get the lower/higher value (BESC needs
// min < max); speed_map is only rewritten if S0/S1 need to swap ends.
function pen_build(cfg, upUs, downUs) {
    var lines = cfg.text.split(/\r?\n/);
    var sec = pen_find_section(lines, pen_section_name());
    var lo = Math.min(upUs, downUs);
    var hi = Math.max(upUs, downUs);
    pen_set_key(lines, sec, "min_pulse_us", String(lo));
    pen_set_key(lines, sec, "max_pulse_us", String(hi));
    var upIsHigh = upUs > downUs;
    var curUpIsHigh = pen_map_percent(cfg.speed_map, 0) > pen_map_percent(cfg.speed_map, 1);
    if (!cfg.simple || cfg.calibrating || upIsHigh !== curUpIsHigh) {
        pen_set_key(lines, sec, "speed_map", upIsHigh ? "0=100.00% 1=0.00%" : "0=0.00% 1=100.00%");
    }
    return lines.join(cfg.crlf ? "\r\n" : "\n");
}

// ---- file I/O --------------------------------------------------------------

function pen_read_config(successfn) {
    var name = pen_config_name();
    fileRead(FILE_VOLUME_FLASH, "/" + name + "?t=" + Date.now(), function(text) {
        var cfg;
        try {
            cfg = pen_parse(text);
        } catch (e) {
            pen_status(e.message, true);
            return;
        }
        successfn(cfg);
    }, function(code, resp) {
        pen_status("Could not read " + name + " (" + code + ")", true);
    });
}

function pen_write_file(name, text, successfn) {
    var file = new File([new Blob([text], { type: "text/plain" })], name);
    fileUpload(FILE_VOLUME_FLASH, "/", [file], null, successfn, function(code, resp) {
        pen_status("Could not write " + name + " (" + code + ")", true);
    });
}

// ---- UI --------------------------------------------------------------------

function pen_show(cfg) {
    pen_cfg = cfg;
    pen_el("pen_current").textContent = "Saved in " + pen_config_name() + ": up " + cfg.up_us +
        " us (S0), down " + cfg.down_us + " us (S1)";
    pen_el("pen_cal_on").style.display = cfg.calibrating ? "" : "none";
    pen_el("pen_cal_off").style.display = cfg.calibrating ? "none" : "";
    pen_el("pen_spinup_ms").value = cfg.spinup_ms;
    pen_el("pen_spindown_ms").value = cfg.spindown_ms;
    pen_el("pen_planner_blocks").value = cfg.planner_blocks;
    if (!pen_el("pen_up_us").value) pen_el("pen_up_us").value = cfg.up_us;
    if (!pen_el("pen_down_us").value) pen_el("pen_down_us").value = cfg.down_us;
}

function pen_load() {
    pen_status("Reading " + pen_config_name() + "...");
    pen_read_config(function(cfg) {
        pen_el("pen_up_us").value = "";
        pen_el("pen_down_us").value = "";
        pen_show(cfg);
        pen_status("");
    });
}

function pen_value(which) {
    var v = parseInt(pen_el("pen_" + which + "_us").value, 10);
    if (isNaN(v)) return null;
    return Math.max(pen_min_us, Math.min(pen_max_us, v));
}

// Moves the servo to the value in the up/down field (calibration mode only)
function pen_test(which) {
    var v = pen_value(which);
    if (v === null) return;
    pen_el("pen_" + which + "_us").value = v;
    if (!pen_cfg || !pen_cfg.calibrating) {
        pen_status("Start calibration first", true);
        return;
    }
    SendPrinterCommand("M3 S" + pen_cal_speed(v), true);
    pen_status("Pen at " + v + " us (testing " + which + ")");
}

function pen_nudge(which, delta) {
    var v = pen_value(which);
    if (v === null) v = 1500;
    pen_el("pen_" + which + "_us").value = Math.max(pen_min_us, Math.min(pen_max_us, v + delta));
    pen_test(which);
}

function pen_machine_busy() {
    if (typeof grblstate === "undefined" || !grblstate || !grblstate.stateName) return false;
    var s = grblstate.stateName;
    return !(s === "Idle" || s === "Alarm" || s === "Sleep");
}

// Writes newText (made from the freshly read config by buildfn), verifies it,
// restarts FluidNC and moves the pen to `after` ("up"/"down") once back.
function pen_rewrite(buildfn, verifyfn, after, what) {
    if (pen_machine_busy()) {
        pen_status("Machine is " + grblstate.stateName + " - wait until it is idle", true);
        return;
    }
    var name = pen_config_name();
    pen_status("Reading " + name + "...");
    pen_read_config(function(cfg) {
        var newText = buildfn(cfg);
        var write = function() {
            pen_status("Writing " + name + "...");
            pen_write_file(name, newText, function() {
                // Read it back to make sure the file on the controller is what we sent
                pen_read_config(function(check) {
                    if (!verifyfn(check)) {
                        pen_status("Verify failed - " + name + " was not written as expected", true);
                        return;
                    }
                    store_localdata("pen_after_restart", after);
                    pen_status(what + " Restarting FluidNC...");
                    restartdlg();
                });
            });
        };
        if (pen_backup_done || cfg.calibrating) {
            write();
        } else {
            pen_status("Backing up " + name + " to " + name + ".bak...");
            pen_write_file(name + ".bak", cfg.text, function() {
                pen_backup_done = true;
                write();
            });
        }
    });
}

function pen_cal_start() {
    pen_rewrite(function(cfg) {
        return pen_build_cal(cfg, cfg.up_us, cfg.down_us);
    }, function(check) {
        return check.calibrating;
    }, "up", "Calibration mode saved.");
}

// keep: true saves the up/down fields, false restores the S0/S1 values
function pen_cal_finish(keep) {
    var upUs = pen_value("up");
    var downUs = pen_value("down");
    if (keep) {
        if (upUs === null || downUs === null) {
            pen_status("Enter both pulse widths", true);
            return;
        }
        if (upUs === downUs) {
            pen_status("Up and down must be different", true);
            return;
        }
    }
    pen_rewrite(function(cfg) {
        if (!keep) {
            upUs = cfg.up_us;
            downUs = cfg.down_us;
        }
        return pen_build(cfg, upUs, downUs);
    }, function(check) {
        return !check.calibrating && check.up_us === upUs && check.down_us === downUs;
    }, "up", keep ? "New positions saved." : "Original positions restored.");
}

function pen_save_settings() {
    store_localdata("pen_config_file", pen_config_name());
    store_localdata("pen_section", pen_section_name());
    store_localdata("pen_park_x", pen_el("pen_park_x").value);
    store_localdata("pen_park_y", pen_el("pen_park_y").value);
}

// ---- plotter settings (spindle settle times, planner_blocks) ---------------

function pen_int_field(name, lo, hi) {
    var v = parseInt(pen_el(name).value, 10);
    if (isNaN(v) || v < lo || v > hi) return null;
    return v;
}

function pen_settings_save() {
    var up = pen_int_field("pen_spinup_ms", 0, 5000);
    var dn = pen_int_field("pen_spindown_ms", 0, 5000);
    var pb = pen_int_field("pen_planner_blocks", 10, 120);
    if (up === null || dn === null) {
        pen_status("Settle times must be 0-5000 ms", true);
        return;
    }
    if (pb === null) {
        pen_status("planner_blocks must be 10-120", true);
        return;
    }
    pen_rewrite(function(cfg) {
        var lines = cfg.text.split(/\r?\n/);
        var sec = pen_find_section(lines, pen_section_name());
        pen_set_key(lines, sec, "spinup_ms", String(up));
        pen_set_key(lines, sec, "spindown_ms", String(dn));
        pen_set_top_key(lines, "planner_blocks", String(pb));
        return lines.join(cfg.crlf ? "\r\n" : "\n");
    }, function(check) {
        return check.spinup_ms === up && check.spindown_ms === dn && check.planner_blocks === pb;
    }, "up", "Settings saved.");
}

// ---- moves -----------------------------------------------------------------

function pen_send_moves(cmds, what) {
    if (pen_machine_busy()) {
        pen_status("Machine is " + grblstate.stateName + " - wait until it is idle", true);
        return;
    }
    if (typeof grblstate !== "undefined" && grblstate && grblstate.stateName === "Alarm") {
        pen_status("Machine is in alarm - home or unlock first", true);
        return;
    }
    cmds.forEach(function(c) { SendPrinterCommand(c, true); });
    if (what) pen_status(what);
}

function pen_goto_origin() {
    pen_send_moves([pen_up_cmd, "G90 G0 X0 Y0"], "Pen up, going to X0 Y0");
}

function pen_change() {
    var x = parseFloat(pen_el("pen_park_x").value);
    var y = parseFloat(pen_el("pen_park_y").value);
    if (isNaN(x) || isNaN(y)) {
        pen_status("Set the pen change position first", true);
        return;
    }
    pen_save_settings();
    // machine coordinates, so the spot doesn't move with the work zero
    pen_send_moves([pen_up_cmd, "G53 G0 X" + x + " Y" + y], "Pen up, parked for pen change");
}

// ---- frame -----------------------------------------------------------------

var pen_frame_box = null;

function pen_frame_files() {
    var sel = pen_el("pen_frame_file");
    fileList(FILE_VOLUME_SD, "/", function(text) {
        var resp;
        try {
            resp = JSON.parse(text);
        } catch (e) {
            pen_status("Could not list SD card files", true);
            return;
        }
        var cur = sel.value;
        var names = (resp.files || []).filter(function(f) {
            return f.size != "-1" && /\.(g|gc|gco|gcode|nc|ngc|tap|txt)$/i.test(f.name);
        }).map(function(f) { return f.name; }).sort();
        sel.innerHTML = "";
        names.forEach(function(n) {
            var o = document.createElement("option");
            o.value = n;
            o.textContent = n;
            sel.appendChild(o);
        });
        if (names.indexOf(cur) >= 0) sel.value = cur;
        pen_frame_box = null;
        pen_el("pen_frame_info").textContent = names.length ? "" : "No G-code files in the SD card root";
    }, function(code) {
        pen_status("Could not list SD card files (" + code + ")", true);
    });
}

// Bounding box of the drawing moves (G1/G2/G3) in a G-code file, in the
// file's own (work) coordinates.  Falls back to all moves if there are no
// G1-G3 moves.  Arcs count by their end points only.
function pen_gcode_bounds(text) {
    var draw = null, all = null;
    var x = 0, y = 0, absolute = true, scale = 1, motion = 0;
    var grow = function(box, px, py) {
        if (!box) return { minX: px, maxX: px, minY: py, maxY: py };
        box.minX = Math.min(box.minX, px); box.maxX = Math.max(box.maxX, px);
        box.minY = Math.min(box.minY, py); box.maxY = Math.max(box.maxY, py);
        return box;
    };
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i].replace(/\(.*?\)/g, "").replace(/;.*$/, "").toUpperCase();
        if (!l.trim()) continue;
        var words = l.match(/[A-Z][+-]?[\d.]+/g);
        if (!words) continue;
        var nx = null, ny = null, skip = false;
        for (var j = 0; j < words.length; j++) {
            var letter = words[j][0];
            var val = parseFloat(words[j].substr(1));
            if (letter === "G") {
                if (val === 0 || val === 1 || val === 2 || val === 3) motion = val;
                else if (val === 90) absolute = true;
                else if (val === 91) absolute = false;
                else if (val === 20) scale = 25.4;
                else if (val === 21) scale = 1;
                else if (val === 53 || val === 28 || val === 30 || val === 92 || val === 10) { skip = true; break; }
            } else if (letter === "X") nx = val * scale;
            else if (letter === "Y") ny = val * scale;
        }
        if (skip) continue;
        if (nx === null && ny === null) continue;
        var px = x, py = y;
        if (nx !== null) x = absolute ? nx : x + nx;
        if (ny !== null) y = absolute ? ny : y + ny;
        all = grow(all, x, y);
        if (motion >= 1) {
            draw = grow(draw, px, py);
            draw = grow(draw, x, y);
        }
    }
    return draw || all;
}

function pen_frame_load(successfn) {
    var name = pen_el("pen_frame_file").value;
    if (!name) {
        pen_status("Pick a file", true);
        return;
    }
    if (pen_frame_box && pen_frame_box.name === name) {
        successfn(pen_frame_box);
        return;
    }
    pen_status("Reading " + name + "...");
    fileRead(FILE_VOLUME_SD, "/sd/" + name, function(text) {
        var b = pen_gcode_bounds(text);
        if (!b) {
            pen_status("No X/Y moves found in " + name, true);
            return;
        }
        b.name = name;
        pen_frame_box = b;
        pen_el("pen_frame_info").textContent = "X " + b.minX.toFixed(1) + " to " + b.maxX.toFixed(1) +
            ", Y " + b.minY.toFixed(1) + " to " + b.maxY.toFixed(1) +
            " (" + (b.maxX - b.minX).toFixed(1) + " x " + (b.maxY - b.minY).toFixed(1) + " mm)";
        pen_status("");
        successfn(b);
    }, function(code) {
        pen_status("Could not read " + name + " (" + code + ")", true);
    });
}

function pen_frame() {
    pen_frame_load(function(b) {
        var f = function(v) { return v.toFixed(3); };
        pen_send_moves([
            pen_up_cmd,
            "G90 G0 X" + f(b.minX) + " Y" + f(b.minY),
            "G0 X" + f(b.maxX) + " Y" + f(b.minY),
            "G0 X" + f(b.maxX) + " Y" + f(b.maxY),
            "G0 X" + f(b.minX) + " Y" + f(b.maxY),
            "G0 X" + f(b.minX) + " Y" + f(b.minY)
        ], "Framing " + b.name + " with the pen up");
    });
}

function init_pen_panel() {
    if (!pen_el("pentab")) return;
    var f = get_localdata("pen_config_file");
    var s = get_localdata("pen_section");
    if (f) pen_el("pen_config_file").value = f;
    if (s) pen_el("pen_section").value = s;
    var px = get_localdata("pen_park_x");
    var py = get_localdata("pen_park_y");
    if (px) pen_el("pen_park_x").value = px;
    if (py) pen_el("pen_park_y").value = py;
    pen_load();
    pen_frame_files();
    var after = get_localdata("pen_after_restart");
    if (after === "up" || after === "down") {
        delete_localdata("pen_after_restart");
        var link = pen_el("pentablink");
        if (link) link.click();
        // give the controller a moment after the reload before moving the pen
        setTimeout(function() {
            if (after === "up") pen_up(); else pen_down();
            pen_status("Restarted - pen moved " + after);
        }, 1500);
    }
}
