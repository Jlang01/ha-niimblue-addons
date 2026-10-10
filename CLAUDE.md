# ha-niimblue-addons — working rules

Home Assistant add-on repository. Active add-on: `niimblue-print` (NiimBlue
label designer in the HA sidebar + host-side print server
`rootfs/usr/local/bin/print-server.js`, a wrapper around niimblue-node /
niimbluelib, over USB-serial or Bluetooth LE via `transport`).
`niimblue-print-bt` (niimprint, Bluetooth Classic) is **deprecated** — kept only
so installs see the notice; don't develop it further.

## Release rule — DO THIS ON EVERY PUSH THAT CHANGES THE ADD-ON

Home Assistant only offers an update when the `version:` string changes. Same
version = HA never updates, even if files changed. So, every push that touches
anything under an add-on folder (`niimblue-print/`, `niimblue-print-bt/`;
same steps with that folder's files):

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
- Image encoder packs 8 px/byte: pad BOTH width and height to a multiple of 8.
- serialport write without a callback throws on EIO and kills the process —
  keep `patch-niimbluelib.sh` and the server auto-restart loop.
- Never use a `device(...)` schema type for the printer: Supervisor refuses to
  START the add-on when that node is absent (printer off at boot). `address`
  is `str?`; `uart: true` covers hot-plugged ttyACM/ttyUSB.
- BLE = niimbluelib's NiimbotNodeBleClient -> @stoprocent/noble with
  `NOBLE_BINDINGS=dbus` (+ global `dbus-next`) -> host BlueZ via `host_dbus`.
  Never noble's default raw-HCI binding: it fights HA's Bluetooth. The
  Dockerfile build step fails loudly if the dbus binding can't resolve.
- print-server.js imports niimblue-node internals (printImages, ImageEncoder,
  loaders) — niimblue-node is pinned; re-test before bumping it.
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
