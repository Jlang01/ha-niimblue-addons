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

### [NiimBlue Print (Bluetooth)](./niimblue-print-bt) — experimental

Same designer, but prints over the **host's internal Bluetooth** adapter via a
Bluetooth Classic RFCOMM (SPP) socket ([niimprint](https://github.com/AndBondStyle/niimprint)).
Kernel/BlueZ-arbitrated, so it **coexists with Home Assistant's Bluetooth
integration** — no USB dongle, no USB passthrough, no exclusive adapter grab.

- Classic SPP (not BLE); printer must be **paired** and its MAC set
- For when you can't pass the USB device through
- Not yet verified against hardware — **prefer the serial add-on** where possible

See its [DOCS](./niimblue-print-bt/DOCS.md).

## Credits

Built on [NiimBlue](https://github.com/MultiMote/niimblue),
[niimblue-node](https://github.com/MultiMote/niimblue-node) and
[niimbluelib](https://github.com/MultiMote/niimbluelib) by
[MultiMote](https://github.com/MultiMote). Not affiliated with NIIMBOT.
