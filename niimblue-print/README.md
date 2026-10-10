# NiimBlue Print (Home Assistant add-on)

NIIMBOT label printing from Home Assistant: the **NiimBlue designer**, quick
**text labels**, **templates**, a **print queue** and **history** in the
sidebar, and REST + MQTT for automations. Prints over **USB** or **Bluetooth
LE** from the Home Assistant machine.

- `transport: auto`: USB if a NIIMBOT is plugged in, else Bluetooth LE through
  BlueZ over D-Bus (shares the adapter with HA's Bluetooth integration).
- Starts without the printer; prints wait in a persistent queue and are
  printed when it comes back (Bluetooth: within seconds of it advertising).
- Label auto-size: reads the roll's RFID tag, looks the size up once (NIIMBOT
  cloud, only the barcode is sent; cached) and fits prints to it.
- Text labels with auto font size, word wrap, QR codes and barcodes, rendered
  offline on the server; templates with `{{placeholders}}`, dates and counters.
- MQTT auto-discovery: status, battery, label, labels remaining, labels low,
  queue, signal, firmware, quick print, reprint, test print, scan.
- HA notifications when labels or the battery run low.

## Install

1. Settings → Add-ons → Add-on Store → ⋮ → **Repositories** → add
   `https://github.com/Jlang01/ha-niimblue-addons`.
2. Open **NiimBlue Print**, install, start. Defaults find the printer by
   themselves.

See [DOCS.md](DOCS.md) for options, the queue, templates, automations and
troubleshooting.

## Architecture

```
┌ Add-on container ─────────────────────────────────────────────┐
│ nginx (:8099, Ingress only)                                    │
│   ├ /            sidebar shell (status bar + tabs)             │
│   ├ /designer/   NiimBlue designer (+ injected print bar)      │
│   └ /api/  ─proxy→  print-server.js (:5000, internal)          │
│                       ├ queue /data/queue → one job at a time  │
│                       ├ text/templates/history (lib modules)   │
│                       ├ MQTT (discovery, niimblue/print)       │
│                       ├ serial: /dev/ttyACM* (uart)            │
│                       └ ble:    BlueZ via host D-Bus           │
└────────────────────────────────────────────────────────────────┘
   HA rest_command → http://<addon-hostname>:5000/print/text …
   HA MQTT         → niimblue/print, niimblue/print/template
```

`print-server.js` wraps [niimblue-node](https://github.com/MultiMote/niimblue-node)
/ [niimbluelib](https://github.com/MultiMote/niimbluelib) by MultiMote (same
encoder and print flow as `niimblue-cli server`); the features live in
`rootfs/usr/local/lib/niimblue-print/`. Tests: `tests/` (unit: `npm test` in
that lib folder; end to end with a fake printer: `node tests/e2e.js`).
Not affiliated with NIIMBOT.
