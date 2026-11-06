// Pen panel for FluidNC pen plotters whose pen is lifted by an RC servo
// driven as the Z axis:
//
//   axes:
//     z:
//       max_rate_mm_per_min: 2400     <- pen up/down speed
//       max_travel_mm: 8              <- Z range is -8 .. 0
//       soft_limits: true
//       motor0:
//         rc_servo:
//           output_pin: gpio.22
//           min_pulse_us: 1300        <- pulse at Z-8
//           max_pulse_us: 2100        <- pulse at Z0
//
// Z is a machine position that maps linearly onto the servo pulse, so pen
// heights are just Z values: "G53 G0 Z0" (up), "G53 G0 Z-7" (down).  G53
// keeps them independent of any work offset, and G0 avoids touching the
// modal feed rate, so the pen moves at the Z max rate.
//
// Pen heights live in pen.json on the controller and are also written to
// macro1.g (down) / macro2.g (up) so the dashboard macro buttons match.
// The servo pulse range and Z speed are applied live with $/ settings and
// also written into the config file in place (comments and all other lines
// untouched, one-time .bak of the original); only max_travel_mm and
// planner_blocks need a restart.

var pen = {
    up_z: 0,
    down_z: -7,
    park_x: 398,
    park_y: 362
};
var pen_state_file = "pen.json";
var pen_down_macro = "macro1.g";
var pen_up_macro = "macro2.g";
var pen_cfg = null;           // last parsed config
var pen_backup_done = false;
var pen_jog_z = 0;            // last Z sent from the height panel
var pen_frame_box = null;

function pen_el(name) {
    return document.getElementById(name);
}

function pen_status(msg, isError) {
    var els = document.getElementsByClassName("pen-status");
    for (var i = 0; i < els.length; i++) {
        els[i].textContent = msg;
        els[i].style.color = isError ? "#c9302c" : "";
    }
}

function pen_config_name() {
    var v = pen_el("pen_config_file") ? pen_el("pen_config_file").value.trim() : "";
    if (v === "") v = "config.yaml";
    return v.replace(/^\/+/, "");
}

function pen_fmt(z) {
    return String(Math.round(z * 1000) / 1000);
}

function pen_up_cmd() {
    return "G53 G0 Z" + pen_fmt(pen.up_z);
}

function pen_down_cmd() {
    return "G53 G0 Z" + pen_fmt(pen.down_z);
}

function pen_up() {
    SendPrinterCommand(pen_up_cmd(), true);
}

function pen_down() {
    SendPrinterCommand(pen_down_cmd(), true);
}

// ---- config parsing / editing --------------------------------------------

function pen_indent(line) {
    return line.match(/^[ \t]*/)[0].length;
}

