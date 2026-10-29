import { Link, SerialTransport, DeviceError, PAGE_PROTO, parseKV } from './link.js';
import { MockTransport } from './mock.js';
import { initTheme } from './theme.js';

const $ = (id) => document.getElementById(id);
const el = {
  connState: $('connState'), btnConnect: $('btnConnect'), btnDemo: $('btnDemo'), btnDisconnect: $('btnDisconnect'),
  unsupported: $('unsupported'), intro: $('intro'), device: $('device'),
  devInfo: $('devInfo'), dirty: $('dirty'), btnSave: $('btnSave'), btnDefaults: $('btnDefaults'),
  fault: $('fault'), btnRun: $('btnRun'),
  rMa: $('rMa'), rSet: $('rSet'), rVbus: $('rVbus'), rState: $('rState'),
  chart: $('chart'), testForm: $('testForm'), testMa: $('testMa'), testS: $('testS'),
  presets: $('presets'), lightOpts: $('lightOpts'), tpl: $('presetTpl'), lastPulse: $('lastPulse'), log: $('log'), toast: $('toast'),
};

const STATE_TEXT = { ON: 'Drawing', OFF: 'Between pulses', IDLE: 'Paused', FAULT: 'Fault' };

let link = null;
let demo = false;
let limits = null;
let presets = [];      // [{ma,on,off,en}] as last confirmed by the device
let hasEnable = false; // firmware supports en= (enable/disable presets)
let active = 1;
let running = 0;
let dirty = false;
let pulses = [];       // [{on, off, set, ma}] in device ms; off/ma null while open
let live = { ma: 0, state: 'IDLE' };
let clock = { dev: 0, at: 0 }; // last device time seen and when (performance.now)
let rafId = 0;
const cards = [];

/* ---------- helpers ---------- */

function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function log(dir, line) {
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  el.log.textContent += `${ts} ${dir} ${line}\n`;
  const lines = el.log.textContent.split('\n');
  if (lines.length > 300) el.log.textContent = lines.slice(-300).join('\n');
  el.log.scrollTop = el.log.scrollHeight;
}

function setConn(state, text) {
  el.connState.dataset.state = state;
  el.connState.textContent = text;
}

function setDirty(v) {
  dirty = v;
  el.dirty.hidden = !v;
  el.btnSave.disabled = !v;
}

const sec = (ms) => +(ms / 1000).toFixed(2);
const toMs = (s) => Math.round(Number(s) * 1000);
function fmtSec(ms) {
  if (ms >= 60000) { const m = ms / 60000; return `${+m.toFixed(1)} min`; }
  return `${+(ms / 1000).toFixed(2)} s`;
}

/* ---------- connection ---------- */

async function connect(useDemo) {
  if (link) return;
  demo = useDemo;
  const transport = useDemo ? new MockTransport() : new SerialTransport();
  setConn('busy', 'Connecting…');
  try {
    await transport.open();
  } catch (e) {
    setConn('off', 'Not connected');
    if (e?.name !== 'NotFoundError') toast(`Couldn't open the port: ${e.message}`, 5000);
    return;
  }
  link = new Link(transport, { onEvent, onClose: onClosed, onLog: log });
  try {
    const hello = parseKV(await link.cmd('HELLO'));
    if (hello._[0] !== 'KA-PROG') throw new Error('That port is not a Keep Alive.');
    if (hello.proto > PAGE_PROTO) throw new Error('This Keep Alive has newer firmware than this page understands. Reload the page and try again.');
    limits = parseKV(await link.cmd('LIMITS'));
    presets = [];
    for (let n = 1; n <= limits.presets; n++) {
      const p = parseKV(await link.cmd(`GET ${n}`));
      if (n === 1) hasEnable = 'en' in p;
      presets.push(toPreset(p));
    }
    await loadOpts();
    const st = parseKV(await link.cmd('STATUS'));
    active = st.active;
    running = st.run;
    await link.cmd(`STREAM ${Math.max(250, limits.stream_min ?? 100)}`);

    el.devInfo.textContent = `${demo ? 'Demo device' : 'Keep Alive'} · firmware ${hello.fw} · hw ${hello.hw} · id ${hello.uid}`;
    buildCards();
    renderAll();
    setDirty(false);
    pulses = [];
    clock = { dev: st.t || 0, at: performance.now() };
    el.lastPulse.textContent = '';
    startChart();
    el.intro.hidden = true;
    el.device.hidden = false;
    el.btnConnect.hidden = true;
    el.btnDemo.hidden = true;
    el.btnDisconnect.hidden = false;
    setConn('on', demo ? 'Demo connected' : 'Connected');
    applyStatus(st);
  } catch (e) {
    toast(e.message, 6000);
    await link?.close();
  }
}

