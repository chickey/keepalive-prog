import { Isp, IspError, UsbTransport, padImage, sectorsFor, APP_LIMIT, TARGET_CHIP_ID, USB_FILTERS } from './isp.js';
import { MockUsbTransport } from './isp-mock.js';
import { Link, SerialTransport, parseKV, KA_USB_IDS } from './link.js';
import { MockTransport } from './mock.js';
import { initTheme } from './theme.js';

const $ = (id) => document.getElementById(id);
const el = {
  connState: $('connState'), unsupported: $('unsupported'),
  fwDevice: $('fwDevice'), fwDeviceSub: $('fwDeviceSub'), fwAvail: $('fwAvail'), fwAvailSub: $('fwAvailSub'),
  fwStatus: $('fwStatus'), fwNote: $('fwNote'),
  btnRestart: $('btnRestart'), viaBoot: $('viaBoot'),
  btnConnect: $('btnConnect'), btnDemo: $('btnDemo'), btnDisconnect: $('btnDisconnect'),
  device: $('device'), chipInfo: $('chipInfo'), protNote: $('protNote'), btnFlash: $('btnFlash'), btnUnlock: $('btnUnlock'),
  progress: $('progress'), stage: $('stage'), pct: $('pct'), barFill: $('barFill'),
  result: $('result'), help: $('help'), log: $('log'),
};

let fw = null;        // { version, bytes, ... } once loaded
let transport = null;
let isp = null;
let busy = false;
let pinger = 0;
let kaPort = null;    // the running Keep Alive's serial port, once known

const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
const isWindows = platform.startsWith('win');
const isLinux = platform.includes('linux') && !/android|cros/i.test(navigator.userAgent);

/* ---------- helpers ---------- */

