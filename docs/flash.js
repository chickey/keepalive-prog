import { Isp, IspError, UsbTransport, padImage, sectorsFor, APP_LIMIT, TARGET_CHIP_ID, USB_FILTERS } from './isp.js';
import { MockUsbTransport } from './isp-mock.js';
import { initTheme } from './theme.js';

const $ = (id) => document.getElementById(id);
const el = {
  connState: $('connState'), unsupported: $('unsupported'),
  fwInfo: $('fwInfo'), fwNote: $('fwNote'),
  btnConnect: $('btnConnect'), btnDemo: $('btnDemo'), btnDisconnect: $('btnDisconnect'),
  device: $('device'), chipInfo: $('chipInfo'), protNote: $('protNote'), btnFlash: $('btnFlash'),
  progress: $('progress'), stage: $('stage'), pct: $('pct'), barFill: $('barFill'),
  result: $('result'), help: $('help'), log: $('log'),
};

let fw = null;        // { version, bytes, ... } once loaded
let transport = null;
let isp = null;
let busy = false;
let pinger = 0;

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
  el.btnConnect.disabled = busy || !!transport || !webUsb();
  el.btnDemo.disabled = busy || !!transport;
  el.btnDisconnect.disabled = busy;
  el.btnConnect.disabled ||= !fw;
  el.btnFlash.disabled = busy || !isp || (!fw && !isp.protectedFlash);
}

const webUsb = () => 'usb' in navigator && window.isSecureContext;

/* ---------- firmware ---------- */

async function loadFirmware() {
  try {
    const mres = await fetch('firmware/manifest.json', { cache: 'no-cache' });
    if (!mres.ok) throw new Error(`manifest: HTTP ${mres.status}`);
    const m = await mres.json();
    const bres = await fetch(`firmware/${m.file}`, { cache: 'no-cache' });
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
    el.fwInfo.innerHTML = `<b>Keep Alive ${esc(m.version)}</b> · ${kb(bytes.length)}${m.built ? ` · built ${esc(m.built)}` : ''} · for ${esc(m.chip || 'CH32X035F8U6')}`;
    if (m.note) { el.fwNote.textContent = m.note; el.fwNote.hidden = false; }
  } catch (e) {
    fw = null;
    el.fwInfo.textContent = 'The firmware file could not be loaded.';
    showResult('error', `<strong>No firmware to install.</strong> ${esc(e.message)}. Try reloading the page.`);
  }
  updateButtons();
}

/* ---------- connection ---------- */

function demoScenario() {
  const m = location.hash.match(/^#demo(?:-(\w+))?$/);
  return m ? (m[1] || 'ok') : null;
}

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
    log('·', `${demo ? 'demo: ' : ''}opening ${transport.label}`);
    await transport.open();
    isp = new Isp(transport, { onLog: log });
    const chip = await isp.identify();
    if (chip.chipId !== TARGET_CHIP_ID) {
      throw new IspError('wrongchip', `This is a ${chip.name || 'CH32X03x'}, not the CH32X035F8U6 used on the Keep Alive.`);
    }
    showDevice(demo);
  } catch (e) {
    await dropConnection();
    showError(e, 'connect');
  } finally {
    busy = false; updateButtons();
  }
  // Install straight away: the bootloader only waits a few seconds.
  // A locked chip waits for the user instead, with the bootloader kept awake.
  if (isp && !isp.protectedFlash) await flash();
  else if (isp) startPinging();
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
  el.btnFlash.textContent = 'Unlock chip';
  el.btnFlash.hidden = !isp.protectedFlash;
  el.btnFlash.classList.toggle('danger', isp.protectedFlash);
  el.btnFlash.classList.toggle('primary', !isp.protectedFlash);
  el.progress.hidden = true;
  el.device.hidden = false;
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
  if (!isp || busy) return;
  if (isp.protectedFlash) return unlock();
  if (!fw) return;
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
    showResult('warn', `<strong>Chip unlocked.</strong> Unplug the Keep Alive, then click <b>Install firmware</b> again and follow the steps.`);
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
  const replug = 'Unplug the Keep Alive, click <b>Install firmware</b> and follow the steps again.';

  if (code === 'open' || code === 'claim' || e?.name === 'SecurityError') {
    let fix;
    if (isWindows) fix = `Windows has a different driver attached to it. Install the WinUSB driver with Zadig (one time): see <a href="#help" data-open-help>Trouble connecting → Windows</a>.`;
    else if (isLinux) fix = `Your user doesn't have permission to open it. Add the udev rule in <a href="#help" data-open-help>Trouble connecting → Linux</a>, then replug it.`;
    else fix = 'Close any other program that might be using it (such as WCH flashing tools), then unplug it and try again.';
    showResult('error', `<strong>Couldn't open the Keep Alive.</strong> ${fix}`);
    if (isWindows || isLinux) el.help.open = true;
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
  const what = { idle: 'while waiting', connect: 'while connecting', erase: 'while erasing', write: 'while writing', verify: 'while checking', reset: 'while restarting', unlock: 'while unlocking' }[stage] || '';
  const lost = code === 'timeout' || code === 'usb' || e?.name === 'NetworkError' || e?.name === 'NotFoundError';
  const safe = stage === 'write' || stage === 'erase' || stage === 'verify'
    ? ' Nothing is broken: update mode is built into the chip and can\'t be erased, so you can always start again.' : '';
  showResult('error', `<strong>${lost ? 'The Keep Alive stopped responding' : 'Something went wrong'} ${what}.</strong> ${lost ? '' : esc(e?.message || e) + ' '}${replug}${safe}`);
}

/* ---------- wiring ---------- */

function init() {
  initTheme($('btnTheme'));
  if (!webUsb()) el.unsupported.hidden = false;
  el.btnConnect.addEventListener('click', () => connect(false));
  el.btnDemo.addEventListener('click', () => connect(true));
  el.btnDisconnect.addEventListener('click', disconnect);
  el.btnFlash.addEventListener('click', flash);
  el.result.addEventListener('click', (e) => { if (e.target.closest('[data-open-help]')) el.help.open = true; });
  window.addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
  if (webUsb()) {
    navigator.usb.addEventListener('disconnect', (e) => {
      if (transport instanceof UsbTransport && transport.device === e.device && !busy) {
        dropConnection(); updateButtons();
        showResult('error', `<strong>The Keep Alive left update mode.</strong> It only waits a few seconds before starting its normal firmware. Unplug it, click <b>Install firmware</b> and plug it in while holding BOOT.`);
      }
    });
  }
  log('·', `looking for ${USB_FILTERS.map((f) => `${f.vendorId.toString(16)}:${f.productId.toString(16)}`).join(' or ')}`);
  updateButtons();
  loadFirmware().then(() => { if (demoScenario()) connect(true); });
}

init();
