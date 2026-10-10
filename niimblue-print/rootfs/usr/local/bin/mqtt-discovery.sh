#!/usr/bin/env bash
# MQTT auto-discovery: exposes printer connectivity, status, battery and a
# reconnect button in Home Assistant automatically (no user YAML). Pulls broker
# creds from the Mosquitto add-on via the Supervisor services API.
set -uo pipefail
API=http://127.0.0.1:5000
log() { echo "[niimblue:mqtt] $*"; }

# --- broker credentials from Supervisor ---------------------------------
SVC=$(curl -sf -H "Authorization: Bearer ${SUPERVISOR_TOKEN:-}" \
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
# State payload = the print server's GET /status JSON.
pub -r -t "homeassistant/binary_sensor/niimblue/connected/config" -m "{
  \"name\":\"Connected\",\"unique_id\":\"niimblue_connected\",
  \"device_class\":\"connectivity\",
  \"state_topic\":\"$STATE\",\"value_template\":\"{{ 'ON' if value_json.connected else 'OFF' }}\",
  \"availability_topic\":\"$AVAIL\",\"device\":$DEV }"

pub -r -t "homeassistant/sensor/niimblue/status/config" -m "{
  \"name\":\"Status\",\"unique_id\":\"niimblue_status\",\"icon\":\"mdi:printer-pos-cog\",
  \"state_topic\":\"$STATE\",\"value_template\":\"{{ value_json.status }}\",
  \"json_attributes_topic\":\"$STATE\",
  \"availability_topic\":\"$AVAIL\",\"device\":$DEV }"

pub -r -t "homeassistant/sensor/niimblue/battery/config" -m "{
  \"name\":\"Battery\",\"unique_id\":\"niimblue_battery\",
  \"device_class\":\"battery\",\"unit_of_measurement\":\"%\",
  \"state_class\":\"measurement\",\"entity_category\":\"diagnostic\",
  \"state_topic\":\"$STATE\",\"value_template\":\"{{ value_json.battery }}\",
  \"availability_topic\":\"$AVAIL\",\"device\":$DEV }"

pub -r -t "homeassistant/button/niimblue/reconnect/config" -m "{
  \"name\":\"Reconnect\",\"unique_id\":\"niimblue_reconnect\",
  \"command_topic\":\"$CMD_RECONNECT\",\"entity_category\":\"config\",
  \"availability_topic\":\"$AVAIL\",\"device\":$DEV }"

# --- reconnect button handler (background subscribe) --------------------
# This long-lived client also carries the Last Will: if the add-on stops or
# dies, the broker marks the entities unavailable by itself.
(
  mosquitto_sub "${AUTH[@]}" -k 30 -t "$CMD_RECONNECT" \
      --will-topic "$AVAIL" --will-payload offline --will-retain \
    | while read -r _; do
    log "Reconnect requested"
    resp=$(curl -s -m 120 -X POST "$API/reconnect" -H 'Content-Type: application/json' -d '{}' 2>/dev/null)
    log "reconnect -> ${resp:-no response}"
  done
) &
sleep 1
pub -r -t "$AVAIL" -m "online"

# --- status publisher loop ----------------------------------------------
trap 'pub -r -t "$AVAIL" -m "offline"; exit 0' TERM INT
while true; do
  status=$(curl -sf -m 5 "$API/status" 2>/dev/null | jq -c . 2>/dev/null || true)
  [ -z "$status" ] && status='{"status":"server down","connected":false,"battery":null}'
  pub -t "$STATE" -m "$status"
  sleep "${RECONNECT:-10}"
done