function log(dir, line) {
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  el.log.textContent += `${ts} ${dir} ${line}\n`;
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

function updateButtons() {
  const idle = !busy && !transport && !!fw;
  el.btnRestart.disabled = !idle || !webUsb() || !webSerial();
  el.btnConnect.disabled = !idle || !webUsb();
  el.btnDemo.disabled = !idle;
  el.btnDisconnect.disabled = busy;
  el.btnFlash.disabled = busy || !isp || !fw;
  el.btnUnlock.disabled = busy || !isp;
}

const webUsb = () => 'usb' in navigator && window.isSecureContext;
const webSerial = () => 'serial' in navigator && window.isSecureContext;

/* ---------- firmware ---------- */

async function loadFirmware() {
  try {
    const mres = await fetch('firmware/manifest.json', { cache: 'no-store' });
    if (!mres.ok) throw new Error(`manifest: HTTP ${mres.status}`);
    const m = await mres.json();
    const bres = await fetch(`firmware/${m.file}`, { cache: 'no-store' });
    if (!bres.ok) throw new Error(`${m.file}: HTTP ${bres.status}`);
    const bytes = new Uint8Array(await bres.arrayBuffer());
    if (bytes.length !== m.size) throw new Error(`${m.file} is ${bytes.length} bytes, manifest says ${m.size}`);
    if (m.sha256) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const got = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
      if (got !== m.sha256.toLowerCase()) throw new Error(`${m.file} doesn't match its checksum`);
    }
    if (bytes.length > APP_LIMIT) throw new Error(`${m.file} is too big for the chip`);
    fw = { ...m, bytes };
    el.fwAvail.textContent = m.version;
    el.fwAvailSub.textContent = `${kb(bytes.length)}${m.built ? ` · built ${m.built}` : ''} · for ${m.chip || 'CH32X035F8U6'}`;
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

/* ---------- connection ---------- */

function demoScenario() {
  const m = location.hash.match(/^#demo(?:-(\w+))?$/);
  return m ? (m[1] || 'ok') : null;
}

/* ---------- the running Keep Alive (serial) ---------- */

async function permittedPort() {
  if (!webSerial()) return null;
  const ports = await navigator.serial.getPorts();
  return ports.find((p) => {
    const i = p.getInfo();
    return i.usbVendorId === KA_USB_IDS.usbVendorId && i.usbProductId === KA_USB_IDS.usbProductId;
  }) || null;
}

// Opens the port and checks it is a Keep Alive. Returns { link, hello }.
async function openKeepAlive(t) {
  const link = new Link(t, { onLog: log });
  try {
    await t.open();
  } catch (e) {
    throw Object.assign(new Error(e.message), { code: 'serial-busy' });
  }
  try {
    const hello = parseKV(await link.cmd('HELLO', 1500));
    if (hello._[0] !== 'KA-PROG') throw new Error('not a Keep Alive');
    return { link, hello };
  } catch (e) {
    await link.close();
    throw Object.assign(new Error(e.message), { code: 'serial-not-ka' });
  }
}

// On load: if this site already knows the Keep Alive's port and it's free,
// say which firmware it has. Closes the port again straight away.
async function detectKeepAlive() {
  try {
    kaPort = await permittedPort();
    if (!kaPort) return;
    const { link, hello } = await openKeepAlive(new SerialTransport(kaPort));
    await link.close();
    showFound(hello.fw);
  } catch (e) {
    if (e?.code === 'serial-busy') {
      el.fwDevice.textContent = "Couldn't check";
      el.fwDeviceSub.textContent = 'It may be open in the config page: click Disconnect there and reload';
    }
  }
}

let deviceFw = null;
function showFound(version) {
  deviceFw = version;
  el.fwDevice.textContent = version;
  el.fwDeviceSub.textContent = 'Currently installed';
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
  if (!fw || !deviceFw) { el.fwStatus.hidden = true; return; }
  const c = cmpVersion(deviceFw, fw.version);
  el.fwStatus.dataset.s = c < 0 ? 'update' : c === 0 ? 'same' : 'newer';
  el.fwStatus.textContent = c < 0 ? `Update available: ${deviceFw} → ${fw.version}`
    : c === 0 ? 'Your Keep Alive already has this version. You can reinstall it if you need to.'
    : `Your Keep Alive has newer firmware (${deviceFw}) than this page offers (${fw.version}).`;
  el.fwStatus.hidden = false;
}

// Restart the running Keep Alive into its bootloader and connect to that.
async function restart(demo) {
  if (transport || busy) return;
  clearResult();
  let link;
  busy = true; updateButtons();
  setConn('busy', 'Finding the Keep Alive…');
  try {
    let st;
    if (demo) {
      st = new MockTransport();
    } else {
      kaPort ||= await permittedPort();
      if (!kaPort) {
        // First time: pick the port. The picker uses up this click, and Chrome
        // needs a fresh one before it can show the USB list, so stop here.
        try { kaPort = await navigator.serial.requestPort(); } catch (e) {
          if (e?.name === 'NotFoundError') { setConn('off', 'Not connected'); return; }
          throw e;
        }
        const found = await openKeepAlive(new SerialTransport(kaPort));
        await found.link.close();
        showFound(found.hello.fw);
        showResult('', 'Found it. Now click <b>Restart into update mode</b> again.');
        setConn('off', 'Not connected');
        return;
      }
      st = new SerialTransport(kaPort);
    }
    const found = await openKeepAlive(st);
    link = found.link;
    showFound(found.hello.fw);
    // Open the device list now, while this click still counts; the bootloader
    // appears in it a moment after the restart.
    const usb = demo ? MockUsbTransport.request(demoScenario() || 'ok') : UsbTransport.request();
    usb.catch(() => {});
    setConn('busy', 'Restarting into update mode…');
    await link.cmd('BOOT');
    try { await link.close(); } catch {}
    link = null;
    try {
      transport = await usb;
    } catch (e) {
      if (e?.name !== 'NotFoundError') throw e;
      setConn('off', 'Not connected');
      showResult('', 'Cancelled. The Keep Alive goes back to its normal firmware by itself in a few seconds.');
      return;
    }
    await connectTransport(demo);
  } catch (e) {
    if (link) try { await link.close(); } catch {}
    await dropConnection();
    showError(e, 'restart');
  } finally {
    busy = false; updateButtons();
  }
  if (isp) startPinging();
}

/* ---------- the bootloader (WebUSB) ---------- */

// BOOT-button route: open the device list, the user plugs in with BOOT held.
async function connect(demo) {
  if (transport || busy) return;
  clearResult();
  busy = true; updateButtons();
  setConn('busy', 'Connecting…');
  try {
    try {
      transport = demo ? await MockUsbTransport.request(demoScenario() || 'ok') : await UsbTransport.request();
    } catch (e) {
      if (e?.name !== 'NotFoundError') throw e;
      setConn('off', 'Not connected'); // chooser cancelled
      return;
    }
    await connectTransport(demo);
  } catch (e) {
    await dropConnection();
    showError(e, 'connect');
  } finally {
    busy = false; updateButtons();
  }
  if (isp) startPinging();
}

// Identify the chip and show it. Nothing is written until Install is clicked;
// meanwhile the bootloader is pinged so it doesn't time out.
async function connectTransport(demo) {
  log('·', `${demo ? 'demo: ' : ''}opening ${transport.label}`);
  setConn('busy', 'Connecting…');
  await transport.open();
  isp = new Isp(transport, { onLog: log });
  const chip = await isp.identify();
  if (chip.chipId !== TARGET_CHIP_ID) {
    throw new IspError('wrongchip', `This is a ${chip.name || 'CH32X03x'}, not the CH32X035F8U6 used on the Keep Alive.`);
  }
  showDevice(demo);
}

function startPinging() {
  clearInterval(pinger);
  pinger = setInterval(async () => {
    if (!isp || busy) return;
    try { await isp.ping(); } catch (e) {
      if (busy) return;
      await dropConnection();
      showError(e, 'idle');
    }
  }, 1000);
}

function showDevice(demo) {
  const c = isp.config;
  const rows = [
    ['Chip', isp.chip.name + (demo ? ' (simulated)' : '')],
    ['Chip ID', isp.uidText],
    ['Bootloader', `v${c.btver}`],
    ['Flash', isp.protectedFlash ? 'Locked' : 'Unlocked'],
  ];
  el.chipInfo.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
  el.protNote.hidden = !isp.protectedFlash;
  el.btnFlash.textContent = `Install firmware ${fw.version}`;
  el.btnFlash.hidden = isp.protectedFlash;
  el.btnUnlock.hidden = !isp.protectedFlash;
  el.progress.hidden = true;
  el.device.hidden = false;
  el.device.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  setConn('on', demo ? 'Demo bootloader' : 'Bootloader connected');
}

async function dropConnection() {
  clearInterval(pinger);
  const t = transport;
  transport = null; isp = null;
  el.device.hidden = true;
  setConn('off', 'Not connected');
  if (t) await t.close();
}

async function disconnect() {
  if (busy) return;
  await dropConnection();
  clearResult();
  updateButtons();
}

/* ---------- flashing ---------- */

async function flash() {
  if (!isp || busy || isp.protectedFlash || !fw) return;
  busy = true; updateButtons();
  clearResult();
  setConn('busy', 'Installing…');
  const image = padImage(fw.bytes);
  let stage = 'erase';
  try {
    setProgress('Erasing…', 0);
    const n = await isp.erase(sectorsFor(image));
    log('·', `erased ${n} sectors`);
    await new Promise((r) => setTimeout(r, 1000)); // wchisp waits after erase too

    stage = 'write';
    await isp.program(image, (done, total) => setProgress('Writing…', 0.1 + 0.6 * done / total));
    await new Promise((r) => setTimeout(r, 500));

    stage = 'verify';
    const bad = await isp.verify(image, (done, total) => setProgress('Checking…', 0.7 + 0.3 * done / total));
    if (bad >= 0) throw new IspError('verify', `The chip doesn't match the firmware at 0x${bad.toString(16).padStart(4, '0')}.`);
    setProgress('Done', 1);

    stage = 'reset';
    await isp.end();
    await dropConnection();
    deviceFw = fw.version;
    el.fwDevice.textContent = fw.version;
    el.fwDeviceSub.textContent = 'Just installed';
    renderFwStatus();
    showResult('ok', `<strong>Keep Alive ${esc(fw.version)} installed and checked.</strong>
      It restarts by itself. If the <a href="./">config page</a> can't find it, unplug it and plug it back in (without holding BOOT).`);
  } catch (e) {
    await dropConnection();
    showError(e, stage);
  } finally {
    busy = false; updateButtons();
  }
}

async function unlock() {
  busy = true; updateButtons();
  try {
    setConn('busy', 'Unlocking…');
    await isp.unprotect();
    await dropConnection();
    showResult('warn', `<strong>Chip unlocked.</strong> Unplug the Keep Alive, then follow <b>First install</b> to connect and install the firmware.`);
    el.viaBoot.open = true;
  } catch (e) {
    await dropConnection();
    showError(e, 'unlock');
  } finally {
    busy = false; updateButtons();
  }
}

/* ---------- errors in plain English ---------- */

function showError(e, stage) {
  log('!', `${stage}: ${e?.code || e?.name || ''} ${e?.message || e}`);
  const code = e?.code;
  const replug = 'Unplug the Keep Alive, plug it back in and try again. If it keeps failing, use <b>First install</b> with the BOOT button.';

  if (code === 'open' || code === 'claim' || e?.name === 'SecurityError') {
    let fix;
    if (isWindows) fix = `Windows has a different driver attached to it. Install the WinUSB driver with Zadig (one time): see <a href="#help" data-open-help>Trouble connecting → Windows</a>.`;
    else if (isLinux) fix = `Your user doesn't have permission to open it. Add the udev rule in <a href="#help" data-open-help>Trouble connecting → Linux</a>, then replug it.`;
    else fix = 'Close any other program that might be using it (such as WCH flashing tools), then unplug it and try again.';
    showResult('error', `<strong>Couldn't open the Keep Alive.</strong> ${fix}`);
    if (isWindows || isLinux) el.help.open = true;
    return;
  }
  if (code === 'serial-busy') {
    showResult('error', `<strong>Couldn't talk to the Keep Alive.</strong> Something else is using it, probably the config page in another tab: click <b>Disconnect</b> there, then try again.`);
    return;
  }
  if (code === 'serial-not-ka') {
    showResult('error', `<strong>That port didn't answer like a Keep Alive.</strong> Check it's plugged in and running, then try again. If its firmware isn't working, use <b>First install</b> with the BOOT button.`);
    kaPort = null;
    el.viaBoot.open = true;
    return;
  }
  if (code === 'wrongchip') {
    showResult('error', `<strong>That isn't a Keep Alive.</strong> ${esc(e.message)} Make sure the Keep Alive is the only board in update mode, and pick it in the list.`);
    return;
  }
  if (code === 'verify') {
    showResult('error', `<strong>The check after writing failed.</strong> ${esc(e.message)} ${replug} If it keeps failing, try a different cable or USB port.`);
    return;
  }
  const what = { idle: 'while waiting', restart: 'while restarting it into update mode', connect: 'while connecting', erase: 'while erasing', write: 'while writing', verify: 'while checking', reset: 'while restarting', unlock: 'while unlocking' }[stage] || '';
  const lost = code === 'timeout' || code === 'usb' || e?.name === 'NetworkError' || e?.name === 'NotFoundError';
  const safe = stage === 'write' || stage === 'erase' || stage === 'verify'
    ? ' Nothing is broken: update mode is built into the chip and can\'t be erased, so you can always start again.' : '';
  showResult('error', `<strong>${lost ? 'The Keep Alive stopped responding' : 'Something went wrong'} ${what}.</strong> ${lost ? '' : esc(e?.message || e) + ' '}${replug}${safe}`);
}

/* ---------- wiring ---------- */

function init() {
  initTheme($('btnTheme'));
  if (!webUsb()) el.unsupported.hidden = false;
  el.btnRestart.addEventListener('click', () => restart(false));
  el.btnConnect.addEventListener('click', () => connect(false));
  el.btnDemo.addEventListener('click', () => restart(true));
  el.btnDisconnect.addEventListener('click', disconnect);
  el.btnFlash.addEventListener('click', flash);
  el.btnUnlock.addEventListener('click', unlock);
  el.result.addEventListener('click', (e) => { if (e.target.closest('[data-open-help]')) el.help.open = true; });
  window.addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
  if (webUsb()) {
    navigator.usb.addEventListener('disconnect', (e) => {
      if (transport instanceof UsbTransport && transport.device === e.device && !busy) {
        dropConnection(); updateButtons();
        showResult('error', `<strong>The Keep Alive left update mode.</strong> It was unplugged, or it timed out. Plug it in and click <b>Restart into update mode</b> again.`);
      }
    });
  }
  log('·', `looking for ${USB_FILTERS.map((f) => `${f.vendorId.toString(16)}:${f.productId.toString(16)}`).join(' or ')}`);
  updateButtons();
  loadFirmware().then(() => { if (demoScenario()) restart(true); else detectKeepAlive(); });
}

init();
