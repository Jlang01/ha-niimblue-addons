# NiimBlue Print — Home Assistant Add-on

Label **designer** (NiimBlue) embedded in the HA sidebar **plus** a persistent
**host-side print server** (built on niimblue-node / niimbluelib) that owns the
printer over **USB-serial** or **Bluetooth LE**. Design a label, hit **Print
via host**, and it prints from the HA machine — no browser Bluetooth, no
laptop-side serial.

## Why this shape

- NiimBlue's built-in print uses **Web Bluetooth / Web Serial** — those live in
  the *browser*, so they can only reach a printer near the machine running the
  browser, **not** the HA host.
- So: the designer is used only to *build* the label; an injected **Print via
  host** button ships the rendered image to the add-on's REST server, which
  holds the real printer connection on the host. Automations use the same
  REST server.

## Transports

| | `serial` (USB) | `ble` (Bluetooth LE) |
|---|---|---|
| Needs | printer USB → HA host (VM passthrough) | HA host Bluetooth adapter in range |
| HA Bluetooth | untouched | **shared** — goes through BlueZ over D-Bus, like HA itself |
| Pairing | – | none needed |
| Connection | kept open while the printer is on | opened on demand, released after `idle_disconnect_seconds` |
| Battery / model info | as far as the printer answers over USB | yes |

Both use the same protocol library (niimbluelib), image encoder and print
flow. Switch with the `transport` option; no reinstall.

**The add-on starts whether or not the printer is on.** It keeps looking for
it (USB hot-plug / Bluetooth) and reports what it is doing in the **Status**
sensor, the designer's status dot and `GET /status`.

## Your printer: NIIMBOT B21S

- USB: id `3513:0002`, passed through to the HA VM, enumerates as
  `/dev/ttyACM0`, stable path
  `/dev/serial/by-id/usb-NIIMBOT_B21_LABEL_PRINTER_B21S-C2BF926031720-if00`.
- Bluetooth: advertises as **`B21S-C2BF926031720`** (LE only, random static
  address `C3:F9:26:03:17:20`). Model reported: `B21S_C2B`, auto-detected
  print task over BLE: `D110`.
- 203 dpi, printhead **384 px** wide, print direction `top`, density 1–5.

### Serial setup

`transport: serial`, `address:` the by-id path above (or empty to
auto-detect a NIIMBOT USB device), `model: B1`.

### Bluetooth setup

1. HA must have a working Bluetooth adapter (Settings → Devices & services →
   Bluetooth shows it). Nothing to pair.
2. Options: `transport: ble`, `address: C3:F9:26:03:17:20` (or the name
   `B21S-C2BF926031720`, or empty to find it by scanning), `model:` empty
   (auto-detect) — or `D110`.
3. Restart the add-on. Status shows `idle` (connects on demand). Print; the
   first print takes a few seconds longer while the link comes up.
4. If prints fail with `le-connection-abort-by-local` / `Device not found`:
   the printer is too far from the HA host's adapter (-85 dBm is marginal) or
   is currently connected to a phone app. Move it closer / close the app.

## Options

| Option | Default | Meaning |
|---|---|---|
| `transport` | `serial` | `serial` or `ble` |
| `address` | _(empty)_ | serial: device path; ble: MAC or name. Empty = auto-detect |
| `model` | `B1` | `printTask`; empty = auto-detect on connect |
| `label_width` / `label_height` | `0` / `0` | px; `0` = use image's own size. B21 printhead max width = **384 px** |
| `print_direction` | `top` | `top` or `left` |
| `density` | `3` | Print darkness (1–5, model-dependent) |
| `threshold` | `128` | B/W threshold (1–255) |
| `image_fit` | `contain` | sharp resize fit |
| `reconnect_seconds` | `10` | Retry base interval (backs off to 5 min) + MQTT publish interval |
| `idle_disconnect_seconds` | `60` | ble: release link after N idle s; `0` = stay connected |
| `mqtt_enabled` | `true` | Publish MQTT discovery entities |
| `log_level` | `info` | `trace`…`error` |

## What you get in HA

- **Sidebar panel** "NiimBlue" — the designer (via Ingress, authenticated),
  with a status dot on the print bar (green connected, blue idle/on-demand,
  amber waiting/connecting, red error).
- **MQTT entities** on the device "NiimBlue Printer" (auto-discovered, needs
  the Mosquitto add-on):
  - **Connected** (binary_sensor, connectivity)
  - **Status** (sensor) — `connected` / `idle` / `waiting` / `connecting` /
    `disconnected` / `error`; attributes carry the detail, last error, last
    print, transport, address
  - **Battery** (sensor, %)
  - **Reconnect** (button)
  - All go *unavailable* when the add-on is stopped.
- **REST API** on port `5000` for automations — see
  `examples/rest_commands.yaml`.

## REST API

- `POST /print` — `{ "imageBase64" | "imageUrl", "quantity", "density",
  "printDirection", "printTask", "labelWidth", "labelHeight", "threshold",
  "imageFit", "waitUntilFinished" }` (same as niimblue-node). Connects first
  if needed. Returns `503` with a reason when the printer is unreachable.
- `GET /status` — `{status, detail, connected, transport, address, model,
  print_task, battery, last_error, last_print_at, last_print_ok, ...}`
- `POST /reconnect`, `POST /connect`, `POST /disconnect` (body ignored)
- `GET /connected`, `GET /info`, `GET /rfid`
- `POST /scan` — `{ "transport": "ble", "timeout": 8000 }` lists nearby
  Bluetooth devices (`likely_printer` flagged); `serial` lists ttys.

## Automations

Add `examples/rest_commands.yaml` to `configuration.yaml`, edit the host IP, then
call `rest_command.niimblue_print_url` / `_base64`. See `examples/automation.yaml`.
Keep the `timeout: 120` — a Bluetooth print that first has to connect takes
longer than rest_command's 10 s default.

## Troubleshooting

- **Status `waiting`** — serial device not present: printer off/unplugged, or
  the USB device is not passed through to the HA VM. The log lists the serial
  devices visible at start.
- **Status `error` with a protocol timeout** — the device answers nothing;
  power-cycle the printer. Retries back off automatically.
- **BLE: "host D-Bus socket missing"** — the add-on needs `host_dbus` (set in
  its config); reinstall/rebuild if you run an old local copy.
- **Designer loads blank under Ingress** — asset paths issue; the add-on builds
  NiimBlue with a relative base (`--base=./`) and nginx injects `<base href>`.
- **"Print via host" grabs the wrong image** — adjust `CANVAS_SELECTORS` in
  `/opt/niimblue/host-print.js` (rootfs) and rebuild.
- **Prints are cut off / wrong size** — set `label_width`/`label_height` to your
  label's pixel dimensions (mm × dpi/25.4), or `0` to trust the image size.

## Credits

- [NiimBlue](https://github.com/MultiMote/niimblue) — designer
- [niimblue-node](https://github.com/MultiMote/niimblue-node) — print server base
- [niimbluelib](https://github.com/MultiMote/niimbluelib) — protocol

All by [MultiMote](https://github.com/MultiMote). BLE via
[@stoprocent/noble](https://github.com/stoprocent/noble)'s BlueZ D-Bus binding.
