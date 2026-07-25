# Changelog

Home Assistant shows this file in the add-on's update dialog. Newest on top.
Bump `version:` in `config.yaml` and add a matching entry here on every push.

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
