# Changelog

Home Assistant shows this file in the add-on's update dialog. Newest on top.
Bump `version:` in `config.yaml` and add a matching entry here on every push.

## 1.3.0
**Heads-up:** port 5000 is no longer published on the host by default (see
*Security*). HA automations reach the API via the add-on's internal hostname
(DOCS → *Automations*). The NiimBlue designer moved into a tab of the new
sidebar page; its print bar works as before.

### New
- **Print queue** (`/data/queue`). Every print (REST, MQTT, sidebar, templates,
  reprints) is a job, printed in order, one at a time, and survives restarts.
  Printer off / asleep / out of range: the job waits and prints by itself as
  soon as the printer is back (Bluetooth: reacts to the printer's
  advertisement within seconds; USB: on plug-in). A request waits up to
  `wait_timeout` (30 s): printed → 200, else **202** with `job_id`
  (`wait: false` answers 202 at once; `waitUntilFinished: false` keeps the 1.2
  answer). `GET /queue`, `DELETE /queue[/{id}]`, `POST /queue/{id}/retry`.
  Jobs older than `queue_max_age_hours` (24) are dropped with a notification.
- **Printer problems pause the queue** instead of failing: lid open, no labels,
  battery too low, overheated, busy → retried until resolved. A job whose
  first page had started is **never retried automatically** (it could print a
  label twice): it is marked failed with a clear reason for a manual retry.
- **Disconnect after printing** (`disconnect_after_print`, default on):
  Bluetooth is released as soon as the queue is empty (printer battery, HA
  Bluetooth slots). `idle_disconnect_seconds` stays the fallback.
- **`transport: auto`** (new default for new installs): a USB NIIMBOT if
  plugged in, else Bluetooth LE. A printer found over Bluetooth is remembered
  (`/data/printer.json`). Density defaults to the model's own (`density: 0`,
  clamped to its range), the label type (gap / black mark / transparent) comes
  from the roll's RFID tag.
- **Text labels**: `POST /print/text` and `POST /preview/text` render text
  (auto font size, optional word wrap, alignment, bold, border), a **QR code**
  and/or a **Code 128 / EAN-13 barcode** server-side to the detected label —
  offline, with DejaVu Sans, kept out of the cropped edges and the printer's
  blind zone.
- **Templates** (`/data/templates`): text templates with `{{placeholders}}`
  plus `{{date}}`, `{{date+7}}`, `{{time}}`, `{{datetime}}`, `{{counter}}`
  (per template, one number per label); image templates saved from the
  designer (💾 in the print bar). `GET/PUT/DELETE /templates/{name}`,
  `POST /print/template/{name}`, `POST /preview/template/{name}`.
- **History** of the last prints (`history_size`, 20) with thumbnails and
  reprint: `GET /history`, `POST /history/{id|last}/reprint`.
- **Warnings**: HA persistent notification once when labels drop below
  `low_label_threshold` (20) or the printer battery below 20 % (reset on a new
  roll / recharge). Needs `homeassistant_api` (added).
- **Sidebar**: status bar (connection, battery, roll, labels left, queue,
  Reconnect) and tabs Designer · Quick print (live preview) · Templates ·
  History · Diagnostics (queue with cancel/retry, printer info, test print,
  scan, connection events). Works on phones.
- **Diagnostics**: `GET /diag`, `GET /scan` (NIIMBOT printers over BLE with
  RSSI + USB), `POST /test` (test label: edges, blind zone, grid, text
  sizes), printer serial / firmware / hardware in `/status`.
- **MQTT** moved into the print server (same entities and topics as 1.2,
  history kept) and gained: *Quick print text*, *Quick print wrap*,
  *Quick print*, *Reprint last*, *Labels low*, *Queue length*, *Clear queue*,
  *Signal strength*, *Firmware*, *Test print*, *Scan*, *Nearby printers*;
  topics `niimblue/print` (JSON or plain text), `niimblue/print/template`,
  results on `niimblue/print/result`. The device shows the real printer model.
- New options: `disconnect_after_print`, `wait_timeout`, `queue_max_age_hours`,
  `low_label_threshold`, `notifications`, `date_format`, `time_format`,
  `timezone`, `history_size`, `api_token`; `transport` gained `auto`,
  `density` gained `0` (= model default).

### Security
- Port 5000 is **not mapped to the host** by default (it was open to the LAN
  without authentication). New optional `api_token` (Bearer) for every client
  except the sidebar; set it if you map the port.
- `imageUrl`: only http/https, 15 s timeout, 20 MB cap, generic errors (no
  probing of internal hosts through error texts).
- The sidebar web server only accepts Home Assistant's ingress proxy.
- Bounds on all print inputs (quantity ≤ 999, sizes ≤ 4096 px, 40 MP decode
  limit, at most two images decoded at a time, body size with a proper 413).

### Fixes
- Bluetooth: a connect that timed out but succeeded later kept the printer
  connected forever ("Device not found" afterwards); listeners leaking on
  noble's peripheral with every connect; a BLE stack that hangs repeatedly
  now restarts the server (queue kept). Adapter off / missing is reported.
- `density`, `threshold` and `print_direction` options now apply to REST /
  automation prints too (were only used by the designer).
- The Reconnect button / MQTT no longer die silently (availability is
  re-published; reconnects are automatic).
- Label cache: a corrupt `/data/*.json` is kept as `.bad` instead of being
  overwritten; writes are fsync'ed; cloud label names are sanitized;
  barcodes like `constructor` are no longer mistaken for cached labels.
- `GET /rfid` no longer runs in the middle of a print.
- 504 from a long print no longer looks like "server down" (designer says
  "still printing or queued").

### Build
- Reproducible: NiimBlue pinned to v2026.9.0 (commit checked), server
  dependencies from a committed `package-lock.json` (`npm ci`), base image
  pinned to Alpine 3.24, build-time patches fail the build when they don't
  apply, compiler toolchain no longer in the runtime image.
- armv7 dropped (no sharp binary for 32-bit ARM musl).
- The deprecated *NiimBlue Print (Bluetooth)* add-on was removed from the
  repository; uninstall it if you still have it.

## 1.2.0
- **Label auto-size.** On connect the add-on reads the label roll's RFID tag
  and resolves its size by barcode: from the local cache
  (`/data/labels.json`), else once from NIIMBOT's cloud (only the barcode is
  sent, 8 s timeout, never blocks or fails a print). With `label_width` /
  `label_height` at 0, prints without an explicit size are fitted to the
  detected label (`image_fit`). Explicit option/request sizes still win.
  New option `label_lookup` (default on) disables the cloud lookup.
- Images are fitted to the whole label (e.g. 400×240 px for a 50×30 mm roll)
  and anything wider than the printhead (384 px on the B21) is centre-cropped,
  like the NIIMBOT app, instead of being sent overwide.
- `label_width`, `label_height`, `image_fit` now apply on the server, so they
  also cover REST/automation prints, not only the designer's print bar.
- **B21S prints with the B1 print task when `model` is empty.** niimbluelib
  auto-detects D110 for the B21S, which prints blank labels.
- `GET /status` has a `label` object (name, size in mm and px, remaining,
  total, source); `/info` shows the print task actually used.
- MQTT: new **Label** (name; size etc. as attributes) and **Labels remaining**
  sensors.
- Designer: the print bar shows the detected label (name, size, labels left)
  and the designer preselects its size once per newly detected roll.

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
