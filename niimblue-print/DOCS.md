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
  address `C3:F9:26:03:17:20`). Model reported: `B21S_C2B`.
- Print task **`B1`** over USB and Bluetooth. niimbluelib auto-detects `D110`
  for this model, which prints **blank** labels; with `model` empty the add-on
  therefore uses `B1` for B21S/B21S_C2B (logged once on connect).
- 203 dpi, printhead **384 px** wide (48 mm), print direction `top`,
  density 1–5.
- Roll in use: `T50*30-230WHITE-NM` (barcode `10262260`), 50 mm across the
  head × 30 mm feed = **400×240 px** label; the head prints the middle
  **384×240 px** (8 px / 1 mm cut on each side, as the NIIMBOT app does).
  Edge-to-edge printing is not verified.

### Serial setup

`transport: serial`, `address:` the by-id path above (or empty to
auto-detect a NIIMBOT USB device), `model: B1`.

### Bluetooth setup

1. HA must have a working Bluetooth adapter (Settings → Devices & services →
   Bluetooth shows it). Nothing to pair.
2. Options: `transport: ble`, `address: C3:F9:26:03:17:20` (or the name
   `B21S-C2BF926031720`, or empty to find it by scanning), `model: B1` (or
   empty: auto-detect, which also ends up at `B1` on the B21S).
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
| `label_width` / `label_height` | `0` / `0` | px; both `0` = **auto**: fit to the detected label roll (else the image's own size). B21 printhead max width = **384 px** |
| `label_lookup` | `true` | Look up the roll's size by its RFID barcode at NIIMBOT's cloud (sends only the barcode) |
| `print_direction` | `top` | `top` or `left` |
| `density` | `3` | Print darkness (1–5, model-dependent) |
| `threshold` | `128` | B/W threshold (1–255) |
| `image_fit` | `contain` | sharp resize fit, default for every print (designer and REST) |
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
  - **Label** (sensor) — name of the label roll in the printer (e.g.
    `T50*30-230WHITE-NM`); attributes: barcode, `width_mm`/`height_mm`,
    `width_px`/`height_px`, remaining, total, source
  - **Labels remaining** (sensor) — labels left on the roll (from its RFID tag)
  - **Reconnect** (button)
  - All go *unavailable* when the add-on is stopped.
- **REST API** on port `5000` for automations — see
  `examples/rest_commands.yaml`.

## Label auto-size

NIIMBOT rolls carry an RFID tag with a barcode and the label counters (total /
used), but **not** the label size. On every connect (and on **Reconnect**)
the add-on reads the tag. If a roll is found, its size comes from:

1. the local cache `/data/labels.json` (kept across updates/restarts), else
2. NIIMBOT's cloud (`print.niimbot.com`, the same lookup the NIIMBOT app does),
   once per roll type, with an 8 s timeout. **Only the roll's barcode is
   sent** — no account, no image, no device data. Turn it off with
   `label_lookup: false`; already cached sizes keep working.

When `label_width`/`label_height` are both `0` and a print request does not
give `labelWidth`/`labelHeight`, the print image is fitted to the detected
label (`image_fit`, default `contain`; images smaller than the label are
scaled up). Precedence: request size > `label_width`/`label_height` options >
detected label > image as is. Offline, unknown roll, no RFID tag or an RFID
read that fails (seen over USB on the B21S): the last known roll is kept, or
nothing is resized. A lookup never fails or holds up a print for longer than
its timeout.

Size math: px = mm × dpi / 25.4, rounded, padded to a multiple of 8. With
print direction `top` the image width runs across the head, with `left` its
height does. Which of the cloud's width/height runs across the head comes from
its `rotate` field (90/270 → height), see `label-size.js` for the evidence.
Images are fitted to the **whole** label (400×240 for the 50×30 roll, same as
NiimBlue's 50x30 preset) and anything wider than the printhead is
**centre-cropped** to it (384 px on the B21) — equal cuts on both sides, like
the NIIMBOT app, so the label's centre stays centred. This crop applies to
every print wider than the head, also with explicit sizes.

Keep content ~0.5 mm (4 px) away from the start and end of the feed on gap or
transparent rolls (black-mark rolls: 1 mm is cut at the bottom); `/status`
reports this as `label.blind_zone`.

The designer shows the detected roll on the print bar (orange when the
designer canvas differs from it) and preselects its size once whenever a new
roll/size is detected; a size you pick afterwards is kept.

## REST API

- `POST /print` — `{ "imageBase64" | "imageUrl", "quantity", "density",
  "printDirection", "printTask", "labelWidth", "labelHeight", "threshold",
  "imageFit", "waitUntilFinished" }` (same as niimblue-node). Connects first
  if needed. Without `labelWidth`/`labelHeight` the image is fitted to the
  detected label (see above); `imageFit` defaults to the `image_fit` option.
  Returns `503` with a reason when the printer is unreachable.
- `GET /status` — `{status, detail, connected, transport, address, model,
  print_task, battery, last_error, last_print_at, last_print_ok, label,
  label_lookup, ...}`. `label` is `null` or `{barcode, name, width_mm,
  height_mm, width_px, height_px, remaining, total, source: "cloud" | "cache"
  | null, ...}`; `width_*`/`height_*` are for the `print_direction` option
  and are what is sent to the printer; `label_width_px`/`label_height_px` are
  the whole label (design size, centre-cropped when printing); also
  `across_*`/`feed_*`, `crop_each_side_px`, `blind_zone`.
- `GET /label.js` — the same `label` object as a script, for the designer.
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
- **Prints are cut off / wrong size** — check the **Label** sensor / `GET
  /status` `label`: is the right roll detected with a size? If not (no RFID
  tag, offline, `label_lookup: false` and not cached), set
  `label_width`/`label_height` to the label's pixel size (mm × dpi/25.4,
  multiple of 8; across-head side ≤ 384 on the B21).
- **Blank labels on a B21S** — the print task must be `B1` (see above); an
  explicit `model: D110` or `"printTask": "D110"` prints nothing.

## Credits

- [NiimBlue](https://github.com/MultiMote/niimblue) — designer
- [niimblue-node](https://github.com/MultiMote/niimblue-node) — print server base
- [niimbluelib](https://github.com/MultiMote/niimbluelib) — protocol

All by [MultiMote](https://github.com/MultiMote). BLE via
[@stoprocent/noble](https://github.com/stoprocent/noble)'s BlueZ D-Bus binding.
