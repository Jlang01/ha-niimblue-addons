# NiimBlue Print — Home Assistant Add-on

Label **designer** (NiimBlue) embedded in the HA sidebar **plus** a persistent
**host-side print server** (niimblue-node) that owns the printer over USB-serial.
Design a label, hit **Print via host**, and it prints from the HA machine — no
browser Bluetooth, no laptop-side serial.

## Why this shape

- NiimBlue's built-in print uses **Web Bluetooth / Web Serial** — those live in
  the *browser*, so they can only reach a printer plugged into the machine
  running the browser, **not** the HA host. There is no websocket bridge in
  niimblue-node to change that.
- So: the designer is used only to *build* the label; an injected **Print via
  host** button ships the rendered image to the add-on's REST server, which
  holds the real serial connection on the host.

## Serial-only by design

Serial is the default and recommended transport:

- The OS gives **exclusive** ownership of `/dev/ttyXXX`. The print server is the
  sole owner, so the designer button and every HA automation funnel through one
  process — a natural print queue, **zero Bluetooth concurrency problems**.
- No contention with HA's own Bluetooth integration, no `noble` native BLE
  stack, no printer-sleep-drops-the-link churn.

> **Requirement:** your printer must expose a USB-CDC serial port. Plug it in and
> check for `/dev/ttyACM*`, `/dev/ttyUSB*`, or an entry under
> `/dev/serial/by-id/`. If nothing appears, the printer is **BLE-only** — set
> `transport: ble` and `host_dbus: true` (heavier, less reliable).

## Your printer: NIIMBOT B21

- USB id `3513:0002`, passed through to the HA VM. Enumerates as a **USB-CDC
  serial** device — `/dev/ttyACM0` (stable path under `/dev/serial/by-id/`).
- 203 dpi, printhead **384 px** wide, print direction `top`, density 1–5.
- The stock options work as-is: `transport: serial`, `address: ""`
  (auto-detects `/dev/ttyACM0`), `model: ""` (auto-detects B21 on connect).
- Just plug in, start the add-on, open the sidebar panel, design, hit
  **Print via host**.

## Options

| Option | Default | Meaning |
|---|---|---|
| `transport` | `serial` | `serial` (recommended) or `ble` |
| `address` | _(empty)_ | Serial device / BLE MAC. Empty = auto-detect serial |
| `model` | _(empty)_ | `printTask`; empty = auto-detect on connect (best for B21) |
| `label_width` / `label_height` | `0` / `0` | px; `0` = use image's own size. B21 printhead max width = **384 px** |
| `print_direction` | `top` | `top` or `left` |
| `density` | `3` | Print darkness (1–5, model-dependent) |
| `threshold` | `128` | B/W threshold (1–255) |
| `image_fit` | `contain` | sharp resize fit |
| `reconnect_seconds` | `10` | Reconnect/status poll interval |
| `mqtt_enabled` | `true` | Publish MQTT discovery entities |
| `log_level` | `info` | `trace`…`error` |

## What you get in HA

- **Sidebar panel** "NiimBlue" — the designer (via Ingress, authenticated).
- **MQTT entities** (auto-discovered, needs the Mosquitto add-on):
  - `binary_sensor.niimblue_connected`
  - `sensor.niimblue_battery`
  - `button.niimblue_reconnect`
- **REST print API** on port `5000` for automations — see
  `examples/rest_commands.yaml`.

## Automations

Add `examples/rest_commands.yaml` to `configuration.yaml`, edit the host IP, then
call `rest_command.niimblue_print_url` / `_base64`. See `examples/automation.yaml`.

## Troubleshooting

- **Designer loads blank under Ingress** — asset paths issue. This add-on builds
  NiimBlue from source with a relative base (`--base=./`) specifically to avoid
  it. If it still happens, check the add-on log for the nginx `sub_filter`
  injecting `<base href>`.
- **"Print via host" grabs the wrong image** — the canvas selector is
  version-sensitive. Edit `CANVAS_SELECTORS` in
  `/opt/niimblue/host-print.js` (rootfs) and rebuild.
- **No serial device found** — check the add-on log's device list, set `address`
  explicitly to a `/dev/serial/by-id/...` path (stable across reboots).
- **Prints are cut off / wrong size** — set `label_width`/`label_height` to your
  label's pixel dimensions (mm × dpi/25.4), or `0` to trust the image size.

## Credits

- [NiimBlue](https://github.com/MultiMote/niimblue) — designer
- [niimblue-node](https://github.com/MultiMote/niimblue-node) — print server
- [niimbluelib](https://github.com/MultiMote/niimbluelib) — protocol

All by [MultiMote](https://github.com/MultiMote).
