# ha-niimblue-addons — working rules

Home Assistant add-on repository. One add-on: `niimblue-print` (NiimBlue label
designer in the HA sidebar + host-side niimblue-node REST print server over
USB-serial).

## Release rule — DO THIS ON EVERY PUSH THAT CHANGES THE ADD-ON

Home Assistant only offers an update when the `version:` string changes. Same
version = HA never updates, even if files changed. So, every push that touches
anything under `niimblue-print/`:

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
