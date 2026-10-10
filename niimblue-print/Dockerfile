# Home Assistant add-on image. Supervisor builds FROM the HA base (Alpine/apk),
# passing BUILD_FROM (build.yaml pins the Alpine release). Default set so a
# plain `docker build` works too.
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.24

# --- 1. NiimBlue designer from source with a RELATIVE base path -----------
# HA ingress serves under /api/hassio_ingress/<token>/, so the app MUST use
# relative asset paths (vite base './'). The prebuilt release uses absolute
# '/assets/...' which 404s under ingress — hence source build. Pinned to a
# release tag + its commit, so a NiimBlue change can't silently break the
# build-time patches (which also fail the build when they don't apply).
FROM ${BUILD_FROM} AS designer
RUN apk add --no-cache nodejs npm git
ARG NIIMBLUE_REF=v2026.9.0
ARG NIIMBLUE_SHA=82c5605780818299422a6acdf3180d87c569578d
RUN git clone --depth 1 --branch ${NIIMBLUE_REF} https://github.com/MultiMote/niimblue.git /src \
    && test "$(git -C /src rev-parse HEAD)" = "${NIIMBLUE_SHA}" \
    || { echo "NiimBlue ${NIIMBLUE_REF} is not commit ${NIIMBLUE_SHA}"; exit 1; }
WORKDIR /src
# Patch UI for host printing: drop the unsupported-browser banner and make the
# preview's Print button print via the host server (see patch script).
COPY patch/patch-niimblue-src.js /tmp/patch-niimblue-src.js
RUN node /tmp/patch-niimblue-src.js
RUN npm ci && npm run build -- --base=./
# result: /src/dist  (relative-path SPA)

# --- 2. print server dependencies (native modules need the toolchain) -----
# Everything comes from the committed package-lock.json (npm ci): niimblue-
# node, niimbluelib, noble + dbus-next, sharp, serialport, mqtt, fonts libs.
FROM ${BUILD_FROM} AS server
RUN apk add --no-cache nodejs npm build-base python3 pkgconf linux-headers eudev-dev bluez-dev bash
WORKDIR /usr/local/lib/niimblue-print
COPY rootfs/usr/local/lib/niimblue-print/package.json rootfs/usr/local/lib/niimblue-print/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# noble must resolve its BlueZ D-Bus binding + dbus-next (BLE shares HA's
# adapter); fail the build loudly if not.
RUN NOBLE=$(dirname "$(node -p 'require.resolve("@stoprocent/noble/package.json", {paths:[require.resolve("@mmote/niimbluelib", {paths:[require.resolve("@mmote/niimblue-node")]})]})')") \
    && test -f "$NOBLE/lib/dbus/bindings.js" \
    && node -e 'require.resolve("dbus-next", {paths:[process.argv[1] + "/lib/dbus"]})' "$NOBLE" \
    && node -e 'require("sharp"); require("serialport")' \
    && echo "[build] noble dbus binding + sharp + serialport OK ($NOBLE)"
# Crash-proof the serial client (write-without-callback kills the process on EIO).
COPY rootfs/usr/local/bin/patch-niimbluelib.sh /tmp/patch-niimbluelib.sh
RUN bash /tmp/patch-niimbluelib.sh /usr/local/lib/niimblue-print/node_modules

# --- 3. runtime (no compiler toolchain) ------------------------------------
FROM ${BUILD_FROM}

ENV LANG=C.UTF-8 NODE_ENV=production

#  nginx jq curl bash : runtime glue (ingress, option parsing)
#  nodejs             : print server
#  font-dejavu        : text labels (rendered offline, server-side)
#  eudev eudev-libs   : serialport (native binding; udevadm for port listing)
RUN apk add --no-cache nginx jq curl bash nodejs font-dejavu eudev eudev-libs

COPY --from=server /usr/local/lib/niimblue-print/node_modules /usr/local/lib/niimblue-print/node_modules
# --- designer static build -> /opt/niimblue/designer (the sidebar shell is /opt/niimblue) ---
COPY --from=designer /src/dist /opt/niimblue/designer

COPY rootfs/ /
RUN chmod +x /run.sh /usr/local/bin/*.sh \
    && node -e 'require("/usr/local/lib/niimblue-print/fonts.js").loadFont("bold")' \
    && node --check /usr/local/bin/print-server.js

EXPOSE 8099 5000
CMD [ "/run.sh" ]
