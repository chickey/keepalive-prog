# Keep Alive firmware

Firmware for the CH32X035F8U6 on the Rev A board, built with
[ch32fun](https://github.com/cnlohr/ch32fun). It implements everything in
`../PROTOCOL.md` and the behaviour in `../HARDWARE.md`.

**Status: compiles cleanly and the protocol/scheduler logic passes its host
tests, but it has not run on hardware yet.** Work through the bring-up
checklist below on the first samples.

## What it does

At power-up it decides where it is plugged in:

- **Computer** (a USB host enumerates it within 1.5 s): appears as the serial
  port "Eplop Keep Alive", LED on, pulsing paused. The config page can start a
  trial (`RUN 1`) or fire a test pulse.
- **Power bank** (no host, or something already pulling D+/D− high): stays
  off the data lines, runs the active preset, and sleeps in standby between
  pulses. The LED blinks the preset number every 10 s.

In both modes the PRESET button steps through presets 1→2→3 (saved
immediately, LED blinks the number); a long press (1.5 s) just shows the
current preset.

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
| `prebuilt/` | Ready-to-flash `keepalive.bin` / `.hex` |

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
After a firmware change, copy `keepalive.bin` and `keepalive.hex` into
`prebuilt/` and commit them.

## Flashing

**USB bootloader (no adapter):** hold the BOOT button while plugging the
board into the Mac, then

```
wchisp flash prebuilt/keepalive.bin      # or: make isp
```

Once the firmware is running, `BOOT` from the config page (Advanced → Enter
update mode) does the same without the button.

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
11. **Bootloader.** `BOOT` → board re-appears as the WCH bootloader
    (4348:55E0).

## Before shipping

- Replace the USB VID/PID in `usb_config.h` and set `USB_FILTER` in
  `docs/link.js` to match.
- Consider enabling flash read protection when programming production units.
