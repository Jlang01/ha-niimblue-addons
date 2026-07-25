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
host-side print server** over USB-serial. Design a label, hit **Print via
host**, it prints from the HA machine. Automations can print via a REST call.

- Serial-only by default → no Bluetooth concurrency issues
- Ingress UI (authenticated), MQTT auto-discovery, serial auto-detection
- Tested target: **NIIMBOT B21** (USB `3513:0002` → `/dev/ttyACM0`)

See its [DOCS](./niimblue-print/DOCS.md).

## Credits

Built on [NiimBlue](https://github.com/MultiMote/niimblue),
[niimblue-node](https://github.com/MultiMote/niimblue-node) and
[niimbluelib](https://github.com/MultiMote/niimbluelib) by
[MultiMote](https://github.com/MultiMote). Not affiliated with NIIMBOT.
