// Talking to the Keep Alive's update loader over Web Serial (PROTOCOL.md,
// "Update loader"). The loader appears as the same serial port as the
// firmware, so no driver is needed on Windows, macOS or Linux.
//
// Firmware files (.kai) are a 128-byte signed header followed by the image
// (firmware/src/image.h). The page only passes them on: the loader checks the
// Ed25519 signature itself and refuses anything Eplop didn't sign.

export const IMG_MAGIC = 0x3149414b; // "KAI1"
export const HDR_SIZE = 128;
export const APP_MAX = 0xf700 - 0x4000;
const DATA_CHUNK = 128;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// Reads the header of a .kai file. Throws if it isn't one.
export function parseKai(bytes) {
  if (bytes.length < HDR_SIZE) throw new Error('The firmware file is too short.');
  const v = new DataView(bytes.buffer, bytes.byteOffset, HDR_SIZE);
  const u32 = (o) => v.getUint32(o, true);
  if (u32(0) !== IMG_MAGIC || u32(4) !== 1) throw new Error("That isn't a Keep Alive firmware file.");
  const length = u32(8);
  if (length !== bytes.length - HDR_SIZE || length > APP_MAX || length % 4) throw new Error('The firmware file is damaged (wrong length).');
  const version = new TextDecoder().decode(bytes.subarray(16, 32)).replace(/\0.*$/s, '');
  return { version, length, secLevel: u32(32), keyId: u32(36), header: bytes.subarray(0, HDR_SIZE), image: bytes.subarray(HDR_SIZE) };
}

export class LoaderError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// link: a Link (link.js) already open on the loader's port.
export class Loader {
  constructor(link) { this.link = link; }

  // Installs a .kai image. Only once the loader has checked the signature
  // does it count the new firmware as installed.
  async install(kai, onProgress) {
    const f = parseKai(kai);
    try {
      await this.link.cmd(`BEGIN ${hex(f.header)}`, 5000);
      for (let off = 0; off < f.length; off += DATA_CHUNK) {
        const chunk = f.image.subarray(off, off + DATA_CHUNK);
        await this.link.cmd(`DATA ${off} ${hex(chunk)}`, 3000);
        onProgress?.(Math.min(off + DATA_CHUNK, f.length), f.length);
      }
      onProgress?.(f.length, f.length, 'check');
      return await this.link.cmd('END', 20000);
    } catch (e) {
      if (e?.code === 6) throw new LoaderError('signature', e.message);
      if (e?.code === 3) throw new LoaderError('refused', e.message);
      throw e;
    }
  }

  async run() {
    try { await this.link.cmd('RUN', 1500); } catch { /* it may restart before the reply gets out */ }
  }
}
