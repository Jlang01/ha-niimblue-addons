#!/usr/bin/env bash
# MQTT auto-discovery: exposes printer connectivity + battery + a reconnect
# button in Home Assistant automatically (no user YAML). Pulls broker creds
# from the Mosquitto add-on via the Supervisor services API.
set -uo pipefail
API=http://127.0.0.1:5000
log() { echo "[niimblue:mqtt] $*"; }

# --- broker credentials from Supervisor ---------------------------------
SVC=$(curl -sf -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
      http://supervisor/services/mqtt 2>/dev/null || true)
if [ -z "$SVC" ]; then
  log "MQTT service not available (is the Mosquitto add-on running?). Skipping."
  exit 0
fi
MQ_HOST=$(echo "$SVC" | jq -r '.data.host')
MQ_PORT=$(echo "$SVC" | jq -r '.data.port')
MQ_USER=$(echo "$SVC" | jq -r '.data.username')
MQ_PASS=$(echo "$SVC" | jq -r '.data.password')
AUTH=(-h "$MQ_HOST" -p "$MQ_PORT")
[ "$MQ_USER" != "null" ] && [ -n "$MQ_USER" ] && AUTH+=(-u "$MQ_USER" -P "$MQ_PASS")

AVAIL="niimblue/availability"
STATE="niimblue/state"
CMD_RECONNECT="niimblue/cmd/reconnect"

pub()  { mosquitto_pub "${AUTH[@]}" "$@"; }
DEV='{"identifiers":["niimblue_print"],"name":"NiimBlue Printer","manufacturer":"NIIMBOT","model":"'"${MODEL:-B21}"'"}'

# --- discovery configs (retained) ---------------------------------------
pub -r -t "homeassistant/binary_sensor/niimblue/connected/config" -m "{
  \"name\":\"Connected\",\"unique_id\":\"niimblue_connected\",
  \"device_class\":\"connectivity\",
  \"state_topic\":\"$STATE\",\"value_template\":\"{{ 'ON' if value_json.connected else 'OFF' }}\",
  \"availability_topic\":\"$AVAIL\",\"device\":$DEV }"

pub -r -t "homeassistant/sensor/niimblue/battery/config" -m "{
  \"name\":\"Battery\",\"unique_id\":\"niimblue_battery\",
  \"state_class\":\"measurement\",\"entity_category\":\"diagnostic\",
  \"state_topic\":\"$STATE\",\"value_template\":\"{{ value_json.battery }}\",
  \"availability_topic\":\"$AVAIL\",\"device\":$DEV }"

pub -r -t "homeassistant/button/niimblue/reconnect/config" -m "{
  \"name\":\"Reconnect\",\"unique_id\":\"niimblue_reconnect\",
  \"command_topic\":\"$CMD_RECONNECT\",\"entity_category\":\"config\",
  \"availability_topic\":\"$AVAIL\",\"device\":$DEV }"

# --- Last Will: mark offline if we die (set via a background keepalive) --
pub -r -t "$AVAIL" -m "online"

# --- reconnect button handler (background subscribe) --------------------
(
  mosquitto_sub "${AUTH[@]}" -t "$CMD_RECONNECT" | while read -r _; do
    log "Reconnect requested"
    curl -sf -X POST "$API/disconnect" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1 || true
    curl -sf -X POST "$API/connect" -H 'Content-Type: application/json' \
      -d "{\"transport\":\"${TRANSPORT:-serial}\",\"address\":\"${ADDRESS:-}\"}" >/dev/null 2>&1 || true
  done
) &

# --- status publisher loop ----------------------------------------------
trap 'pub -r -t "$AVAIL" -m "offline"; exit 0' TERM INT
while true; do
  connected=$(curl -sf "$API/connected" 2>/dev/null | jq -r '.connected // false' 2>/dev/null || echo false)
  battery=""
  if [ "$connected" = "true" ]; then
    battery=$(curl -sf "$API/info" 2>/dev/null | jq -r '.printerInfo.charge // empty' 2>/dev/null || echo "")
  fi
  pub -t "$STATE" -m "{\"connected\":$connected,\"battery\":${battery:-null}}"
  sleep "${RECONNECT:-10}"
done