function pen_is_blank(line) {
    return /^\s*(#.*)?$/.test(line);
}

function pen_escape(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Finds "name:" with nothing after it between lines [from, to) at an
// indent greater than minIndent.  Returns {start, end, base, childIndent}.
function pen_find_block(lines, name, from, to, minIndent) {
    var header = new RegExp("^([ \\t]*)" + pen_escape(name) + ":\\s*(#.*)?$");
    for (var i = from; i < to; i++) {
        var m = lines[i].match(header);
        if (!m || m[1].length <= minIndent) continue;
        var base = m[1].length;
        var end = i + 1;
        var childIndent = -1;
        for (var j = i + 1; j < to; j++) {
            if (pen_is_blank(lines[j])) continue;
            var ind = pen_indent(lines[j]);
            if (ind <= base) break;
            if (childIndent < 0) childIndent = ind;
            end = j + 1;
        }
        if (childIndent < 0) childIndent = base + 2;
        return { start: i, end: end, base: base, childIndent: childIndent };
    }
    return null;
}

// path like ["axes", "z", "motor0", "rc_servo"]
function pen_find_path(lines, path) {
    var from = 0, to = lines.length, minIndent = -1, blk = null;
    for (var k = 0; k < path.length; k++) {
        blk = pen_find_block(lines, path[k], from, to, minIndent);
        if (!blk) return null;
        from = blk.start + 1;
        to = blk.end;
        minIndent = blk.base;
    }
    return blk;
}

function pen_key_regex(key, indent) {
    return new RegExp("^([ \\t]{" + indent + "}" + key + ":[ \\t]*)([^#\\r\\n]*?)([ \\t]*#.*)?$");
}

function pen_get_key(lines, blk, key) {
    var re = pen_key_regex(key, blk.childIndent);
    for (var i = blk.start + 1; i < blk.end; i++) {
        var m = lines[i].match(re);
        if (m) return m[2].trim();
    }
    return null;
}

function pen_set_key(lines, blk, key, value) {
    var re = pen_key_regex(key, blk.childIndent);
    for (var i = blk.start + 1; i < blk.end; i++) {
        var m = lines[i].match(re);
        if (m) {
            lines[i] = m[1] + value + (m[3] || "");
            return;
        }
    }
    var pad = new Array(blk.childIndent + 1).join(" ");
    lines.splice(blk.start + 1, 0, pad + key + ": " + value);
    blk.end++;
}

// Top-level (unindented) key such as planner_blocks
function pen_get_top_key(lines, key) {
    var re = pen_key_regex(key, 0);
    for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(re);
        if (m) return m[2].trim();
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

function pen_num(v, dflt) {
    var n = parseFloat(v);
    return isNaN(n) ? dflt : n;
}

function pen_parse(text) {
    var lines = text.split(/\r?\n/);
    var z = pen_find_path(lines, ["axes", "z"]);
    var servo = pen_find_path(lines, ["axes", "z", "motor0", "rc_servo"]);
    if (!z || !servo) throw new Error("No Z axis rc_servo in " + pen_config_name());
    return {
        text: text,
        crlf: /\r\n/.test(text),
        min_pulse_us: pen_num(pen_get_key(lines, servo, "min_pulse_us"), 1000),   // FluidNC defaults
        max_pulse_us: pen_num(pen_get_key(lines, servo, "max_pulse_us"), 2000),
        z_travel: pen_num(pen_get_key(lines, z, "max_travel_mm"), 1000),
        z_rate: pen_num(pen_get_key(lines, z, "max_rate_mm_per_min"), 1000),
        planner_blocks: pen_num(pen_get_top_key(lines, "planner_blocks"), 16)
    };
}

function pen_build(cfg, v) {
    var lines = cfg.text.split(/\r?\n/);
    var servo = pen_find_path(lines, ["axes", "z", "motor0", "rc_servo"]);
    pen_set_key(lines, servo, "min_pulse_us", String(v.min_pulse_us));
    pen_set_key(lines, servo, "max_pulse_us", String(v.max_pulse_us));
    var z = pen_find_path(lines, ["axes", "z"]);
    pen_set_key(lines, z, "max_rate_mm_per_min", v.z_rate.toFixed(6));
    pen_set_key(lines, z, "max_travel_mm", v.z_travel.toFixed(6));
    pen_set_top_key(lines, "planner_blocks", String(v.planner_blocks));
    return lines.join(cfg.crlf ? "\r\n" : "\n");
}

// Pulse width the servo gets at machine Z (same mapping as RcServo.cpp)
function pen_pulse_at(z) {
    if (!pen_cfg) return null;
    var t = pen_cfg.z_travel;
    var f = Math.max(0, Math.min(1, (z + t) / t));
    return Math.round(pen_cfg.min_pulse_us + (pen_cfg.max_pulse_us - pen_cfg.min_pulse_us) * f);
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
    }, function(code) {
        pen_status("Could not read " + name + " (" + code + ")", true);
    });
}

function pen_write_file(name, text, successfn) {
    var file = new File([new Blob([text], { type: "text/plain" })], name);
    fileUpload(FILE_VOLUME_FLASH, "/", [file], null, successfn, function(code) {
        pen_status("Could not write " + name + " (" + code + ")", true);
    });
}

function pen_load_state(successfn) {
    fileRead(FILE_VOLUME_FLASH, "/" + pen_state_file + "?t=" + Date.now(), function(text) {
        try {
            var d = JSON.parse(text);
            ["up_z", "down_z", "park_x", "park_y"].forEach(function(k) {
                if (typeof d[k] === "number") pen[k] = d[k];
            });
        } catch (e) {
            console.log("Invalid " + pen_state_file);
        }
        successfn();
    }, function() {
        successfn();   // not there yet: defaults
    });
}

// Saves pen.json and the pen up/down macro files
function pen_save_state(successfn) {
    pen_write_file(pen_state_file, JSON.stringify(pen, null, 1), function() {
        pen_write_file(pen_down_macro, pen_down_cmd() + "\n", function() {
            pen_write_file(pen_up_macro, pen_up_cmd() + "\n", function() {
                if (successfn) successfn();
            });
        });
    });
}

// ---- UI --------------------------------------------------------------------

function pen_show() {
    pen_el("pen_up_z").textContent = pen_fmt(pen.up_z);
    pen_el("pen_down_z").textContent = pen_fmt(pen.down_z);
    pen_el("pen_code_down").textContent = pen_down_cmd();
    pen_el("pen_code_up").textContent = pen_up_cmd();
    pen_el("pen_park_x").value = pen.park_x;
    pen_el("pen_park_y").value = pen.park_y;
    if (pen_cfg) {
        pen_el("pen_min_pulse").value = pen_cfg.min_pulse_us;
        pen_el("pen_max_pulse").value = pen_cfg.max_pulse_us;
        pen_el("pen_z_travel").value = pen_cfg.z_travel;
        pen_el("pen_z_rate").value = pen_cfg.z_rate;
        pen_el("pen_planner_blocks").value = pen_cfg.planner_blocks;
        pen_el("pen_jog_z").min = -pen_cfg.z_travel;
    }
    pen_show_jog();
}

function pen_show_jog() {
    pen_el("pen_jog_z").value = pen_fmt(pen_jog_z);
    var p = pen_pulse_at(pen_jog_z);
    pen_el("pen_jog_pulse").textContent = p === null ? "" : "(" + p + " us)";
}

function pen_load() {
    pen_status("Reading settings...");
    pen_load_state(function() {
        pen_read_config(function(cfg) {
            pen_cfg = cfg;
            pen_show();
            pen_status("");
        });
        pen_show();
    });
}

function pen_machine_busy() {
    if (typeof grblstate === "undefined" || !grblstate || !grblstate.stateName) return false;
    var s = grblstate.stateName;
    return !(s === "Idle" || s === "Alarm" || s === "Sleep");
}

function pen_send_moves(cmds, what) {
    if (pen_machine_busy()) {
        pen_status("Machine is " + grblstate.stateName + " - wait until it is idle", true);
        return false;
    }
    if (typeof grblstate !== "undefined" && grblstate && grblstate.stateName === "Alarm") {
        pen_status("Machine is in alarm - home or unlock first", true);
        return false;
    }
    cmds.forEach(function(c) { SendPrinterCommand(c, true); });
    if (what) pen_status(what);
    return true;
}

// ---- pen heights (live) ----------------------------------------------------

function pen_clamp_z(z) {
    var t = pen_cfg ? pen_cfg.z_travel : 1000;
    return Math.max(-t, Math.min(0, z));
}

function pen_jog_to(z) {
    z = pen_clamp_z(Math.round(z * 1000) / 1000);
    if (pen_send_moves(["G53 G0 Z" + pen_fmt(z)])) {
        pen_jog_z = z;
        pen_status("Pen at Z" + pen_fmt(z));
    }
    pen_show_jog();
}

function pen_jog(delta) {
    pen_jog_to(pen_jog_z + delta);
}

function pen_jog_field() {
    var z = parseFloat(pen_el("pen_jog_z").value);
    if (!isNaN(z)) pen_jog_to(z);
}

function pen_use_as(which) {
    if (which === "up" && pen_jog_z <= pen.down_z) {
        pen_status("Up must be above down (Z" + pen_fmt(pen.down_z) + ")", true);
        return;
    }
    if (which === "down" && pen_jog_z >= pen.up_z) {
        pen_status("Down must be below up (Z" + pen_fmt(pen.up_z) + ")", true);
        return;
    }
    pen[which + "_z"] = pen_jog_z;
    pen_show();
    pen_save_state(function() {
        pen_status("Pen " + which + " saved as Z" + pen_fmt(pen_jog_z) + " - update the DrawingBot preset");
    });
}

// ---- servo + plotter settings ----------------------------------------------

function pen_settings_save() {
    var v = {
        min_pulse_us: parseInt(pen_el("pen_min_pulse").value, 10),
        max_pulse_us: parseInt(pen_el("pen_max_pulse").value, 10),
        z_travel: parseFloat(pen_el("pen_z_travel").value),
        z_rate: parseFloat(pen_el("pen_z_rate").value),
        planner_blocks: parseInt(pen_el("pen_planner_blocks").value, 10)
    };
    var bad = function(x, lo, hi) { return isNaN(x) || x < lo || x > hi; };
    if (bad(v.min_pulse_us, 500, 2500) || bad(v.max_pulse_us, 500, 2500)) {
        pen_status("Pulse widths must be 500-2500 us", true);
        return;
    }
    if (bad(v.z_travel, 1, 100) || bad(v.z_rate, 10, 100000)) {
        pen_status("Check Z travel (1-100 mm) and Z speed", true);
        return;
    }
    if (bad(v.planner_blocks, 10, 120)) {
        pen_status("planner_blocks must be 10-120", true);
        return;
    }
    if (pen_machine_busy()) {
        pen_status("Machine is " + grblstate.stateName + " - wait until it is idle", true);
        return;
    }
    var name = pen_config_name();
    pen_status("Reading " + name + "...");
    pen_read_config(function(cfg) {
        var restart = cfg.z_travel !== v.z_travel || cfg.planner_blocks !== v.planner_blocks;
        var newText = pen_build(cfg, v);
        var write = function() {
            pen_status("Writing " + name + "...");
            pen_write_file(name, newText, function() {
                pen_read_config(function(check) {
                    if (check.min_pulse_us !== v.min_pulse_us || check.max_pulse_us !== v.max_pulse_us ||
                        check.z_travel !== v.z_travel || check.z_rate !== v.z_rate ||
                        check.planner_blocks !== v.planner_blocks) {
                        pen_status("Verify failed - " + name + " was not written as expected", true);
                        return;
                    }
                    pen_cfg = check;
                    if (restart) {
                        pen_status("Saved. Restarting FluidNC for travel / planner change...");
                        restartdlg();
                        return;
                    }
                    // apply live: RcServo re-reads its pulse range on every update
                    SendPrinterCommand("$/axes/z/motor0/rc_servo/min_pulse_us=" + v.min_pulse_us, true);
                    SendPrinterCommand("$/axes/z/motor0/rc_servo/max_pulse_us=" + v.max_pulse_us, true);
                    SendPrinterCommand("$/axes/z/max_rate_mm_per_min=" + v.z_rate, true);
                    pen_show();
                    pen_status("Saved and applied");
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
}

// ---- homing check ----------------------------------------------------------
// FluidNC's status report doesn't say whether the axes are homed, and $X
// (unlock) lets the machine move without homing.  So the panel only trusts
// a homing cycle it has seen finish since the page was opened: FluidNC
// prints "[MSG:Homed:XY]" then.  An alarm or a restart clears it.  This
// works from the console stream, so it doesn't need status reports on.

var pen_homed_axes = "";

function pen_homed() {
    return pen_homed_axes.indexOf("X") >= 0 && pen_homed_axes.indexOf("Y") >= 0;
}

function pen_watch_line(line) {
    var m = line.match(/^\[MSG:Homed:([A-Z]*)\]/);
    if (m) {
        for (var i = 0; i < m[1].length; i++) {
            if (pen_homed_axes.indexOf(m[1][i]) < 0) pen_homed_axes += m[1][i];
        }
        if (pen_homed()) pen_status("Homed");
    } else if (/^ALARM:/.test(line) || /'\$' for help/.test(line) || /^\[MSG:.*Unhomed/.test(line)) {
        pen_homed_axes = "";
    }
}

function pen_watch_homing(state) {
    if (state.stateName === "Alarm") pen_homed_axes = "";
}

// Runs fn if X/Y have been homed, otherwise offers to home first
function pen_if_homed(fn) {
    if (pen_homed()) {
        fn();
        return;
    }
    confirmdlg("Not homed",
        "X/Y haven't been homed since this page was opened, so the machine may not be where it thinks it is. Home now?",
        function(answer) {
            if (answer !== "yes") {
                pen_status("Cancelled - home first", true);
                return;
            }
            if (pen_machine_busy()) {
                pen_status("Machine is " + grblstate.stateName + " - wait until it is idle", true);
                return;
            }
            // G-code is refused in Alarm, so the pen can only be lifted first when not in alarm
            var inAlarm = typeof grblstate !== "undefined" && grblstate && grblstate.stateName === "Alarm";
            if (!inAlarm) SendPrinterCommand(pen_up_cmd(), true);
            SendPrinterCommand("$H", true);
            pen_status("Homing...");
        });
}

// ---- moves -----------------------------------------------------------------

function pen_goto_origin() {
    pen_if_homed(function() {
        pen_send_moves([pen_up_cmd(), "G90 G0 X0 Y0"], "Pen up, going to X0 Y0");
    });
}

function pen_change() {
    var x = parseFloat(pen_el("pen_park_x").value);
    var y = parseFloat(pen_el("pen_park_y").value);
    if (isNaN(x) || isNaN(y)) {
        pen_status("Set the pen change position first", true);
        return;
    }
    if (x !== pen.park_x || y !== pen.park_y) {
        pen.park_x = x;
        pen.park_y = y;
        pen_save_state();
    }
    // machine coordinates, so the spot doesn't move with the work zero
    pen_if_homed(function() {
        pen_send_moves([pen_up_cmd(), "G53 G0 X" + x + " Y" + y], "Pen up, parked for pen change");
    });
}

// ---- frame -----------------------------------------------------------------

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

// Bounding box of the drawing moves in a G-code file, in the file's own
// (work) coordinates.  A move draws when the pen is down: Z below the
// midpoint of the up/down heights, or a G1-G3 move if the file never
// moves Z.  Arcs count by their end points only.
function pen_gcode_bounds(text) {
    var draw = null, cut = null, all = null;
    var x = 0, y = 0, z = 0, absolute = true, scale = 1, motion = 0, sawZ = false;
    var mid = (pen.up_z + pen.down_z) / 2;
    var grow = function(box, px, py) {
        if (!box) return { minX: px, maxX: px, minY: py, maxY: py };
        box.minX = Math.min(box.minX, px); box.maxX = Math.max(box.maxX, px);
        box.minY = Math.min(box.minY, py); box.maxY = Math.max(box.maxY, py);
        return box;
    };
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i].replace(/\(.*?\)/g, "").replace(/;.*$/, "").toUpperCase();
        if (!l.trim() || l.trim()[0] === "$") continue;
        var words = l.match(/[A-Z][+-]?[\d.]+/g);
        if (!words) continue;
        var nx = null, ny = null, nz = null, skip = false, g53 = false;
        for (var j = 0; j < words.length; j++) {
            var letter = words[j][0];
            var val = parseFloat(words[j].substr(1));
            if (letter === "G") {
                if (val === 0 || val === 1 || val === 2 || val === 3) motion = val;
                else if (val === 90) absolute = true;
                else if (val === 91) absolute = false;
                else if (val === 20) scale = 25.4;
                else if (val === 21) scale = 1;
                else if (val === 53) g53 = true;
                else if (val === 28 || val === 30 || val === 92 || val === 10) { skip = true; break; }
            } else if (letter === "X") nx = val * scale;
            else if (letter === "Y") ny = val * scale;
            else if (letter === "Z") nz = val * scale;
        }
        if (skip) continue;
        if (nz !== null) {
            sawZ = true;
            z = (absolute || g53) ? nz : z + nz;
        }
        if (g53 || (nx === null && ny === null)) continue;
        var px = x, py = y;
        if (nx !== null) x = absolute ? nx : x + nx;
        if (ny !== null) y = absolute ? ny : y + ny;
        all = grow(all, x, y);
        if (z < mid) {
            draw = grow(draw, px, py);
            draw = grow(draw, x, y);
        }
        if (motion >= 1) {
            cut = grow(cut, px, py);
            cut = grow(cut, x, y);
        }
    }
    return (sawZ ? draw : cut) || all;
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
    pen_if_homed(function() {
        pen_frame_go();
    });
}

function pen_frame_go() {
    pen_frame_load(function(b) {
        var f = function(v) { return v.toFixed(3); };
        pen_send_moves([
            pen_up_cmd(),
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
    if (f) pen_el("pen_config_file").value = f;
    pen_load();
    pen_frame_files();
}
