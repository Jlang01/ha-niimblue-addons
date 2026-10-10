# Home Assistant add-on image. Supervisor builds FROM the HA base (Alpine/apk),
# passing BUILD_FROM. Default set so plain `docker build` works too.
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest

# --- Build NiimBlue from source with a RELATIVE base path ---------------
# HA ingress serves under /api/hassio_ingress/<token>/, so the app MUST use
# relative asset paths (vite base './'). The prebuilt release uses absolute
# '/assets/...' which 404s under ingress — hence source build.
FROM ${BUILD_FROM} AS designer
RUN apk add --no-cache nodejs npm git
ARG NIIMBLUE_REF=main
RUN git clone --depth 1 --branch ${NIIMBLUE_REF} https://github.com/MultiMote/niimblue.git /src
WORKDIR /src
# Patch UI for host printing: drop the unsupported-browser banner and make the
# preview's Print button print via the host server (see patch script).
COPY patch/patch-niimblue-src.js /tmp/patch-niimblue-src.js
RUN node /tmp/patch-niimblue-src.js
RUN npm ci && npm run build -- --base=./
# result: /src/dist  (relative-path SPA)

# ========================================================================
FROM ${BUILD_FROM}

ENV LANG=C.UTF-8 NODE_ENV=production

# Runtime + native build deps (noble/serialport compile against musl):
#  nginx jq curl bash mosquitto-clients : runtime glue
#  nodejs npm                           : run niimblue-node
#  build-base python3 pkgconf linux-headers eudev-dev : native module build
#  bluez-dev                            : noble's (unused) raw-HCI addon build
RUN apk add --no-cache \
      nginx jq curl bash mosquitto-clients \
      nodejs npm \
      build-base python3 pkgconf linux-headers eudev-dev bluez-dev

# --- niimblue-node (niimbluelib + encoder; our print-server.js wraps it) ---
# Pinned: print-server.js uses its exported printImages/ImageEncoder/loaders
# and patch-niimbluelib.sh patches its niimbluelib build.
ARG NIIMBLUE_NODE_VERSION=1.4.1
# dbus-next: lets noble (niimbluelib's BLE lib) use its BlueZ D-Bus binding
# (NOBLE_BINDINGS=dbus) instead of raw HCI, so BLE printing shares the adapter
# with Home Assistant's Bluetooth integration. Global install = resolvable
# from noble's nested node_modules (/usr/local/lib/node_modules).
ARG DBUS_NEXT_VERSION=0.10.2
RUN npm install -g @mmote/niimblue-node@${NIIMBLUE_NODE_VERSION} dbus-next@${DBUS_NEXT_VERSION} \
    && npm cache clean --force \
    && cd /usr/local/lib/node_modules/@mmote/niimblue-node \
    && NOBLE=$(dirname "$(node -p 'require.resolve("@stoprocent/noble/package.json", {paths:[require.resolve("@mmote/niimbluelib")]})')") \
    && test -f "$NOBLE/lib/dbus/bindings.js" \
    && node -e 'require.resolve("dbus-next", {paths:[process.argv[1] + "/lib/dbus"]})' "$NOBLE" \
    && echo "[build] noble dbus binding OK ($NOBLE)"

# --- designer static build from stage 1 ---
COPY --from=designer /src/dist /opt/niimblue

COPY rootfs/ /
RUN chmod +x /run.sh /usr/local/bin/*.sh

# Crash-proof the serial client (write-without-callback kills the process on EIO).
RUN /usr/local/bin/patch-niimbluelib.sh

EXPOSE 8099 5000
CMD [ "/run.sh" ]
