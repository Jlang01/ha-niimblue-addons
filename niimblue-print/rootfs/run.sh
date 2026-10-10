#!/usr/bin/env bash
set -euo pipefail

OPT=/data/options.json
log() { echo "[niimblue] $*"; }

# ---- read options -------------------------------------------------------
opt() { jq -r --arg d "$2" ".${1} // \$d" "$OPT"; }
TRANSPORT=$(opt transport serial)
ADDRESS=$(opt address "")
MODEL=$(opt model "")   # empty = let the server auto-detect printTask on connect
LW=$(opt label_width 0)
LH=$(opt label_height 0)
DIR=$(opt print_direction top)
DENSITY=$(opt density 3)
THRESHOLD=$(opt threshold 128)
FIT=$(opt image_fit contain)
RECONNECT=$(opt reconnect_seconds 10)
# NB: jq '//' treats false AND 0 as fallback-trigger; read 0-able ints explicitly.
IDLE_DISCONNECT=$(jq -r 'if .idle_disconnect_seconds == null then 60 else .idle_disconnect_seconds end' "$OPT")
# NB: jq '//' treats false as fallback-trigger, so read booleans explicitly.
MQTT_ENABLED=$(jq -r 'if .mqtt_enabled == null then true else .mqtt_enabled end' "$OPT")
LOG_LEVEL=$(opt log_level info)

# The printer may be off / unplugged / out of range at start: that is fine.
# The print server keeps looking for it and reports state on GET /status.
if [ "$TRANSPORT" = "serial" ]; then
  log "Transport: USB serial, device: ${ADDRESS:-auto-detect (NIIMBOT USB 3513:xxxx)}"
  log "Serial devices visible now:"
  found=0
  for d in /dev/serial/by-id/* /dev/ttyACM* /dev/ttyUSB*; do
    [ -e "$d" ] && { log "  $d"; found=1; }
  done
  [ "$found" = 1 ] || log "  (none — waiting for the printer)"
else
  # BLE through BlueZ over D-Bus (host_dbus) — shares the adapter with Home
  # Assistant's Bluetooth integration. noble picks its dbus binding from env.
  export NOBLE_BINDINGS=dbus
  export DBUS_SYSTEM_BUS_ADDRESS="unix:path=/run/dbus/system_bus_socket"
  log "Transport: Bluetooth LE via BlueZ (D-Bus), printer: ${ADDRESS:-auto-discover by name}"
  if [ ! -S /run/dbus/system_bus_socket ]; then
    log "WARNING: host D-Bus socket missing — Bluetooth cannot work (host_dbus not granted?)"
  fi
fi

# ---- generate designer config (read by injected button) ----------------
cat > /opt/niimblue/config.js <<EOF
// Generated at runtime from add-on options.
window.NIIMBLUE_HOST = {
  model: "${MODEL}",
  printDirection: "${DIR}",
  labelWidth: ${LW:-0},
  labelHeight: ${LH:-0},
  density: ${DENSITY},
  threshold: ${THRESHOLD},
  imageFit: "${FIT}",
  transport: "${TRANSPORT}",
  // API is proxied by nginx under the ingress path at ./api/
  apiBase: "api"
};
EOF

# ---- nginx (ingress) in background -------------------------------------
log "Starting nginx (ingress) on :8099 ..."
nginx -g "daemon off;" &

# ---- MQTT discovery (polls the server until it is up) ------------------
export TRANSPORT ADDRESS RECONNECT MODEL IDLE_DISCONNECT LOG_LEVEL
if [ "$MQTT_ENABLED" = "true" ]; then
  /usr/local/bin/mqtt-discovery.sh &
fi

# ---- print server, supervised in the FOREGROUND ------------------------
# This loop IS the main run.sh process (PID 1, init: false), so it keeps the
# server alive: a serial write EIO can still kill the node process despite the
# lib patch — restart it so /api stays up and returns JSON errors instead of
# nginx 502s. On add-on stop, forward TERM so the server releases the printer
# (drops the Bluetooth link) before the container goes away.
# Bind 0.0.0.0 so HA core rest_command can also reach it on :5000.
export HOST=0.0.0.0 PORT=5000
log "Starting niimblue print server on :5000 ..."
child=""
stopping=0
trap 'stopping=1; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null' TERM INT
while [ "$stopping" = 0 ]; do
  node /usr/local/bin/print-server.js &
  child=$!
  # 'wait' returns early when the trap fires; wait again for a clean exit.
  wait "$child" || true
  [ "$stopping" = 1 ] && { wait "$child" 2>/dev/null || true; break; }
  log "print server exited, restarting in 2s"
  sleep 2
done
log "Stopped."
