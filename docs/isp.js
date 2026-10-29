// WCH USB ISP bootloader protocol over WebUSB, for flashing the CH32X035.
//
// Written from the wire protocol as implemented by wchisp
// (https://github.com/ch32-rs/wchisp, src/protocol.rs, src/flashing.rs).
//
// Every request is   [cmd, len_lo, len_hi, payload...]
// and every reply is [cmd, status, len_lo, len_hi, payload...]
// sent as single bulk packets (max 64 bytes) on endpoint 2 OUT / 2 IN.

export const USB_FILTERS = [
  { vendorId: 0x4348, productId: 0x55e0 },
  { vendorId: 0x1a86, productId: 0x55e0 },
];

const CMD = {
  IDENTIFY: 0xa1, ISP_END: 0xa2, ISP_KEY: 0xa3, ERASE: 0xa4,
  PROGRAM: 0xa5, VERIFY: 0xa6, READ_CONFIG: 0xa7, WRITE_CONFIG: 0xa8,
};
const CFG_MASK_RDPR_USER_DATA_WPR = 0x07;
const CFG_MASK_ALL = 0x1f;

export const SECTOR = 1024;
const CHUNK = 56;               // 8-byte header + 56 data = one 64-byte packet
const MIN_ERASE_SECTORS = 8;

// CH32X03x family (wchisp devices/0x23-CH32X03x.yaml). Chip IDs are decimal there.
export const FAMILY_X03X = 0x23;
export const CHIPS_X03X = {
  80: 'CH32X035R8T6', 81: 'CH32X035C8T6', 94: 'CH32X035F8U6', 86: 'CH32X035G8U6',
  91: 'CH32X035G8R6', 87: 'CH32X035F7P6', 90: 'CH32X033F8P6',
};
export const TARGET_CHIP_ID = 94; // CH32X035F8U6

// Firmware must stop short of the settings page (0x0800F700, see firmware/src/store.c),
// and erase never reaches it either.
export const APP_LIMIT = 0xf700;
const MAX_ERASE_SECTORS = Math.floor(APP_LIMIT / SECTOR);

export class IspError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ---------- WebUSB transport ---------- */

export class UsbTransport {
  constructor(device) { this.device = device; this.closed = false; }

  // Uses a bootloader this site already has permission for if one is plugged in;
  // otherwise shows the browser's device chooser (NotFoundError if cancelled).
  static async request() {
    const known = (await navigator.usb.getDevices())
      .find((d) => USB_FILTERS.some((f) => f.vendorId === d.vendorId && f.productId === d.productId));
    const device = known || await navigator.usb.requestDevice({ filters: USB_FILTERS });
    return new UsbTransport(device);
  }

  get label() { return this.device.productName || 'WCH USB bootloader'; }

  async open() {
    const d = this.device;
    try {
      await d.open();
    } catch (e) {
      throw new IspError('open', e.message || String(e));
    }
    try {
      if (d.configuration === null) await d.selectConfiguration(1);
      await d.claimInterface(0);
    } catch (e) {
      try { await d.close(); } catch {}
      throw new IspError('claim', e.message || String(e));
    }
  }

  async send(bytes) {
    const r = await this.device.transferOut(2, bytes);
    if (r.status !== 'ok') throw new IspError('usb', `USB write ${r.status}`);
  }

  async recv(timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new IspError('timeout', 'The bootloader stopped answering.')), timeoutMs);
    });
    try {
      const r = await Promise.race([this.device.transferIn(2, 64), timeout]);
      if (r.status !== 'ok') throw new IspError('usb', `USB read ${r.status}`);
      return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    } finally {
      clearTimeout(timer);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.device.releaseInterface(0); } catch {}
    try { await this.device.close(); } catch {}
  }
}

/* ---------- protocol ---------- */

const sum8 = (bytes) => bytes.reduce((a, b) => (a + b) & 0xff, 0);
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function packet(cmd, payload) {
  const p = new Uint8Array(3 + payload.length);
  p[0] = cmd; p[1] = payload.length & 0xff; p[2] = payload.length >> 8;
  p.set(payload, 3);
  return p;
}

const u32le = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

export class Isp {
  constructor(transport, { onLog } = {}) {
    this.t = transport;
    this.onLog = onLog || (() => {});
    this.chip = null;   // { chipId, family, name }
    this.config = null; // { rdpr, wrpr, btver, uid }
    this.key = null;
    this.queue = Promise.resolve();
  }