function onClosed() {
  link = null;
  cancelAnimationFrame(rafId);
  setConn('off', 'Not connected');
  el.device.hidden = true;
  el.intro.hidden = false;
  el.btnConnect.hidden = false;
  el.btnDemo.hidden = false;
  el.btnDisconnect.hidden = true;
  el.fault.hidden = true;
  setDirty(false);
}

async function disconnect() {
  if (!link) return;
  if (dirty && !confirmLeave()) return;
  try { await link.cmd('STREAM 0', 800); } catch {}
  await link.close();
}

function confirmLeave() {
  // In-page confirmation: second click within 4 s goes ahead.
  if (disconnect.armed && Date.now() - disconnect.armed < 4000) { disconnect.armed = 0; return true; }
  disconnect.armed = Date.now();
  toast('You have unsaved changes. Click Disconnect again to discard them.', 4000);
  return false;
}

/* ---------- events from device ---------- */

function onEvent(line) {
  const kind = line.slice(0, 2);
  const kv = parseKV(line.slice(2));
  if (kind === '!S') applyStatus(kv);
  else if (kind === '!E') applyEdge(kv);
  else if (kind === '!P') { active = kv.active; renderActive(); toast(`Preset ${active} selected on the device`); }
  else if (kind === '!T') toast(`Test pulse done: ${kv.ma} mA measured`);
  else if (kind === '!F') {
    if (kv._[0] === 'CLEAR') { el.fault.hidden = true; return; }
    const why = { OVERVOLT: 'Bus voltage too high (fast-charge raised it above 6 V). Load is off.',
      UNDERVOLT: 'Bus voltage too low. Load is off.',
      OVERCURRENT: 'Load current above limit. Load is off.',
      NOREG: "Couldn't reach the target current." }[kv._[0]] || kv._[0];
    el.fault.textContent = `Fault: ${why}` + (kv.vbus ? ` (${(kv.vbus / 1000).toFixed(2)} V)` : '');
    el.fault.hidden = false;
  }
}

function applyStatus(s) {
  if (s.active && s.active !== active) { active = s.active; renderActive(); }
  if (s.run !== undefined && s.run !== running) { running = s.run; renderRun(); }
  el.rMa.textContent = s.ma ?? '–';
  el.rSet.textContent = s.set ?? '–';
  el.rVbus.textContent = s.vbus !== undefined ? (s.vbus / 1000).toFixed(2) : '–';
  el.rState.textContent = STATE_TEXT[s.state] || s.state || '–';
  el.rState.dataset.s = s.state || '';
  live = { ma: s.ma || 0, state: s.state };
  if (s.t !== undefined) seeTime(s.t);
}

// Device time drives the chart, so USB and browser timing jitter don't show.
function seeTime(t) {
  if (t + 60000 < clock.dev) pulses = []; // device restarted (or ms counter wrapped)
  clock = { dev: t, at: performance.now() };
}

function devNow() {
  return clock.dev + Math.min(performance.now() - clock.at, 2000);
}

function applyEdge(e) {
  seeTime(e.t);
  const open = pulses.length && pulses[pulses.length - 1].off === null ? pulses[pulses.length - 1] : null;
  if (e._[0] === 'on') {
    if (open) open.off = e.t;
    pulses.push({ on: e.t, off: null, set: e.set, ma: null });
  } else if (e._[0] === 'off' && open) {
    open.off = e.t;
    open.ma = e.ma;
    el.lastPulse.textContent = `Last pulse ${e.ma} mA for ${fmtSec(e.dur ?? e.t - open.on)}`;
  }
  const cutoff = e.t - 35000;
  while (pulses.length && pulses[0].off !== null && pulses[0].off < cutoff) pulses.shift();
}

/* ---------- presets ---------- */

// Firmware before en= has every preset enabled.
const toPreset = (p) => ({ ma: p.ma, on: p.on, off: p.off, en: p.en ?? 1 });

