#!/usr/bin/env bash
# MQTT auto-discovery: exposes printer connectivity, status, battery and a
# reconnect button in Home Assistant automatically (no user YAML). Pulls broker
# creds from the Mosquitto add-on via the Supervisor services API.
set -uo pipefail
API=http://127.0.0.1:5000
log() { echo "[niimblue:mqtt] $*"; }

# --- broker credentials from Supervisor ---------------------------------
# Under s6-overlay the token may only exist in s6's container environment, not
# in this process' env: fall back to it. Retry a while (Supervisor/Mosquitto
# can still be coming up at boot) and log the real HTTP status on failure.
TOKEN="${SUPERVISOR_TOKEN:-}"
[ -z "$TOKEN" ] && [ -r /run/s6/container_environment/SUPERVISOR_TOKEN ] \
  && TOKEN=$(cat /run/s6/container_environment/SUPERVISOR_TOKEN)
[ -z "$TOKEN" ] && log "WARNING: no SUPERVISOR_TOKEN available"
SVC=""
for attempt in 1 2 3 4 5 6; do
  body=$(curl -s -m 10 -w '\n%{http_code}' -H "Authorization: Bearer ${TOKEN}" \
         http://supervisor/services/mqtt 2>&1 || true)
  code=${body##*$'\n'}
  body=${body%$'\n'*}
  if [ "$code" = "200" ] && echo "$body" | jq -e '.data.host' >/dev/null 2>&1; then
    SVC=$body
    break
  fi
  log "MQTT service lookup failed (attempt $attempt, HTTP ${code:-none}): $(echo "$body" | head -c 200)"
  sleep 10
done
if [ -z "$SVC" ]; then
  log "MQTT service not available (is the Mosquitto add-on running?). Skipping."
  exit 0
fi
log "MQTT broker: $(echo "$SVC" | jq -r '.data.host'):$(echo "$SVC" | jq -r '.data.port')"
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

# Label roll detected via RFID (+ size from cache / NIIMBOT cloud). State =
# label name (else its size, else barcode); attributes = the whole label object.
# "None" = unknown in HA (no roll detected yet / no RFID tag).
pub -r -t "homeassistant/sensor/niimblue/label/config" -m "{
  \"name\":\"Label\",\"unique_id\":\"niimblue_label\",\"icon\":\"mdi:label-outline\",
  \"state_topic\":\"$STATE\",
  \"value_template\":\"{% set l = value_json.label %}{% if not l %}None{% elif l.name %}{{ l.name }}{% elif l.width_mm %}{{ l.width_mm }}x{{ l.height_mm }} mm{% else %}{{ l.barcode }}{% endif %}\",
  \"json_attributes_topic\":\"$STATE\",
  \"json_attributes_template\":\"{{ (value_json.label or {}) | tojson }}\",
  \"availability_topic\":\"$AVAIL\",\"device\":$DEV }"

pub -r -t "homeassistant/sensor/niimblue/labels_remaining/config" -m "{
  \"name\":\"Labels remaining\",\"unique_id\":\"niimblue_labels_remaining\",
  \"icon\":\"mdi:label-multiple-outline\",\"unit_of_measurement\":\"labels\",
  \"state_class\":\"measurement\",
  \"state_topic\":\"$STATE\",
  \"value_template\":\"{{ value_json.label.remaining if value_json.label and value_json.label.remaining is not none else None }}\",
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
