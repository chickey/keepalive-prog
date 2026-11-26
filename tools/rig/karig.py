#!/usr/bin/env python3
"""Keep Alive factory rig: put the update loader on blank boards, many at once.

Plug boards into a USB hub on the Raspberry Pi (or any Linux/macOS computer).
Each board that shows up in WCH's USB bootloader is programmed with the loader
image, restarted, and checked: it must come back as the Keep Alive serial port
and answer HELLO with the expected loader version. Results go on the screen,
one row per hub port, and into a CSV log.

  python3 karig.py                                  # loader only (what ships)
  python3 karig.py --image ../../firmware/prebuilt/factory-full.bin
  python3 karig.py --once                           # program what's plugged in, then exit
  python3 karig.py --web 8765                       # dashboard at http://localhost:8765
  python3 karig.py --mode batch                     # wait for a Flash command (Enter, or the dashboard)

Modes: "auto" flashes each board as soon as it appears. "batch" connects to
each board as it appears, keeps WCH's bootloader awake (it gives up after
about 5 s otherwise) and flashes the waiting boards one at a time on command.

Needs pyusb and pyserial (pip install -r requirements.txt) and libusb.
"""
import argparse, collections, csv, datetime, hashlib, http.server, json, os, re, secrets, sys, threading, time

import usb.core, usb.util
import serial, serial.tools.list_ports

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_IMAGE = os.path.join(HERE, "..", "..", "firmware", "prebuilt", "factory-loader.bin")
BOOT_IDS = [(0x4348, 0x55E0), (0x1A86, 0x55E0)]
KA_ID = (0x1209, 0xD035)

# ---------------------------------------------------------------- WCH ISP (as docs/isp.js)
IDENTIFY, ISP_END, ISP_KEY, ERASE, PROGRAM, VERIFY, READ_CONFIG, WRITE_CONFIG = 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8
CHUNK, SECTOR = 56, 1024
APP_LIMIT = 0xF700          # never erase the settings page
FAMILY_X03X, CHIP_F8U6 = 0x23, 94


class IspError(Exception):
    pass


