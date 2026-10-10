# NiimBlue Print — Home Assistant Add-on

NIIMBOT label printing from Home Assistant: a sidebar page with the
**NiimBlue label designer**, **quick text labels**, **templates**, a **print
queue** and **history**, plus a print server (built on niimblue-node /
niimbluelib) that owns the printer over **USB** or **Bluetooth LE** — and REST
+ MQTT for automations.

## Why this shape

- NiimBlue's built-in print uses **Web Bluetooth / Web Serial** — those live in
  the *browser*, so they can only reach a printer near the machine running the
  browser, **not** the HA host.
- So the designer only *builds* the label; its **Print via host** button sends
  the image to the add-on's print server, which holds the real printer
  connection on the host. Automations, MQTT and the other tabs use the same
  server.

## The sidebar page

A status bar on top (connection, battery, label roll + size, labels left,
queue, **Reconnect**) and tabs:

| Tab | What |
|---|---|
| **Designer** | NiimBlue, unchanged. Print bar bottom-right: copies, **🖨 Print via host**, **💾** = save the canvas as an *image* template |
| **Quick print** | Type text (one line per line), wrap / bold / border / alignment / font size, optional QR code and barcode, **live preview** of exactly what prints, Print, *Save as template* |
| **Templates** | Your templates with preview, a field per `{{variable}}`, copies, Print, Delete, *Edit in Quick print* |
| **History** | The last prints with thumbnails, source, status and **Reprint** |
| **Diagnostics** | Print queue (cancel / retry), printer info (model, serial, firmware, signal), **Test print**, **Scan**, connection events, raw `/diag` |

It works in the HA app on phones too.

## Transports

| | `serial` (USB) | `ble` (Bluetooth LE) |
|---|---|---|
| Needs | printer USB → HA host (VM passthrough) | HA host Bluetooth adapter in range |
| HA Bluetooth | untouched | **shared** — goes through BlueZ over D-Bus, like HA itself |
| Pairing | – | none needed |
| Connection | kept open while the printer is on (no printer battery cost; live status) | opened per print, released when the queue is empty (`disconnect_after_print`) |
| Printer switched on later | prints the queue on plug-in / power-on | prints the queue as soon as the printer **advertises** (seconds) |

`transport: auto` (default for new installs) uses a NIIMBOT plugged in by USB
when there is one, else Bluetooth. With `address` empty a Bluetooth printer
is found by its name (`B21S-…`, `B1-…`, `D110-…`: every model niimbluelib
knows) and remembered in `/data/printer.json`, so later connects skip the
scan; after three failed connects it is forgotten and searched again.

**The add-on starts whether or not the printer is on.** It keeps looking for
it and reports what it is doing in the **Status** sensor, the status bar and
`GET /status`.

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
  density 1–5 (default 3).
- Roll in use: `T50*30-230WHITE-NM` (barcode `10262260`), 50 mm across the
  head × 30 mm feed = **400×240 px** label; the head prints the middle
  **384×240 px** (8 px / 1 mm cut on each side, as the NIIMBOT app does).
  Edge-to-edge printing is not verified (use **Test print**).

### Bluetooth setup

1. HA must have a working Bluetooth adapter (Settings → Devices & services →
   Bluetooth shows it). Nothing to pair. ESPHome Bluetooth proxies can **not**
   be used by an add-on.
2. `transport: auto` (or `ble`), `address` empty (or `C3:F9:26:03:17:20`).
3. Print. The first print after a while takes a few seconds longer while the
   link comes up; afterwards the link is released again.
4. Prints wait (status `error … queued jobs wait`) with `Device not found` /
   `le-connection-abort-by-local`: the printer is off, too far from the HA
   host's adapter (-85 dBm is marginal; see **Signal strength**) or connected
   to a phone app. The queue prints as soon as it is reachable.

## Print queue

Every print — designer, Quick print, templates, REST, MQTT, reprints, test
labels — becomes a **job** in `/data/queue`. Jobs print **in order, one at a
time**, and survive add-on restarts and updates.

