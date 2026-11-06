#!/usr/bin/env bash
set -euo pipefail

# Paths are overridable only for tests (tests/run-sh.test.js).
DATA=${NIIMBLUE_DATA:-/data}
OPT=${NIIMBLUE_OPTIONS:-$DATA/options.json}
CONFIG_JS=${NIIMBLUE_CONFIG_JS:-/opt/niimblue/config.js}
SERVER=${NIIMBLUE_SERVER:-/usr/local/bin/print-server.js}
SUPERVISOR_URL=${SUPERVISOR_URL:-http://supervisor}
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
  > "$CONFIG_JS"

# ---- nginx (ingress), supervised in the background -----------------------
[ -n "${NIIMBLUE_NO_NGINX:-}" ] || (
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
#
# Crash loops: a run shorter than STABLE_S counts as a quick crash. Restarts
# back off (2 s doubling to 5 min) and after NOTIFY_AFTER quick crashes in a
# row Home Assistant gets ONE persistent notification with the reason (from
# /data/last-crash.json, written by the server's fatal handler). The server
# dismisses it again once it has stayed up for 10 min (lib/crash.js).
# Exit code 3 = the server's own BLE watchdog restart: not a crash.
#
# Bind 0.0.0.0: port 5000 is only reachable from other containers (HA core
# via the add-on hostname) unless mapped in the add-on's Network settings.
export HOST=0.0.0.0 PORT=5000
export TRANSPORT ADDRESS MODEL RECONNECT IDLE_DISCONNECT DISCONNECT_AFTER_PRINT LOG_LEVEL
export LABEL_WIDTH="${LW:-0}" LABEL_HEIGHT="${LH:-0}" IMAGE_FIT="$FIT" PRINT_DIRECTION="$DIR"
export DENSITY THRESHOLD WAIT_TIMEOUT QUEUE_MAX_AGE_HOURS MQTT_ENABLED
export LABEL_LOOKUP LABELS_FILE="$DATA/labels.json" DATA_DIR="$DATA" SUPERVISOR_URL
export LOW_LABEL_THRESHOLD NOTIFICATIONS DATE_FORMAT TIME_FORMAT TIMEZONE HISTORY_SIZE API_TOKEN
if [ "$LABEL_LOOKUP" = "true" ]; then
  log "Label size lookup: on (sends only the roll's RFID barcode to NIIMBOT's cloud, once per roll type)"
else
  log "Label size lookup: off (cached sizes in $DATA/labels.json still used)"
fi
[ -n "$API_TOKEN" ] && log "API token set: clients other than the sidebar must send 'Authorization: Bearer <api_token>'"

STABLE_S=${NIIMBLUE_STABLE_S:-60}          # a run at least this long resets the backoff
RESTART_BASE_S=${NIIMBLUE_RESTART_BASE_S:-2}
RESTART_MAX_S=300
NOTIFY_AFTER=${NIIMBLUE_NOTIFY_AFTER:-5}
CRASH_FILE="$DATA/last-crash.json"
LOOP_FLAG="$DATA/crash-loop-notified"      # names shared with lib/crash.js

# The fatal error of the run that started at epoch $1 (empty if it left none).
crash_reason() {
  [ -f "$CRASH_FILE" ] || return 0
  jq -r --argjson s "$1" 'select((.at_epoch // 0) >= $s) | .message // empty' "$CRASH_FILE" 2>/dev/null | head -c 300 || true
}

# One HA persistent notification (id, title, message). Never fails the loop.
notify_ha() {
  local tok=${SUPERVISOR_TOKEN:-}
  [ -n "$tok" ] || tok=$(cat /run/s6/container_environment/SUPERVISOR_TOKEN 2>/dev/null || true)
  if [ -z "$tok" ]; then log "cannot notify Home Assistant: no SUPERVISOR_TOKEN"; return 1; fi
  if jq -n --arg id "$1" --arg t "$2" --arg m "$3" '{notification_id: $id, title: $t, message: $m}' \
    | curl -fsS -m 10 -X POST -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
      --data @- "$SUPERVISOR_URL/core/api/services/persistent_notification/create" >/dev/null; then
    return 0
  fi
  log "Home Assistant notification failed"
  return 1
}

log "Starting niimblue print server on :5000 ..."
child=""
stopping=0
quick=0
trap 'stopping=1; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null' TERM INT
while [ "$stopping" = 0 ]; do
  started=$(date +%s)
  node "$SERVER" &
  child=$!
  rc=0
  # 'wait' returns early when the trap fires; wait again for a clean exit.
  wait "$child" || rc=$?
  [ "$stopping" = 1 ] && { wait "$child" 2>/dev/null || true; break; }
  ran=$(( $(date +%s) - started ))
  if [ "$rc" = 3 ] || [ "$ran" -ge "$STABLE_S" ]; then quick=0; else quick=$((quick + 1)); fi
  reason=$(crash_reason "$started")
  [ -z "$reason" ] && [ "$rc" -gt 128 ] && reason="killed by signal $((rc - 128))"
  delay=$RESTART_BASE_S
  [ "$quick" -gt 1 ] && delay=$(( RESTART_BASE_S << (quick > 9 ? 8 : quick - 1) ))
  [ "$delay" -gt "$RESTART_MAX_S" ] && delay=$RESTART_MAX_S
  if [ "$rc" = 3 ]; then
    log "print server restarting itself (Bluetooth watchdog), restarting in ${delay}s"
  else
    streak=""
    [ "$quick" -gt 0 ] && streak=", quick crash #$quick in a row"
    log "print server exited (code $rc after ${ran}s${reason:+: $reason})${streak}, restarting in ${delay}s"
  fi
  if [ "$quick" = "$NOTIFY_AFTER" ] && [ "$NOTIFICATIONS" = "true" ] && [ ! -f "$LOOP_FLAG" ]; then
    if notify_ha niimblue_crash_loop "NiimBlue Print: print server keeps crashing" \
      "The print server crashed $quick times in a row and is restarted with growing delays (up to $((RESTART_MAX_S / 60)) min). Printing does not work until this is fixed.

Last error: ${reason:-unknown (see the add-on log)}

Queued labels are kept. This notification goes away by itself once the server stays up for 10 minutes."; then
      : > "$LOOP_FLAG"
      log "Home Assistant notified about the crash loop"
    fi
  fi
  # interruptible sleep: add-on stop must not wait for a 5 min backoff
  sleep "$delay" &
  child=$!
  wait "$child" || true
done
log "Stopped."
