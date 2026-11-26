import { Isp, IspError, UsbTransport, padImage, sectorsFor, APP_LIMIT, TARGET_CHIP_ID, USB_FILTERS } from './isp.js';
import { MockUsbTransport } from './isp-mock.js';
import { Link, SerialTransport, parseKV, KA_USB_IDS } from './link.js';
import { MockTransport } from './mock.js';
import { Loader, LoaderError, parseKai } from './loader-link.js';
import { MockSerialDevice } from './loader-mock.js';
import { initTheme } from './theme.js';

// Two ways in:
//  - Web Serial (normal): the Keep Alive's update loader, reached either by
//    asking the running firmware to restart into it (BOOT) or by holding
//    PRESET at power-up. No driver anywhere. Installs the signed .kai file.
//  - WebUSB (advanced / legacy): WCH's bootloader in the chip, for boards with
//    no loader (factory-fresh, or firmware older than 1.1.0). Installs the
//    loader and the firmware together. Needs WinUSB (Zadig) on Windows.

const $ = (id) => document.getElementById(id);
const el = {
  connState: $('connState'), unsupported: $('unsupported'),
  fwDevice: $('fwDevice'), fwDeviceSub: $('fwDeviceSub'), fwAvail: $('fwAvail'), fwAvailSub: $('fwAvailSub'),
  fwStatus: $('fwStatus'), fwNote: $('fwNote'),
  btnConnect: $('btnConnect'), btnConnect2: $('btnConnect2'), btnDemo: $('btnDemo'), btnIsp: $('btnIsp'),
  viaPreset: $('viaPreset'), viaBoot: $('viaBoot'),
  device: $('device'), devTitle: $('devTitle'), chipInfo: $('chipInfo'), devNote: $('devNote'),
  btnFlash: $('btnFlash'), btnUnlock: $('btnUnlock'), btnDisconnect: $('btnDisconnect'),
  progress: $('progress'), stage: $('stage'), pct: $('pct'), barFill: $('barFill'),
  result: $('result'), help: $('help'), log: $('log'),
};

let fw = null;        // { version, kai, info, full?, ... } once loaded
let session = null;   // { kind: 'serial', link, hello, mode, demo } | { kind: 'isp', transport, isp, demo }
let busy = false;
let pinger = 0;
let mockDev = null;   // the simulated board, in demo mode

const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
const isWindows = platform.startsWith('win');
const isLinux = platform.includes('linux') && !/android|cros/i.test(navigator.userAgent);
const isMac = platform.startsWith('mac');

/* ---------- helpers ---------- */

function log(dir, line) {
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  el.log.textContent += `${ts} ${dir} ${line.length > 140 ? line.slice(0, 140) + '…' : line}\n`;
  const lines = el.log.textContent.split('\n');
  if (lines.length > 400) el.log.textContent = lines.slice(-400).join('\n');
  el.log.scrollTop = el.log.scrollHeight;
}

function setConn(state, text) {
  el.connState.dataset.state = state;
  el.connState.textContent = text;
}

function showResult(kind, html) {
  el.result.className = `notice ${kind}`;
  el.result.innerHTML = html;
  el.result.hidden = false;
}
const clearResult = () => { el.result.hidden = true; };

