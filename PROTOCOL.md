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
< OK KA-PROG fw=1.0.0 proto=1 hw=A uid=1A2B3C4D
```
The page refuses to configure a device whose `proto` is newer than it understands, and asks the user to reload the page.

### `LIMITS`
Ranges the firmware accepts, so the page never hard-codes them.
```
> LIMITS
< OK presets=3 ma_max=325 on_min=10 on_max=600000 off_max=3600000 stream_min=100 stream_max=60000
```
`stream_min`/`stream_max` bound the `STREAM` interval. The page must ignore keys it doesn't know, so new limits can be added without bumping `proto`.

### `GET <n>` / `GET`
Read preset `n` (1–3). Without `n`, returns all three on one line separated by ` | `.
```
> GET 1
< OK p=1 ma=50 on=500 off=4500
```
`off=0` means continuous load (on-time ignored). `ma=0` means preset disabled (no load).

### `SET <n> ma=<mA> on=<ms> off=<ms>`
Change preset `n` in RAM. Takes effect immediately if `n` is the active preset. Omitted keys keep their value. Not persistent until `SAVE`.
```
> SET 1 ma=120 on=250
< OK p=1 ma=120 on=250 off=4500
```

### `SELECT <n>`
Make preset `n` active (same as the button). Persisted by `SAVE`.
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

### `DEFAULTS`
Restore factory presets in RAM (still needs `SAVE`).

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
Reply, then reboot into the WCH USB bootloader for a firmware update.
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
| `!P active=<n>` | Preset changed with the button |
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