  // One request/reply at a time, so a keep-alive ping can't interleave with flashing.
  transfer(cmd, payload, timeoutMs = 1000) {
    const run = () => this._transfer(cmd, payload, timeoutMs);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  // The bootloader gives up and starts the old firmware after a few seconds
  // without ISP traffic, so the page pings it while it waits for the user.
  ping() { return this.transfer(CMD.READ_CONFIG, [CFG_MASK_ALL, 0]); }

  async _transfer(cmd, payload, timeoutMs) {
    const req = packet(cmd, payload);
    this.onLog('>', hex(req.subarray(0, 3)) + ' ' + hex(req.subarray(3, 24)) + (req.length > 24 ? '…' : ''));
    await this.t.send(req);
    const res = await this.t.recv(timeoutMs);
    this.onLog('<', hex(res.subarray(0, 4)) + ' ' + hex(res.subarray(4, 24)) + (res.length > 24 ? '…' : ''));
    if (res.length < 4 || res[0] !== cmd) throw new IspError('protocol', 'Unexpected reply from the bootloader.');
    const len = res[2] | (res[3] << 8);
    const body = res.subarray(4);
    if (body.length !== len) throw new IspError('protocol', 'Malformed reply from the bootloader.');
    return body;
  }

  // Identify, read config and work out the XOR key. Throws if it isn't a CH32X03x.
  async identify() {
    const id = new Uint8Array(2 + 16);
    id.set(new TextEncoder().encode('MCU ISP & WCH.CN'), 2);
    const r = await this.transfer(CMD.IDENTIFY, id);
    const chipId = r[0], family = r[1];
    const name = family === FAMILY_X03X ? CHIPS_X03X[chipId] : null;
    this.chip = { chipId, family, name };
    if (family !== FAMILY_X03X) {
      throw new IspError('wrongchip', `This is not a CH32X035 (WCH device type 0x${family.toString(16)}, chip 0x${chipId.toString(16)}).`);
    }

    // CH32X03x only answers the full mask (wchisp dump_config notes this).
    const c = await this.transfer(CMD.READ_CONFIG, [CFG_MASK_ALL, 0]);
    if (c.length < 26) throw new IspError('protocol', 'The bootloader returned a short configuration block.');
    const uid = c.slice(18, 26);
    this.config = {
      raw: c.slice(2, 14),
      rdpr: c[2],
      wrpr: c.slice(10, 14),
      btver: `${c[14].toString(16)}${c[15].toString(16)}.${c[16].toString(16)}${c[17].toString(16)}`.replace(/^0(?=\d)/, ''),
      uid,
    };
    const w = (i) => uid[i] | (uid[i + 1] << 8);
    if (((w(0) + w(2) + w(4)) & 0xffff) !== w(6)) {
      throw new IspError('protocol', 'The chip ID read from the bootloader failed its checksum.');
    }
    // All-zero key seed: key = [sum(uid)] * 8, last byte += chip ID.
    const s = sum8(uid);
    this.key = new Uint8Array(8).fill(s);
    this.key[7] = (s + chipId) & 0xff;
    return this.chip;
  }

  get protectedFlash() {
    return this.config.rdpr !== 0xa5 || this.config.wrpr.some((b) => b !== 0xff);
  }

  get uidText() { return Array.from(this.config.uid, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join('-'); }

  // Clears read and write protection. The chip must be reset (replugged) afterwards.
  async unprotect() {
    const cfg = Uint8Array.from(this.config.raw);
    cfg[0] = 0xa5; cfg[1] = 0x5a;
    cfg.fill(0xff, 8, 12);
    await this.transfer(CMD.WRITE_CONFIG, [CFG_MASK_RDPR_USER_DATA_WPR, 0, ...cfg]);
    await this.end();
  }

  async sendKey() {
    const r = await this.transfer(CMD.ISP_KEY, new Uint8Array(0x1e));
    if (r[0] !== sum8(this.key)) throw new IspError('protocol', 'The bootloader rejected the session key.');
  }

  async erase(sectors) {
    const n = Math.min(Math.max(sectors, MIN_ERASE_SECTORS), MAX_ERASE_SECTORS);
    await this.transfer(CMD.ERASE, u32le(n), 5000);
    return n;
  }

  _chunkPacket(addr, data) {
    const p = new Uint8Array(5 + data.length);
    p.set(u32le(addr), 0);
    p[4] = crypto.getRandomValues(new Uint8Array(1))[0];
    for (let i = 0; i < data.length; i++) p[5 + i] = data[i] ^ this.key[i % 8];
    return p;
  }

  async program(image, onProgress) {
    await this.sendKey();
    for (let a = 0; a < image.length; a += CHUNK) {
      await this.transfer(CMD.PROGRAM, this._chunkPacket(a, image.subarray(a, a + CHUNK)), 2000);
      onProgress?.(Math.min(a + CHUNK, image.length), image.length);
    }
    // The bootloader needs a final empty write to commit the last block.
    await this.transfer(CMD.PROGRAM, this._chunkPacket(image.length, new Uint8Array(0)), 2000);
  }

  // Returns the address of the first mismatching chunk, or -1 if all match.
  async verify(image, onProgress) {
    await this.sendKey();
    for (let a = 0; a < image.length; a += CHUNK) {
      const r = await this.transfer(CMD.VERIFY, this._chunkPacket(a, image.subarray(a, a + CHUNK)), 2000);
      if (r[0] !== 0x00) return a;
      onProgress?.(Math.min(a + CHUNK, image.length), image.length);
    }
    return -1;
  }

  // Leaves the bootloader and starts the firmware. The device drops off USB, so the reply may never come.
  async end() {
    try { await this.transfer(CMD.ISP_END, [1], 500); } catch {}
  }
}

// Pads to a whole sector like wchisp does.
export function padImage(bin) {
  const len = Math.ceil(bin.length / SECTOR) * SECTOR;
  const out = new Uint8Array(len);
  out.set(bin);
  return out;
}

export const sectorsFor = (image) => image.length / SECTOR + 1;
