# Changelog

Home Assistant shows this file in the add-on's update dialog. Newest on top.
Bump `version:` in `config.yaml` and add a matching entry here on every push.

## 1.1.1
- **MQTT entities actually appear.** The Supervisor token is now also read from
  s6's container environment, the broker lookup retries for a minute at boot,
  and a failure logs the real HTTP status instead of a generic "not available".
- **Clear Bluetooth error when the host has no adapter.** Instead of noble's
  "Timeout waiting for Noble to be powered on", the status says there is no
  local Bluetooth adapter (ESPHome Bluetooth proxies can't be used from an
  add-on) and suggests passing a USB adapter to the host or using serial.

## 1.1.0
- **Starts without the printer.** `address` is now a plain text option instead
  of a device picker: Supervisor refused to start the add-on (and raised a
  "boot failed" repair) whenever the printer was off or unplugged at boot.
  Hot-plug works: switch the printer on any time and it connects by itself.
- New print server wrapper (same niimblue-node/niimbluelib print path):
  retries with backoff (no more `connect -> unreachable` log spam, real error
  messages instead), connects on demand when a print arrives, one print job at
  a time, a watchdog for stuck jobs, clean printer release on add-on stop.
- Serial auto-detect (`address` empty) only picks a NIIMBOT USB device
  (vendor 3513), never another serial stick.
- **Bluetooth LE transport** (`transport: ble`): prints through Home
  Assistant's own Bluetooth adapter via BlueZ/D-Bus, so it coexists with HA's
  Bluetooth integration. `address` = printer MAC or name, or empty to find it
  by name. The link is released after `idle_disconnect_seconds` (default 60).
  Verified printing on a B21S over BLE. Replaces the experimental
  "NiimBlue Print (Bluetooth)" add-on.
- New `GET /status` (state, detail, battery, last error, last print) and
  `POST /reconnect`. MQTT: new **Status** sensor (details as attributes),
  battery now actually reported (wrong field before), entities go
  *unavailable* when the add-on stops (MQTT Last Will).
- Designer print bar shows a printer status dot.
- niimblue-node pinned to 1.4.1.

## 1.0.5
- Dropped the "browser does not support bluetooth/serial" banner.
- Preview's **Print** button now prints via the host server (padded to a
  multiple of 8, always enabled).
- Removed the browser "system printer" print button.

## 1.0.4
- Pad both image dimensions to a multiple of 8 (print direction rotates the
  image, so either axis can be the "column" axis).
- `no-store` on injected `config.js` / `host-print.js` so add-on updates always
  take effect (no stale cached JS under ingress).

## 1.0.3
- Fix "column count must be multiple of 8" by padding image width.
- Hard-set the B1 print task (info auto-detect times out over serial on B21S).

## 1.0.2
- Crash-resilient serial handling: tolerate write EIO instead of killing the
  print server; supervise + auto-restart the server.

## 1.0.1
- Build on the Alpine Home Assistant base (apk), not Debian/apt.

## 1.0.0
- Initial release: NiimBlue designer in the HA sidebar (ingress) + host-side
  niimblue-node REST print server over USB-serial, MQTT discovery.
