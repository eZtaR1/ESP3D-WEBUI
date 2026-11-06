// Pen (servo) panel for FluidNC pen plotters that lift the pen with a
// BESC-type servo spindle, e.g.
//
//   BESC:
//     speed_map: 0=100.00% 1=0.00%
//     min_pulse_us: 1400
//     max_pulse_us: 2100
//
// "M3 S0" moves the pen up and "M3 S1" moves it down.  The pulse width each
// one produces comes from min_pulse_us / max_pulse_us / speed_map, and
// FluidNC only applies those at startup (BESC::init()), so a change has to
// be written to the config file and the controller restarted before the
// servo moves to the new position.  This panel does exactly that: it edits
// only those lines of the config file in place (comments and everything
// else are left untouched), keeps a one-time backup of the original file,
// restarts FluidNC, and moves the pen to the position that was just changed.

var pen_up_cmd = "M3 S0";
var pen_down_cmd = "M3 S1";
var pen_min_us = 500;
var pen_max_us = 2500;
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
        simple: (pUp === 0 || pUp === 100) && (pDown === 0 || pDown === 100) && pUp !== pDown
    };
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
    if (!cfg.simple || upIsHigh !== curUpIsHigh) {
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
    pen_el("pen_up_us").value = cfg.up_us;
    pen_el("pen_down_us").value = cfg.down_us;
    pen_el("pen_current").textContent = "In " + pen_config_name() + ": up " + cfg.up_us +
        " us (S0), down " + cfg.down_us + " us (S1)";
}

function pen_load() {
    pen_status("Reading " + pen_config_name() + "...");
    pen_read_config(function(cfg) {
        pen_show(cfg);
        pen_status("");
    });
}

function pen_value(which) {
    var v = parseInt(pen_el("pen_" + which + "_us").value, 10);
    if (isNaN(v)) return null;
    return Math.max(pen_min_us, Math.min(pen_max_us, v));
}

function pen_nudge(which, delta) {
    var v = pen_value(which);
    if (v === null) v = 1500;
    pen_el("pen_" + which + "_us").value = Math.max(pen_min_us, Math.min(pen_max_us, v + delta));
}

function pen_machine_busy() {
    if (typeof grblstate === "undefined" || !grblstate || !grblstate.stateName) return false;
    var s = grblstate.stateName;
    return !(s === "Idle" || s === "Alarm" || s === "Sleep");
}

// which: "up" or "down" -- the position to move to after the restart.
function pen_apply(which) {
    var upUs = pen_value("up");
    var downUs = pen_value("down");
    if (upUs === null || downUs === null) {
        pen_status("Enter both pulse widths", true);
        return;
    }
    if (upUs === downUs) {
        pen_status("Up and down must be different", true);
        return;
    }
    if (pen_machine_busy()) {
        pen_status("Machine is " + grblstate.stateName + " - wait until it is idle", true);
        return;
    }
    var name = pen_config_name();
    pen_status("Reading " + name + "...");
    pen_read_config(function(cfg) {
        if (cfg.up_us === upUs && cfg.down_us === downUs) {
            pen_status("No change - moving pen " + which);
            if (which === "up") pen_up(); else pen_down();
            return;
        }
        var newText = pen_build(cfg, upUs, downUs);
        var write = function() {
            pen_status("Writing " + name + "...");
            pen_write_file(name, newText, function() {
                // Read it back to make sure the file on the controller is what we sent
                pen_read_config(function(check) {
                    if (check.up_us !== upUs || check.down_us !== downUs) {
                        pen_status("Verify failed: " + name + " has up " + check.up_us + " / down " + check.down_us, true);
                        return;
                    }
                    store_localdata("pen_after_restart", which);
                    pen_status("Saved. Restarting FluidNC...");
                    restartdlg();
                });
            });
        };
        if (pen_backup_done) {
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

function pen_save_settings() {
    store_localdata("pen_config_file", pen_config_name());
    store_localdata("pen_section", pen_section_name());
}

function init_pen_panel() {
    if (!pen_el("pentab")) return;
    var f = get_localdata("pen_config_file");
    var s = get_localdata("pen_section");
    if (f) pen_el("pen_config_file").value = f;
    if (s) pen_el("pen_section").value = s;
    pen_load();
    var after = get_localdata("pen_after_restart");
    if (after === "up" || after === "down") {
        delete_localdata("pen_after_restart");
        displayBlock("pentab");
        var link = pen_el("pentablink");
        if (link) link.click();
        // give the controller a moment after the reload before moving the pen
        setTimeout(function() {
            if (after === "up") pen_up(); else pen_down();
            pen_status("Restarted with new values - pen moved " + after);
        }, 1500);
    }
}