- **Printer unreachable** (off, asleep, out of range, unplugged, adapter off):
  the job waits; the add-on retries with backoff (5 s → 60 s) and right away
  when the printer shows up (Bluetooth advertisement, USB plug-in, adapter
  back). Status bar / **Queue length** show it.
- **Printer needs a person** — lid open, no labels, battery too low,
  overheated, busy: the queue **pauses** and retries until it's resolved (the
  printer's own status reports are used where it sends them).
- **A job that already started printing is never retried automatically.**
  If the link drops or the printer reports an error after the first page
  began, a retry could print a label twice, so the job ends as **failed**
  (reason shown) and waits for **Retry** in the Diagnostics tab (or
  `POST /queue/{id}/retry`). A job that was still connecting when the add-on
  restarted simply waits again.
- Jobs still waiting after `queue_max_age_hours` (24 h) are dropped with a
  notification, so a label doesn't come out days later. `0` keeps them.
- `disconnect_after_print`: once the queue is empty a Bluetooth printer is
  released (saves its battery, frees HA's Bluetooth slot). USB stays
  connected — that costs the printer nothing and keeps battery / roll status
  live.

A print request waits up to `wait_timeout` (30 s) for its job:
**200** = printed; **202** = still queued/printing, with `job_id` (it prints
by itself later); **500** = failed (`error`, `error_state`, `job_id`).
`"wait": false` answers 202 immediately; `"wait_timeout": 60` per request.
1.2's `"waitUntilFinished": false` still answers 200 "Print job submitted".

## Text labels

`POST /print/text` (and `/preview/text`, same body, returns the PNG):

```json
{
  "lines": ["Erdbeermarmelade", "{{date}}"],     // or "text": "line 1\nline 2"
  "wrap": false,          // true = word-wrap long lines (bigger text)
  "align": "center",      // left | center | right
  "font_size": "auto",    // or px (shrunk with a warning if it doesn't fit)
  "bold": false,
  "border": false,
  "qr": "https://…",      // optional
  "barcode": { "type": "code128", "data": "NB-0001" },   // or ean13 (12/13 digits)
  "quantity": 1,
  "vars": { "name": "x" } // optional, for {{name}} in the text
}
```

- Rendered on the server (DejaVu Sans, works offline) to the **detected
  label**: the printed area after the centre-crop (384×240 for the 50×30
  roll), with a 1 mm margin and the feed-direction blind zone kept clear.
  Fallback: `label_width`/`label_height`, else 384×240.
- **Auto font size** = the largest size at which everything fits. With
  `wrap: false` each line stays one line (long lines make all text smaller);
  `wrap: true` breaks lines at spaces, and only breaks a single overlong word
  when keeping it whole would make the text tiny.
- A QR code goes beside the text on landscape labels, below it on portrait
  ones; a barcode goes in a band under the text, with its digits. Modules are
  whole pixels so they scan (1 px bars get a warning).
- `{{date}}`, `{{time}}`, `{{datetime}}` (and offsets, see below) work in plain
  text prints too.
- `/preview/text` returns `image/png`; with `"format": "json"` it returns
  `{image (base64), font_size, lines, warnings, …}`.

## Templates

Stored in `/data/templates/<name>.json`.

- **Text templates** — a text label layout (as above) whose text, QR and
  barcode data may contain placeholders. Make one in **Quick print → Save as
  template** or with `PUT /templates/{name}`.
- **Image templates** — the designer canvas as PNG (💾 in the print bar).
  Printed exactly as designed (fitted to the label like any image).
  **Placeholders and counters can't work in image templates** — their text is
  pixels. Use a text template for anything that changes.

Placeholders:

| Placeholder | Result |
|---|---|
| `{{name}}` | variable: `vars.name` from the request, else the template's `defaults`, else the request fails (400, lists what's missing) |
| `{{date}}` `{{time}}` `{{datetime}}` | now, in `timezone` (default: HA's), formatted by `date_format` / `time_format` |
| `{{date+7}}` `{{date-1}}` `{{date+2w}}` `{{date+3m}}` `{{date+1y}}` | date offset in days / weeks / months / years (best-before labels) |
| `{{time+30}}` `{{datetime+2h}}` | offset in minutes / hours |
| `{{date:DD.MM.YY}}` | own format: `YYYY YY MM M DD D HH H mm ss` |
| `{{counter}}` `{{counter:4}}` | per-template number, **one per label** (copies 3 → 3 labels #5, #6, #7), zero-padded to 4 |

The counter reserves its numbers when the job is queued: they are never
printed twice, but a job that is cancelled or fails leaves a gap. Set it with
`PUT /templates/{name}` `{"counter": 1, …}` (re-saving without `counter`
keeps it).

API: `GET /templates`, `GET|PUT|DELETE /templates/{name}`,
`POST /print/template/{name}` `{vars, quantity}`,
`POST /preview/template/{name}` `{vars}` (missing variables show as `{{name}}`).

## History

The last `history_size` (20) jobs — printed, failed or expired — with the
exact images that went to the printer, in `/data/history`:
`GET /history`, `GET /history/{id}/thumb.png`, `GET /history/{id}/{n}.png`,
`POST /history/{id}/reprint` (`last` = newest; reprints the same images, a
counter is not advanced again), `DELETE /history`.

## Warnings

With `notifications` on, the add-on creates a Home Assistant persistent
notification **once** when

- fewer than `low_label_threshold` (20) labels are left on the roll (again
  for the next roll; dismissed when a new roll is inserted), or
- the printer battery drops below 20 % (dismissed at 25 %).

The **Labels low** binary sensor (device class *problem*) mirrors the label
condition for your own automations.

## Options

| Option | Default | Meaning |
|---|---|---|
| `transport` | `auto` | `auto`, `serial` or `ble` |
| `address` | _(empty)_ | Empty = auto. `/dev/serial/by-id/...` (USB) or BLE MAC / name |
| `model` | _(empty)_ | `printTask`; empty = auto-detect on connect (B21S → `B1`) |
| `label_width` / `label_height` | `0` / `0` | px; both `0` = **auto**: fit to the detected label roll (else the image's own size) |
| `label_lookup` | `true` | Look up the roll's size by its RFID barcode at NIIMBOT's cloud (sends only the barcode) |
| `print_direction` | `top` | `top` or `left`, for every print |
| `density` | `0` | 1–5; `0` = the model's default (B21S: 3). Clamped to the model's range |
| `threshold` | `128` | Grey pixels darker than this print black |
| `image_fit` | `contain` | How images are fitted to the label (sharp fit) |
| `disconnect_after_print` | `true` | Bluetooth: release the printer when the queue is empty |
| `idle_disconnect_seconds` | `60` | Bluetooth: release a link opened otherwise after N idle s; `0` = stay connected |
| `reconnect_seconds` | `10` | USB retry base interval + MQTT publish interval |
| `wait_timeout` | `30` | s a print request waits before answering 202 (queued) |
| `queue_max_age_hours` | `24` | Drop jobs still waiting after this; `0` = never |
| `low_label_threshold` | `20` | Labels-low warning below this; `0` = off |
| `notifications` | `true` | HA persistent notifications (labels / battery low, dropped jobs) |
| `date_format` / `time_format` | `YYYY-MM-DD` / `HH:mm` | For `{{date}}` / `{{time}}` |
| `timezone` | _(empty)_ | e.g. `Europe/Berlin`; empty = Home Assistant's |
| `history_size` | `20` | Jobs kept in the history |
| `api_token` | _(empty)_ | When set, API clients other than the sidebar need `Authorization: Bearer <token>` |
| `mqtt_enabled` | `true` | MQTT entities + `niimblue/print` topics |
| `log_level` | `info` | `debug`/`trace` log every packet |

## MQTT

Auto-discovered on the device **NiimBlue Printer** (needs the Mosquitto
add-on; entities go *unavailable* when the add-on stops):

- Sensors: **Status** (details as attributes), **Battery**, **Label** (roll
  name; size etc. as attributes), **Labels remaining**, **Queue length**
  (queue summary as attributes), **Signal strength** (BLE RSSI, diagnostic),
  **Firmware** (serial / hardware as attributes, diagnostic), **Nearby
  printers** (after *Scan*)
- Binary sensors: **Connected**, **Labels low**
- Quick print: **Quick print text** (text, ≤ 255 characters, `\n` = new
  line), **Quick print wrap** (switch), **Quick print** (button) — prints the
  text with auto size. Text and switch are kept across restarts.
- Buttons: **Reconnect**, **Reprint last**, **Clear queue**, **Test print**,
  **Scan**

Print from automations without a rest_command:

| Topic | Payload |
|---|---|
| `niimblue/print` | JSON like `POST /print/text`, or plain text (`\n` = new line) |
| `niimblue/print/template` | `{"name": "Vorrat", "vars": {"name": "Zucker"}, "quantity": 2}` |
| `niimblue/print/result` | (published) `{ok, action, message / error, job_id, …}` per command, and for jobs that fail or expire later |

See `examples/automation.yaml`.

## REST API

Inside Home Assistant the API is at **`http://<add-on hostname>:5000`**. The
hostname is the add-on's slug with `-` instead of `_`: open the add-on in
Settings → Add-ons; the page URL ends in e.g. `/a0d7b954_niimblue_print`, so
the hostname is `a0d7b954-niimblue-print` (`local-niimblue-print` for a
locally copied add-on). Port 5000 is **not** published on the host by
default; map it under the add-on's *Network* settings only for clients outside
HA, and set `api_token` then. `rest_command` sends the token with
`headers: {Authorization: "Bearer …"}`.

Printing (all queued, see *Print queue* for 200/202):

- `POST /print` — `{ "imageBase64" | "imageUrl" | "pages": [...], "quantity",
  "density", "printDirection", "printTask", "labelType", "labelWidth",
  "labelHeight", "threshold", "imageFit", "wait", "wait_timeout" }` (same as
  niimblue-node). Without `labelWidth`/`labelHeight` the image is fitted to the
  detected label. `imageUrl`: http/https only, 15 s, 20 MB.
- `POST /print/text`, `POST /preview/text` — text labels (above)
- `POST /print/template/{name}`, `POST /preview/template/{name}`, templates CRUD
- `POST /test` — test label for the detected label (frame on the outermost
  pixels, corner marks, dashed blind-zone lines, 1 mm grid, 1/2/3 px lines,
  text sizes); `{"preview": true}` returns the PNG
- `GET /queue`, `DELETE /queue`, `DELETE /queue/{id}`, `POST /queue/{id}/retry`
- `GET /history`, `POST /history/{id}/reprint`, …

Printer:

- `GET /status` — `{status, detail, connected, transport, transport_active,
  address, model, print_task, battery, rssi, printer: {serial, firmware,
  hardware, …}, density, label, queue, warnings, last_error, …}`. `label` is
  `null` or `{barcode, name, width_mm, height_mm, width_px, height_px,
  remaining, total, paper_type, source, label_width_px, label_height_px,
  crop_each_side_px, blind_zone, …}`.
- `GET /diag` — adapter / transport / USB devices / remembered printer /
  RSSI / heartbeat / queue / last 50 connection events / versions
- `GET /scan?seconds=8` — NIIMBOT printers nearby over Bluetooth (name,
  address, RSSI) + NIIMBOT USB devices
- `POST /reconnect`, `POST /connect`, `POST /disconnect`, `GET /connected`,
  `GET /info`, `GET /rfid`, `POST /scan` (1.2 form), `GET /label.js`

## Label auto-size

NIIMBOT rolls carry an RFID tag with a barcode, the label counters (total /
used) and the label type, but **not** the label size. On every connect (and
on **Reconnect**) the add-on reads the tag. If a roll is found, its size comes
from:

1. the local cache `/data/labels.json` (kept across updates/restarts), else
2. NIIMBOT's cloud (`print.niimbot.com`, the same lookup the NIIMBOT app does),
   once per roll type, with an 8 s timeout. **Only the roll's barcode is
   sent** — no account, no image, no device data. Turn it off with
   `label_lookup: false`; already cached sizes keep working.

The label type (gaps / black mark / transparent) from the tag is sent with
every print. Precedence for the image size: request size >
`label_width`/`label_height` options > detected label > image as is. Offline,
unknown roll, no RFID tag or an RFID read that fails: the last known roll is
kept, or nothing is resized.

Size math: px = mm × dpi / 25.4, rounded, padded to a multiple of 8. With
print direction `top` the image width runs across the head, with `left` its
height does. Which of the cloud's width/height runs across the head comes from
its `rotate` field (90/270 → height), see `label-size.js` for the evidence.
Images are fitted to the **whole** label (400×240 for the 50×30 roll, same as
NiimBlue's 50x30 preset) and anything wider than the printhead is
**centre-cropped** to it (384 px on the B21) — equal cuts on both sides, like
the NIIMBOT app, so the label's centre stays centred.

Keep content ~0.5 mm (4 px) away from the start and end of the feed on gap or
transparent rolls (black-mark rolls: 1 mm is cut at the bottom); `/status`
reports this as `label.blind_zone`. Text labels and the test label do this
automatically.

## Automations

`examples/rest_commands.yaml` (edit the hostname) and
`examples/automation.yaml`: text label on demand, template with variables,
MQTT print without rest_command, low-labels reaction. Keep `timeout: 60` or
more on rest_commands (the add-on answers after `wait_timeout`, 30 s, at the
latest).

## Troubleshooting

- **Diagnostics tab first**: status, transport in use, adapter state, signal,
  queue (why it waits), recent connection events.
- **Status `waiting`** — no printer found: USB printer off/unplugged or not
  passed through to the HA VM; no Bluetooth adapter / D-Bus.
- **Jobs wait with `unreachable`** — printer off / out of range / connected to
  the phone app. They print once it is reachable, or expire after
  `queue_max_age_hours`.
- **Queue paused (`lid_open`, `no_labels`, …)** — fix it at the printer; the
  queue continues by itself.
- **Job `failed` with `interrupted`** — the link dropped while it printed;
  check the label, then **Retry** (deliberately not automatic).
- **Bluetooth adapter `poweredOff` / `unsupported`** — the host adapter is
  off, blocked (rfkill) or missing; the add-on continues when it is back. A
  BLE stack that hangs on connect three times in a row makes the server
  restart itself (logged; the queue is kept).
- **Designer loads blank** — asset paths: NiimBlue is built with a relative
  base and nginx injects `<base href>`; reload the panel.
- **Prints are cut off / wrong size** — check the **Label** sensor / `GET
  /status` `label`: is the right roll detected with a size? If not, set
  `label_width`/`label_height` (mm × dpi/25.4, multiple of 8). Use **Test
  print** to see the printable area.
- **Blank labels on a B21S** — the print task must be `B1` (see above); an
  explicit `model: D110` or `"printTask": "D110"` prints nothing.
- **401 from the API** — `api_token` is set; send `Authorization: Bearer …`.

## Credits

- [NiimBlue](https://github.com/MultiMote/niimblue) — designer
- [niimblue-node](https://github.com/MultiMote/niimblue-node) — print server base
- [niimbluelib](https://github.com/MultiMote/niimbluelib) — protocol
- [opentype.js](https://github.com/opentypejs/opentype.js), [bwip-js](https://github.com/metafloor/bwip-js),
  [MQTT.js](https://github.com/mqttjs/MQTT.js), DejaVu fonts — text labels, codes, MQTT

NiimBlue/niimblue-node/niimbluelib are by [MultiMote](https://github.com/MultiMote). BLE via
[@stoprocent/noble](https://github.com/stoprocent/noble)'s BlueZ D-Bus binding.
Not affiliated with NIIMBOT.
