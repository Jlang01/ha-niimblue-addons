#!/usr/bin/env bash
# Keeps the printer connected. Niimbot printers sleep when idle and drop the
# link; this re-issues /connect whenever /connected reports false.
set -uo pipefail
API=http://127.0.0.1:5000
log() { echo "[niimblue:autoconnect] $*"; }

: "${TRANSPORT:=serial}"
: "${ADDRESS:=}"
: "${RECONNECT:=10}"

if [ -z "$ADDRESS" ]; then
  log "No address resolved; connect-on-demand disabled. Set 'address' in options."
fi

while true; do
  if [ -n "$ADDRESS" ]; then
    connected=$(curl -sf "$API/connected" 2>/dev/null | jq -r '.connected // false' 2>/dev/null || echo false)
    if [ "$connected" != "true" ]; then
      log "Connecting ($TRANSPORT $ADDRESS) ..."
      resp=$(curl -sf -X POST "$API/connect" \
        -H 'Content-Type: application/json' \
        -d "{\"transport\":\"$TRANSPORT\",\"address\":\"$ADDRESS\"}" 2>/dev/null || echo '{"error":"unreachable"}')
      log "connect -> $resp"
    fi
  fi
  sleep "$RECONNECT"
done
