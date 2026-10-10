# NiimBlue Print (Home Assistant add-on)

NIIMBOT label **designer in the HA sidebar** + a **persistent host-side print
server** over **USB-serial or Bluetooth LE**. Design a label, press **Print via
host**, it prints from the Home Assistant machine. Automations can print too
via a REST call.

- USB-serial or Bluetooth LE (`transport` option). Bluetooth goes through
  BlueZ over D-Bus, so it shares the adapter with HA's Bluetooth integration.
- Starts without the printer; hot-plug / reconnect with backoff.
- Ingress UI (authenticated, no extra cert).
- Label auto-size: reads the roll's RFID tag, looks the size up once (NIIMBOT
  cloud, only the barcode is sent; cached) and fits prints to it.
- MQTT auto-discovery: connected, status, battery, label, labels remaining,
  reconnect button.

## Install

1. Settings → Add-ons → Add-on Store → ⋮ → **Repositories** → add
   `https://github.com/Jlang01/ha-niimblue-addons`.
2. Open **NiimBlue Print**, install, choose `transport`, start.

See [DOCS.md](DOCS.md) for options, Bluetooth setup, automations, and
troubleshooting.

## Architecture

```
┌ Add-on container ───────────────────────────────────────┐
│ nginx (:8099, Ingress) ── serves NiimBlue designer       │
│   └ /api/  ─proxy→  print-server.js (:5000)              │
│                       ├ serial: /dev/ttyACM* (uart)      │
│                       └ ble:    BlueZ via host D-Bus     │
└──────────────────────────────────────────────────────────┘
   designer "Print via host"  ┐
   HA rest_command  ──────────┴→ POST /print → printer
```

`print-server.js` wraps [niimblue-node](https://github.com/MultiMote/niimblue-node)
/ [niimbluelib](https://github.com/MultiMote/niimbluelib) by MultiMote (same
encoder and print flow as `niimblue-cli server`) and adds connection
management. Not affiliated with NIIMBOT.
