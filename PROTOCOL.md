# Config protocol (draft, proto version 1)

Line-based ASCII over USB CDC (virtual serial port). Human-readable on purpose:
any serial terminal can drive it (`screen /dev/tty.usbmodem* 115200`), which
makes bring-up and support easy. The baud rate is ignored by CDC.

## Framing

- Host → device: one command per line, terminated by `\n` (`\r\n` accepted). Max 128 characters.
- Device → host: exactly one reply line per command, starting `OK` or `ERR`.
- Device → host, unsolicited: event lines starting `!`. The host must accept these at any time, including between a command and its reply.
- Arguments are `key=value` pairs, space separated, any order. Units are always integer **mA** and **ms**.
- No echo.

## Errors

`ERR <code> <text>`

| Code | Meaning |
|---|---|
| 1 | Unknown command |
| 2 | Missing or malformed argument |
| 3 | Value out of range (see `LIMITS`) |
| 4 | Flash write failed |
| 5 | Not allowed in current state (e.g. fault active) |

## Commands

### `HELLO`
First command the page sends. Identifies the device and protocol version.
```
> HELLO
< OK KA-PROG fw=1.0.5 proto=1 hw=A uid=1A2B3C4D
```
The page refuses to configure a device whose `proto` is newer than it understands, and asks the user to reload the page.

### `LIMITS`
Ranges the firmware accepts, so the page never hard-codes them.
```
> LIMITS
< OK presets=3 ma_max=325 on_min=10 on_max=30000 off_max=3599990 period_max=3600000 duty_max=50 stream_min=100 stream_max=60000
```
Since 1.0.5 a preset must also satisfy `off >= on` (at most `duty_max` = 50% on, so there is no continuous load) and `on + off <= period_max` (one hour). `period_max` and `duty_max` are only sent by firmware that enforces them; before 1.0.5 `on_max` was 600000, `off_max` 3600000, and `off=0` meant continuous load.
`stream_min`/`stream_max` bound the `STREAM` interval. The page must ignore keys it doesn't know, so new limits can be added without bumping `proto`.

### `GET <n>` / `GET`
Read preset `n` (1–3). Without `n`, returns all three on one line separated by ` | `.
```
> GET 1
< OK p=1 ma=50 on=500 off=4500 en=1
```
`ma=0` means no load.
`en=0` means the preset is disabled: the button skips it and `SELECT` refuses
it. Firmware before 1.0.1 doesn't send `en`; treat a missing `en` as `1`.

### `SET <n> ma=<mA> on=<ms> off=<ms> en=<0|1>`
Change preset `n` in RAM. Takes effect immediately if `n` is the active preset. Omitted keys keep their value. Not persistent until `SAVE`.
```
> SET 1 ma=120 on=250
< OK p=1 ma=120 on=250 off=4500 en=1
```
The resulting preset is checked as a whole, so a `SET` that would break a limit is refused and nothing changes (`ERR 3 off must be at least on (max 50% duty)`, `ERR 3 on + off must be at most 1 hour`, `ERR 3 on must be 10-30000 ms`).
Presets saved by older firmware are pulled into these limits at power-up.

The active preset can't be disabled (`ERR 5 select another preset first`), so
at least one preset is always enabled.

### `SELECT <n>`
Make preset `n` active (same as the button). Persisted by `SAVE`. A disabled
preset can't be selected (`ERR 5 preset is disabled`).
```
> SELECT 2
< OK active=2
```

### `SAVE`
Write all presets and the active selection to flash. The page calls this only on an explicit "Save to device", so dragging a slider doesn't wear the flash.
```
> SAVE
< OK saved
```

### `OPTS` / `OPTS led=<0|1|2>`
Device options (firmware 1.0.3+). Without arguments, reports them. Persisted by `SAVE`.
```
> OPTS led=1
< OK led=1
```
| Option | Meaning |
|---|---|
| `led` | The light in keep-alive mode (on a power bank). `0` = off. `1` = one short flash as each pulse starts. `2` = blink the active preset number every 10 s. New boards default to `0` (1.1.0+; before that, `2`). In every mode the light still blinks on a button press and at power-up, and flashes for faults. On a PC it is on steadily regardless. |

Older firmware answers `ERR 1 unknown command`; the page then hides the option.

### `DIAG`
Diagnostics for bring-up (firmware 1.0.4+); fields may change between versions.
```
> DIAG
< OK awu_us=21845
```
`awu_us` is the standby wake-up timer tick in µs, measured at power-up against the main clock.

### `DEFAULTS`
Restore factory presets in RAM, all enabled (still needs `SAVE`).

### `STATUS`
```
> STATUS
< OK active=1 run=1 state=ON vbus=5012 ma=101 set=100 t=12345
```
| Field | Meaning |
|---|---|
| `run` | 1 = pulsing, 0 = paused (default while connected to a PC) |
| `state` | `ON` (load drawing), `OFF` (between pulses), `IDLE` (preset disabled or paused), `FAULT` |
| `vbus` | Measured VBUS in mV |
| `ma` | Measured load current in mA |
| `set` | Current target in mA (0 between pulses) |
| `t` | ms since boot, uint32 (wraps after ~49.7 days). Same clock as `!E` edges; lets the page detect resets. |

