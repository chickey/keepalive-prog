// Transport + protocol layer for the Keep Alive (see PROTOCOL.md).
// A transport delivers text lines in both directions; Link turns that into
// command/reply calls plus an event stream.

export const PAGE_PROTO = 1;

// TODO: set once the USB IDs are allocated, e.g. { usbVendorId: 0x1209, usbProductId: 0x0001 }.
// While null, the browser's port picker lists every serial port.
export const USB_FILTER = null;

// The IDs the firmware currently uses (usb_config.h), for recognising a port
// this site already has permission for.
export const KA_USB_IDS = { usbVendorId: 0x1209, usbProductId: 0xd035 };

export class SerialTransport {
  // port: an already-permitted SerialPort; without one, open() shows the port picker.
  constructor(port = null) {
    this.port = port;
    this.onLine = null;
    this.onClose = null;
    this.closed = false;
  }

  async open() {
    const opts = USB_FILTER ? { filters: [USB_FILTER] } : {};
    this.port ||= await navigator.serial.requestPort(opts);
    await this.port.open({ baudRate: 115200 });
    this.writer = this.port.writable.getWriter();
    this._onDisconnect = (e) => { if (e.target === this.port) this.close(); };
    navigator.serial.addEventListener('disconnect', this._onDisconnect);
    this._readLoop();
  }

  async _readLoop() {
    const decoder = new TextDecoderStream();
    this.pipeDone = this.port.readable.pipeTo(decoder.writable).catch(() => {});
    this.reader = decoder.readable.getReader();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          this.onLine?.(line);
        }
      }
    } catch { /* port lost */ }
    finally { this._finish(); }
  }

  async write(text) {
    await this.writer.write(new TextEncoder().encode(text));
  }

  async close() {
    try { await this.reader?.cancel(); } catch {}
    try { await this.pipeDone; } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
    this._finish();
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    navigator.serial?.removeEventListener('disconnect', this._onDisconnect);
    this.onClose?.();
  }
}

export class DeviceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

class GarbledReply extends Error {}

// The protocol is printable ASCII. Firmware 1.0.1 sometimes delivers a line
// with four bytes zeroed, so control characters mean the line is damaged.
const GARBLED = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
// Commands that can safely be sent again if the reply was damaged.
const RETRYABLE = /^(HELLO|LIMITS|GET|SET|SELECT|STATUS|STREAM|RUN|SAVE|DEFAULTS|OPTS)\b/i;

export class Link {
  constructor(transport, { onEvent, onClose, onLog } = {}) {
    this.t = transport;
    this.onEvent = onEvent;
    this.onLog = onLog;
    this.pending = null;
    this.queue = Promise.resolve();
    transport.onLine = (l) => this._line(l);
    transport.onClose = () => {
      if (this.pending) { this.pending.reject(new Error('Disconnected')); this.pending = null; }
      onClose?.();
    };
  }

  _line(raw) {
    const line = raw.trim();
    if (!line) return;
    if (GARBLED.test(line)) {
      this.onLog?.('<', `(damaged line ignored) ${JSON.stringify(line)}`);
      // Can't tell an event from a reply any more; if a reply is due, ask again.
      const p = this.pending;
      if (p && !line.startsWith('!')) { this.pending = null; clearTimeout(p.timer); p.reject(new GarbledReply()); }
      return;
    }
    if (line.startsWith('!')) {
      if (!line.startsWith('!S ')) this.onLog?.('<', line);
      this.onEvent?.(line);
      return;
    }
    this.onLog?.('<', line);
    const p = this.pending;
    if (!p) return; // stray reply, ignore
    this.pending = null;
    clearTimeout(p.timer);
    if (line === 'OK' || line.startsWith('OK ')) p.resolve(line.slice(2).trim());
    else if (line.startsWith('ERR')) {
      const m = line.match(/^ERR\s+(\d+)\s*(.*)$/);
      p.reject(new DeviceError(m ? +m[1] : 0, m ? m[2] : line));
    } else p.reject(new Error(`Unexpected reply: ${line}`));
  }

  // One command in flight at a time; replies are matched in order.
  // A damaged reply is retried (twice) for commands that are safe to repeat.
  async cmd(text, timeout = 2000) {
    for (let tries = 0; ; tries++) {
      try {
        return await this._cmd(text, timeout);
      } catch (e) {
        if (!(e instanceof GarbledReply)) throw e;
        if (tries >= 2 || !RETRYABLE.test(text)) throw new Error(`Damaged reply to "${text}". Try again.`);
      }
    }
  }

  _cmd(text, timeout) {
    const run = () => new Promise((resolve, reject) => {
      const p = { resolve, reject };
      p.timer = setTimeout(() => {
        if (this.pending === p) this.pending = null;
        reject(new Error(`No reply to "${text}"`));
      }, timeout);
      this.pending = p;
      this.onLog?.('>', text);
      Promise.resolve(this.t.write(text + '\n')).catch((e) => {
        if (this.pending === p) { this.pending = null; clearTimeout(p.timer); reject(e); }
      });
    });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  close() { return this.t.close(); }
}

// "a=1 b=foo" -> { a: 1, b: 'foo' }; bare words go in ._ (array)
export function parseKV(text) {
  const out = { _: [] };
  for (const tok of text.trim().split(/\s+/)) {
    if (!tok) continue;
    const i = tok.indexOf('=');
    if (i < 0) { out._.push(tok); continue; }
    const k = tok.slice(0, i), v = tok.slice(i + 1);
    out[k] = /^-?\d+$/.test(v) ? Number(v) : v;
  }
  return out;
}
