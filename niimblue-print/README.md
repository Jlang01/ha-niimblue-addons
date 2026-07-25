# NiimBlue Print (Home Assistant add-on)

NIIMBOT label **designer in the HA sidebar** + a **persistent host-side print
server** over USB-serial. Design a label, press **Print via host**, it prints
from the Home Assistant machine. Automations can print too via a REST call.

- Serial-only by default → no Bluetooth concurrency headaches.
- Ingress UI (authenticated, no extra cert).
- MQTT auto-discovery: connected sensor, battery, reconnect button.
- Serial device auto-detection.

## Install (local add-on)

1. Copy the `niimblue-print/` folder into your HA `addons/` share
   (Samba/SSH add-on → `/addons/niimblue-print`).
2. **Settings → Add-ons → Add-on Store → ⋮ → Check for updates**.
3. Open **NiimBlue Print**, install, start.
4. Plug the printer into the HA host via USB.

See [DOCS.md](DOCS.md) for options, automations, and troubleshooting.

## Architecture

```
┌ Add-on container ─────────────────────────────┐
│ nginx (:8099, Ingress) ── serves NiimBlue      │
│   └ /api/  ─proxy→  niimblue-node server (:5000)│
│                       └ owns /dev/ttyXXX (serial)│
└────────────────────────────────────────────────┘
   designer "Print via host"  ┐
   HA rest_command  ──────────┴→ POST /print → printer
```

Built on [NiimBlue](https://github.com/MultiMote/niimblue) and
[niimblue-node](https://github.com/MultiMote/niimblue-node) by MultiMote.
Not affiliated with NIIMBOT.
