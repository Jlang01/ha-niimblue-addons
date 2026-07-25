#!/usr/bin/env python3
"""Bluetooth print server for the NiimBlue add-on.

Exposes the same REST surface the designer's injected button already uses
(POST /print with imageBase64), but prints over the HOST's internal Bluetooth
adapter. It shells out to `niimprint`, whose Bluetooth backend is a Bluetooth
*Classic* RFCOMM (SPP) socket (AF_BLUETOOTH). That socket is arbitrated by the
kernel/BlueZ, so it COEXISTS with Home Assistant's Bluetooth integration on one
adapter — no exclusive HCI grab, no USB dongle.

NOTE: Classic SPP, not BLE. The printer must support Classic and be paired.

Endpoints (nginx proxies /api/ -> here):
  POST /print      {imageBase64, density?, printTask?/model?, quantity?, rotate?}
  GET  /connected  {connected, battery}
  GET  /info       {printerInfo:{}}
  GET  /scan       {devices:[{name,address}]}   (bluetoothctl known/scanned)
"""
import base64
import io
import json
import os
import re
import subprocess
import tempfile
import threading

from flask import Flask, jsonify, request
from PIL import Image

app = Flask(__name__)


def opt(name, default):
    v = os.environ.get(name)
    return v if v not in (None, "") else default


MODEL = opt("MODEL", "b21").lower()
ADDRESS = opt("ADDRESS", "").upper()
DENSITY = int(opt("DENSITY", "3"))
ROTATE = str(opt("ROTATE", "0"))
MAX_WIDTH = 384 if MODEL in ("b1", "b18", "b21") else 96

# When the 'address' option is blank, the MAC paired via the setup page is
# persisted here (add-on can't write the Supervisor-managed options.json).
PAIRED_FILE = "/data/paired.json"

_lock = threading.Lock()                # serialize BT ops (one radio, channel 1)
_last_print_ok = False


_MAC_RE = re.compile(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$")


def current_address():
    """Configured 'address' option wins; else the MAC saved by the setup page."""
    if ADDRESS:
        return ADDRESS
    try:
        with open(PAIRED_FILE) as f:
            a = (json.load(f).get("address") or "").upper()
        return a if _MAC_RE.match(a) else None
    except (OSError, ValueError):
        return None


# ---- image prep ----------------------------------------------------------
def pad_to_8(img):
    """Encoder packs 8 px/byte; pad both dims to a multiple of 8 (white)."""
    w, h = img.size
    w8 = (w + 7) // 8 * 8
    h8 = (h + 7) // 8 * 8
    if (w8, h8) == (w, h):
        return img
    canvas = Image.new("RGB", (w8, h8), "white")
    canvas.paste(img.convert("RGB"), (0, 0))
    return canvas


# ---- niimprint CLI (Bluetooth Classic RFCOMM) ---------------------------
def run_niimprint(png_path, addr, model, density, rotate):
    cmd = [
        "python3", "-m", "niimprint",
        "-c", "bluetooth",
        "-a", addr,
        "-m", model,
        "-d", str(density),
        "-r", str(rotate),
        "-i", png_path,
    ]
    app.logger.info("exec: %s", " ".join(cmd))
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "niimprint failed").strip())
    return (p.stdout or "").strip()


# ---- bluetoothctl discovery + pairing (Classic) -------------------------
_DEV_RE = re.compile(r"Device\s+([0-9A-F:]{17})\s+(.*)", re.I)


def _bctl(args, timeout=25):
    return subprocess.run(["bluetoothctl", *args], capture_output=True,
                          text=True, timeout=timeout)


def device_info(mac):
    """Full `bluetoothctl info` text, or '' on failure."""
    try:
        return _bctl(["info", mac], timeout=12).stdout
    except Exception:
        return ""


def has_spp(mac, info=None):
    """True if the device advertises the Serial Port (SPP) UUID — the address
    niimprint's RFCOMM socket needs (NIIMBOT exposes two addresses)."""
    txt = info if info is not None else device_info(mac)
    return "Serial Port" in txt


def looks_like_printer(name):
    n = (name or "").upper()
    return bool(re.match(r"^(B1|B18|B21|D11|D110)\b", n))


def bt_devices(scan_seconds=0, check_spp=True):
    devs = {}
    try:
        if scan_seconds > 0:
            subprocess.run(["bluetoothctl", "--timeout", str(int(scan_seconds)),
                            "scan", "on"], capture_output=True, text=True,
                           timeout=scan_seconds + 5)
        out = _bctl(["devices"], timeout=10).stdout
        for line in out.splitlines():
            m = _DEV_RE.search(line)
            if m:
                devs[m.group(1).upper()] = m.group(2).strip()
    except Exception as e:  # bluetoothctl absent / no adapter
        app.logger.warning("bluetoothctl failed: %s", e)
    result = []
    for a, n in devs.items():
        entry = {"address": a, "name": n, "likely_printer": looks_like_printer(n)}
        if check_spp:
            entry["spp"] = has_spp(a)
        result.append(entry)
    # printers first, then SPP-capable
    result.sort(key=lambda d: (not d["likely_printer"], not d.get("spp")))
    return result


