# Keep Alive factory rig

Programs the **update loader** onto new boards, several at a time, checks
each one, and logs it. Boards ship with only the loader; customers install
the firmware from the website on first use, over Web Serial with no driver.

## What it does, per board

1. Waits for the board to appear in WCH's USB bootloader (`4348:55E0` or
   `1A86:55E0`) on any port of the hub.
2. Checks it's a CH32X035F8U6, reads its chip ID, erases the flash (not the
   settings page) and writes the loader image, then reads it back to verify.
3. Restarts it, waits for it to come back as the Keep Alive serial port
   (`1209:D035`), and sends `HELLO`. It must answer as the loader, with the
   expected loader version and no firmware installed.
4. Shows **PASS** or **FAIL** (with the reason) on that port's tile, and adds a
   line to `rig-log.csv`: time, slot, hub port, result, chip ID, WCH bootloader
   version, the loader's `HELLO` reply, and the image's SHA-256.

Unplug a finished board and plug in the next; each hub port is one tile
on the screen. A board that fails is retried when it's plugged in again.

Every board's chip ID is in the log, which is the record of what shipped
with which loader (useful for CE/UKCA and Cyber Resilience Act paperwork).

## Hardware

- Raspberry Pi 4 or 5 (a 3B+ works too) with Raspberry Pi OS (desktop), and
  an HDMI screen.
- A **powered** USB 2.0 hub (7 ports is a good size). The Keep Alive draws
  little while being programmed, but the Pi's own ports can't power many.
- Short, data-capable USB cables, one per port.

## Getting boards into WCH's bootloader

This still has to be confirmed on factory-fresh boards. A blank board we
tested showed up briefly as an unknown USB device without BOOT held, which
suggests a blank chip starts WCH's bootloader by itself. The rig catches
it within a fraction of a second, so plugging in may be all that's needed.
If a board doesn't appear (no tile shows up), hold BOOT while
plugging it in. For volume, a pogo-pin jig can hold BOOT down.

## The dashboard

`start-rig.sh` (the **Keep Alive Rig** launcher on the Pi) starts the rig and
opens its dashboard full-screen: a tile per hub port that goes yellow with a
progress bar while the board is programmed, green **Done** or red **Failed**
with the reason, then asks for the board to be unplugged. Above it are the
session's pass/fail counts; below, the latest results and a **Download log**
button. It beeps on pass and fail (the **Sound** button turns that off).
Closing the window stops the rig, so the Pi is free for other work.

`http://localhost:8765/?demo` shows made-up boards, to check the screen
without hardware.

## Setup on the Pi

Raspberry Pi OS with the desktop. Copy the repository (or just `tools/rig`
and `firmware/prebuilt`) to the Pi, then:

```bash
cd keepalive-prog/tools/rig
./setup-pi.sh
```

Log out and back in, then start **Keep Alive Rig** from the menu or the
desktop. For a Pi that does nothing else, `./setup-pi.sh --autostart` also
runs the terminal view on the HDMI console at every boot.

## Running it by hand

```bash
./start-rig.sh                      # dashboard, as the launcher does
.venv/bin/python karig.py           # terminal view (e.g. over SSH)
.venv/bin/python karig.py --web 8765 --listen 0.0.0.0   # dashboard others on the network can watch
```

## Options

```
karig.py [--image FILE] [--log FILE] [--once] [--web PORT] [--listen ADDR]
```

- `--image` defaults to `firmware/prebuilt/factory-loader.bin` (loader only).
  `factory-full.bin` (loader + firmware) is also there if a batch ever needs to
  ship ready to use; the check then expects firmware to be installed.
- `--log` defaults to `rig-log.csv` next to the script; it's appended to.
- `--once` programs whatever is plugged in and exits (1 if anything failed).
- `--web` serves the dashboard on that port instead of drawing in the
  terminal; `--listen 0.0.0.0` makes it reachable from other machines (it
  shows chip IDs and the log, so only on a trusted network).

It also runs on macOS and other Linux machines with libusb, which is handy
for trying it with one board: `python3 -m venv .venv && .venv/bin/pip install
-r requirements.txt`, then `./start-rig.sh`.

## Updating the loader image

The image comes from `make prebuilt` in `firmware/`. Copy the new
`factory-loader.bin` to the Pi and restart the service. Boards already in
the field keep the loader they shipped with; the loader can't update itself.
