# Changelog

Home Assistant shows this file in the add-on's update dialog. Newest on top.
Bump `version:` in `config.yaml` and add a matching entry here on every push.

## 0.2.2
- **Deprecated.** Use **NiimBlue Print** (1.1.0+) with `transport: ble`
  instead: Bluetooth LE through Home Assistant's own adapter via BlueZ/D-Bus,
  same protocol library as USB, verified printing on a B21S. This add-on's
  backend (niimprint, Bluetooth Classic) uses an outdated protocol that prints
  blank labels on the B21S, and the B21S advertises its BLE address as
  LE-only. Uninstall this add-on after switching.

## 0.2.1
- Print is fully connect-on-demand: each print opens the Bluetooth link to the
  paired printer, prints, then **explicitly disconnects** (no per-print scan, no
  lingering connection) so HA's Bluetooth regains the radio between prints.

## 0.2.0
- **Pair without SSH.** Added an in-add-on setup page (`./setup.html`, also a
  "⚙ BT" link on the print bar): scan for printers, pair with one click, and it
  is remembered — no `bluetoothctl` over SSH needed. A NoInputNoOutput bt-agent
  auto-accepts pairing.
- Scan now flags which address advertises the **Serial Port (SPP)** profile —
  NIIMBOT exposes two addresses and only the SPP one can print.
- Leaving `address` blank now uses the paired printer (saved to `/data`); set
  `address` to pin a specific MAC. New `/pair`, `/forget` API endpoints.

## 0.1.0
- Initial (experimental) Bluetooth variant: NiimBlue designer in the HA sidebar
  + host-side print server over a Bluetooth Classic RFCOMM (SPP) socket
  (niimprint). Kernel/BlueZ-arbitrated, so it coexists with Home Assistant's
  Bluetooth integration on the internal adapter — no USB dongle, no exclusive
  HCI grab. Requires the printer paired and its MAC set. Classic SPP, not BLE.
  Not yet verified against hardware.
