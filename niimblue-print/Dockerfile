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
#  bluez-dev                            : only needed if BLE fallback is used
RUN apk add --no-cache \
      nginx jq curl bash mosquitto-clients \
      nodejs npm \
      build-base python3 pkgconf linux-headers eudev-dev bluez-dev

# --- niimblue-node (CLI + REST print server) ---
ARG NIIMBLUE_NODE_VERSION=latest
RUN npm install -g @mmote/niimblue-node@${NIIMBLUE_NODE_VERSION} \
    && npm cache clean --force

# --- designer static build from stage 1 ---
COPY --from=designer /src/dist /opt/niimblue

COPY rootfs/ /
RUN chmod +x /run.sh /usr/local/bin/*.sh

# Crash-proof the serial client (write-without-callback kills the process on EIO).
RUN /usr/local/bin/patch-niimbluelib.sh

EXPOSE 8099 5000
CMD [ "/run.sh" ]
