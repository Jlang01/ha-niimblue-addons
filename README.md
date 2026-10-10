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

NIIMBOT label printing from Home Assistant, over **USB or Bluetooth LE**
(through HA's own adapter via BlueZ/D-Bus — coexists with HA's Bluetooth
integration, no pairing, no dongle).

- Sidebar page: NiimBlue **designer**, **Quick print** text labels with live
  preview, **templates** (`{{placeholders}}`, dates, counters), **history**
  with reprint, **diagnostics** — also on phones
- **Persistent print queue**: prints wait while the printer is off or out of
  range and come out as soon as it's back; lid open / no labels pause it
- Text, QR codes and barcodes rendered on the server, sized to the label roll
  the printer reports (RFID)
- Automations: REST (`rest_command`) or MQTT topics; MQTT auto-discovery with
  status, battery, label roll, labels remaining, queue, quick-print entities
- Warnings when labels or battery run low (HA notifications)
- Tested target: **NIIMBOT B21S** (USB `3513:0002`; BLE `B21S-…`)

See its [DOCS](./niimblue-print/DOCS.md).

## Credits

Built on [NiimBlue](https://github.com/MultiMote/niimblue),
[niimblue-node](https://github.com/MultiMote/niimblue-node) and
[niimbluelib](https://github.com/MultiMote/niimbluelib) by
[MultiMote](https://github.com/MultiMote). Not affiliated with NIIMBOT.
