# USB Keep Alive – Programmable

Configurable USB power-bank keep-alive. A CH32X035 pulses a switched resistor
load so low-power devices don't let a power bank shut off. Pulse current,
on-time and off-time are set from a web page over Web Serial; three presets can
be stored and selected with the on-board button.

## Layout

| Folder | Contents |
|---|---|
| `docs/` | Web Serial config page and WebUSB firmware flasher, served by GitHub Pages from `/docs` |
| `HARDWARE.md` | Pin map, nets and the hardware decisions the firmware relies on |
| `PROTOCOL.md` | Command protocol between the config page and the device |
| `firmware/` | Device firmware; see `firmware/README.md` for building, flashing and the bring-up checklist |

## GitHub Pages

Settings → Pages → Deploy from a branch → `main` / `/docs`.
The page is plain HTML/CSS/JS with no build step, so what's in `docs/` is what
gets served. Web Serial needs HTTPS, which Pages provides.

## Firmware flasher

`docs/flash.html` (linked from the config page) installs firmware from the
browser over WebUSB, using the CH32X035's built-in USB bootloader. Needs
Chrome, Edge or Opera on a desktop computer.

- **Updating a working Keep Alive:** plug it in normally and click **Restart
  into update mode**. The page sends `BOOT` over Web Serial (the first time,
  Chrome asks for the serial port), opens the WebUSB device list, and the
  bootloader appears in it a moment later.
- **First install, or broken firmware:** open the device list with
  **Connect**, then hold the BOOT button while plugging the Keep Alive in.

Either way the bootloader shows up as USB ID `1A86:55E0` or `4348:55E0`
(Chrome: "unknown device from QinHeng Electronics"). Pick it straight away:
it starts the normal firmware again about 5 seconds after appearing if
nothing talks to it. Once connected, the page shows the chip and pings the
bootloader so it stays in update mode; nothing is written until **Install
firmware** is clicked. It checks the chip is a CH32X035F8U6, erases, writes,
verifies and restarts it.

- **Windows:** WebUSB can't open the device while WCH's own driver owns it.
  Install the WinUSB driver for the bootloader (`1A86:55E0` or `4348:55E0`) with [Zadig](https://zadig.akeo.ie/)
  once; the page's *Trouble connecting* section walks through it.
- **Linux:** needs a udev rule (shown on the page).
- **macOS:** works as is.

It flashes `docs/firmware/keepalive.bin`, described by
`docs/firmware/manifest.json` (version, size, SHA-256). To publish a new build,
copy `firmware/prebuilt/keepalive.bin` there and update the manifest:

```
cd firmware && make site
```

The protocol code (`docs/isp.js`) follows
[wchisp](https://github.com/ch32-rs/wchisp). It has been used on the first
Rev A board from macOS; Windows and Linux are untested.

## Trying the page locally

The page uses ES modules, so open it through a local web server rather than
double-clicking the file:

```
cd docs
python3 -m http.server 8000
```

Then open <http://localhost:8000> in Chrome. **Try demo** (or
<http://localhost:8000/#demo>) runs a simulated Keep Alive that speaks the same
protocol, so the page can be used before any hardware exists.

The flasher has the same: <http://localhost:8000/flash.html#demo>, or **Try
demo**. Other simulated cases: `#demo-protected` (locked chip),
`#demo-otherchip`, `#demo-nodriver` (device can't be opened, as on Windows
without WinUSB) and `#demo-badverify`.

| File | Purpose |
|---|---|
| `docs/index.html`, `style.css` | Page layout and styling |
| `docs/app.js` | UI logic |
| `docs/link.js` | Web Serial transport and protocol layer (`USB_FILTER` goes here once the USB IDs are set) |
| `docs/mock.js` | Simulated device for demo mode |
| `docs/theme.js` | Light/dark toggle shared by both pages |
| `docs/flash.html`, `flash.js` | Firmware flasher page and UI logic |
| `docs/isp.js` | WCH USB ISP bootloader protocol over WebUSB |
| `docs/isp-mock.js` | Simulated bootloader for the flasher's demo mode |
| `docs/firmware/` | Firmware the flasher installs, plus `manifest.json` |

## Licence

Source-available for noncommercial use: firmware and config page under
PolyForm Noncommercial 1.0.0, documentation under CC BY-NC-SA 4.0. The Eplop
name and logo are not licensed. See [LICENSE.md](LICENSE.md).
