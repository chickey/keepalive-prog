# USB Keep Alive – Programmable

Configurable USB power-bank keep-alive. A CH32X035 pulses a switched resistor
load so low-power devices don't let a power bank shut off. Pulse current,
on-time and off-time are set from a web page over Web Serial; three presets can
be stored and selected with the on-board button.

## Layout

| Folder | Contents |
|---|---|
| `docs/` | Web Serial config page and firmware flasher, served by GitHub Pages from `/docs` |
| `HARDWARE.md` | Pin map, nets and the hardware decisions the firmware relies on |
| `PROTOCOL.md` | Command protocol between the config page and the device |
| `firmware/` | Device firmware; see `firmware/README.md` for building, flashing and the bring-up checklist |

## GitHub Pages

Settings → Pages → Deploy from a branch → `main` / `/docs`.
The page is plain HTML/CSS/JS with no build step, so what's in `docs/` is what
gets served. Web Serial needs HTTPS, which Pages provides.

## Firmware flasher

`docs/flash.html` (linked from the config page) installs firmware from the
browser. Needs Chrome, Edge or Opera on a desktop computer.

Since 1.1.0 every Keep Alive has an **update loader** at the start of flash
(see *Update loader* in `PROTOCOL.md`). It appears as the same USB serial port
as the firmware, so installing works over Web Serial with **no driver on
Windows, macOS or Linux**:

- **Install or update:** click **Connect** (the first time, pick *Eplop Keep
  Alive*), then **Install firmware**. A running Keep Alive is told to restart
  into update mode (`BOOT`) and the page reconnects by itself. Boards ship
  with only the loader, which stays in update mode until firmware is installed.
- **Recovery:** hold INPUT while plugging it in to stay in update mode.

The loader only accepts firmware signed with Eplop's key (Ed25519), checks it
before marking it installed, and keeps the saved presets.

**Advanced, WCH bootloader (BOOT button, WebUSB):** for boards with no loader
(factory-fresh chips, or firmware older than 1.1.0). It installs the loader
and the firmware together from `keepalive-full.bin`. Windows needs the WinUSB
driver for it ([Zadig](https://zadig.akeo.ie/)); Linux needs a udev rule; both
are on the page. Production boards get the loader on the factory rig instead
(`tools/rig`).

`docs/firmware/` holds `keepalive.kai` (the signed firmware),
`keepalive-full.bin` (loader + firmware for the WCH route) and
`manifest.json`. To publish a build:

```
cd firmware && make prebuilt && make site NOTE="…"
```

Signing needs the private key (`~/.eplop/keepalive-primary.pem` by default,
`KEY=` to change); see `tools/kasign.py`. The WebUSB code (`docs/isp.js`)
follows [wchisp](https://github.com/ch32-rs/wchisp).

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
| `docs/loader-link.js`, `loader-mock.js` | Update loader protocol over Web Serial, and its demo |
| `docs/firmware/` | Firmware the flasher installs, plus `manifest.json` |
| `tools/kasign.py` | Signing keys, signing, factory images |
| `tools/rig/` | Raspberry Pi factory rig: puts the loader on boards, many at once |

## Licence

Source-available for noncommercial use: firmware and config page under
PolyForm Noncommercial 1.0.0, documentation under CC BY-NC-SA 4.0. The Eplop
name and logo are not licensed. See [LICENSE.md](LICENSE.md).
