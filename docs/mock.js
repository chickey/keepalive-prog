// Simulated Keep Alive implementing PROTOCOL.md, for the "Try demo" button.
// Behaves like a board connected to a PC: pulsing starts paused.

const LIMITS = { presets: 3, ma_max: 325, on_min: 10, on_max: 600000, off_max: 3600000, stream_min: 100, stream_max: 60000 };
const DEFAULTS = [
  { ma: 50, on: 500, off: 4500, en: 1 },
  { ma: 125, on: 500, off: 4500, en: 1 },
  { ma: 200, on: 500, off: 4500, en: 1 },
];

export class MockTransport {
  constructor() {
    this.onLine = null;
    this.onClose = null;
    this.closed = false;
    this.flash = { presets: DEFAULTS.map((p) => ({ ...p })), active: 1 };
    this.presets = this.flash.presets.map((p) => ({ ...p }));
    this.active = this.flash.active;
    this.led = 2;
    this.run = 0;
    this.runStart = 0;
    this.test = null;
    this.pulse = null;      // open pulse { t, set }
    this.lastT = 0;         // device time already processed
    this.meas = 0;
    this.set = 0;
    this.state = 'IDLE';
    this.vbus = 5060;
    this.stream = 0;
    this.lastStream = 0;
    this.t0 = performance.now();
  }

  async open() {
    await new Promise((r) => setTimeout(r, 250));
    this.timer = setInterval(() => this._tick(), 20);
  }

