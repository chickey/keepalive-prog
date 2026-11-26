# Keep Alive firmware

Firmware for the CH32X035F8U6 on the Rev A board, built with
[ch32fun](https://github.com/cnlohr/ch32fun). It implements everything in
`../PROTOCOL.md` and the behaviour in `../HARDWARE.md`.

**Status:** runs on Rev A hardware (tested on macOS and a power bank). The
update loader and signed installs (1.1.0) have been tested on macOS only so
far; Windows and Linux are next.

## What it does

At power-up it decides where it is plugged in:

- **Computer** (a USB host enumerates it within 60 s): appears as the serial
  port "Eplop Keep Alive", LED on, pulsing paused. The config page can start a
  trial (`RUN 1`) or fire a test pulse. The wait is long because macOS on
  laptops asks the user to allow a new USB accessory before enumerating it.
- **Power bank** (no host, or something already pulling D+/D− high): stays
  off the data lines, runs the active preset, and sleeps in standby between
  pulses. By default the LED stays off (since 1.1.0); the config
  page can switch it to a short flash with each pulse, or to blinking the
  preset number every 10 s.

It runs the active preset from power-up while it waits for a host, so a power
bank is kept awake during the 60 s; deep sleep only starts once it has given
up on a host and let go of the data lines.

In both modes the PRESET button steps through the enabled presets 1→2→3 (saved
immediately, LED blinks the number) on a quick tap; holding it for 0.5 s or more just shows the
current preset. Presets disabled on the config page are skipped. With only
one preset enabled, the LED blinks once instead of the preset number, and a
short press just blinks without restarting the pulse timing.

Pulse limits (since 1.0.5, enforced by the firmware): a pulse lasts 10 ms to
30 s, the off time is at least as long as the on time (50% duty at most, so
there is no continuous load), and a whole cycle is at most an hour. Presets
saved by older firmware are clamped into these limits at power-up.

## Layout

| File | Purpose |
|---|---|
| `keepalive.c` | Start-up, main loop, faults, sleep decisions |
| `src/proto.c` | Command protocol |
| `src/sched.c` | Pulse timing, exact edge times |
| `src/load.c` | TIM2 PWM on the three legs, ADC sampling and current regulation (TIM3, 4 kHz) |
| `src/store.c` | Presets in the last flash page (0x0800F700) |
| `src/usbio.c` | Host detection, CDC input/output |
| `src/ui.c` | Button and LED |
| `src/power.c` | Standby with auto-wake between pulses |
| `usb_config.h` | USB descriptors (**USB IDs are placeholders**) |
| `test/test_host.c` | PC-side tests for protocol and scheduler |
| `loader/` | Update loader: Web Serial installs, Ed25519 signature check |
| `src/image.h` | Flash layout and signed image header |
| `prebuilt/` | Signed firmware and factory images (`make prebuilt`) |

## Building

```
git submodule update --init      # once after cloning, fetches ch32fun
cd firmware
make            # builds keepalive.bin
make test       # host tests, needs only a normal C compiler
```

Tested with ch32fun `6b247c7` and xPack GNU RISC-V Embedded GCC 13.4.0-1.

### Toolchain

Use the [xPack `riscv-none-elf-gcc`](https://github.com/xpack-dev-tools/riscv-none-elf-gcc-xpack/releases)
build: it includes newlib, so no `NEWLIB=` setting is needed, and ch32fun
finds the `riscv-none-elf-` prefix on its own. Homebrew's `riscv64-elf-gcc`
has no C library and fails on `string.h`.

On an Apple-silicon Mac:

```
mkdir -p ~/opt && cd ~/opt
curl -LO https://github.com/xpack-dev-tools/riscv-none-elf-gcc-xpack/releases/download/v13.4.0-1/xpack-riscv-none-elf-gcc-13.4.0-1-darwin-arm64.tar.gz
tar -xzf xpack-riscv-none-elf-gcc-13.4.0-1-darwin-arm64.tar.gz
echo 'export PATH="$HOME/opt/xpack-riscv-none-elf-gcc-13.4.0-1/bin:$PATH"' >> ~/.zshrc
```

Use the `darwin-x64` archive on an Intel Mac, `linux-x64` on Linux.
After a firmware change, run `make prebuilt` and commit `prebuilt/`.

## Flashing

Flash layout (`src/image.h`): update loader 0x0000–0x3EFF (`loader/`), header
of the installed firmware at 0x3F00, firmware 0x4000–0xF6FF, presets at
0xF700. The firmware is linked for 0x4000 and won't run without the loader.

```
make prebuilt     # builds loader + firmware, signs, writes prebuilt/:
                  #   keepalive.kai       signed firmware (what the web page installs)
                  #   factory-loader.bin  loader only (what ships)
                  #   factory-full.bin    loader + firmware
make site NOTE="…"   # publishes to ../docs/firmware
```

Signing uses `~/.eplop/keepalive-primary.pem` (override with `KEY=`); test
builds must be signed too, or the loader refuses them.

**Normal route:** the web flasher over Web Serial (no driver), via the loader.

**Factory / no loader yet:** hold BOOT while plugging in to reach WCH's
bootloader, then run the rig (`tools/rig/karig.py`, loader only by default) or
use *Advanced: WCH bootloader* on the flash page (loader + firmware).

**WCH-LinkE** on the SWDIO/SWCLK pads: `make flash` (uses ch32fun's
minichlink), or WCH-LinkUtility.

## Bring-up checklist

Take these in order; each relies on the ones before.

1. **Flash and enumerate.** Plug into the Mac with nothing in the output
   socket. Expect LED on plus one blink, and a port at
   `/dev/tty.usbmodem*`. `screen /dev/tty.usbmodem* 115200`, type `HELLO`.
2. **Voltages.** `STATUS` → `vbus` should match a meter on VBUS within ~2%.
   If not, check R12/R13 and the reference correction in `load.c`.
3. **Current regulation.** With a USB power meter inline: `TEST ma=50 ms=3000`,
   then 125, 200, 300. Readings should be within a few mA of the request and
   steady. Repeat at 5 and 20 mA: low currents are where ADC offset shows up,
   so compare the meter against both the request and `!T done ma=`. Listen for PWM whine; watch for oscillation (meter jumping). The
   loop gain is the `/ 2` in `control_step()`.
4. **Flash storage.** `SET 1 ma=77`, `SAVE`, unplug, replug, `GET 1` → 77.
   If it fails, the fast page program sequence in `store.c` is the suspect.
5. **Config page.** Open the page, connect, start a trial, edit and save
   presets. The chart should show clean pulses.
6. **Power bank mode.** Plug into a bank: no enumeration, LED blinks preset
   number, pulses on a USB meter every 5 s. Check pulse timing with a scope or
   meter logging.
7. **Sleep current.** Between pulses, measure the board's current (µA meter in
   VBUS). Expect well under 1 mA. If the board resets, hangs or pulses at the
   wrong times after sleeping, set `DEEP_SLEEP` to 0 in `keepalive.c` to
   confirm the rest works, then debug `power.c`.
8. **Button.** Short presses cycle 1→2→3 with matching blinks, and survive a
   power cycle.
9. **Detection edge cases.** Apple-style bank, a bank with a phone plugged
   into the Keep Alive, Windows PC. Each should end up in the expected mode.
10. **Faults.** A QC bank with a phone on the output should report
    `OVERVOLT` (load off) if the bus goes above 6 V.
11. **Update loader.** `BOOT` → board re-appears as *Eplop Keep Alive
    (update)* on the same serial port; the flash page installs and restarts it.

## Before shipping

- Replace the USB VID/PID in `usb_config.h` and set `USB_FILTER` in
  `docs/link.js` to match.
- Consider enabling flash read protection when programming production units,
  and write-protecting the loader's sectors once it is proven.
- Keep the signing keys safe: the backup (`keepalive-backup.pem`) offline.