def pair_device(mac):
    """Pair + trust via BlueZ (a NoInputNoOutput bt-agent auto-accepts). The
    NIIMBOT SPP link works even if profile-connect reports NotAvailable."""
    steps = {}
    try:
        subprocess.run(["bluetoothctl", "--timeout", "8", "scan", "on"],
                       capture_output=True, text=True, timeout=15)
    except Exception as e:
        steps["scan"] = str(e)
    for cmd in (["pair", mac], ["trust", mac], ["connect", mac]):
        try:
            r = _bctl(cmd, timeout=30)
            steps[cmd[0]] = (r.stdout + r.stderr).strip().splitlines()[-1:] or [""]
            steps[cmd[0]] = steps[cmd[0]][0]
        except Exception as e:
            steps[cmd[0]] = str(e)
    info = device_info(mac)
    return steps, has_spp(mac, info)


# ---- routes --------------------------------------------------------------
@app.post("/print")
def print_label():
    global _last_print_ok
    data = request.get_json(force=True, silent=True) or {}
    b64 = data.get("imageBase64")
    if not b64:
        return jsonify(error="imageBase64 missing"), 400
    addr = current_address()
    if not addr:
        return jsonify(error="no printer address; pair one on the setup page "
                             "(./setup.html) or set 'address' in the add-on "
                             "options"), 503

    model = str(data.get("printTask") or data.get("model") or MODEL).lower()
    density = int(data.get("density") or DENSITY)
    rotate = str(data.get("rotate") or ROTATE)
    quantity = int(data.get("quantity") or 1)

    try:
        raw = base64.b64decode(b64)
        img = pad_to_8(Image.open(io.BytesIO(raw)))
    except Exception as e:
        return jsonify(error="bad image: %s" % e), 400

    # niimprint refuses images wider than the printhead.
    eff_w = img.height if rotate in ("90", "270") else img.width
    if eff_w > MAX_WIDTH:
        return jsonify(error="image %dpx wide exceeds %s printhead (%dpx); "
                             "resize the label" % (eff_w, model.upper(), MAX_WIDTH)), 400

    with _lock:
        tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        try:
            img.save(tmp.name, "PNG")
            tmp.close()
            out = ""
            for _ in range(max(1, quantity)):
                out = run_niimprint(tmp.name, addr, model, density, rotate)
            _last_print_ok = True
            return jsonify(ok=True, address=addr, output=out)
        except Exception as e:
            _last_print_ok = False
            return jsonify(error=str(e)), 500
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
            # niimprint already closed its RFCOMM socket when the process exited;
            # also tell BlueZ to drop the ACL link so HA fully regains the radio
            # between prints (connect-on-demand, no lingering connection).
            try:
                _bctl(["disconnect", addr], timeout=8)
            except Exception:
                pass


@app.get("/connected")
def connected():
    # RFCOMM is connect-on-demand; report reachable if a MAC is known.
    return jsonify(connected=bool(current_address()), battery=None)


@app.get("/info")
def info():
    return jsonify(printerInfo={})


@app.get("/scan")
def scan():
    try:
        secs = int(request.args.get("seconds", "8"))
        spp = request.args.get("spp", "1") not in ("0", "false", "no")
        return jsonify(devices=bt_devices(secs, check_spp=spp),
                       current=current_address())
    except Exception as e:
        return jsonify(error=str(e), devices=[]), 500


@app.post("/pair")
def pair():
    """Pair the given MAC and remember it (used when 'address' option is blank).
    Body: {"address": "AA:BB:CC:DD:EE:FF"}"""
    if ADDRESS:
        return jsonify(error="'address' is set in add-on options; clear it to "
                             "pair from here"), 409
    data = request.get_json(force=True, silent=True) or {}
    mac = (data.get("address") or "").upper()
    if not _MAC_RE.match(mac):
        return jsonify(error="invalid MAC address"), 400
    with _lock:
        steps, spp = pair_device(mac)
        try:
            with open(PAIRED_FILE, "w") as f:
                json.dump({"address": mac, "spp": spp}, f)
        except OSError as e:
            return jsonify(error="paired but could not save: %s" % e,
                           steps=steps, spp=spp), 500
    return jsonify(ok=True, address=mac, spp=spp, steps=steps,
                   warning=None if spp else "This address does NOT advertise the "
                   "Serial Port (SPP) profile. NIIMBOT exposes two addresses — "
                   "printing may fail; try the other one.")


@app.post("/forget")
def forget():
    try:
        os.unlink(PAIRED_FILE)
    except OSError:
        pass
    return jsonify(ok=True)


@app.get("/health")
def health():
    return jsonify(ok=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5001"))
    app.run(host="0.0.0.0", port=port, threaded=True)
