var servoSettings = {
    min_pulse_us: 1000,
    max_pulse_us: 2000,
    pen_up_percent: 10,
    pen_down_percent: 90,
    tool: 'servo'
};

function init_pen_panel() {
    loadServoSettings();
}

function loadServoSettings() {
    var url = '/servo.json';
    SendGetHttp(url, function(resp) {
        try {
            var data = JSON.parse(resp);
            if (data.min_pulse_us) servoSettings.min_pulse_us = parseInt(data.min_pulse_us);
            if (data.max_pulse_us) servoSettings.max_pulse_us = parseInt(data.max_pulse_us);
            if (data.pen_up_percent) servoSettings.pen_up_percent = parseInt(data.pen_up_percent);
            if (data.pen_down_percent) servoSettings.pen_down_percent = parseInt(data.pen_down_percent);
            if (data.tool) servoSettings.tool = data.tool;
        } catch (e) {
            console.log('Invalid servo.json');
        }
        updateServoUI();
    }, function(error, resp){
        updateServoUI();
    });
}

function loadServoConfig() {
    var url = '/config.yaml';
    var tool = servoSettings.tool;
    SendGetHttp(url, function(resp) {
        parseServoConfig(resp, tool);
        updateServoUI();
    });
}

function parseServoConfig(text, tool) {
    var lines = text.split(/\r?\n/);
    var inTool = false;
    var indent = '';
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (!inTool) {
            var m = l.match(new RegExp('^\\s*' + tool + ':\\s*$'));
            if (m) {
                inTool = true;
                indent = l.match(/^\s*/)[0] + '  ';
            }
            continue;
        }
        if (!l.startsWith(indent)) break;
        var mm = l.match(/min_pulse_us:\s*(\d+)/);
        if (mm) servoSettings.min_pulse_us = parseInt(mm[1]);
        mm = l.match(/max_pulse_us:\s*(\d+)/);
        if (mm) servoSettings.max_pulse_us = parseInt(mm[1]);
    }
}

function updateServoUI() {
    if (id('servo_min_pulse')) id('servo_min_pulse').value = servoSettings.min_pulse_us;
    if (id('servo_max_pulse')) id('servo_max_pulse').value = servoSettings.max_pulse_us;
    if (id('servo_up_percent')) id('servo_up_percent').value = servoSettings.pen_up_percent;
    if (id('servo_down_percent')) id('servo_down_percent').value = servoSettings.pen_down_percent;
    if (id('servo_tool')) id('servo_tool').value = servoSettings.tool;
}

function saveServoSettings() {
    servoSettings.min_pulse_us = parseInt(id('servo_min_pulse').value);
    servoSettings.max_pulse_us = parseInt(id('servo_max_pulse').value);
    servoSettings.pen_up_percent = parseInt(id('servo_up_percent').value);
    servoSettings.pen_down_percent = parseInt(id('servo_down_percent').value);
    if (id('servo_tool')) servoSettings.tool = id('servo_tool').value.trim();
    var blob = new Blob([JSON.stringify(servoSettings, null, ' ')], {type: 'application/json'});
    var file = new File([blob], 'servo.json');
    var formData = new FormData();
    formData.append('path', '/');
    formData.append('myfile[]', file, 'servo.json');
    SendFileHttp('/files', formData);
    saveServoConfig();
}

function saveServoConfig() {
    var url = '/config.yaml';
    SendGetHttp(url, function(resp) {
        var tool = servoSettings.tool;
        var lines = resp.split(/\r?\n/);
        var out = [];
        var inTool = false;
        var indent = '';
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            if (!inTool) {
                out.push(l);
                var m = l.match(new RegExp('^\\s*' + tool + ':\\s*$'));
                if (m) {
                    inTool = true;
                    indent = l.match(/^\s*/)[0] + '  ';
                }
                continue;
            }
            if (!l.startsWith(indent)) {
                out.push(indent + 'min_pulse_us: ' + servoSettings.min_pulse_us);
                out.push(indent + 'max_pulse_us: ' + servoSettings.max_pulse_us);
                out.push(l);
                inTool = false;
                continue;
            }
        }
        if (inTool) {
            out.push(indent + 'min_pulse_us: ' + servoSettings.min_pulse_us);
            out.push(indent + 'max_pulse_us: ' + servoSettings.max_pulse_us);
        }
        var blob = new Blob([out.join('\n')], {type: 'text/plain'});
        var file = new File([blob], 'config.yaml');
        var formData2 = new FormData();
        formData2.append('path', '/');
        formData2.append('myfile[]', file, 'config.yaml');
        SendFileHttp('/files', formData2);
    });
}

function servoCalc(percent) {
    var minv = parseInt(id('servo_min_pulse').value);
    var maxv = parseInt(id('servo_max_pulse').value);
    return Math.round(minv + (maxv - minv) * (percent / 100));
}

function servoTestMin() { sendCommand('M3 S' + servoCalc(0)); }
function servoTestMax() { sendCommand('M3 S' + servoCalc(100)); }
function servoTestUp() { var p = parseInt(id('servo_up_percent').value); sendCommand('M3 S' + servoCalc(p)); }
function servoTestDown() { var p = parseInt(id('servo_down_percent').value); sendCommand('M3 S' + servoCalc(p)); }