function buildCards() {
  el.presets.textContent = '';
  cards.length = 0;
  for (let i = 0; i < limits.presets; i++) {
    const node = el.tpl.content.firstElementChild.cloneNode(true);
    const c = {
      root: node,
      pn: node.querySelector('.pn'), badge: node.querySelector('.badge'), use: node.querySelector('.use'),
      range: node.querySelector('.ma-range'), ma: node.querySelector('.ma'),
      on: node.querySelector('.on'), off: node.querySelector('.off'), cont: node.querySelector('.cont'),
      summary: node.querySelector('.summary'), err: node.querySelector('.ferr'),
      en: node.querySelector('.en'), enWrap: node.querySelector('.en-wrap'),
    };
    const n = i + 1;
    c.pn.textContent = n;
    const id = (k) => `p${n}-${k}`;
    for (const [k, inp] of [['ma', c.ma], ['on', c.on], ['off', c.off], ['cont', c.cont], ['range', c.range], ['en', c.en]]) inp.id = id(k);
    c.enWrap.hidden = !hasEnable;
    const lbls = node.querySelectorAll('.flabel');
    lbls[0].htmlFor = id('ma'); lbls[1].htmlFor = id('on'); lbls[2].htmlFor = id('off');
    c.range.setAttribute('aria-label', `Preset ${n} pulse current`);
    c.range.max = limits.ma_max;
    c.ma.max = limits.ma_max;
    c.on.min = sec(limits.on_min); c.on.max = sec(limits.on_max);
    c.off.max = sec(limits.off_max);

    c.range.addEventListener('input', () => { c.ma.value = c.range.value; edited(n); });
    c.ma.addEventListener('input', () => { c.range.value = c.ma.value; edited(n); });
    c.on.addEventListener('input', () => edited(n));
    c.off.addEventListener('input', () => edited(n));
    c.cont.addEventListener('change', () => { c.off.disabled = c.cont.checked; edited(n); });
    c.use.addEventListener('click', () => select(n));
    c.en.addEventListener('change', () => setEnabled(n, c.en.checked));
    cards.push(c);
    el.presets.append(node);
  }
}

function readCard(n) {
  const c = cards[n - 1];
  const ma = Number(c.ma.value), on = toMs(c.on.value);
  const off = c.cont.checked ? 0 : toMs(c.off.value);
  const errs = [];
  if (!Number.isInteger(ma) || ma < 0 || ma > limits.ma_max) errs.push(['ma', `Current must be 0–${limits.ma_max} mA.`]);
  if (!(on >= limits.on_min && on <= limits.on_max)) errs.push(['on', `On time must be ${fmtSec(limits.on_min)} to ${fmtSec(limits.on_max)}.`]);
  if (!c.cont.checked && !(off >= limits.on_min && off <= limits.off_max)) errs.push(['off', `Off time must be ${fmtSec(limits.on_min)} to ${fmtSec(limits.off_max)}.`]);
  return { val: { ma, on, off }, errs };
}

function renderCard(n, p = presets[n - 1]) {
  const c = cards[n - 1];
  c.root.classList.toggle('disabled', !p.en);
  c.en.checked = !!p.en;
  for (const inp of [c.ma, c.range, c.on, c.cont]) inp.disabled = !p.en;
  c.ma.value = p.ma; c.range.value = p.ma;
  c.on.value = sec(p.on);
  c.cont.checked = p.off === 0;
  c.off.disabled = !p.en || p.off === 0;
  c.off.value = p.off === 0 ? '' : sec(p.off);
  renderSummary(n, p);
}

function renderSummary(n, p) {
  const c = cards[n - 1];
  if (p.en === 0) { c.summary.innerHTML = '<b>Disabled</b> · the button skips this preset'; return; }
  if (p.ma === 0) { c.summary.innerHTML = 'No load (<b>0 mA</b>)'; return; }
  if (p.off === 0) { c.summary.innerHTML = `Continuous <b>${p.ma} mA</b>`; return; }
  const period = p.on + p.off;
  const duty = (p.on / period) * 100;
  const avg = (p.ma * p.on) / period;
  c.summary.innerHTML = `Every <b>${fmtSec(period)}</b> · ${duty < 10 ? duty.toFixed(1) : Math.round(duty)}% duty · average <b>${avg < 10 ? avg.toFixed(1) : Math.round(avg)} mA</b>`;
}

