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

_lock = threading.Lock()                # serialize BT ops (one radio, channel 1)
_last_print_ok = False


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


# ---- bluetoothctl discovery (Classic) -----------------------------------
_DEV_RE = re.compile(r"Device\s+([0-9A-F:]{17})\s+(.*)", re.I)


def bt_devices(scan_seconds=0):
    devs = {}
    try:
        if scan_seconds > 0:
            subprocess.run(["bluetoothctl", "--timeout", str(int(scan_seconds)),
                            "scan", "on"], capture_output=True, text=True,
                           timeout=scan_seconds + 5)
        out = subprocess.run(["bluetoothctl", "devices"], capture_output=True,
                             text=True, timeout=10).stdout
        for line in out.splitlines():
            m = _DEV_RE.search(line)
            if m:
                devs[m.group(1).upper()] = m.group(2).strip()
    except Exception as e:  # bluetoothctl absent / no adapter
        app.logger.warning("bluetoothctl failed: %s", e)
    return [{"address": a, "name": n} for a, n in devs.items()]


# ---- routes --------------------------------------------------------------
@app.post("/print")
def print_label():
    global _last_print_ok
    data = request.get_json(force=True, silent=True) or {}
    b64 = data.get("imageBase64")
    if not b64:
        return jsonify(error="imageBase64 missing"), 400
    if not ADDRESS:
        return jsonify(error="no 'address' set; pair the printer and set its "
                             "Bluetooth MAC in the add-on options"), 503

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
                out = run_niimprint(tmp.name, ADDRESS, model, density, rotate)
            _last_print_ok = True
            return jsonify(ok=True, address=ADDRESS, output=out)
        except Exception as e:
            _last_print_ok = False
            return jsonify(error=str(e)), 500
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass


@app.get("/connected")
def connected():
    # RFCOMM is connect-on-demand; report reachable if a MAC is configured.
    return jsonify(connected=bool(ADDRESS), battery=None)


@app.get("/info")
def info():
    return jsonify(printerInfo={})


@app.get("/scan")
def scan():
    try:
        secs = int(request.args.get("seconds", "8"))
        return jsonify(devices=bt_devices(secs))
    except Exception as e:
        return jsonify(error=str(e), devices=[]), 500


@app.get("/health")
def health():
    return jsonify(ok=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5001"))
    app.run(host="0.0.0.0", port=port, threaded=True)
