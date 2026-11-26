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
4. Shows **PASS** or **FAIL** (with the reason) on that port's row, and adds a
   line to `rig-log.csv`: time, slot, hub port, result, chip ID, WCH bootloader
   version, the loader's `HELLO` reply, and the image's SHA-256.

Unplug a finished board and plug in the next; each hub port is one row
on the screen. A board that fails is retried when it's plugged in again.

Every board's chip ID is in the log, which is the record of what shipped
with which loader (useful for CE/UKCA and Cyber Resilience Act paperwork).

## Hardware

- Raspberry Pi 4 or 5 (a 3B+ works too) with Raspberry Pi OS Lite, and an
  HDMI screen.
- A **powered** USB 2.0 hub (7 ports is a good size). The Keep Alive draws
  little while being programmed, but the Pi's own ports can't power many.
- Short, data-capable USB cables, one per port.

## Getting boards into WCH's bootloader

This still has to be confirmed on factory-fresh boards. A blank board we
tested showed up briefly as an unknown USB device without BOOT held, which
suggests a blank chip starts WCH's bootloader by itself. The rig catches
it within a fraction of a second, so plugging in may be all that's needed.
If a board doesn't appear (its row never shows up), hold BOOT while
plugging it in. For volume, a pogo-pin jig can hold BOOT down.

## Setup on the Pi

Copy the repository (or just `tools/rig` and `firmware/prebuilt`) to the Pi,
then:

```bash
cd keepalive-prog/tools/rig
./setup-pi.sh
sudo reboot
```

After the reboot the rig runs full-screen on the HDMI console. To stop it:
`sudo systemctl stop keepalive-rig`. To run it by hand (e.g. over SSH):

```bash
.venv/bin/python karig.py
```

## Options

```
karig.py [--image FILE] [--log FILE] [--once]
```

- `--image` defaults to `firmware/prebuilt/factory-loader.bin` (loader only).
  `factory-full.bin` (loader + firmware) is also there if a batch ever needs to
  ship ready to use; the check then expects firmware to be installed.
- `--log` defaults to `rig-log.csv` next to the script; it's appended to.
- `--once` programs whatever is plugged in and exits (1 if anything failed).

It also runs on macOS and other Linux machines with libusb, which is handy
for trying it with one board: `pip install -r requirements.txt`, then
`python3 karig.py`.

## Updating the loader image

The image comes from `make prebuilt` in `firmware/`. Copy the new
`factory-loader.bin` to the Pi and restart the service. Boards already in
the field keep the loader they shipped with; the loader can't update itself.
