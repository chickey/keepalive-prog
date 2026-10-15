# USB Keep Alive – Programmable

Configurable USB power-bank keep-alive. A CH32X035 pulses a switched resistor
load so low-power devices don't let a power bank shut off. Pulse current,
on-time and off-time are set from a web page over Web Serial; three presets can
be stored and selected with the on-board button.

## Layout

| Folder | Contents |
|---|---|
| `docs/` | Web Serial config page, served by GitHub Pages from `/docs` |
| `HARDWARE.md` | Pin map, nets and the hardware decisions the firmware relies on |
| `PROTOCOL.md` | Command protocol between the config page and the device |
| `firmware/` | Device firmware; see `firmware/README.md` for building, flashing and the bring-up checklist |

## GitHub Pages

Settings → Pages → Deploy from a branch → `main` / `/docs`.
The page is plain HTML/CSS/JS with no build step, so what's in `docs/` is what
gets served. Web Serial needs HTTPS, which Pages provides.

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

| File | Purpose |
|---|---|
| `docs/index.html`, `style.css` | Page layout and styling |
| `docs/app.js` | UI logic |
| `docs/link.js` | Web Serial transport and protocol layer (`USB_FILTER` goes here once the USB IDs are set) |
| `docs/mock.js` | Simulated device for demo mode |

## Licence

Source-available for noncommercial use: firmware and config page under
PolyForm Noncommercial 1.0.0, documentation under CC BY-NC-SA 4.0. The Eplop
name and logo are not licensed. See [LICENSE.md](LICENSE.md).
