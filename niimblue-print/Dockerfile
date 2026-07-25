ARG BUILD_FROM
FROM ${BUILD_FROM} AS designer

# --- Build NiimBlue from source with a RELATIVE base path ---------------
# HA ingress serves the add-on under /api/hassio_ingress/<token>/, so the
# app MUST use relative asset paths (vite base './'). The prebuilt release
# uses absolute '/assets/...' which 404s under ingress — hence source build.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG NIIMBLUE_REF=main
RUN git clone --depth 1 --branch ${NIIMBLUE_REF} https://github.com/MultiMote/niimblue.git /src
WORKDIR /src
RUN npm ci && npm run build -- --base=./
# result: /src/dist  (relative-path SPA)

# ========================================================================
FROM ${BUILD_FROM}

ENV LANG=C.UTF-8 \
    NODE_ENV=production \
    NIIMBLUE_NODE_VERSION=latest

# --- System deps ---
#  nginx  : serve designer + ingress proxy
#  jq     : parse /data/options.json
#  mosquitto-clients : MQTT discovery + status publish
#  build-essential python3 libudev-dev : native build for noble/serialport
#  libbluetooth-dev : only needed if BLE fallback is used
RUN apt-get update && apt-get install -y --no-install-recommends \
      nginx jq curl ca-certificates mosquitto-clients \
      build-essential python3 pkg-config libudev-dev libbluetooth-dev \
    && rm -rf /var/lib/apt/lists/*

# --- niimblue-node (CLI + REST print server) ---
RUN npm install -g @mmote/niimblue-node@${NIIMBLUE_NODE_VERSION} \
    && npm cache clean --force

# --- designer static build from stage 1 ---
COPY --from=designer /src/dist /opt/niimblue

COPY rootfs/ /
RUN chmod +x /run.sh /usr/local/bin/*.sh

EXPOSE 8099 5000
CMD [ "/run.sh" ]