class Isp:
    def __init__(self, dev):
        self.dev = dev
        try:
            if dev.is_kernel_driver_active(0):
                dev.detach_kernel_driver(0)
        except (NotImplementedError, usb.core.USBError):
            pass
        dev.set_configuration()
        usb.util.claim_interface(dev, 0)
        self.key = None

    def close(self):
        try:
            usb.util.release_interface(self.dev, 0)
            usb.util.dispose_resources(self.dev)
        except usb.core.USBError:
            pass

    def xfer(self, cmd, payload, timeout=1000):
        payload = bytes(payload)
        self.dev.write(0x02, bytes([cmd, len(payload) & 0xFF, len(payload) >> 8]) + payload, timeout)
        r = bytes(self.dev.read(0x82, 64, timeout))
        if len(r) < 4 or r[0] != cmd:
            raise IspError("unexpected reply from the bootloader")
        n = r[2] | r[3] << 8
        if len(r) - 4 != n:
            raise IspError("malformed reply from the bootloader")
        return r[4:]

    def identify(self):
        r = self.xfer(IDENTIFY, b"\0\0" + b"MCU ISP & WCH.CN")
        chip, family = r[0], r[1]
        if family != FAMILY_X03X or chip != CHIP_F8U6:
            raise IspError(f"not a CH32X035F8U6 (type 0x{family:02x}, chip {chip})")
        c = self.xfer(READ_CONFIG, [0x1F, 0])
        if len(c) < 26:
            raise IspError("short configuration block")
        self.raw = c[2:14]
        self.rdpr, self.wrpr = c[2], c[10:14]
        self.btver = f"{c[14]:x}{c[15]:x}.{c[16]:x}{c[17]:x}".lstrip("0")
        self.uid = c[18:26]
        w = lambda i: self.uid[i] | self.uid[i + 1] << 8
        if (w(0) + w(2) + w(4)) & 0xFFFF != w(6):
            raise IspError("chip ID failed its checksum")
        s = sum(self.uid) & 0xFF
        self.key = bytes([s] * 7 + [(s + chip) & 0xFF])

    @property
    def protected(self):
        return self.rdpr != 0xA5 or any(b != 0xFF for b in self.wrpr)

    def unprotect(self):
        cfg = bytearray(self.raw)
        cfg[0], cfg[1] = 0xA5, 0x5A
        cfg[8:12] = b"\xff" * 4
        self.xfer(WRITE_CONFIG, bytes([0x07, 0]) + bytes(cfg))
        self.end()

    def send_key(self):
        r = self.xfer(ISP_KEY, bytes(0x1E))
        if r[0] != sum(self.key) & 0xFF:
            raise IspError("bootloader rejected the session key")

    def chunk(self, addr, data):
        return addr.to_bytes(4, "little") + secrets.token_bytes(1) + bytes(b ^ self.key[i % 8] for i, b in enumerate(data))

    def erase_all(self):
        self.xfer(ERASE, (APP_LIMIT // SECTOR).to_bytes(4, "little"), 5000)

    def program(self, image, progress):
        self.send_key()
        for a in range(0, len(image), CHUNK):
            self.xfer(PROGRAM, self.chunk(a, image[a:a + CHUNK]), 2000)
            progress(min(a + CHUNK, len(image)) / len(image))
        self.xfer(PROGRAM, self.chunk(len(image), b""), 2000)

    def verify(self, image, progress):
        self.send_key()
        for a in range(0, len(image), CHUNK):
            if self.xfer(VERIFY, self.chunk(a, image[a:a + CHUNK]), 2000)[0] != 0:
                raise IspError(f"verify failed at 0x{a:04x}")
            progress(min(a + CHUNK, len(image)) / len(image))

    def ping(self):
        """Any request keeps the bootloader from timing out; this one changes nothing."""
        self.xfer(READ_CONFIG, [0x1F, 0])

    def end(self):
        try:
            self.xfer(ISP_END, [1], 500)
        except (usb.core.USBError, IspError):
            pass


# ---------------------------------------------------------------- the rig
def port_path(dev):
    return f"{dev.bus}-" + ".".join(str(p) for p in (dev.port_numbers or ()))


class Slot:
    def __init__(self, path, number):
        self.path, self.number = path, number
        self.state, self.detail, self.uid, self.t = "waiting", "", "", time.time()
        self.progress = 0.0      # 0..1 through the whole job, for the dashboard
        self.started = None
        self.busy = self.plugged = False
        self.isp = None          # batch mode: the open bootloader, waiting its turn
        self.btver = ""
        self.io = threading.Lock()   # one user of self.isp at a time (keep-alive vs flashing)


class Rig:
    def __init__(self, a):
        self.a = a
        self.image = open(a.image, "rb").read()
        if len(self.image) > APP_LIMIT:
            raise SystemExit("image is larger than the flash")
        self.padded = self.image + b"\0" * (-len(self.image) % SECTOR)
        self.sha = hashlib.sha256(self.image).hexdigest()
        m = re.search(rb"ldr=([0-9A-Za-z.\-]+)", self.image[:0x3F00])
        self.loader_ver = m.group(1).decode() if m else "?"
        self.with_app = len(self.image) > 0x4000
        self.slots, self.lock = {}, threading.Lock()
        self.passed = self.failed = 0
        self.prev = set()
        self.claimed = set()     # serial ports a worker has already taken
        self.recent = collections.deque(maxlen=50)
        self.started = time.time()
        self.settings_path = os.path.join(HERE, "rig-settings.json")
        self.mode = a.mode or self.load_settings().get("mode", "auto")
        self.batch = None        # {"total", "done", "cancel"} while a batch runs
        new = not os.path.exists(a.log)
        self.log = open(a.log, "a", newline="")
        self.csv = csv.writer(self.log)
        if new:
            self.csv.writerow(["time", "slot", "port", "result", "detail", "isp_uid", "bootloader",
                               "hello", "image", "image_sha256"])
            self.log.flush()

    def load_settings(self):
        try:
            with open(self.settings_path) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def set_mode(self, mode):
        if mode not in ("auto", "batch"):
            return
        self.mode = mode
        try:
            with open(self.settings_path, "w") as f:
                json.dump({"mode": mode}, f)
        except OSError:
            pass
        if mode == "auto":
            self.start_batch()   # anything already waiting goes now

    def ready_slots(self):
        with self.lock:
            return sorted((s for s in self.slots.values() if s.state == "ready" and s.isp), key=lambda s: s.number)

    def start_batch(self):
        """Flash the waiting boards one at a time, in port order."""
        with self.lock:
            if self.batch:
                return False
            self.batch = {"total": 0, "done": 0, "cancel": False}
        threading.Thread(target=self.run_batch, daemon=True).start()
        return True

    def run_batch(self):
        b = self.batch
        try:
            while not b["cancel"]:
                queue = self.ready_slots()
                b["total"] = b["done"] + len(queue)
                if not queue:
                    break
                s = queue[0]
                s.busy = True
                self.work(s, isp=s.isp)
                b["done"] += 1
        finally:
            with self.lock:
                self.batch = None

    def cancel_batch(self):
        if self.batch:
            self.batch["cancel"] = True

    def prepare(self, dev, s):
        """Batch mode: connect, identify, and hold the board in the bootloader until its turn."""
        try:
            with s.io:
                self.set(s, "connecting")
                s.started = None
                isp = Isp(dev)
                try:
                    isp.identify()
                except Exception:
                    isp.close()
                    raise
                s.uid, s.btver, s.isp = isp.uid.hex().upper(), isp.btver, isp
                self.set(s, "ready")
                s.progress = 0.0
        except (IspError, usb.core.USBError, OSError) as e:
            self.set(s, "FAIL", f"couldn't connect: {e}")
            self.record(s, "FAIL", f"couldn't connect: {e}", s.uid)
        finally:
            s.busy = False

    def keep_awake(self):
        """Batch mode: ping every waiting bootloader once a second so it doesn't time out."""
        while True:
            time.sleep(1.0)
            for s in self.ready_slots():
                if not s.io.acquire(blocking=False):
                    continue
                try:
                    if s.state == "ready" and s.isp:
                        s.isp.ping()
                except (IspError, usb.core.USBError, OSError):
                    self.drop(s, "left the bootloader before its turn (unplugged?)")
                finally:
                    s.io.release()

    def drop(self, s, why=""):
        if s.isp:
            s.isp.close()
            s.isp = None
        if s.state == "ready":
            self.set(s, "waiting", why)
            s.uid = ""

    def slot(self, path):
        with self.lock:
            if path not in self.slots:
                self.slots[path] = Slot(path, len(self.slots) + 1)
            return self.slots[path]

    def record(self, s, result, detail, isp_uid="", btver="", hello=""):
        with self.lock:
            if result == "PASS": self.passed += 1
            else: self.failed += 1
            now = datetime.datetime.now().isoformat(timespec="seconds")
            self.csv.writerow([now, s.number, s.path, result, detail,
                               isp_uid, btver, hello, os.path.basename(self.a.image), self.sha])
            self.log.flush()
            uid = re.search(r"\buid=(\S+)", hello)
            self.recent.appendleft({"time": now, "slot": s.number, "result": result, "detail": detail,
                                    "chip": isp_uid, "id": uid.group(1) if uid else "",
                                    "secs": round(time.time() - s.started, 1) if s.started else None})

    # Where each step starts in the overall progress bar.
    STEPS = {"connecting": 0.0, "unlocking": 0.02, "erasing": 0.03, "writing": 0.08, "verifying": 0.7,
             "restarting": 0.9, "checking": 0.97, "PASS": 1.0, "FAIL": None}

    def set(self, s, state, detail=""):
        s.state, s.detail, s.t = state, detail, time.time()
        if state == "connecting":
            s.started = time.time()
        p = self.STEPS.get(state)
        if p is not None:
            s.progress = p

    def step_progress(self, s, lo, hi):
        def cb(f):
            s.detail = f"{f:.0%}"
            s.progress = lo + (hi - lo) * f
        return cb

    def find_serial(self, s, before, timeout=20.0):
        """The Keep Alive port that appears after the restart: same hub port if the OS says, else the new one."""
        t0 = time.time()
        while time.time() - t0 < timeout:
            ports = [p for p in serial.tools.list_ports.comports() if (p.vid, p.pid) == KA_ID]
            for p in ports:
                loc = (p.location or "").split(":")[0]
                if loc and loc == s.path:
                    return p.device
            with self.lock:
                fresh = [p.device for p in ports if p.device not in before and p.device not in self.claimed]
                if len(fresh) == 1:
                    self.claimed.add(fresh[0])
                    return fresh[0]
            time.sleep(0.2)
        return None

    def hello(self, dev_path):
        with serial.Serial(dev_path, 115200, timeout=1) as sp:
            sp.dtr = True
            time.sleep(0.1)
            sp.reset_input_buffer()
            for _ in range(3):
                sp.write(b"HELLO\n")
                line = sp.readline().decode(errors="replace").strip()
                if line.startswith("OK"):
                    return line
            return line

    def work(self, s, dev=None, isp=None):
        isp_uid = btver = ""
        s.io.acquire()
        try:
            if isp is None:
                self.set(s, "connecting")
                isp = Isp(dev)
                isp.identify()
            else:
                self.set(s, "connecting")
            s.isp = None
            isp_uid, btver = isp.uid.hex().upper(), isp.btver
            s.uid = isp_uid
            if isp.protected:
                self.set(s, "unlocking")
                isp.unprotect()
                raise IspError("chip was read-protected: unlocked (this erased it); unplug and plug in again")
            self.set(s, "erasing")
            isp.erase_all()
            self.set(s, "writing", "0%")
            isp.program(self.padded, self.step_progress(s, 0.08, 0.7))
            self.set(s, "verifying", "0%")
            isp.verify(self.padded, self.step_progress(s, 0.7, 0.9))
            before = {p.device for p in serial.tools.list_ports.comports()}
            self.set(s, "restarting")
            isp.end()
            isp.close()
            isp = None
            port = self.find_serial(s, before)
            if not port:
                raise IspError("loader didn't appear as a serial port after the restart")
            self.set(s, "checking")
            line = self.hello(port)
            with self.lock:
                self.claimed.discard(port)
            kv = dict(x.split("=", 1) for x in line.split() if "=" in x)
            if not line.startswith("OK KA-LOADER"):
                raise IspError(f"unexpected answer: {line[:60]!r}")
            if kv.get("ldr") != self.loader_ver:
                raise IspError(f"loader {kv.get('ldr')} answered, expected {self.loader_ver}")
            if not self.with_app and kv.get("app") != "none":
                raise IspError(f"firmware {kv.get('app')} still installed")
            if self.with_app and kv.get("app") in (None, "none"):
                raise IspError("firmware missing after flashing")
            self.set(s, "PASS", f"loader {kv['ldr']}  id {kv.get('uid', '?')}")
            self.record(s, "PASS", "", isp_uid, btver, line)
        except (IspError, usb.core.USBError, serial.SerialException, OSError) as e:
            self.set(s, "FAIL", str(e))
            self.record(s, "FAIL", str(e), isp_uid, btver)
        finally:
            if isp:
                isp.close()
            s.busy = False
            s.io.release()

    def scan(self):
        # A board is started on when its bootloader appears; one that stays in the
        # bootloader after a failure is retried only once it's unplugged and back.
        present = set()
        for vid, pid in BOOT_IDS:
            for dev in usb.core.find(find_all=True, idVendor=vid, idProduct=pid):
                path = port_path(dev)
                present.add(path)
                s = self.slot(path)
                if not s.busy and path not in self.prev and not s.isp:
                    s.busy, s.plugged = True, True
                    if self.mode == "auto" and not self.batch:
                        threading.Thread(target=self.work, args=(s, dev), daemon=True).start()
                    else:
                        threading.Thread(target=self.prepare, args=(dev, s), daemon=True).start()
        self.prev = present
        # A waiting board that was unplugged leaves the queue.
        for s in self.ready_slots():
            if s.path not in present and s.io.acquire(blocking=False):
                try:
                    self.drop(s)
                finally:
                    s.io.release()
        # Show "unplug" until the finished board is gone from the port.
        ka_locs = {(p.location or "").split(":")[0] for p in serial.tools.list_ports.comports() if (p.vid, p.pid) == KA_ID}
        ka_any = bool(ka_locs)
        for s in self.slots.values():
            if not s.busy:
                s.plugged = s.path in present or s.path in ka_locs or (ka_any and "" in ka_locs)
        return present

    def draw(self):
        G, R, Y, D, B, X = "\033[42;30m", "\033[41;97m", "\033[43;30m", "\033[2m", "\033[1m", "\033[0m"
        out = ["\033[H\033[2J", f"{B}Keep Alive rig{X}   image {os.path.basename(self.a.image)}  "
               f"(loader {self.loader_ver}{', with firmware' if self.with_app else ''})", ""]
        with self.lock:
            slots = sorted(self.slots.values(), key=lambda s: s.number)
            for s in slots:
                if s.state == "PASS": tag = f"{G} PASS {X}"
                elif s.state == "FAIL": tag = f"{R} FAIL {X}"
                elif s.state == "ready": tag = f"\033[44;97m READY{X}"
                elif s.state == "waiting": tag = f"{D} ---- {X}"
                else: tag = f"{Y} BUSY {X}"
                note = s.detail if s.state in ("PASS", "FAIL") else f"{s.state} {s.detail}"
                if s.state in ("PASS", "FAIL") and s.plugged:
                    note += f"{D}   unplug{X}"
                out.append(f" {B}{s.number:>2}{X} {tag}  {note[:70]}")
            if not slots:
                out.append(" Plug boards into the hub (hold BOOT if they don't appear).")
            out += ["", f" passed {self.passed}   failed {self.failed}   log {self.a.log}"]
            if self.mode == "batch":
                n = sum(1 for x in self.slots.values() if x.state == "ready" and x.isp)
                b = self.batch
                out.append(f" {B}Batch mode{X}: " + (f"flashing {b['done'] + 1} of {b['total']}" if b else
                           f"{n} ready. Press Enter to flash them." if n else "plug boards in with BOOT held; press Enter to flash them."))
        sys.stdout.write("\n".join(out) + "\n")
        sys.stdout.flush()

    def snapshot(self):
        with self.lock:
            slots = [{"n": s.number, "port": s.path, "state": s.state, "detail": s.detail, "chip": s.uid,
                      "progress": s.progress, "plugged": s.plugged, "busy": s.busy,
                      "secs": round(time.time() - s.started, 1) if s.started and s.busy else None}
                     for s in sorted(self.slots.values(), key=lambda s: s.number)]
            ready = sorted((x for x in self.slots.values() if x.state == "ready" and x.isp), key=lambda x: x.number)
            for d in slots:
                q = [x.number for x in ready]
                d["queue"] = q.index(d["n"]) + 1 if d["n"] in q else None
            b = self.batch
            return {"mode": self.mode, "ready": len(ready),
                    "batch": {"total": b["total"], "done": b["done"], "cancel": b["cancel"]} if b else None,
                    "image": os.path.basename(self.a.image), "loader": self.loader_ver, "with_app": self.with_app,
                    "sha": self.sha[:12], "passed": self.passed, "failed": self.failed,
                    "log": os.path.abspath(self.a.log), "slots": slots, "recent": list(self.recent)}

    def serve(self, port, host):
        rig = self
        page = os.path.join(HERE, "dashboard.html")

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send(self, code, ctype, body, extra=()):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-store")
                for k, v in extra:
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                path = self.path.split("?")[0]
                if path in ("/", "/index.html"):
                    self.send(200, "text/html; charset=utf-8", open(page, "rb").read())
                elif path == "/state":
                    self.send(200, "application/json", json.dumps(rig.snapshot()).encode())
                elif path == "/log.csv":
                    with rig.lock:
                        rig.log.flush()
                        data = open(rig.a.log, "rb").read()
                    self.send(200, "text/csv", data, [("Content-Disposition", 'attachment; filename="rig-log.csv"')])
                else:
                    self.send(404, "text/plain", b"not found")

            def do_POST(self):
                path, _, q = self.path.partition("?")
                if path == "/mode":
                    rig.set_mode(q.replace("m=", ""))
                elif path == "/start":
                    rig.start_batch()
                elif path == "/cancel":
                    rig.cancel_batch()
                else:
                    return self.send(404, "text/plain", b"not found")
                self.send(200, "application/json", json.dumps(rig.snapshot()).encode())

        srv = http.server.ThreadingHTTPServer((host, port), Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        print(f"Keep Alive rig dashboard: http://{'localhost' if host in ('127.0.0.1', '') else host}:{port}/   (Ctrl+C to stop)")
        sys.stdout.flush()

    def stdin_commands(self):
        for line in sys.stdin:
            if self.mode == "batch":
                self.start_batch()

    def run(self):
        last = 0
        threading.Thread(target=self.keep_awake, daemon=True).start()
        if self.a.web:
            self.serve(self.a.web, self.a.listen)
        elif sys.stdin.isatty():
            threading.Thread(target=self.stdin_commands, daemon=True).start()
        while True:
            present = self.scan()
            if not self.a.web and time.time() - last > 0.25:
                self.draw()
                last = time.time()
            if self.a.once and self.slots and not self.batch and not any(s.busy or s.state == "ready" for s in self.slots.values()):
                if not self.a.web:
                    self.draw()
                return 0 if not self.failed else 1
            time.sleep(0.1)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--image", default=DEFAULT_IMAGE, help="factory image (default: loader only)")
    p.add_argument("--log", default=os.path.join(HERE, "rig-log.csv"), help="CSV log, appended to")
    p.add_argument("--once", action="store_true", help="exit when every connected board is done")
    p.add_argument("--mode", choices=["auto", "batch"], help="start in this mode (default: the last one used)")
    p.add_argument("--web", type=int, metavar="PORT", help="show a dashboard on this port instead of the terminal view")
    p.add_argument("--listen", default="127.0.0.1",
                   help="address for the dashboard (default: this computer only; 0.0.0.0 lets others on the network watch)")
    a = p.parse_args()
    try:
        sys.exit(Rig(a).run())
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
