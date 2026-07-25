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
MQTT_ENABLED=$(opt mqtt_enabled true)
LOG_LEVEL=$(opt log_level info)

export NIIMBLUE_LOG_LEVEL="$LOG_LEVEL"

# ---- resolve serial device ---------------------------------------------
if [ "$TRANSPORT" = "serial" ] && [ -z "$ADDRESS" ]; then
  log "Auto-detecting serial device..."
  # Prefer a stable by-id path, fall back to common CDC/USB nodes.
  ADDRESS=$(ls /dev/serial/by-id/* 2>/dev/null | head -n1 || true)
  if [ -z "$ADDRESS" ]; then
    for d in /dev/ttyACM0 /dev/ttyACM1 /dev/ttyUSB0 /dev/ttyUSB1; do
      [ -e "$d" ] && ADDRESS="$d" && break
    done
  fi
  if [ -z "$ADDRESS" ]; then
    log "WARNING: no serial device found. Plug in the printer or set 'address' manually."
    log "Available tty devices:"; ls -1 /dev/tty* 2>/dev/null | grep -E 'ACM|USB' || log "  (none)"
  else
    log "Using serial device: $ADDRESS"
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
  // API is proxied by nginx under the ingress path at ./api/
  apiBase: "api"
};
EOF

# ---- start the print server --------------------------------------------
# Bind 0.0.0.0 so HA core rest_command can reach it on :5000, and nginx
# proxies it under ingress. Serial exclusivity = this is the sole owner.
log "Starting niimblue print server on :5000 ..."
DBG=""
case "$LOG_LEVEL" in debug|trace) DBG="-d" ;; esac
niimblue-cli server -h 0.0.0.0 -p 5000 $DBG &
SERVER_PID=$!

# wait for server to accept connections
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:5000/connected >/dev/null 2>&1 && break
  sleep 1
done

# ---- autoconnect / reconnect supervisor --------------------------------
export TRANSPORT ADDRESS RECONNECT MODEL
/usr/local/bin/autoconnect.sh &

# ---- MQTT discovery + status -------------------------------------------
if [ "$MQTT_ENABLED" = "true" ]; then
  /usr/local/bin/mqtt-discovery.sh &
fi

# ---- nginx (ingress) in foreground -------------------------------------
log "Starting nginx (ingress) on :8099 ..."
exec nginx -g "daemon off;"
