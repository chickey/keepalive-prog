// Simulated Keep Alive for the flash page's demo: a running firmware that
// restarts into a simulated update loader on BOOT, and the loader itself.
//
// Scenarios (flash.html#demo-<name>):
//   ok      running 1.0.9-demo; update installs fine (default)
//   blank   loader only, no firmware yet (how boards ship)
//   badsig  the loader refuses the image as not signed by Eplop

export class MockSerialDevice {
  constructor(scenario = 'ok') {
    this.scenario = scenario;
    this.mode = scenario === 'blank' ? 'loader' : 'app';
    this.app = scenario === 'blank' ? null : '1.0.9-demo';
    this.rx = null;          // upload in progress
    this.port = null;
  }

  // A fresh transport each time the "port" is opened, like a real re-enumeration.
  transport() { return new MockSerialTransport(this); }
}

class MockSerialTransport {
  constructor(dev) { this.dev = dev; this.onLine = null; this.onClose = null; this.closed = false; }

  async open() {
    await new Promise((r) => setTimeout(r, 200));
    if (this.dev.offline) throw Object.assign(new Error('The port is restarting'), { name: 'NetworkError' });
  }

  write(text) {
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (l) setTimeout(() => this._handle(l), 2 + Math.random() * 6);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }

  _send(l) { if (!this.closed) this.onLine?.(l); }

  // Drops off "USB" for a moment, then comes back in the given mode.
  _restart(mode) {
    const d = this.dev;
    d.offline = true;
    setTimeout(() => this.close(), 30);
    setTimeout(() => { d.mode = mode; d.offline = false; }, 1200);
  }

  _handle(l) {
    const d = this.dev;
    const [cmd, ...args] = l.split(/\s+/);
    const C = cmd.toUpperCase();
    if (d.mode === 'app') {
      if (C === 'HELLO') this._send(`OK KA-PROG fw=${d.app} proto=1 hw=A uid=D3M0D3M0 boot=loader`);
      else if (C === 'BOOT') { this._send('OK bootloader'); this._restart('loader'); }
      else this._send('ERR 1 unknown command');
      return;
    }
    switch (C) {
      case 'HELLO':
        this._send(`OK KA-LOADER ldr=1.1.0 proto=1 chip=CH32X035F8U6 uid=D3M0D3M0 sn=000000000000000000000000 app=${d.app || 'none'} max=46848 keys=2`);
        break;
      case 'BEGIN': {
        const bytes = Uint8Array.from((args[0] || '').match(/../g) || [], (h) => parseInt(h, 16));
        try {
          const v = new DataView(bytes.buffer);
          if (bytes.length !== 128 || v.getUint32(0, true) !== 0x3149414b) throw 0;
          d.rx = { length: v.getUint32(8, true), version: new TextDecoder().decode(bytes.subarray(16, 32)).replace(/\0.*$/s, ''), got: 0 };
          d.app = null;
          this._send('OK');
        } catch { this._send('ERR 3 not a Keep Alive firmware image'); }
        break;
      }
      case 'DATA': {
        if (!d.rx) { this._send('ERR 5 no BEGIN'); break; }
        if (+args[0] !== d.rx.got) { this._send('ERR 5 expected offset'); break; }
        d.rx.got += (args[1] || '').length / 2;
        this._send(`OK ${d.rx.got}`);
        break;
      }
      case 'END':
        if (!d.rx || d.rx.got !== d.rx.length) { this._send('ERR 5 image incomplete'); break; }
        setTimeout(() => {
          if (d.scenario === 'badsig') this._send('ERR 6 not signed by Eplop');
          else { d.app = d.rx.version; this._send(`OK verified app=${d.app}`); }
          d.rx = null;
        }, 900);   // the real check takes about a second
        break;
      case 'RUN':
        if (!d.app) { this._send('ERR 7 no firmware installed'); break; }
        this._send('OK');
        this._restart('app');
        break;
      case 'ABORT': d.rx = null; this._send('OK'); break;
      default: this._send('ERR 1 unknown command');
    }
  }
}