function setProgress(stage, frac) {
  el.progress.hidden = false;
  el.stage.textContent = stage;
  const p = Math.round(frac * 100);
  el.pct.textContent = `${p}%`;
  el.barFill.style.width = `${p}%`;
  el.progress.querySelector('.bar').setAttribute('aria-valuenow', p);
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const webUsb = () => 'usb' in navigator && window.isSecureContext;
const webSerial = () => 'serial' in navigator && window.isSecureContext;

function updateButtons() {
  const idle = !busy && !session && !!fw;
  el.btnConnect.disabled = el.btnConnect2.disabled = !idle || !webSerial();
  el.btnIsp.disabled = !idle || !webUsb();
  el.btnDemo.disabled = !idle;
  el.btnDisconnect.disabled = busy;
  el.btnFlash.disabled = busy || !session || !fw;
  el.btnUnlock.disabled = busy || session?.kind !== 'isp';
}

async function sha256hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchChecked(file, size, sha) {
  const res = await fetch(`firmware/${file}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== size) throw new Error(`${file} is ${bytes.length} bytes, manifest says ${size}`);
  if (sha && await sha256hex(bytes) !== sha.toLowerCase()) throw new Error(`${file} doesn't match its checksum`);
  return bytes;
}

/* ---------- firmware ---------- */

async function loadFirmware() {
  try {
    const mres = await fetch('firmware/manifest.json', { cache: 'no-store' });
    if (!mres.ok) throw new Error(`manifest: HTTP ${mres.status}`);
    const m = await mres.json();
    const kai = await fetchChecked(m.file, m.size, m.sha256);
    const info = parseKai(kai);
    if (info.version !== m.version) throw new Error(`${m.file} is version ${info.version}, manifest says ${m.version}`);
    fw = { ...m, kai, info };
    el.fwAvail.textContent = m.version;
    el.fwAvailSub.textContent = `${kb(info.length)}${m.built ? ` · built ${m.built}` : ''} · signed by Eplop`;
    renderFwStatus();
    if (m.note) { el.fwNote.textContent = m.note; el.fwNote.hidden = false; }
  } catch (e) {
    fw = null;
    el.fwAvail.textContent = 'Not available';
    el.fwAvailSub.textContent = 'The firmware file could not be loaded.';
    showResult('error', `<strong>No firmware to install.</strong> ${esc(e.message)}. Try reloading the page.`);
  }
  updateButtons();
}

// The loader + firmware image for WCH's bootloader; only needed on that route.
async function loadFull() {
  if (fw.fullBytes) return fw.fullBytes;
  const f = fw.full;
  if (!f) throw new Error('This page has no full image to install.');
  const bytes = await fetchChecked(f.file, f.size, f.sha256);
  if (bytes.length > APP_LIMIT) throw new Error(`${f.file} is too big for the chip`);
  fw.fullBytes = bytes;
  return bytes;
}

let deviceFw;          // undefined: not checked; null: no firmware (loader only)
function showFound(version, sub = 'Currently installed') {
  deviceFw = version;
  el.fwDevice.textContent = version || 'No firmware yet';
  el.fwDeviceSub.textContent = version ? sub : 'Only the update loader is on it';
  renderFwStatus();
}

// 1.0.4 < 1.0.5-test1 < 1.0.5 (a pre-release label sorts before its release).
function cmpVersion(a, b) {
  const p = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)(-.*)?/.exec(v) || []; return [+m[1] || 0, +m[2] || 0, +m[3] || 0, m[4] ? 0 : 1, m[4] || '']; };
  const x = p(a), y = p(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x[4] === y[4] ? 0 : (x[4] < y[4] ? -1 : 1);
}

function renderFwStatus() {
  if (!fw || deviceFw === undefined) { el.fwStatus.hidden = true; return; }
  if (!deviceFw) {
    el.fwStatus.dataset.s = 'update';
    el.fwStatus.textContent = `Ready for its first install: ${fw.version}`;
  } else {
    const c = cmpVersion(deviceFw, fw.version);
    el.fwStatus.dataset.s = c < 0 ? 'update' : c === 0 ? 'same' : 'newer';
    el.fwStatus.textContent = c < 0 ? `Update available: ${deviceFw} → ${fw.version}`
      : c === 0 ? 'Your Keep Alive already has this version. You can reinstall it if you need to.'
      : `Your Keep Alive has newer firmware (${deviceFw}) than this page offers (${fw.version}).`;
  }
  el.fwStatus.hidden = false;
}

function demoScenario() {
  const m = location.hash.match(/^#demo(?:-([\w-]+))?$/);
  return m ? (m[1] || 'ok') : null;
}

/* ---------- serial: the firmware or the update loader ---------- */

const isKaPort = (p) => {
  const i = p.getInfo();
  return i.usbVendorId === KA_USB_IDS.usbVendorId && i.usbProductId === KA_USB_IDS.usbProductId;
};

async function permittedPorts() {
  return webSerial() ? (await navigator.serial.getPorts()).filter(isKaPort) : [];
}

// Opens a transport and says hello. Returns { link, hello, mode } with mode
// 'app' (running firmware) or 'loader' (update mode).
async function openSerial(t) {
  const link = new Link(t, { onLog: log, onClose: () => onSerialClosed(link) });
  try {
    await t.open();
  } catch (e) {
    throw Object.assign(new Error(e.message), { code: 'serial-busy' });
  }
  try {
    const hello = parseKV(await link.cmd('HELLO', 1500));
    const mode = { 'KA-PROG': 'app', 'KA-LOADER': 'loader' }[hello._[0]];
    if (!mode) throw new Error('not a Keep Alive');
    return { link, hello, mode };
  } catch (e) {
    await link.close();
    throw Object.assign(new Error(e.message), { code: 'serial-not-ka' });
  }
}

// Connect button: a port this site already has permission for, else the picker.
async function connect(demo) {
  if (session || busy) return;
  clearResult();
  busy = true; updateButtons();
  setConn('busy', 'Connecting…');
  try {
    let found = null;
    if (demo) {
      const sc = demoScenario() || 'ok';
      if (sc === 'old') found = await openSerial(new MockTransport());
      else { mockDev = new MockSerialDevice(sc); found = await openSerial(mockDev.transport()); }
    } else {
      for (const p of await permittedPorts()) {
        try { found = await openSerial(new SerialTransport(p)); break; } catch (e) { log('·', `known port: ${e.message}`); }
      }
      if (!found) {
        let port;
        try { port = await navigator.serial.requestPort({ filters: [KA_USB_IDS] }); } catch (e) {
          if (e?.name === 'NotFoundError') { setConn('off', 'Not connected'); return; }
          throw e;
        }
        found = await openSerial(new SerialTransport(port));
      }
    }
    session = { kind: 'serial', ...found, demo };
    showSerialDevice();
  } catch (e) {
    await dropSession();
    showError(e, 'connect');
  } finally {
    busy = false; updateButtons();
  }
}

function onSerialClosed(link) {
  if (session?.kind === 'serial' && session.link === link && !busy) {
    session = null;
    el.device.hidden = true;
    setConn('off', 'Not connected');
    updateButtons();
    showResult('', 'The Keep Alive was disconnected.');
  }
}

function showSerialDevice() {
  const h = session.hello;
  let rows, note = '';
  if (session.mode === 'app') {
    showFound(h.fw);
    rows = [['Running', `firmware ${h.fw}`], ['Chip ID', h.uid], ['Hardware', `rev ${h.hw}`]];
    if (h.boot !== 'loader') {
      note = `<strong>This Keep Alive has firmware from before the update loader.</strong>
        Installing adds the loader, using the chip's own bootloader one last time: a device list opens, and you pick the
        <i>unknown device from QinHeng Electronics</i> in it.${isWindows ? ' On Windows this needs the WinUSB driver (see <a href="#viaBoot" data-open-boot>Advanced</a>) for this one install.' : ''}`;
    }
  } else {
    const app = h.app === 'none' ? null : h.app;
    showFound(app, 'Installed, not running (update mode)');
    rows = [['Mode', 'Update mode'], ['Installed', app || 'No firmware yet'], ['Update loader', `v${h.ldr}`], ['Chip ID', h.uid]];
  }
  el.devTitle.textContent = session.mode === 'app' ? 'Keep Alive connected' : 'Keep Alive in update mode';
  el.chipInfo.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
  el.devNote.innerHTML = note;
  el.devNote.hidden = !note;
  el.btnFlash.textContent = `Install firmware ${fw.version}`;
  el.btnFlash.hidden = false;
  el.btnUnlock.hidden = true;
  el.progress.hidden = true;
  el.device.hidden = false;
  el.device.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  setConn('on', session.demo ? 'Demo connected' : session.mode === 'app' ? 'Connected' : 'Update mode');
}

// Waits for the Keep Alive to come back on USB in the given mode after a
// restart; the browser keeps its permission because the port's IDs and serial
// number stay the same.
async function waitFor(mode, ms, onSlow) {
  const t0 = performance.now();
  let slowShown = false;
  while (performance.now() - t0 < ms) {
    await sleep(400);
    const transports = session?.demo ? [mockDev.transport()] : (await permittedPorts()).map((p) => new SerialTransport(p));
    for (const t of transports) {
      try {
        const found = await openSerial(t);
        if (found.mode === mode) return found;
        await found.link.close();
      } catch { /* not back yet */ }
    }
    if (!slowShown && performance.now() - t0 > 6000) { slowShown = true; onSlow?.(); }
  }
  return null;
}

async function installSerial() {
  let stage = 'restart';
  try {
    if (session.mode === 'app') {
      setConn('busy', 'Restarting into update mode…');
      setProgress('Restarting into update mode…', 0);
      await session.link.cmd('BOOT');
      try { await session.link.close(); } catch {}
      const found = await waitFor('loader', 60000, () => {
        if (isMac) setProgress('Waiting for update mode… If your Mac asks to allow the accessory, click Allow.', 0);
      });
      if (!found) throw Object.assign(new Error('update mode did not appear'), { code: 'lost' });
      session = { ...session, ...found };
      showSerialDevice();
    }
    stage = 'write';
    setConn('busy', 'Installing…');
    const loader = new Loader(session.link);
    const res = await loader.install(fw.kai, (done, total, phase) => {
      if (phase === 'check') setProgress('Checking the signature…', 0.92);
      else setProgress('Writing…', 0.05 + 0.85 * done / total);
    });
    log('·', `loader: ${res}`);
    stage = 'run';
    setProgress('Starting the new firmware…', 0.97);
    await loader.run();
    try { await session.link.close(); } catch {}
    const back = await waitFor('app', 15000);
    setProgress('Done', 1);
    if (back) {
      await back.link.close();
      showFound(back.hello.fw, 'Just installed, and running');
    } else {
      showFound(fw.version, 'Just installed');
    }
    session = null;
    el.device.hidden = true;
    setConn('off', 'Not connected');
    showResult('ok', `<strong>Keep Alive ${esc(fw.version)} installed${back ? ' and running' : ''}.</strong>
      The Keep Alive checked that it's genuine Eplop firmware before accepting it. Your presets are as they were.
      ${back ? '' : 'If it doesn\'t start, unplug it and plug it back in. '}Open the <a href="./">config page</a> to set it up.`);
  } catch (e) {
    await dropSession();
    showError(e, stage);
  }
}

/* ---------- WCH bootloader (WebUSB) ---------- */

async function openIsp(transport, demo) {
  log('·', `${demo ? 'demo: ' : ''}opening ${transport.label}`);
  await transport.open();
  const isp = new Isp(transport, { onLog: log });
  session = { kind: 'isp', transport, isp, demo };
  const chip = await isp.identify();
  if (chip.chipId !== TARGET_CHIP_ID) {
    throw new IspError('wrongchip', `This is a ${chip.name || 'CH32X03x'}, not the CH32X035F8U6 used on the Keep Alive.`);
  }
  startPinging();
}

// "Connect with BOOT": open the device list, the user plugs in with BOOT held.
async function connectIsp(demo) {
  if (session || busy) return;
  clearResult();
  busy = true; updateButtons();
  setConn('busy', 'Connecting…');
  try {
    let t;
    try {
      t = demo ? await MockUsbTransport.request(demoScenario()?.replace(/^boot-?/, '') || 'ok') : await UsbTransport.request();
    } catch (e) {
      if (e?.name !== 'NotFoundError') throw e;
      setConn('off', 'Not connected');
      return;
    }
    await openIsp(t, demo);
    showIspDevice();
  } catch (e) {
    await dropSession();
    showError(e, 'connect');
  } finally {
    busy = false; updateButtons();
  }
}

function startPinging() {
  clearInterval(pinger);
  pinger = setInterval(async () => {
    if (session?.kind !== 'isp' || busy) return;
    try { await session.isp.ping(); } catch (e) {
      if (busy) return;
      await dropSession();
      showError(e, 'idle');
    }
  }, 1000);
}

function showIspDevice() {
  const { isp, demo } = session;
  const c = isp.config;
  const rows = [
    ['Chip', isp.chip.name + (demo ? ' (simulated)' : '')],
    ['Chip ID', isp.uidText],
    ['WCH bootloader', `v${c.btver}`],
    ['Flash', isp.protectedFlash ? 'Locked' : 'Unlocked'],
  ];
  el.devTitle.textContent = "Connected to the chip's bootloader";
  el.chipInfo.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
  el.devNote.innerHTML = isp.protectedFlash
    ? `<strong>This chip's flash is locked (read-protected).</strong> Unlocking erases it completely, including saved presets.
       After unlocking, unplug the Keep Alive, then connect with BOOT again.`
    : 'This installs the update loader and the firmware together.';
  el.devNote.hidden = false;
  el.devNote.className = isp.protectedFlash ? 'notice warn' : 'hint';
  el.btnFlash.textContent = `Install loader + firmware ${fw.version}`;
  el.btnFlash.hidden = isp.protectedFlash;
  el.btnUnlock.hidden = !isp.protectedFlash;
  el.progress.hidden = true;
  el.device.hidden = false;
  el.device.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  setConn('on', demo ? 'Demo bootloader' : 'Bootloader connected');
}

// Firmware from before 1.1.0: BOOT restarts into WCH's bootloader, not the
// loader. The device list has to open in this click, before BOOT is sent.
async function installLegacy() {
  const demo = session.demo;
  const full = await loadFull();
  const usb = demo ? MockUsbTransport.request('ok') : UsbTransport.request();
  usb.catch(() => {});
  setConn('busy', 'Restarting into the bootloader…');
  await session.link.cmd('BOOT');
  try { await session.link.close(); } catch {}
  session = null;
  let t;
  try { t = await usb; } catch (e) {
    if (e?.name !== 'NotFoundError') throw e;
    el.device.hidden = true;
    setConn('off', 'Not connected');
    showResult('', 'Cancelled. The Keep Alive goes back to its normal firmware by itself in a few seconds.');
    return;
  }
  await openIsp(t, demo);
  await installIsp(full);
}

async function installIsp(full) {
  const { isp } = session;
  const image = padImage(full);
  let stage = 'erase';
  try {
    setConn('busy', 'Installing…');
    setProgress('Erasing…', 0);
    const n = await isp.erase(sectorsFor(image));
    log('·', `erased ${n} sectors`);
    await sleep(1000); // wchisp waits after erase too
    stage = 'write';
    await isp.program(image, (done, total) => setProgress('Writing…', 0.1 + 0.6 * done / total));
    await sleep(500);
    stage = 'verify';
    const bad = await isp.verify(image, (done, total) => setProgress('Checking…', 0.7 + 0.3 * done / total));
    if (bad >= 0) throw new IspError('verify', `The chip doesn't match the firmware at 0x${bad.toString(16).padStart(4, '0')}.`);
    setProgress('Done', 1);
    stage = 'reset';
    await isp.end();
    await dropSession();
    showFound(fw.version, 'Just installed');
    showResult('ok', `<strong>Update loader and Keep Alive ${esc(fw.version)} installed and checked.</strong>
      It restarts by itself. Future updates go through the update loader, with no driver needed.
      If the <a href="./">config page</a> can't find it, unplug it and plug it back in (without holding BOOT).`);
  } catch (e) {
    await dropSession();
    showError(e, stage);
  }
}

/* ---------- buttons ---------- */

async function install() {
  if (!session || busy || !fw) return;
  busy = true; updateButtons();
  clearResult();
  try {
    if (session.kind === 'isp') await installIsp(await loadFull());
    else if (session.mode === 'app' && session.hello.boot !== 'loader') await installLegacy();
    else await installSerial();
  } catch (e) {
    await dropSession();
    showError(e, 'restart');
  } finally {
    busy = false; updateButtons();
  }
}

async function unlock() {
  busy = true; updateButtons();
  try {
    setConn('busy', 'Unlocking…');
    await session.isp.unprotect();
    await dropSession();
    showResult('warn', '<strong>Chip unlocked.</strong> Unplug the Keep Alive, then connect with BOOT again and install.');
  } catch (e) {
    await dropSession();
    showError(e, 'unlock');
  } finally {
    busy = false; updateButtons();
  }
}

async function dropSession() {
  clearInterval(pinger);
  const s = session;
  session = null;
  el.device.hidden = true;
  setConn('off', 'Not connected');
  if (!s) return;
  try {
    if (s.kind === 'isp') await s.transport.close();
    else await s.link.close();
  } catch {}
}

async function disconnect() {
  if (busy) return;
  // Leaving update mode with firmware installed: start it rather than leave it waiting.
  if (session?.kind === 'serial' && session.mode === 'loader' && session.hello.app !== 'none') {
    await new Loader(session.link).run();
  }
  await dropSession();
  clearResult();
  updateButtons();
}

/* ---------- errors in plain English ---------- */

function showError(e, stage) {
  log('!', `${stage}: ${e?.code || e?.name || ''} ${e?.message || e}`);
  const code = e?.code;

  if (e instanceof LoaderError && code === 'signature') {
    showResult('error', `<strong>The Keep Alive refused this firmware: it isn't signed by Eplop.</strong>
      It stays in update mode, so nothing unsigned can run. Reload this page to get genuine firmware and install it again.`);
    return;
  }
  if (e instanceof LoaderError && code === 'refused') {
    showResult('error', `<strong>The Keep Alive refused this firmware.</strong> ${esc(e.message)}. Reload the page to get the latest firmware.`);
    return;
  }
  if (code === 'open' || code === 'claim' || e?.name === 'SecurityError') {
    let fix;
    if (isWindows) fix = `Windows needs the WinUSB driver for the chip's bootloader: see <a href="#viaBoot" data-open-boot>Advanced → Windows</a>.`;
    else if (isLinux) fix = `Your user doesn't have permission to open it: see <a href="#viaBoot" data-open-boot>Advanced → Linux</a>.`;
    else fix = 'Close any other program that might be using it (such as WCH flashing tools), then unplug it and try again.';
    showResult('error', `<strong>Couldn't open the Keep Alive's bootloader.</strong> ${fix}`);
    return;
  }
  if (code === 'serial-busy') {
    showResult('error', `<strong>Couldn't open the Keep Alive.</strong> Something else is using it, probably the config page in another tab: click <b>Disconnect</b> there, then try again.${isLinux ? ' On Linux, also check <a href="#help" data-open-help>Trouble connecting</a>.' : ''}`);
    return;
  }
  if (code === 'serial-not-ka') {
    showResult('error', `<strong>That port didn't answer like a Keep Alive.</strong> Check it's plugged in, then try again. If it still doesn't answer, put it in update mode by hand: see <b>Keep Alive not in the list, or it won't start</b>.`);
    el.viaPreset.open = true;
    return;
  }
  if (code === 'lost') {
    showResult('error', `<strong>The Keep Alive didn't come back in update mode.</strong> Unplug it, hold PRESET while plugging it back in, then click <b>Connect</b>. Its firmware and presets are untouched.`);
    el.viaPreset.open = true;
    return;
  }
  if (code === 'wrongchip') {
    showResult('error', `<strong>That isn't a Keep Alive.</strong> ${esc(e.message)} Make sure the Keep Alive is the only board in the bootloader, and pick it in the list.`);
    return;
  }
  if (code === 'verify') {
    showResult('error', `<strong>The check after writing failed.</strong> ${esc(e.message)} Unplug the Keep Alive and try again; if it keeps failing, try a different cable or USB port.`);
    return;
  }
  const what = { idle: 'while waiting', restart: 'while restarting it', connect: 'while connecting', erase: 'while erasing', write: 'while writing', verify: 'while checking', reset: 'while restarting', run: 'while starting the new firmware', unlock: 'while unlocking' }[stage] || '';
  const writing = stage === 'write' || stage === 'erase' || stage === 'verify';
  const safe = writing
    ? ' Nothing is broken: the Keep Alive stays in update mode until a complete, genuine firmware is installed, so you can always start again.' : '';
  const again = writing
    ? 'Click <b>Connect</b> to try again (if it isn\'t found, unplug it and hold PRESET while plugging it back in).'
    : 'Unplug the Keep Alive, plug it back in and try again.';
  showResult('error', `<strong>Something went wrong ${what}.</strong> ${esc(e?.message || e)}. ${again}${safe}`);
}

/* ---------- wiring ---------- */

function init() {
  initTheme($('btnTheme'));
  if (!webSerial()) el.unsupported.hidden = false;
  el.btnConnect.addEventListener('click', () => connect(false));
  el.btnConnect2.addEventListener('click', () => connect(false));
  el.btnIsp.addEventListener('click', () => connectIsp(false));
  el.btnDemo.addEventListener('click', () => (demoScenario()?.startsWith('boot') ? connectIsp(true) : connect(true)));
  el.btnDisconnect.addEventListener('click', disconnect);
  el.btnFlash.addEventListener('click', install);
  el.btnUnlock.addEventListener('click', unlock);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-help]')) el.help.open = true;
    if (e.target.closest('[data-open-boot]')) el.viaBoot.open = true;
  });
  window.addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
  if (webUsb()) {
    navigator.usb.addEventListener('disconnect', (e) => {
      if (session?.kind === 'isp' && session.transport instanceof UsbTransport && session.transport.device === e.device && !busy) {
        dropSession(); updateButtons();
        showResult('error', '<strong>The Keep Alive left the bootloader.</strong> It was unplugged, or it timed out. Unplug it and connect with BOOT again.');
      }
    });
  }
  log('·', `serial: Keep Alive ${KA_USB_IDS.usbVendorId.toString(16)}:${KA_USB_IDS.usbProductId.toString(16)}; bootloader: ${USB_FILTERS.map((f) => `${f.vendorId.toString(16)}:${f.productId.toString(16)}`).join(' or ')}`);
  updateButtons();
  loadFirmware().then(() => {
    if (demoScenario()) (demoScenario().startsWith('boot') ? connectIsp(true) : connect(true));
    else detectKeepAlive();
  });
}

// On load: if this site already knows the Keep Alive's port and it's free,
// say which firmware it has, then close the port again.
async function detectKeepAlive() {
  try {
    for (const p of await permittedPorts()) {
      try {
        const { link, hello, mode } = await openSerial(new SerialTransport(p));
        await link.close();
        if (mode === 'app') showFound(hello.fw);
        else showFound(hello.app === 'none' ? null : hello.app, 'Installed, not running (update mode)');
        return;
      } catch (e) {
        if (e?.code === 'serial-busy') {
          el.fwDevice.textContent = "Couldn't check";
          el.fwDeviceSub.textContent = 'It may be open in the config page: click Disconnect there and reload';
        }
      }
    }
  } catch {}
}

init();
