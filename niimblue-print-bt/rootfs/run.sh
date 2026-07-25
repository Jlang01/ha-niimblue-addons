#!/usr/bin/env bash
set -euo pipefail

OPT=/data/options.json
log() { echo "[niimblue-bt] $*"; }

# ---- read options -------------------------------------------------------
opt() { jq -r --arg d "$2" ".${1} // \$d" "$OPT"; }
ADDRESS=$(opt address "")
MODEL=$(opt model "b21")
DENSITY=$(opt density 3)
ROTATE=$(opt rotate 0)
# NB: jq '//' treats false as fallback-trigger, so read booleans explicitly.
MQTT_ENABLED=$(jq -r 'if .mqtt_enabled == null then true else .mqtt_enabled end' "$OPT")
LOG_LEVEL=$(opt log_level info)

PRINT_PORT=5001

# ---- generate designer config (read by injected print button) ----------
cat > /opt/niimblue/config.js <<EOF
// Generated at runtime from add-on options.
window.NIIMBLUE_HOST = {
  model: "${MODEL}",
  density: ${DENSITY},
  // API is proxied by nginx under the ingress path at ./api/
  apiBase: "api"
};
EOF

# ---- nginx (ingress) in background -------------------------------------
log "Starting nginx (ingress) on :8099 ..."
nginx -g "daemon off;" &

# ---- Bluetooth: power the adapter + a Just Works pairing agent ----------
# bt-agent (NoInputNoOutput) auto-accepts pairing so the setup page can pair
# the printer without any PIN/prompt. Needs host_dbus -> host BlueZ.
bluetoothctl --timeout 3 power on >/dev/null 2>&1 || true
if command -v bt-agent >/dev/null 2>&1; then
  log "Starting Bluetooth pairing agent (NoInputNoOutput) ..."
  bt-agent -c NoInputNoOutput >/dev/null 2>&1 &
fi

# ---- MQTT discovery (optional) -----------------------------------------
export MODEL ADDRESS PRINT_PORT
export RECONNECT=10
export TRANSPORT="bluetooth"
if [ "$MQTT_ENABLED" = "true" ]; then
  /usr/local/bin/mqtt-discovery.sh &
fi

if [ -z "$ADDRESS" ]; then
  log "WARNING: no 'address' set. Pair the printer and set its Bluetooth MAC in options."
  log "Tip: browse the Web UI API at ./api/scan to list nearby devices."
else
  log "Using Bluetooth address: $ADDRESS (model=${MODEL})"
fi

# ---- Bluetooth print server, supervised in the FOREGROUND --------------
export MODEL ADDRESS DENSITY ROTATE PORT="$PRINT_PORT"
log "Starting Bluetooth print server on :${PRINT_PORT} ..."
while true; do
  python3 /usr/local/bin/print-server.py || true
  log "print server exited, restarting in 2s"
  sleep 2
done