function renderActive() {
  cards.forEach((c, i) => {
    const on = i + 1 === active;
    c.root.classList.toggle('active', on);
    c.badge.hidden = !on;
    c.use.hidden = on || !presets[i]?.en;
    // The active preset can't be disabled, so at least one always stays enabled.
    c.en.disabled = on;
    c.enWrap.title = on ? 'This is the active preset. Use another preset before disabling this one.' : '';
  });
  const p = presets[active - 1];
  if (p && p.ma > 0) el.testMa.value = p.ma;
}

function renderRun() {
  el.btnRun.textContent = running ? 'Stop trial' : 'Start trial';
  el.btnRun.classList.toggle('primary', !!running);
}

function renderAll() {
  for (let n = 1; n <= cards.length; n++) renderCard(n);
  renderActive();
  renderRun();
  el.testMa.max = limits.ma_max;
}

// Debounced SET per preset; the device's reply is the source of truth.
const pendingSet = {};
function edited(n) {
  const c = cards[n - 1];
  const { val, errs } = readCard(n);
  for (const k of ['ma', 'on', 'off']) c[k].setAttribute('aria-invalid', errs.some(([f]) => f === k));
  c.err.hidden = !errs.length;
  c.err.textContent = errs.map(([, m]) => m).join(' ');
  if (errs.length) return;
  renderSummary(n, { ...val, en: presets[n - 1].en });
  clearTimeout(pendingSet[n]);
  pendingSet[n] = setTimeout(() => pushSet(n, val), 300);
}

async function pushSet(n, val) {
  try {
    const r = parseKV(await link.cmd(`SET ${n} ma=${val.ma} on=${val.on} off=${val.off}`));
    presets[n - 1] = toPreset(r);
    setDirty(true);
    if (n === active && r.ma > 0) el.testMa.value = r.ma;
  } catch (e) {
    const c = cards[n - 1];
    c.err.hidden = false;
    c.err.textContent = e instanceof DeviceError ? `The device rejected this: ${e.message}` : e.message;
  }
}

async function setEnabled(n, on) {
  const c = cards[n - 1];
  try {
    const r = parseKV(await link.cmd(`SET ${n} en=${on ? 1 : 0}`));
    presets[n - 1] = toPreset(r);
    c.err.hidden = true;
    setDirty(true);
  } catch (e) {
    c.err.hidden = false;
    c.err.textContent = e instanceof DeviceError ? `The device rejected this: ${e.message}` : e.message;
  }
  renderCard(n);
  renderActive();
}

// Device options (firmware 1.0.3+; older firmware answers OPTS with ERR 1).
const ledRadios = () => [...el.lightOpts.querySelectorAll('input[name="led"]')];
let ledMode = 2;
function renderLed() { for (const r of ledRadios()) r.checked = Number(r.value) === ledMode; }

async function loadOpts() {
  try {
    const o = parseKV(await link.cmd('OPTS'));
    ledMode = o.led ?? 2;
    renderLed();
    el.lightOpts.hidden = false;
  } catch (e) {
    if (!(e instanceof DeviceError)) throw e;
    el.lightOpts.hidden = true;
  }
}

async function setLed(mode) {
  try {
    const o = parseKV(await link.cmd(`OPTS led=${mode}`));
    ledMode = o.led;
    setDirty(true);
  } catch (e) {
    toast(e.message);
  }
  renderLed();
}

async function select(n) {
  try {
    const r = parseKV(await link.cmd(`SELECT ${n}`));
    active = r.active;
    renderActive();
    setDirty(true);
  } catch (e) { toast(e.message); }
}

async function save() {
  el.btnSave.disabled = true;
  // Make sure any debounced edits reach the device first.
  for (const n of Object.keys(pendingSet)) {
    clearTimeout(pendingSet[n]);
    const { val, errs } = readCard(+n);
    if (!errs.length) await pushSet(+n, val);
    delete pendingSet[n];
  }
  try {
    await link.cmd('SAVE', 4000);
    setDirty(false);
    toast('Saved to the Keep Alive');
  } catch (e) {
    el.btnSave.disabled = false;
    toast(`Save failed: ${e.message}`, 5000);
  }
}

async function restoreDefaults() {
  try {
    await link.cmd('DEFAULTS');
    for (let n = 1; n <= cards.length; n++) {
      const p = parseKV(await link.cmd(`GET ${n}`));
      presets[n - 1] = toPreset(p);
      renderCard(n);
      cards[n - 1].err.hidden = true;
    }
    renderActive();
    setDirty(true);
    toast('Factory presets restored. Click Save to keep them.');
  } catch (e) { toast(e.message); }
}

