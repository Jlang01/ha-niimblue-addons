# ha-niimblue-addons — working rules

Home Assistant add-on repository with one add-on: `niimblue-print` (sidebar
shell with the NiimBlue designer, quick text labels, templates, history,
diagnostics + host-side print server `rootfs/usr/local/bin/print-server.js`,
a wrapper around niimblue-node / niimbluelib, over USB-serial or Bluetooth LE
via `transport` auto|serial|ble). Feature modules live in
`rootfs/usr/local/lib/niimblue-print/` (queue, text layout/render, templates,
history, warnings, MQTT bridge, BLE helpers); tests in `niimblue-print/tests/`.
The old `niimblue-print-bt` add-on (niimprint, BT Classic) was removed in 1.3.0.

## Release rule — DO THIS ON EVERY PUSH THAT CHANGES THE ADD-ON

Home Assistant only offers an update when the `version:` string changes. Same
version = HA never updates, even if files changed. So, every push that touches
anything under the add-on folder (`niimblue-print/`):

1. Bump `niimblue-print/config.yaml` → `version:` (semver, e.g. 1.0.5 → 1.0.6).
2. Add a matching top entry to `niimblue-print/CHANGELOG.md` (HA renders this in
   the update dialog; absence shows "No changelog found").
3. Commit with the version in the subject, e.g. `... (v1.0.6)`.
4. Push. Then in HA: Add-on Store → ⋮ → **Check for updates** (the store caches
   repo metadata; a fresh push isn't seen until this reload).

No other file is needed for updates — no release tags, no GitHub Releases. HA
reads `config.yaml`/`CHANGELOG.md` straight from the git repo.

## Version-shows-stale checklist

If HA shows an old "Neueste Version" after a push:
- Confirm the push landed: `git ls-remote origin main` HEAD == local HEAD.
- Confirm `config.yaml` version was actually bumped (not just code changed).
- In HA, **Check for updates** on the store to drop the metadata cache.

## Build reality (don't relearn the hard way)

- Supervisor builds `FROM ghcr.io/home-assistant/<arch>-base` (Alpine, **apk**),
  NOT the Debian/node image. No `apt-get`.
- Ingress serves under a sub-path, so assets must be relative: `vite build
  --base=./`, plus nginx injects `<base href="$http_x_ingress_path/">`.
- Image encoder packs 8 px/byte; niimbluelib 0.47's encoder pads the columns
  to 8 itself (verified in `utils/image_encoder.js`), rows can be any count —
  the old client-side pad-to-8 was removed in 1.3.0. Server-rendered labels
  are multiples of 8 anyway (label-size.js).
- serialport write without a callback throws on EIO and kills the process —
  keep `patch-niimbluelib.sh` and the server auto-restart loop.
- Never use a `device(...)` schema type for the printer: Supervisor refuses to
  START the add-on when that node is absent (printer off at boot). `address`
  is `str?`; `uart: true` covers hot-plugged ttyACM/ttyUSB.
- BLE = niimbluelib's NiimbotNodeBleClient -> @stoprocent/noble with
  `NOBLE_BINDINGS=dbus` (+ `dbus-next`) -> host BlueZ via `host_dbus`.
  print-server.js sets NOBLE_BINDINGS before loading niimbluelib. Never
  noble's default raw-HCI binding: it fights HA's Bluetooth. The Dockerfile
  build step fails loudly if the dbus binding can't resolve.
- Server deps (niimblue-node, dbus-next, mqtt, bwip-js, opentype.js) come from
  `rootfs/usr/local/lib/niimblue-print/package-lock.json` via `npm ci` in a
  builder stage. `overrides: node-gyp ^11` is required: dbus-next -> usocket
  hoists node-gyp 7, which breaks noble's native build on Python >= 3.12.
  After changing deps: `npm install` there (needs registry access), commit
  the lockfile. `.dockerignore` keeps host-built node_modules out.
- NiimBlue is pinned (Dockerfile NIIMBLUE_REF tag + NIIMBLUE_SHA check);
  `patch/patch-niimblue-src.js` and `patch-niimbluelib.sh` exit 1 when an
  anchor is missing — re-check them when bumping.
- Base images pinned to `:3.24` (build.yaml). armv7 dropped: sharp has no
  linuxmusl-arm binary.
- print-server.js imports niimblue-node internals (printImages, ImageEncoder)
  — niimblue-node is pinned; re-test before bumping it.
- niimbluelib BLE quirks handled in print-server.js: c.device is set only at
  the END of connect() (a timed-out connect must be disconnected when it
  settles, else an orphan link holds the printer); every connect adds a
  "disconnect" listener to noble's cached Peripheral (removed by us).
- Port 5000 is `null` (not on the host) by default; HA core uses the add-on
  hostname. nginx :8099 only allows 172.30.32.2 (ingress) + loopback.
  Optional `api_token` for non-loopback clients.
- Local testing: `npm test` in the lib folder (unit), `node tests/e2e.js`
  (fake printer preload `tests/fake-printer.js` + mosquitto + fake
  Supervisor; also runs inside the image: mount tests at /e2e/tests and
  `ln -s / /e2e/rootfs`). Never print on the real printer from tests.
- B21S facts: BLE name `B21S-C2BF926031720`, LE-only random address
  `C3:F9:26:03:17:20`, model B21S_C2B. Print task **B1** (USB and BLE);
  niimbluelib auto-detects D110, which prints BLANK labels on it (verified
  2026-10-10) -> print-server.js `PRINT_TASK_OVERRIDES` forces B1 when no
  task is configured. No pairing needed. niimprint (Classic) prints blank
  labels on it.
- Label auto-size: RFID barcode -> NIIMBOT cloud `getCloudTemplateByOneCode`
  -> `/data/labels.json`; geometry + across-head rule in `label-size.js`
  (pure, exported: `labelCanvas`, `centreCropAcross`, `blindZone` — reuse it,
  don't duplicate size math). Overwidth is centre-cropped like the app
  (50 mm roll = 400 px -> 384 px head, 8 px cut each side).
