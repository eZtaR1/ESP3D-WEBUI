# pl0tb0t – pen plotter setup

Wall-mounted pen plotter on an MKS DLC32 running FluidNC, with the pen lifted
by an RC servo driven as the **Z axis**.

Files in this folder:

| File | What it is | Where it goes |
|---|---|---|
| `config.yaml` | FluidNC machine config | Controller flash (`/config.yaml`) |
| `macro1.g` | Pen down (dashboard **M1** button) | Controller flash (`/macro1.g`) |
| `macro2.g` | Pen up (dashboard **M2** button) | Controller flash (`/macro2.g`) |
| `plotbot-z-dbv3.json` | DrawingBotV3 G-code preset `plotbot-z` | Import in DrawingBotV3 |

The WebUI (`index.html.gz` at the repo root) also goes on the controller flash.
The WebUI keeps `macro1.g`, `macro2.g` and `pen.json` up to date when you
change pen heights, so the copies here are only the starting point.

## Machine

| | |
|---|---|
| Board | MKS DLC32, I2S stepping (`I2S_STATIC`) |
| Network | Hostname `fluidnc` (`http://fluidnc.local/`), currently 192.168.3.165 |
| Drivers | TMC2209 over UART1 (X addr 0, Y addr 1), 16 microsteps, StealthChop |
| X | 80 steps/mm, 400 mm travel, 5000 mm/min, 500 mm/s² |
| Y | 80 steps/mm, 365 mm travel, 5000 mm/min, 1000 mm/s² |
| Homing | Sensorless (StallGuard) toward negative, X first then Y. X: seek 2000 / feed 500 / stallguard 24. Y: stallguard 30 |
| After homing | Pen up, then park at X398 Y362 |
| Motors | Always held (`idle_ms: 255`); required, the machine is wall-mounted |
| Pen | RC servo on Z, signal on `gpio.22`, 50 Hz |

## Pen = Z axis

The servo is a FluidNC `rc_servo` motor on Z. Machine Z maps linearly onto the
servo pulse:

| Z (machine) | Pulse |
|---|---|
| Z0 (top) | `max_pulse_us` = 2100 µs |
| Z-8 (bottom, `max_travel_mm: 8`) | `min_pulse_us` = 1300 µs |

That is 100 µs per mm. Z has soft limits, so a move outside Z0 to Z-8 raises an
alarm instead of crushing the pen.

### Commands

| Action | G-code |
|---|---|
| Pen up | `G53 G0 Z0` |
| Pen down | `G53 G0 Z-7` |
| Any height | `G53 G0 Z-6.5` |
| Height change while drawing (tapered stroke) | `G1 X… Y… Z…` |

- **Always use `G53`** for pen moves. It means machine position, so zeroing or
  setting a work origin never shifts the pen height.
- **Use `G0`** for pen up/down. It moves at the Z max rate (the "pen speed")
  and doesn't change the drawing feed rate.
- Pen speed is the Z `max_rate_mm_per_min` (2400). Lower it for a softer
  landing, or if lines start with a blob / drag a tail (the servo has no
  position feedback, so FluidNC assumes it has arrived).
- The servo goes limp until the first move after boot, and whenever the
  motors are disabled (`$MD`).

## DrawingBotV3 preset (`plotbot-z`)

| Field | Value |
|---|---|
| Start code | `G21` / `G90` / `G53 G0 Z0` / `$H` / `G1 F2000` |
| End code | `G53 G0 Z0` / `$H` |
| Pen down | `G53 G0 Z-7` |
| Pen up | `G53 G0 Z0` |
| Units | mm, curve flatness 0.1 |

Drawing speed is the `F2000` in the start code. When you change pen heights in
the WebUI, copy the new pen up/down codes it shows into this preset.

## Everyday use (WebUI)

**Dashboard → GRBL panel → Pen tab:**

- **Pen up / Pen down**: move to the saved heights.
- **Go to X0 Y0**: pen up, then go to the work origin.
- **Pen change**: pen up, then park at a machine X/Y (default 398 / 362).
- **Frame**: pick a file on the SD card; traces its drawing area with the pen
  up and shows the size.
- **Height**: jog the pen ±0.2 / ±1 mm live (shows the pulse width), then
  **Use as pen up** / **Use as pen down**. Saves `pen.json`, `macro1.g`,
  `macro2.g`.

Frame, Go to X0 Y0 and Pen change only move after the machine has been homed
since the page was opened. `$X` (unlock) does **not** count; you'll be asked
to home.

**Menu → Preferences → Pen plotter:** servo pulse range, Z travel, pen speed,
planner blocks. **Apply to controller** writes `config.yaml` in place (comments
kept, original saved once as `config.yaml.bak`). Pulses and speed apply
immediately; Z travel and planner blocks restart FluidNC.

Long jobs: close the WebUI while plotting. Keeping it open during long tasks
has caused odd behaviour.

## Tuning checklist

1. Set pen down: lower until the pen draws a clean, even line; **Use as pen down**.
2. Set pen up: lower from Z0 until the pen just clears the paper (less servo
   strain/buzz); **Use as pen up**.
3. Copy the new codes into the DrawingBot preset.
4. Blobs at line starts or tails at line ends: lower the pen speed.
5. Re-check homing after any StallGuard change (`stallguard_debug: true`,
   read the feed-phase SG values, then set it back to `false`).
6. After changing `config.yaml` by hand, back it up off the controller.

## Recovery

**WebUI won't load (e.g. an upload stopped halfway):**

1. Open `http://fluidnc.local/?forcefallback=yes` (FluidNC's built-in file
   manager) and upload `index.html.gz` again, then reboot.
2. If that doesn't load, telnet in (`telnet fluidnc.local`) and run
   `$LocalFS/Delete=/index.html.gz`; the root page then falls back to the
   built-in upload page.
3. Or from a computer:
   `curl -F "path=/" -F "myfile[]=@index.html.gz;filename=/index.html.gz" http://fluidnc.local/files`

**Bad config:** the WebUI keeps the original as `config.yaml.bak` on the
controller. Download it from the built-in file manager
(`http://fluidnc.local/?forcefallback=yes`), upload it as `config.yaml`, and restart.

## History

- Before the Z conversion the pen was a BESC spindle on `gpio.22`
  (`M3 S0` up, `M3 S1` down, `speed_map: 0=100% 1=0%`, 1400–2100 µs).
  The Z config keeps the same up/down pulses at Z0 / Z-7.