async function toggleRun() {
  try {
    const r = parseKV(await link.cmd(`RUN ${running ? 0 : 1}`));
    running = r.run;
    renderRun();
  } catch (e) { toast(e.message); }
}

async function testPulse(ev) {
  ev.preventDefault();
  const ma = Math.round(Number(el.testMa.value));
  const ms = toMs(el.testS.value);
  if (!(ma >= 1 && ma <= limits.ma_max)) return toast(`Test current must be 1–${limits.ma_max} mA.`);
  if (!(ms >= 1 && ms <= limits.on_max)) return toast(`Test length must be up to ${fmtSec(limits.on_max)}.`);
  try { await link.cmd(`TEST ma=${ma} ms=${ms}`); } catch (e) { toast(e.message); }
}

/* ---------- chart ---------- */

function startChart() {
  cancelAnimationFrame(rafId);
  let last = 0;
  const frame = (ts) => {
    if (ts - last > 40) { last = ts; drawChart(); }
    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);
}

function drawChart() {
  if (el.device.hidden) return;
  const cv = el.chart;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const cMa = css.getPropertyValue('--chart-ma').trim();
  const cSet = css.getPropertyValue('--chart-set').trim();
  const cGrid = css.getPropertyValue('--line').trim();
  const cText = css.getPropertyValue('--muted').trim();

  const now = devNow();
  const t0 = now - 30000;
  const vis = pulses.filter((p) => (p.off === null ? now : p.off) >= t0);
  const liveMa = live.state === 'ON' ? live.ma : null;
  const peak = Math.max(50, ...vis.map((p) => Math.max(p.set, p.ma ?? liveMa ?? 0)));
  const step = peak > 200 ? 100 : peak > 100 ? 50 : 25;
  const top = Math.ceil((peak * 1.1) / step) * step;
  const padL = 36, padR = 8, padT = 10, padB = 10;
  const x = (t) => padL + ((t - t0) / 30000) * (w - padL - padR);
  const y = (v) => padT + (1 - v / top) * (h - padT - padB);

  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.fillStyle = cText;
  ctx.strokeStyle = cGrid;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = 0; v <= top; v += step) {
    const yy = Math.round(y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
    ctx.fillText(v, padL - 6, yy);
  }

  // Square waveform: 0 between pulses, a level for each pulse.
  const wave = (level, color, width, dash) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, 0, w - padL - padR, h);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x(t0), y(0));
    for (const p of vis) {
      const v = level(p);
      const end = p.off === null ? now : p.off;
      ctx.lineTo(x(p.on), y(0));
      ctx.lineTo(x(p.on), y(v));
      ctx.lineTo(x(end), y(v));
      if (p.off !== null) ctx.lineTo(x(end), y(0));
    }
    const lastOpen = vis.length && vis[vis.length - 1].off === null;
    if (!lastOpen) ctx.lineTo(x(now), y(0));
    ctx.stroke();
    ctx.restore();
  };
  wave((p) => p.set, cSet, 1.5, [4, 4]);
  wave((p) => p.ma ?? liveMa ?? p.set, cMa, 2, []);

  const lastP = vis[vis.length - 1];
  const endV = lastP && lastP.off === null ? (liveMa ?? lastP.set) : 0;
  ctx.fillStyle = cMa;
  ctx.beginPath(); ctx.arc(x(now), y(endV), 3, 0, Math.PI * 2); ctx.fill();
}

/* ---------- wiring ---------- */

function init() {
  const supported = 'serial' in navigator && window.isSecureContext;
  if (!supported) {
    el.unsupported.hidden = false;
    el.btnConnect.disabled = true;
  }
  el.btnConnect.addEventListener('click', () => connect(false));
  el.btnDemo.addEventListener('click', () => connect(true));
  el.btnDisconnect.addEventListener('click', disconnect);
  el.btnSave.addEventListener('click', save);
  el.btnDefaults.addEventListener('click', restoreDefaults);
  for (const r of ledRadios()) r.addEventListener('change', () => setLed(Number(r.value)));
  el.btnRun.addEventListener('click', toggleRun);
  el.testForm.addEventListener('submit', testPulse);
  initTheme($('btnTheme'));
  window.addEventListener('resize', drawChart);
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  if (location.hash === '#demo') connect(true);
}

init();
