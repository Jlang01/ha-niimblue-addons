# NiimBlue Home Assistant Add-ons

Home Assistant add-on repository for NIIMBOT label printing.

## Add this repository

Settings → Add-ons → Add-on Store → ⋮ (top right) → **Repositories** → add:

```
https://github.com/Jlang01/ha-niimblue-addons
```

Then the add-ons below appear in the store.

## Add-ons

### [NiimBlue Print](./niimblue-print)

NIIMBOT label **designer** (NiimBlue) in the HA sidebar + a **persistent
host-side print server** over **USB-serial or Bluetooth LE**. Design a label,
hit **Print via host**, it prints from the HA machine. Automations can print
via a REST call.

- `transport: serial` (USB) or `transport: ble` — Bluetooth LE through HA's
  own adapter via BlueZ/D-Bus, **coexists with HA's Bluetooth integration**,
  no pairing, no dongle
- Starts without the printer, reconnects by itself, status entity via MQTT
- Ingress UI (authenticated), MQTT auto-discovery, NIIMBOT USB auto-detection
- Tested target: **NIIMBOT B21S** (USB `3513:0002` → `/dev/ttyACM0`; BLE
  `B21S-…`)

See its [DOCS](./niimblue-print/DOCS.md).

### [NiimBlue Print (Bluetooth)](./niimblue-print-bt) — deprecated

Old Bluetooth Classic (niimprint) variant. Superseded by **NiimBlue Print**
with `transport: ble`; niimprint prints blank labels on the B21S. Uninstall it.

## Credits

Built on [NiimBlue](https://github.com/MultiMote/niimblue),
[niimblue-node](https://github.com/MultiMote/niimblue-node) and
[niimbluelib](https://github.com/MultiMote/niimbluelib) by
[MultiMote](https://github.com/MultiMote). Not affiliated with NIIMBOT.