  write(text) {
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (l) setTimeout(() => this._handle(l), 10 + Math.random() * 25);
    }
  }

  async close() {
    clearInterval(this.timer);
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }

  _send(l) { if (!this.closed) this.onLine?.(l); }
  _now() { return Math.round(performance.now() - this.t0); }
  _fmt(n) { const p = this.presets[n - 1]; return `p=${n} ma=${p.ma} on=${p.on} off=${p.off} en=${p.en}`; }

  // Pulse edges are generated from the schedule at their exact device time,
  // even if the browser delays this timer (e.g. background tab), like a
  // hardware timer would.
  _tick() {
    const now = this._now();
    const from = this.lastT;
    this.lastT = now;

    if (this.test) {
      if (this.test.start > from && this.test.start <= now) this._edgeOn(this.test.start, this.test.ma);
      if (this.test.end <= now) {
        this._edgeOff(this.test.end);
        this._send(`!T done ma=${this.test.avg}`);
        this.runStart = this.test.end;
        this.test = null;
      }
    } else if (this.run) {
      const p = this.presets[this.active - 1];
      if (p.ma > 0 && p.off === 0) {
        if (!this.pulse) this._edgeOn(Math.max(this.runStart, from), p.ma);
      } else if (p.ma > 0) {
        const per = p.on + p.off;
        const k0 = Math.max(0, Math.floor((from - this.runStart) / per));
        const k1 = Math.floor((now - this.runStart) / per);
        for (let k = k0; k <= k1; k++) {
          const tOn = this.runStart + k * per, tOff = tOn + p.on;
          if (tOn > from && tOn <= now) this._edgeOn(tOn, p.ma);
          if (tOff > from && tOff <= now) this._edgeOff(tOff);
        }
      }
    }

    // Live reading for the status line.
    const on = !!this.pulse;
    this.set = on ? this.pulse.set : 0;
    this.meas = on ? Math.max(0, this.set - 0.6 + (Math.random() - 0.5) * 2) : Math.random() * 0.4;
    this.vbus = 5060 - this.meas * 0.45 + (Math.random() - 0.5) * 6;
    this.state = on ? 'ON' : (this.run && this.presets[this.active - 1].ma > 0 ? 'OFF' : 'IDLE');
    if (this.stream && now - this.lastStream >= this.stream) {
      this.lastStream = now;
      this._send(`!S ${this._status()}`);
    }
  }

  _edgeOn(t, set) {
    if (this.pulse) this._edgeOff(t);
    this.pulse = { t, set };
    if (this.stream) this._send(`!E on t=${t} set=${set}`);
  }

  _edgeOff(t) {
    if (!this.pulse) return;
    const p = this.pulse;
    this.pulse = null;
    // Average over the pulse: a few ms of rise, then regulated within ~1 mA.
    const avg = Math.round(p.set - 0.8 + (Math.random() - 0.5) * 1.2);
    if (this.test) this.test.avg = avg;
    if (this.stream) this._send(`!E off t=${t} ma=${avg} dur=${t - p.t}`);
  }

  // Schedule changed (edit, select, run, test): close any open pulse now and
  // restart the cycle from now.
  _restart() {
    const now = this._now();
    this._edgeOff(now);
    this.runStart = now;
    this.lastT = now - 1;
  }

  _status() {
    return `active=${this.active} run=${this.run} state=${this.state} vbus=${Math.round(this.vbus)} ma=${Math.round(this.meas || 0)} set=${this.set} t=${this._now()}`;
  }

  _check(k, v) {
    if (!Number.isInteger(v)) return false;
    if (k === 'ma') return v >= 0 && v <= LIMITS.ma_max;
    if (k === 'on') return v >= LIMITS.on_min && v <= LIMITS.on_max;
    if (k === 'off') return v >= 0 && v <= LIMITS.off_max;
    return false;
  }

  _handle(line) {
    const [cmd, ...rest] = line.split(/\s+/);
    const args = {};
    const bare = [];
    for (const t of rest) {
      const i = t.indexOf('=');
      if (i < 0) bare.push(t); else args[t.slice(0, i)] = /^-?\d+$/.test(t.slice(i + 1)) ? Number(t.slice(i + 1)) : NaN;
    }
    const n = bare.length ? Number(bare[0]) : null;
    const badPreset = () => !(Number.isInteger(n) && n >= 1 && n <= LIMITS.presets);

    switch (cmd.toUpperCase()) {
      case 'HELLO':
        return this._send('OK KA-PROG fw=1.0.3-demo proto=1 hw=A uid=DEMO0001');
      case 'LIMITS':
        return this._send(`OK presets=${LIMITS.presets} ma_max=${LIMITS.ma_max} on_min=${LIMITS.on_min} on_max=${LIMITS.on_max} off_max=${LIMITS.off_max} stream_min=${LIMITS.stream_min} stream_max=${LIMITS.stream_max}`);
      case 'GET':
        if (n === null) return this._send('OK ' + [1, 2, 3].map((i) => this._fmt(i)).join(' | '));
        if (badPreset()) return this._send('ERR 3 preset must be 1-3');
        return this._send('OK ' + this._fmt(n));
      case 'SET': {
        if (badPreset()) return this._send('ERR 3 preset must be 1-3');
        for (const [k, v] of Object.entries(args)) {
          if (!['ma', 'on', 'off', 'en'].includes(k)) return this._send(`ERR 2 unknown key ${k}`);
          if (k === 'en' ? v !== 0 && v !== 1 : !this._check(k, v)) return this._send(`ERR 3 ${k} out of range`);
        }
        if (args.en === 0 && n === this.active) return this._send('ERR 5 select another preset first');
        Object.assign(this.presets[n - 1], args);
        if (n === this.active) this._restart();
        return this._send('OK ' + this._fmt(n));
      }
      case 'SELECT':
        if (badPreset()) return this._send('ERR 3 preset must be 1-3');
        if (!this.presets[n - 1].en) return this._send('ERR 5 preset is disabled');
        this.active = n; this._restart();
        return this._send(`OK active=${n}`);
      case 'SAVE':
        this.flash = { presets: this.presets.map((p) => ({ ...p })), active: this.active };
        return setTimeout(() => this._send('OK saved'), 120);
      case 'DEFAULTS':
        this.presets = DEFAULTS.map((p) => ({ ...p }));
        return this._send('OK defaults');
      case 'OPTS':
        for (const [k, v] of Object.entries(args)) {
          if (k !== 'led') return this._send('ERR 2 unknown key');
          if (![0, 1, 2].includes(v)) return this._send('ERR 3 led must be 0, 1 or 2');
          this.led = v;
        }
        return this._send(`OK led=${this.led}`);
      case 'STATUS':
        return this._send('OK ' + this._status());
      case 'STREAM':
        if (!Number.isInteger(n) || (n !== 0 && (n < LIMITS.stream_min || n > LIMITS.stream_max))) return this._send('ERR 3 interval out of range');
        this.stream = n; this.lastStream = 0;
        return this._send(`OK stream=${n}`);
      case 'RUN':
        if (n !== 0 && n !== 1) return this._send('ERR 2 RUN 0 or RUN 1');
        this.run = n; this._restart();
        return this._send(`OK run=${n}`);
      case 'TEST':
        if (!this._check('ma', args.ma) || args.ma < 1) return this._send('ERR 3 ma out of range');
        if (!Number.isInteger(args.ms) || args.ms < 1 || args.ms > LIMITS.on_max) return this._send('ERR 3 ms out of range');
        this._restart();
        this.test = { ma: args.ma, start: this._now(), end: this._now() + args.ms, avg: 0 };
        return this._send('OK test');
      case 'BOOT':
        this._send('OK bootloader');
        return setTimeout(() => this.close(), 150);
      default:
        return this._send('ERR 1 unknown command');
    }
  }
}
