# Changelog

Home Assistant shows this file in the add-on's update dialog. Newest on top.
Bump `version:` in `config.yaml` and add a matching entry here on every push.

## 0.1.0
- Initial (experimental) Bluetooth variant: NiimBlue designer in the HA sidebar
  + host-side print server over a Bluetooth Classic RFCOMM (SPP) socket
  (niimprint). Kernel/BlueZ-arbitrated, so it coexists with Home Assistant's
  Bluetooth integration on the internal adapter — no USB dongle, no exclusive
  HCI grab. Requires the printer paired and its MAC set. Classic SPP, not BLE.
  Not yet verified against hardware.
