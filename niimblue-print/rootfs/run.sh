#!/usr/bin/env bash
set -euo pipefail

OPT=/data/options.json
log() { echo "[niimblue] $*"; }

# ---- read options -------------------------------------------------------
# NB: jq '//' treats false AND 0 as "missing", so booleans and 0-able numbers
# are read with an explicit null check.
opt() { jq -r --arg d "$2" ".${1} // \$d" "$OPT"; }
optn() { jq -r --arg d "$2" "if .${1} == null then \$d else .${1} end" "$OPT"; }
TRANSPORT=$(opt transport auto)
ADDRESS=$(opt address "")
MODEL=$(opt model "")   # empty = auto-detect printTask on connect (B21S -> B1)
LW=$(optn label_width 0)
LH=$(optn label_height 0)
DIR=$(opt print_direction top)
DENSITY=$(optn density 0)          # 0 = the printer model's default
THRESHOLD=$(opt threshold 128)
FIT=$(opt image_fit contain)
RECONNECT=$(opt reconnect_seconds 10)
IDLE_DISCONNECT=$(optn idle_disconnect_seconds 60)
DISCONNECT_AFTER_PRINT=$(optn disconnect_after_print true)
WAIT_TIMEOUT=$(optn wait_timeout 30)
QUEUE_MAX_AGE_HOURS=$(optn queue_max_age_hours 24)
MQTT_ENABLED=$(optn mqtt_enabled true)
LABEL_LOOKUP=$(optn label_lookup true)
LOW_LABEL_THRESHOLD=$(optn low_label_threshold 20)
NOTIFICATIONS=$(optn notifications true)
DATE_FORMAT=$(opt date_format "YYYY-MM-DD")
TIME_FORMAT=$(opt time_format "HH:mm")
TIMEZONE=$(opt timezone "")
HISTORY_SIZE=$(optn history_size 20)
API_TOKEN=$(opt api_token "")
LOG_LEVEL=$(opt log_level info)

# Bluetooth always through BlueZ over D-Bus (shared with HA's own Bluetooth),
# never noble's raw-HCI binding, whatever the transport (auto / scan use it).
export NOBLE_BINDINGS=dbus
export DBUS_SYSTEM_BUS_ADDRESS="unix:path=/run/dbus/system_bus_socket"

# The printer may be off / unplugged / out of range at start: that is fine.
# The print server keeps looking for it and reports state on GET /status.
log "Transport: ${TRANSPORT}${ADDRESS:+, address $ADDRESS}"
log "Serial devices visible now:"
found=0
for d in /dev/serial/by-id/* /dev/ttyACM* /dev/ttyUSB*; do
  [ -e "$d" ] && { log "  $d"; found=1; }
done
[ "$found" = 1 ] || log "  (none)"
if [ ! -S /run/dbus/system_bus_socket ]; then
  log "Host D-Bus socket missing: Bluetooth cannot work (host_dbus not granted?)"
fi

# ---- designer config (read by the injected print bar), JSON-encoded --------
jq -n \
  --arg model "$MODEL" --arg dir "$DIR" --arg fit "$FIT" --arg transport "$TRANSPORT" \
  --argjson lw "${LW:-0}" --argjson lh "${LH:-0}" --argjson density "${DENSITY:-0}" \
  --argjson threshold "${THRESHOLD:-128}" \
  '{model: $model, printDirection: $dir, labelWidth: $lw, labelHeight: $lh,
    density: $density, threshold: $threshold, imageFit: $fit, transport: $transport,
    apiBase: "../api"}' \
  | { printf '// Generated at runtime from the add-on options. apiBase is relative to designer/.\nwindow.NIIMBLUE_HOST = '; cat; printf ';\n'; } \
  > /opt/niimblue/config.js

# ---- nginx (ingress), supervised in the background -----------------------
(
  while :; do
    nginx -g "daemon off;" || true
    log "nginx exited, restarting in 2s"
    sleep 2
  done
) &

# ---- print server, supervised in the FOREGROUND ------------------------
# This loop IS the main run.sh process (PID 1, init: false), so it keeps the
# server alive: a serial write EIO can still kill the node process despite the
# lib patch, and the BLE watchdog exits on purpose — restart it so /api stays
# up (queued print jobs survive in /data/queue). On add-on stop, forward TERM
# so the server releases the printer before the container goes away.
# Bind 0.0.0.0: port 5000 is only reachable from other containers (HA core
# via the add-on hostname) unless mapped in the add-on's Network settings.
export HOST=0.0.0.0 PORT=5000
export TRANSPORT ADDRESS MODEL RECONNECT IDLE_DISCONNECT DISCONNECT_AFTER_PRINT LOG_LEVEL
export LABEL_WIDTH="${LW:-0}" LABEL_HEIGHT="${LH:-0}" IMAGE_FIT="$FIT" PRINT_DIRECTION="$DIR"
export DENSITY THRESHOLD WAIT_TIMEOUT QUEUE_MAX_AGE_HOURS MQTT_ENABLED
export LABEL_LOOKUP LABELS_FILE=/data/labels.json DATA_DIR=/data
export LOW_LABEL_THRESHOLD NOTIFICATIONS DATE_FORMAT TIME_FORMAT TIMEZONE HISTORY_SIZE API_TOKEN
if [ "$LABEL_LOOKUP" = "true" ]; then
  log "Label size lookup: on (sends only the roll's RFID barcode to NIIMBOT's cloud, once per roll type)"
else
  log "Label size lookup: off (cached sizes in /data/labels.json still used)"
fi
[ -n "$API_TOKEN" ] && log "API token set: clients other than the sidebar must send 'Authorization: Bearer <api_token>'"
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
