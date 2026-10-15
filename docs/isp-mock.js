// Simulated WCH USB bootloader (CH32X035F8U6) for flash.html#demo.
// Same interface as UsbTransport in isp.js; it decodes the packets itself, so
// the demo exercises the real protocol code, not a shortcut.
//
// Scenarios, chosen with the URL hash:
//   #demo            normal board
//   #demo-protected  flash read-protected; needs unprotect and a replug
//   #demo-otherchip  a different WCH chip in bootloader mode
//   #demo-nodriver   the device can't be opened (Windows with WCH's driver)
//   #demo-badverify  one byte reads back wrong

import { IspError } from './isp.js';

const FLASH_SIZE = 62 * 1024;
const devices = {}; // one simulated board per scenario, so it survives a "replug"

function makeBoard(scenario) {
  const uid = crypto.getRandomValues(new Uint8Array(8));
  const w = (i) => uid[i] | (uid[i + 1] << 8);
  const ck = (w(0) + w(2) + w(4)) & 0xffff;
  uid[6] = ck & 0xff; uid[7] = ck >> 8;
  const flash = new Uint8Array(FLASH_SIZE).fill(0xff);
  crypto.getRandomValues(flash.subarray(0, 12 * 1024)); // "old firmware"
  return {
    scenario,
    chipId: scenario === 'otherchip' ? 0x31 : 94,
    family: scenario === 'otherchip' ? 0x21 : 0x23,
    uid,
    // RDPR nRDPR USER nUSER | DATA0 nDATA0 DATA1 nDATA1 | WRPR0..3
    cfg: Uint8Array.from([scenario === 'protected' ? 0x00 : 0xa5, 0x5a, 0x1f, 0xe0, 0xff, 0x00, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff]),
    flash,
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class MockUsbTransport {
  constructor(scenario = 'ok') {
    this.board = devices[scenario] ||= makeBoard(scenario);
    this.queue = [];
    this.waiters = [];
    this.gone = false;
    this.closed = false;
  }

  static async request(scenario) {
    await wait(300); // the chooser
    return new MockUsbTransport(scenario);
  }

  get label() { return 'USB Module (simulated)'; }

  async open() {
    await wait(150);
    if (this.board.scenario === 'nodriver') {
      throw new IspError('open', 'Access denied.');
    }
  }

  async send(req) {
    if (this.gone || this.closed) throw new IspError('usb', 'The device was disconnected.');
    const res = await this._handle(Uint8Array.from(req));
    if (res) this._push(res);
  }

  recv(timeoutMs) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== waiter);
        reject(new IspError('timeout', 'The bootloader stopped answering.'));
      }, timeoutMs);
      const waiter = (pkt) => { clearTimeout(t); resolve(pkt); };
      this.waiters.push(waiter);
    });
  }

  async close() { this.closed = true; }

  _push(pkt) {
    const w = this.waiters.shift();
    if (w) w(pkt); else this.queue.push(pkt);
  }

  _key() {
    const s = this.board.uid.reduce((a, b) => (a + b) & 0xff, 0);
    const k = new Uint8Array(8).fill(s);
    k[7] = (s + this.board.chipId) & 0xff;
    return k;
  }

  _locked() { return this.board.cfg[0] !== 0xa5; }

  async _handle(req) {
    const b = this.board;
    const cmd = req[0];
    const len = req[1] | (req[2] << 8);
    const p = req.subarray(3, 3 + len);
    const reply = (...payload) => {
      const out = new Uint8Array(4 + payload.length);
      out[0] = cmd; out[2] = payload.length;
      out.set(payload, 4);
      return out;
    };
    const addrOf = () => (p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)) >>> 0;
    const decode = () => { const k = this._key(); return p.subarray(5).map((x, i) => x ^ k[i % 8]); };

    switch (cmd) {
      case 0xa1: // identify
        await wait(20);
        return reply(b.chipId, b.family);
      case 0xa7: // read config
        await wait(20);
        return reply(p[0], 0, ...b.cfg, 0x00, 0x02, 0x09, 0x00, ...b.uid);
      case 0xa8: // write config
        await wait(60);
        b.cfg.set(p.subarray(2, 14));
        if (!this._locked()) b.flash.fill(0xff); // clearing read protection wipes the chip
        return reply(0, 0);
      case 0xa3: // key
        await wait(10);
        return reply(this._key().reduce((a, x) => (a + x) & 0xff, 0), 0);
      case 0xa4: { // erase
        const n = p[0] | (p[1] << 8);
        await wait(250 + n * 25);
        if (this._locked()) return reply(0xfe, 0);
        b.flash.fill(0xff, 0, Math.min(n * 1024, FLASH_SIZE));
        return reply(0, 0);
      }
      case 0xa5: { // program
        await wait(6);
        if (this._locked()) return reply(0xfe, 0);
        const a = addrOf();
        decode().forEach((x, i) => { if (a + i < FLASH_SIZE) b.flash[a + i] &= x; });
        return reply(0, 0);
      }
      case 0xa6: { // verify
        await wait(3);
        const a = addrOf();
        const d = decode();
        let ok = d.every((x, i) => b.flash[a + i] === x);
        if (b.scenario === 'badverify' && a <= 0x1234 && a + d.length > 0x1234) ok = false;
        return reply(ok ? 0 : 0xf5, 0);
      }
      case 0xa2: // end: the board resets and drops off USB without answering
        this.gone = true;
        return null;
      default:
        await wait(5);
        return reply(0xfe, 0);
    }
  }
}