### `STREAM <ms>` / `STREAM 0`
Send a status event every `<ms>` (`stream_min`–`stream_max` from `LIMITS`) for the live readouts, and turn on
pulse edge events (`!E`) for the chart. `0` stops both. Stops automatically
when the port closes.
```
< !S active=1 run=1 state=ON vbus=5008 ma=100 set=100 t=12500
< !E on t=12000 set=100
< !E off t=12500 ma=99 dur=500
```
The page draws the pulse chart from `!E` edges using the device's own `t`,
not from `!S` samples, so pulses appear at their true width and spacing
regardless of sampling rate or USB/browser timing.

### `RUN 1` / `RUN 0`
Start or stop pulsing while connected to a PC. Not saved. Pulsing is paused
whenever the device is enumerated by a host (see Behaviour notes), so the page
uses `RUN 1` only for a live trial and `RUN 0` to stop it.

### `TEST ma=<mA> ms=<ms>`
One-off pulse to try a value without changing presets. Max `ms` = `on_max`.
Any pulse in progress ends first; if a trial is running, its cycle restarts
after the test pulse. The test pulse produces `!E` edges like any other.
```
> TEST ma=150 ms=2000
< OK test
< !T done ma=149
```

### `BOOT`
Reply, then restart into the update loader (1.1.0+; earlier firmware went to
WCH's USB bootloader instead). `HELLO` from 1.1.0 includes `boot=loader` to say so.
```
> BOOT
< OK bootloader
```

## Events

| Event | When |
|---|---|
| `!S ...` | Periodic status (see `STREAM`) |
| `!E on t=<ms> set=<mA>` | Pulse started (while streaming). `t` is the exact edge time from the hardware timer |
| `!E off t=<ms> ma=<mA> dur=<ms>` | Pulse ended. `ma` is the average measured current over the pulse after the first few ms of settling |
| `!P active=<n>` | Preset changed with the button (it skips disabled presets) |
| `!T done ma=<mA>` | `TEST` pulse finished |
| `!F <reason> vbus=<mV>` | Fault: `OVERVOLT` (> 6 V), `UNDERVOLT` (< 4.2 V), `OVERCURRENT`, `NOREG` (target not reached) |
| `!F CLEAR` | Fault cleared |

## Behaviour notes

- **Pulsing is paused while connected to a PC.** When the firmware detects a USB host and enumerates, it sets `run=0`. The page can start a live trial with `RUN 1` (or a single `TEST` pulse); `RUN 0` stops it. Unplugging from the PC and plugging into a power bank returns to normal keep-alive operation with the active preset.
- Firmware clamps every value to `LIMITS` even if the host doesn't.
- Changing the active preset (`SET` on it, `SELECT`, `RUN`, `TEST`) ends any pulse in progress (with an `!E off`) and restarts the cycle from that moment.
- Factory defaults:

| Preset | mA | on (ms) | off (ms) | Intent |
|---|---|---|---|---|
| 1 | 50 | 500 | 4500 | Low |
| 2 | 125 | 500 | 4500 | Medium |
| 3 | 200 | 500 | 4500 | High |

## Open items

- USB VID/PID (pid.codes or WCH) — the page filters on it.
- USB product string: "Eplop Keep Alive" (agreed).

## Update loader

Since 1.1.0 the first 16 KB of flash hold an update loader, and the firmware
runs after it. The loader appears as the same USB serial port (same IDs and
serial number, product name *Eplop Keep Alive (update)*), so the flash page
reaches it over Web Serial with no driver on any system. It stays in update
mode when the firmware asked (`BOOT`), when INPUT is held at power-up, or when
no valid firmware is installed (new boards ship like this). Otherwise it
starts the firmware straight away.

Same line format as above: one command, one `OK`/`ERR` reply.

| Command | Reply |
|---|---|
| `HELLO` | `OK KA-LOADER ldr=<ver> proto=1 chip=CH32X035F8U6 uid=<8 hex> sn=<24 hex> app=<ver>\|none max=<bytes> keys=<n>` |
| `BEGIN <256 hex>` | The 128-byte image header. Checks it, then marks the installed firmware as gone. `OK` |
| `DATA <offset> <hex>` | Up to 128 bytes at `offset` (decimal, must follow on from the last). `OK <bytes so far>` |
| `END` | Checks the CRC and the Ed25519 signature (about 7 s), then marks the firmware installed. `OK verified app=<ver>`, or `ERR 6` |
| `RUN` | Restarts into the firmware. `ERR 7` if none is installed |
| `ABORT` | Drops an unfinished upload |
| `CLEAR` | Marks the firmware as not installed (testing, factory); presets are kept |

Errors: `1` unknown command, `2` bad argument, `3` refused (not a Keep Alive
image, or a lower `sec_level` than the installed one), `4` flash write failed,
`5` out of order, `6` image damaged or not signed by Eplop, `7` no firmware.

The image format (`.kai`) is the header from `firmware/src/image.h` followed
by the firmware: magic `KAI1`, version, length, `sec_level`, key ID, CRC-32,
and an Ed25519 signature over the first 64 header bytes plus the image. The
loader holds two public keys (`firmware/loader/keys.h`): 0 signs releases, 1
is an offline backup. An upload that fails part way leaves no firmware
installed, so the board stays in update mode until a complete, genuine image
goes on. The presets page (0xF700) is never touched.
