#!/usr/bin/env bash
# Crash-proof the niimbluelib node serial client.
#
# Upstream calls this.device.write(Buffer.from(data)) with NO callback. When the
# write fails (EIO on some printers, e.g. B21S_C2B over USB), node-serialport
# emits an unhandled 'error' event that KILLS the whole server process. We:
#   1. give write() a callback so the error is delivered, not thrown globally
#   2. attach an 'error' listener on the port
# Both are idempotent string patches on the readable CJS build.
set -euo pipefail

# Runs at image build time (Dockerfile). Arg: node_modules root to search.
ROOT=${1:-/usr/local/lib/niimblue-print/node_modules}
F=$(find "$ROOT" -path '*niimbluelib/dist/cjs/client/node_serial_impl.js' 2>/dev/null | head -1)
if [ -z "$F" ]; then
  echo "[patch] node_serial_impl.js not found under $ROOT (niimbluelib layout changed?)"
  exit 1
fi
echo "[patch] patching $F"

# 1) write() with error callback (only if not already patched)
if grep -q 'this.device.write(Buffer.from(data));' "$F"; then
  sed -i 's|this.device.write(Buffer.from(data));|this.device.write(Buffer.from(data), function (e) { if (e) console.error("serial write error:", e \&\& e.message); });|' "$F"
  echo "[patch]  - write() callback added"
fi

# 2) port 'error' listener right after the port is assigned
if grep -q 'this.device = _port;' "$F" && ! grep -q 'serial port error:' "$F"; then
  sed -i 's|this.device = _port;|this.device = _port; _port.on("error", function (e) { console.error("serial port error:", e \&\& e.message); });|' "$F"
  echo "[patch]  - port error listener added"
fi

# verify
grep -q 'serial write error:' "$F" && echo "[patch] OK" || { echo "[patch] FAILED to apply write patch"; exit 1; }
