# Home Assistant add-on image (Bluetooth variant). Supervisor builds FROM the
# HA base (Alpine/apk), passing BUILD_FROM. Default set so `docker build` works.
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest

# --- Build NiimBlue from source with a RELATIVE base path (ingress) ------
# Identical designer build to the serial add-on: same source, same UI patches
# (drop browser banner, preview prints via host).
FROM ${BUILD_FROM} AS designer
RUN apk add --no-cache nodejs npm git
ARG NIIMBLUE_REF=main
RUN git clone --depth 1 --branch ${NIIMBLUE_REF} https://github.com/MultiMote/niimblue.git /src
WORKDIR /src
COPY patch/patch-niimblue-src.js /tmp/patch-niimblue-src.js
RUN node /tmp/patch-niimblue-src.js
RUN npm ci && npm run build -- --base=./
# result: /src/dist  (relative-path SPA)

# ========================================================================
FROM ${BUILD_FROM}

ENV LANG=C.UTF-8

# Runtime + Bluetooth stack:
#  nginx jq curl bash mosquitto-clients : runtime glue
#  python3 py3-pip py3-pillow           : print server + niimprint (no compile)
#  bluez dbus-libs                       : bluetoothctl for pairing/scan + BlueZ
RUN apk add --no-cache \
      nginx jq curl bash mosquitto-clients \
      python3 py3-pip py3-pillow \
      bluez dbus-libs git

# Python print backend: niimprint (Bluetooth Classic RFCOMM via AF_BLUETOOTH,
# uses stdlib socket — no bleak). The PyPI 'niimprint' is a stale placeholder,
# so install from GitHub. --ignore-requires-python: its poetry marker pins
# ~3.11 but it runs fine on the base image's Python.
RUN pip install --no-cache-dir --break-system-packages \
      flask pyserial click && \
    pip install --no-cache-dir --break-system-packages --ignore-requires-python --no-deps \
      "niimprint @ git+https://github.com/AndBondStyle/niimprint"

# --- designer static build from stage 1 ---
COPY --from=designer /src/dist /opt/niimblue

COPY rootfs/ /
RUN chmod +x /run.sh /usr/local/bin/*.sh /usr/local/bin/*.py

EXPOSE 8099 5001
CMD [ "/run.sh" ]
