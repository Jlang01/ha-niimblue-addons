#!/usr/bin/env node
/* NiimBlue host print server for the Home Assistant add-on.
 *
 * A thin, add-on-aware wrapper around the SAME niimblue-node / niimbluelib code
 * paths the stock `niimblue-cli server` uses (same image encoder, same print
 * task flow), adding what the stock server lacks:
 *
 *   - Starts with NO printer present and keeps retrying with backoff. A printer
 *     that is switched off / unplugged / out of Bluetooth range is normal.
 *   - transport auto|serial|ble. auto: a NIIMBOT USB device (vendor 3513) if
 *     one is plugged in, else Bluetooth LE. Serial auto-detect only ever picks
 *     a NIIMBOT device, never some other tty (Zigbee stick, ...).
 *   - Bluetooth goes through BlueZ over D-Bus (noble's dbus binding,
 *     NOBLE_BINDINGS=dbus), so it SHARES the adapter with Home Assistant's
 *     Bluetooth integration instead of grabbing raw HCI.
 *   - Persistent print queue (/data/queue): every print is a job, printed in
 *     order, one at a time; jobs wait (and survive restarts) while the printer
 *     is off / asleep / out of range and print as soon as it is back (BLE:
 *     reacts to its advertisement). Bluetooth is released after the queue is
 *     drained (disconnect_after_print) or after an idle period.
 *   - Printer problems (lid open, no labels, ...) pause the queue; a job that
 *     already started printing is never retried automatically (no duplicates).
 *   - GET /status /diag /scan: connection state, printer info, diagnostics.
 *   - Label auto-size: reads the roll's RFID barcode on connect, resolves the
 *     label size (local cache /data/labels.json, else NIIMBOT's cloud) and,
 *     when no size is configured or requested, fits prints to it.
 *   - Text labels, templates, history, warnings, MQTT: modules under
 *     /usr/local/lib/niimblue-print (features.js wires their REST routes);
 *     this file keeps the printer, the queue runner and the HTTP server.
 *
 * API-compatible with `niimblue-cli server` for /connect /disconnect
 * /connected /info /rfid /print /scan, so existing rest_commands keep working.
 * Configured by env vars set in run.sh from the add-on options.
 */
"use strict";
const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { createRequire } = require("module");

// Bluetooth always via BlueZ over D-Bus (shared with HA), never noble's raw
// HCI binding: set before niimbluelib loads noble (transport auto and /scan
// can use Bluetooth even when the add-on option says serial).
process.env.NOBLE_BINDINGS = process.env.NOBLE_BINDINGS || "dbus";
process.env.DBUS_SYSTEM_BUS_ADDRESS = process.env.DBUS_SYSTEM_BUS_ADDRESS || "unix:path=/run/dbus/system_bus_socket";

// niimblue-node comes from the lib's package-lock (npm ci at build time);
// resolve it and ITS copies of the libs so we share one niimbluelib instance
// with its printImages()/ImageEncoder.
const LIB_DIR = process.env.NIIMBLUE_LIB_DIR || path.join(__dirname, "../lib/niimblue-print");
const NB_DIR = process.env.NIIMBLUE_NODE_DIR || path.join(LIB_DIR, "node_modules/@mmote/niimblue-node");
const nbRequire = createRequire(path.join(NB_DIR, "package.json"));
const nb = nbRequire("./");
const lib = nbRequire("@mmote/niimbluelib");
const { z } = nbRequire("zod");
const { Mutex } = nbRequire("async-mutex");
const sharp = nbRequire("sharp");
// noble = the instance niimbluelib uses (same module cache), resolved lazily
const libRequire = createRequire(nbRequire.resolve("@mmote/niimbluelib"));
const labelSize = require(path.join(__dirname, "label-size.js"));
const { createFeatures } = require(path.join(LIB_DIR, "features.js"));
const { TemplateStore } = require(path.join(LIB_DIR, "templates.js"));
const { History } = require(path.join(LIB_DIR, "history.js"));
const { Warnings, haNotifier } = require(path.join(LIB_DIR, "warnings.js"));
const { MqttBridge } = require(path.join(LIB_DIR, "mqtt-bridge.js"));
const { PrintQueue } = require(path.join(LIB_DIR, "queue.js"));
const printerErrors = require(path.join(LIB_DIR, "printer-errors.js"));
const { Ble } = require(path.join(LIB_DIR, "ble.js"));
const placeholders = require(path.join(LIB_DIR, "placeholders.js"));
const supervisor = require(path.join(LIB_DIR, "supervisor.js"));
const { writeJsonAtomic, readJson } = require(path.join(LIB_DIR, "persist.js"));

// ---- config (env from run.sh) ------------------------------------------
const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const bool = (v, d) => (v === undefined || v === "" ? d : !/^(false|0|no|off)$/i.test(String(v)));
const CFG = {
  transport: ["serial", "ble"].includes(env("TRANSPORT", "auto")) ? env("TRANSPORT", "auto") : "auto",
  address: env("ADDRESS", ""),               // tty path | BLE MAC or name | "" = auto
  printTask: env("MODEL", ""),               // "" = auto-detect on connect
  reconnectS: Math.max(3, int(env("RECONNECT", "10"), 10)),
  idleS: Math.max(0, int(env("IDLE_DISCONNECT", "60"), 60)), // BLE only; 0 = stay connected
  disconnectAfterPrint: bool(env("DISCONNECT_AFTER_PRINT", "true"), true),  // BLE: release when the queue is empty
  host: env("HOST", "0.0.0.0"),
  apiToken: env("API_TOKEN", ""),            // required (Bearer) from non-loopback clients when set
  port: int(env("PORT", "5000"), 5000),
  debug: /^(debug|trace)$/.test(env("LOG_LEVEL", "info")),
  // Size/fit defaults from the add-on options. 0/0 = auto (detected label).
  labelWidth: Math.max(0, int(env("LABEL_WIDTH", "0"), 0)),
  labelHeight: Math.max(0, int(env("LABEL_HEIGHT", "0"), 0)),
  imageFit: env("IMAGE_FIT", "contain"),
  printDirection: env("PRINT_DIRECTION", "top") === "left" ? "left" : "top",
  labelLookup: bool(env("LABEL_LOOKUP", "true"), true),   // NIIMBOT cloud lookup by roll barcode
  labelsFile: env("LABELS_FILE", "/data/labels.json"),
  // Server-side print defaults (request values win). density 0 = the model's
  // default (B21S: 3); any density is clamped to the model's range.
  density: Math.min(5, Math.max(0, int(env("DENSITY", "0"), 0))),
  threshold: Math.min(255, Math.max(1, int(env("THRESHOLD", "128"), 128))),
  dataDir: env("DATA_DIR", "/data"),
  mqttEnabled: bool(env("MQTT_ENABLED", "true"), true),
  lowLabelThreshold: Math.max(0, int(env("LOW_LABEL_THRESHOLD", "20"), 20)),
  notifications: bool(env("NOTIFICATIONS", "true"), true),
  timezone: env("TIMEZONE", "") || env("TZ", ""),
  dateFormat: env("DATE_FORMAT", "YYYY-MM-DD"),
  timeFormat: env("TIME_FORMAT", "HH:mm"),
  historySize: Math.min(200, Math.max(1, int(env("HISTORY_SIZE", "20"), 20))),
  waitTimeoutS: Math.min(300, Math.max(0, int(env("WAIT_TIMEOUT", "30"), 30))),
  queueMaxAgeH: Math.max(0, int(env("QUEUE_MAX_AGE_HOURS", "24"), 24)),
};
if (!["contain", "cover", "fill", "inside", "outside"].includes(CFG.imageFit)) CFG.imageFit = "contain";
if (CFG.printTask && !lib.printTaskNames.includes(CFG.printTask)) {
  console.warn(`[niimblue:server] unknown model/printTask '${CFG.printTask}', ignoring ` +
    `(valid: ${lib.printTaskNames.join(", ")})`);
  CFG.printTask = "";
}
const PRINTER_FILE = path.join(CFG.dataDir, "printer.json");   // remembered BLE printer
const VERSION = (() => { try { return require(path.join(LIB_DIR, "package.json")).version; } catch (_) { return "?"; } })();

const NIIMBOT_USB_VID = "3513";
const BACKOFF_MAX_S = 300;
const BLE_SCAN_MS = 8000;
const CONNECT_TIMEOUT_MS = 30000;
const CONNECT_HANGS_BEFORE_RESTART = 3;   // BLE connects that hung in a row -> restart (fresh noble/BlueZ state)
const BLE_CONNECT_ATTEMPTS = 3;
const HEARTBEAT_MAX_FAILS = 5;
const JOB_TIMEOUT_BASE_MS = 60000;
const JOB_TIMEOUT_PER_LABEL_MS = 20000;
const MAX_QUANTITY = 999;
const MAX_SIDE_PX = 4096;
const MAX_INPUT_PIXELS = 40e6;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15000;

const log = (...a) => console.log("[niimblue:server]", ...a);
const msg = (e) => (e instanceof Error ? e.message : String(e));
const iso = () => new Date().toISOString();

class RestError extends Error {
  constructor(message, status = 500, extra) { super(message); this.status = status; this.extra = extra; }
}

// ---- state --------------------------------------------------------------
// status: starting | waiting | connecting | connected | idle | disconnected | error
const state = {
  client: null,
  status: "starting",
  detail: "",
  transport: null,        // transport of the current / last connection (serial | ble)
  address: null,          // device path / BLE address actually in use
  bleFound: null,         // BLE printer found by scan, remembered in /data/printer.json
  battery: null,
  model: null,
  failures: 0,
  nextAttemptAt: 0,
  lastActivity: 0,
  lastError: null,
  lastErrorAt: null,
  lastConnectedAt: null,
  lastPrintAt: null,
  lastPrintOk: null,
  label: null,            // roll from RFID: {barcode, uuid, serial, total, used, type, seenAt, tpl, source}
  meta: null,             // {model, dpi, printheadPixels, printDirection, density*, paperTypes, info} of the last printer
  adapter: null,          // Bluetooth adapter state from noble (poweredOn / poweredOff / unsupported ...)
  connectHangs: 0,
  events: [],             // last connection events for /diag
};
const lock = new Mutex();   // serializes connect / disconnect / print / scan

const isConnected = () => !!state.client && state.client.isConnected();

function event(type, detail = "") {
  state.events.push({ at: iso(), type, detail });
  if (state.events.length > 50) state.events.splice(0, state.events.length - 50);
}

function setStatus(status, detail = "") {
  if (state.status === status && state.detail === detail) return;
  state.status = status;
  state.detail = detail;
  event(status, detail);
  log(`${status}${detail ? ": " + detail : ""}`);
  statusChanged();
}

/** Push state to MQTT soon (coalesced). Set up in main. */
let statusChangedHook = () => {};
const statusChanged = () => statusChangedHook();

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

// ---- transport + device resolution ---------------------------------------
// The address option decides the transport in auto mode when it is set
// (/dev/... = serial, anything else = a BLE MAC or name).
const addressKind = (a) => (!a ? null : a.startsWith("/dev/") ? "serial" : "ble");
const serialAddress = () => (CFG.transport === "serial" ? CFG.address : addressKind(CFG.address) === "serial" ? CFG.address : "");
const bleAddress = () => (CFG.transport === "ble" ? CFG.address : addressKind(CFG.address) === "ble" ? CFG.address : "");

function ttyVendor(dev) {
  try {
    const name = path.basename(fs.realpathSync(dev));          // by-id symlink -> ttyACM0
    return fs.readFileSync(`/sys/class/tty/${name}/device/../idVendor`, "utf8").trim().toLowerCase();
  } catch (_) {
    return null;
  }
}

function listSerial() {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    let real = p;
    try { real = fs.realpathSync(p); } catch (_) { /* dangling */ }
    if (seen.has(real)) return;
    seen.add(real);
    const vid = ttyVendor(p);
    out.push({ address: p, name: path.basename(p), niimbot: vid === NIIMBOT_USB_VID || /niimbot/i.test(p) });
  };
  // Stable by-id paths first, then raw CDC/USB-serial nodes.
  try { fs.readdirSync("/dev/serial/by-id").sort().forEach((f) => add(`/dev/serial/by-id/${f}`)); } catch (_) { /* none */ }
  try {
    fs.readdirSync("/dev").filter((f) => /^tty(ACM|USB)\d+$/.test(f)).sort().forEach((f) => add(`/dev/${f}`));
  } catch (_) { /* none */ }
  return out;
}

function resolveSerial() {
  const a = serialAddress();
  if (a) return fs.existsSync(a) ? a : null;
  if (CFG.transport === "ble" || addressKind(CFG.address) === "ble") return null;
  const hit = listSerial().find((d) => d.niimbot);
  return hit ? hit.address : null;
}

// Model names from niimbluelib (B21, B21S, D110, ...). A NIIMBOT advertises as
// "<MODEL>-<serial>", e.g. "B21S-C2B...", so match the part before the dash.
const MODEL_HEADS = new Set(Object.values(lib.PrinterModel).map((m) => String(m).split("_")[0].toUpperCase()));
const looksLikePrinter = (name) => MODEL_HEADS.has(String(name || "").split(/[-_\s]/)[0].toUpperCase());

// dbus-next emits an unhandled 'error' (= process crash) when the bus socket is
// missing, so check before noble touches it.
const DBUS_SOCKET = (env("DBUS_SYSTEM_BUS_ADDRESS", "").match(/unix:path=([^,;]+)/) || [])[1]
  || "/run/dbus/system_bus_socket";
const dbusPresent = () => fs.existsSync(DBUS_SOCKET);
function assertDbus() {
  if (!dbusPresent()) {
    throw new RestError(`host D-Bus not available (${DBUS_SOCKET} missing; add-on needs host_dbus)`, 503);
  }
}

/**
 * Transport to use now: serial | ble | null (nothing usable).
 * auto: a plugged-in NIIMBOT USB device wins, else Bluetooth.
 */
function pickTransport() {
  if (CFG.transport !== "auto") return CFG.transport;
  const k = addressKind(CFG.address);
  if (k) return k;
  if (resolveSerial()) return "serial";
  return dbusPresent() ? "ble" : null;
}
const isBle = () => (state.transport || pickTransport()) === "ble";
// BLE links are opened on demand (and released) unless idle_disconnect_seconds = 0
const onDemand = () => isBle() && CFG.idleS > 0;

const ble = new Ble(() => {
  assertDbus();
  return libRequire("@stoprocent/noble");
}, {
  log: (m) => log(m),
  looksLikePrinter,
  onState: (s) => {
    const was = state.adapter;
    state.adapter = s;
    event("adapter", s);
    if (s === "poweredOn" && was && was !== "poweredOn") queue && queue.kick();   // adapter back: retry now
    if (s !== "poweredOn" && isBle() && !isConnected()) {
      setStatus("error", `Bluetooth adapter ${s === "poweredOff" ? "is switched off" : s === "unsupported" ? "not available (missing / blocked)" : s}`);
    }
    statusChanged();
  },
});

function loadPrinterFile() {
  try {
    const d = JSON.parse(fs.readFileSync(PRINTER_FILE, "utf8"));
    if (d && d.ble && d.ble.address) state.bleFound = d.ble;
  } catch (_) { /* first run */ }
}
function rememberBle(found) {
  state.bleFound = found;
  try {
    fs.mkdirSync(path.dirname(PRINTER_FILE), { recursive: true });
    fs.writeFileSync(PRINTER_FILE, JSON.stringify({ ble: found }));
  } catch (e) { log(`could not remember the printer: ${msg(e)}`); }
}

async function bleScan(timeoutMs) {
  assertDbus();
  const devs = await ble.scan(timeoutMs);
  return devs;
}

async function resolveBle() {
  const a = bleAddress();
  if (a) return a;
  if (state.bleFound) return state.bleFound.address;
  setStatus("connecting", "scanning for a NIIMBOT printer over Bluetooth ...");
  const hit = (await bleScan(BLE_SCAN_MS)).find((d) => d.likely_printer);
  if (!hit) return null;
  rememberBle({ address: hit.address, name: hit.name });
  log(`found ${hit.name} (${hit.address}), remembered. Tip: set 'address: ${hit.address}' to skip scans for good.`);
  return hit.address;
}

/** Does a BLE advertisement belong to our printer? */
function isOurPrinter(info) {
  const want = bleAddress() || (state.bleFound && state.bleFound.address);
  if (want) {
    const w = want.toLowerCase();
    return (info.address && info.address.toLowerCase() === w) || (info.name && info.name.toLowerCase() === w) ||
      (state.bleFound && info.name && info.name === state.bleFound.name);
  }
  return looksLikePrinter(info.name);
}

// ---- label detection (RFID barcode -> size) ----------------------------
// The roll's RFID tag carries a barcode and the label counters, but no size
// (printers don't report it). NIIMBOT's app gets the size from the cloud by
// barcode; we do the same once per barcode and cache it in /data/labels.json.
// Only the barcode is sent. Never blocks/fails a print: no answer = no
// auto size. Geometry rule + evidence: label-size.js.
const CLOUD_URL = "https://print.niimbot.com/api/template/getCloudTemplateByOneCode";
const CLOUD_TIMEOUT_MS = 8000;
const CLOUD_RETRY_MS = 5 * 60 * 1000;        // network error: retry on a later connect
const CLOUD_MISS_MS = 24 * 3600 * 1000;      // unknown barcode: don't ask again for a day
const RFID_FETCH_TIMEOUT_MS = 8000;

// labels: barcode -> template, without a prototype ("constructor" etc. are not hits)
const labelDb = { labels: Object.create(null), current: null, printer: null };
const cachedLabel = (barcode) => (Object.hasOwn(labelDb.labels, barcode) ? labelDb.labels[barcode] : null);
const lookups = new Map();   // barcode -> in-flight cloud lookup promise
const lookupBackoff = new Map();  // barcode -> do not retry before (ms)
let lastSavedDb = null;

function loadLabelDb() {
  const d = readJson(CFG.labelsFile, null, (m) => log(`label cache: ${m}`));
  if (d && typeof d.labels === "object" && d.labels) labelDb.labels = Object.assign(Object.create(null), d.labels);
  if (d && d.current && d.current.barcode) labelDb.current = d.current;
  if (d && d.printer) labelDb.printer = d.printer;
  if (labelDb.printer) state.meta = labelDb.printer;
  // Last roll seen: shown in /status until the printer reports again (a new
  // connect re-reads the tag before any auto-sized print).
  const cur = labelDb.current;
  if (cur) {
    const tpl = cachedLabel(cur.barcode);
    state.label = { ...cur, tpl, source: tpl ? "cache" : null };
  }
}

function saveLabelDb() {
  try {
    labelDb.current = state.label
      ? { barcode: state.label.barcode, uuid: state.label.uuid, serial: state.label.serial,
          total: state.label.total, used: state.label.used, type: state.label.type, seenAt: state.label.seenAt }
      : null;
    labelDb.printer = state.meta;
    const data = JSON.stringify({ version: 1, ...labelDb }, null, 2);
    if (data === lastSavedDb) return;   // BLE connects per print: skip no-op writes
    writeJsonAtomic(CFG.labelsFile, data);
    lastSavedDb = data;
  } catch (e) {
    log(`label cache write failed: ${msg(e)}`);
  }
}

async function cloudLookup(barcode) {
  if (typeof fetch !== "function") throw new Error("no fetch() in this Node.js");
  const r = await fetch(CLOUD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "niimbot-user-agent": "AppVersionName/999.0.0" },
    body: JSON.stringify({ oneCode: barcode }),
    signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return labelSize.parseCloudTemplate(j && j.data);   // null = unknown barcode
}

/** Resolve the size for a barcode (cache, else cloud). Never throws. */
function resolveLabel(barcode) {
  const apply = (tpl, source) => {
    if (state.label && state.label.barcode === barcode) {
      state.label.tpl = tpl;
      state.label.source = source;
    }
  };
  const cached = cachedLabel(barcode);
  if (cached) {
    // keep source "cloud" if this run fetched it; anything else is the cache
    if (!state.label || state.label.tpl !== cached) apply(cached, "cache");
    return Promise.resolve();
  }
  if (!CFG.labelLookup) return Promise.resolve();
  if (lookups.has(barcode)) return lookups.get(barcode);
  if ((lookupBackoff.get(barcode) || 0) > Date.now()) return Promise.resolve();
  const p = cloudLookup(barcode).then((tpl) => {
    if (!tpl) {
      lookupBackoff.set(barcode, Date.now() + CLOUD_MISS_MS);
      log(`label ${barcode}: unknown to the NIIMBOT cloud, no auto size`);
      return;
    }
    tpl.fetched_at = iso();
    labelDb.labels[barcode] = tpl;
    apply(tpl, "cloud");
    saveLabelDb();
    log(`label ${barcode}: ${tpl.name || "?"} ${tpl.cloud_width_mm}x${tpl.cloud_height_mm} mm ` +
      `(rotate ${tpl.rotate}) from NIIMBOT cloud`);
  }, (e) => {
    lookupBackoff.set(barcode, Date.now() + CLOUD_RETRY_MS);
    log(`label ${barcode}: cloud lookup failed (${msg(e)}), no auto size for now`);
  }).finally(() => lookups.delete(barcode));
  lookups.set(barcode, p);
  return p;
}

/** Feed an RFID read (niimbluelib CombinedRfidInfo) into the label state. */
function onRfid(info) {
  const t = info && info.labelRfidInfo;
  if (!t) return;                       // read failed: keep the last known roll
  if (!t.tagPresent || !t.barCode) {
    if (state.label) log("no RFID label tag reported (no roll / non-NIIMBOT roll): auto size off");
    state.label = null;
    saveLabelDb();
    return;
  }
  const barcode = String(t.barCode).trim();
  if (!/^[0-9A-Za-z_.-]{1,64}$/.test(barcode)) { log(`ignoring odd RFID barcode '${barcode}'`); return; }
  const same = state.label && state.label.barcode === barcode;
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
  state.label = {
    barcode,
    uuid: t.uuid || null,
    serial: t.serialNumber || null,
    total: n(t.allPaper),
    used: n(t.usedPaper),
    type: Number.isInteger(t.consumablesType) && t.consumablesType > 0 ? t.consumablesType : null,
    seenAt: iso(),
    tpl: same ? state.label.tpl : null,
    source: same ? state.label.source : null,
  };
  if (!same) log(`label roll ${barcode} detected (${state.label.total ?? "?"} labels, ${state.label.used ?? "?"} used)`);
  saveLabelDb();
  resolveLabel(barcode);
}

/** Print canvas of the current roll for a print direction, or null. */
function labelGeometry(printDirection) {
  if (!state.label || !state.label.tpl) return null;
  const meta = state.meta || {};
  return labelSize.labelCanvas(state.label.tpl, {
    printheadPx: meta.printheadPixels, dpi: meta.dpi, printDirection,
  });
}

function labelStatus() {
  const L = state.label;
  if (!L) return null;
  const g = labelGeometry(CFG.printDirection);
  const remaining = L.total !== null && L.used !== null ? Math.max(0, L.total - L.used) : null;
  return {
    barcode: L.barcode,
    name: L.tpl ? L.tpl.name : null,
    width_mm: g ? g.width_mm : null,
    height_mm: g ? g.height_mm : null,
    width_px: g ? g.width_px : null,
    height_px: g ? g.height_px : null,
    remaining,
    total: L.total,
    source: L.tpl ? L.source : null,
    // extras: orientation details for the numbers above
    print_direction: CFG.printDirection,
    across_mm: g ? g.across_mm : null,
    feed_mm: g ? g.feed_mm : null,
    across_px: g ? g.across_px : null,
    feed_px: g ? g.feed_px : null,
    // whole label (design size); prints are centre-cropped to width/height_px
    label_width_px: g ? g.label_width_px : null,
    label_height_px: g ? g.label_height_px : null,
    full_across_px: g ? g.full_across_px : null,
    clipped: g ? g.clipped : null,
    crop_each_side_px: g ? g.crop_each_side_px : null,
    blind_zone: g ? g.blind_zone : null,
    paper_type: autoLabelType(),            // label type sent with prints (1 gap, 2 black mark, 5 transparent)
    dpi: g ? g.dpi : null,
    serial: L.serial,
    seen_at: L.seenAt,
    lookup: CFG.labelLookup ? (lookups.has(L.barcode) ? "pending" : "on") : "off",
  };
}

// ---- print task --------------------------------------------------------
// niimbluelib 0.47 (niimblue-node 1.4.1) maps B21S / B21S_C2B to the D110
// print task. Verified 2026-10-10 on a real B21S_C2B over BLE from HA: D110
// prints BLANK labels, B1 prints correctly. So, when no task is configured,
// override the auto-detected task for these models. B21S_C2B is verified;
// B21S (same family, same D110 mapping in niimbluelib) is not.
// Other B21 variants already get non-D110 tasks from niimbluelib.
const PRINT_TASK_OVERRIDES = { B21S_C2B: "B1", B21S: "B1" };
let overrideLogged = null;

/** Print task to use when the request does not name one. */
function autoPrintTask(c) {
  if (CFG.printTask) return CFG.printTask;
  const detected = c.getPrintTaskType();
  const model = c.getModelMetadata()?.model;
  const forced = model && PRINT_TASK_OVERRIDES[model];
  if (forced && lib.printTaskNames.includes(forced)) {
    if (overrideLogged !== model) {
      overrideLogged = model;
      log(`model ${model}: using print task ${forced} instead of auto-detected ${detected ?? "none"} ` +
        "(D110 prints blank labels on the B21S; set 'model' to override)");
    }
    return forced;
  }
  return detected;
}

// ---- connection ---------------------------------------------------------
/**
 * niimbluelib adds a "disconnect" listener to noble's (cached, reused)
 * Peripheral on every BLE connect and never removes it: drop them once the
 * link is gone, or they pile up (MaxListenersExceeded, stale handlers firing).
 */
function dropPeripheralListeners(c) {
  const p = c && c.device;
  if (p && typeof p.removeAllListeners === "function" && typeof p.connectAsync === "function") {
    setImmediate(() => { try { p.removeAllListeners("disconnect"); } catch (_) { /* gone */ } });
  }
}

function makeClient(address, transport) {
  const c = transport === "ble" ? new lib.NiimbotNodeBleClient() : new lib.NiimbotNodeSerialClient();
  if (transport === "ble") c.setAddress(address); else c.setPort(address);
  let lastProgress = "";
  c.on("printprogress", (e) => {
    const p = `page ${e.page}/${e.pagesTotal}, print ${e.pagePrintProgress}%, feed ${e.pageFeedProgress}%`;
    if (p !== lastProgress) log(p);     // status is polled every 500 ms: log changes only
    lastProgress = p;
  });
  c.on("heartbeat", (e) => {
    const b = c.getPrinterInfo().batteryPercents;
    if (b !== undefined) state.battery = b;
    // lid closed / roll back in: a paused queue can go on right away
    const hb = e && e.data;
    if (hb && queue && queue.blocked && ["lid_open", "no_labels"].includes(queue.blocked.state) &&
      hb.lidClosed !== false && hb.paperInserted !== false) queue.kick();
  });
  // niimbluelib reads the RFID tag during connect, after each print and when
  // the heartbeat sees the lid/roll change; every read lands here.
  c.on("rfidinfofetched", (e) => {
    if (state.client === c) onRfid(e.info);
  });
  // niimbluelib itself drops the link after HEARTBEAT_MAX_FAILS misses.
  c.on("heartbeatfailed", (e) => {
    if (e.failedAttempts >= HEARTBEAT_MAX_FAILS) log("heartbeat lost, link will be dropped");
  });
  c.on("disconnect", () => {
    event("disconnect", `${transport} ${address}`);
    dropPeripheralListeners(c);
    if (state.client !== c || state.status !== "connected") return;
    state.client = null;
    state.nextAttemptAt = Date.now() + CFG.reconnectS * 1000;
    setStatus(onDemand() ? "idle" : "disconnected", "link closed by printer");
  });
  if (CFG.debug) {
    c.on("packetsent", (e) => log(`>> ${lib.Utils.bufToHex(e.packet.toBytes())} (${lib.RequestCommandId[e.packet.command]})`));
    c.on("packetreceived", (e) => log(`<< ${lib.Utils.bufToHex(e.packet.toBytes())} (${lib.ResponseCommandId[e.packet.command]})`));
  }
  return c;
}

function failed(e) {
  state.failures++;
  state.lastError = msg(e);
  state.lastErrorAt = iso();
  const delay = Math.min(BACKOFF_MAX_S, CFG.reconnectS * 2 ** Math.min(state.failures - 1, 6));
  state.nextAttemptAt = Date.now() + delay * 1000;
  // A scanned (not configured) BLE printer that keeps failing may have changed: rescan.
  if (state.failures >= 3 && state.bleFound && !bleAddress()) {
    log(`forgetting ${state.bleFound.name || state.bleFound.address} after ${state.failures} failed connects (will scan again)`);
    state.bleFound = null;
    try { fs.rmSync(PRINTER_FILE, { force: true }); } catch (_) { /* ignore */ }
  }
  const pending = queue && queue.pending().length;
  const retry = pending ? "queued jobs wait, retrying" : onDemand() ? "will retry on next print" : `retrying in ${delay}s`;
  setStatus("error", `${state.lastError} (${retry})`);
}

/** Printer metadata + info worth keeping when disconnected (status / diag). */
function captureMeta(c) {
  const meta = c.getModelMetadata();
  const info = c.getPrinterInfo() || {};
  if (!meta && !info.serial) return;
  state.meta = {
    ...(state.meta || {}),
    ...(meta ? {
      model: meta.model, dpi: meta.dpi, printheadPixels: meta.printheadPixels, printDirection: meta.printDirection,
      densityMin: meta.densityMin, densityMax: meta.densityMax, densityDefault: meta.densityDefault,
      paperTypes: meta.paperTypes,
    } : {}),
    info: {
      serial: info.serial ?? null,
      mac: info.mac ?? null,
      firmware: info.softwareVersion ?? null,
      hardware: info.hardwareVersion ?? null,
      protocol_version: info.protocolVersion ?? null,
      model_id: info.modelId ?? null,
      auto_shutdown: info.autoShutdownTime ?? null,
    },
  };
}

/** Caller must hold `lock`. No-op if already connected. */
async function connectNow(reason) {
  if (isConnected()) return;
  const transport = pickTransport();
  if (!transport) {
    const why = "no NIIMBOT USB printer plugged in and no Bluetooth (host D-Bus) available";
    setStatus("waiting", why);
    throw new RestError(why, 503);
  }
  let address;
  try {
    if (transport === "ble") {
      assertDbus();
      if (state.adapter && state.adapter !== "poweredOn" && state.adapter !== "unknown") {
        throw new Error(`Bluetooth adapter ${state.adapter === "poweredOff" ? "is switched off" : state.adapter}`);
      }
      await ble.unwatch();   // niimbluelib runs its own discovery for the connect
    }
    address = transport === "ble" ? await resolveBle() : resolveSerial();
  } catch (e) {
    failed(e);
    throw new RestError(`Bluetooth: ${msg(e)}`, 503);
  }
  if (!address) {
    const why = transport === "ble"
      ? "no NIIMBOT printer found over Bluetooth (switched on and in range?)"
      : serialAddress()
        ? `${serialAddress()} not present (printer off or unplugged?)`
        : "no NIIMBOT USB device found (printer off or unplugged?)";
    if (transport === "ble") failed(new Error(why)); else setStatus("waiting", why);
    throw new RestError(why, 503);
  }
  // BLE on a marginal link: BlueZ drops/re-adds the device object and LE
  // connects abort now and then. A couple of quick retries (each re-runs
  // discovery) turn most of those into a successful print.
  const attempts = transport === "ble" ? BLE_CONNECT_ATTEMPTS : 1;
  let c;
  for (let i = 1; ; i++) {
    setStatus("connecting", `${transport} ${address} (${reason}${attempts > 1 ? `, try ${i}/${attempts}` : ""})`);
    c = makeClient(address, transport);
    state.client = c;
    const connecting = c.connect();
    try {
      await withTimeout(connecting, CONNECT_TIMEOUT_MS, "connect");
      break;
    } catch (e) {
      state.client = null;
      // niimbluelib sets c.device only at the very end of connect(), so a
      // disconnect now may be a no-op: if the timed-out connect still
      // succeeds later, drop THAT link, or it holds the printer for good.
      connecting.then(() => c.disconnect(), () => {}).finally(() => dropPeripheralListeners(c)).catch(() => {});
      c.disconnect().catch(() => {});
      // Watchdog: noble/BlueZ connects that hang (not fail) repeatedly mean a
      // wedged BLE stack. Restart the server (run.sh restarts it; the queue
      // survives) so noble starts from a clean D-Bus state.
      if (transport === "ble" && /connect timed out/.test(msg(e))) {
        state.connectHangs++;
        if (state.connectHangs >= CONNECT_HANGS_BEFORE_RESTART) {
          log(`Bluetooth connect hung ${state.connectHangs} times in a row: restarting the print server to reset the BLE stack`);
          event("watchdog", "BLE connect hangs -> restart");
          setTimeout(() => process.exit(3), 1500);   // after the queue has re-queued the job
        }
      }
      if (i < attempts) {
        log(`connect try ${i} failed: ${msg(e)}`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      // noble never reaching "poweredOn" = BlueZ has no usable local adapter
      // (e.g. HA in a VM that only uses ESPHome Bluetooth proxies, which an
      // add-on cannot reach). Say so instead of the cryptic noble message.
      const err = /powered on/i.test(msg(e))
        ? new Error("no local Bluetooth adapter on the host (BlueZ never powered on). " +
          "ESPHome Bluetooth proxies are not usable from an add-on; pass a USB BT " +
          "adapter to the host or use transport: serial")
        : e;
      failed(err);
      throw new RestError(`connect failed: ${msg(err)}`, 503);
    }
  }
  state.connectHangs = 0;
  state.transport = transport;
  state.address = address;
  state.failures = 0;
  state.lastConnectedAt = iso();
  state.lastActivity = Date.now();
  const info = c.getPrinterInfo();
  if (info.batteryPercents !== undefined) state.battery = info.batteryPercents;
  captureMeta(c);
  state.model = (state.meta && state.meta.model) ?? state.model;
  if (transport === "ble" && !bleAddress() && (!state.bleFound || state.bleFound.address !== address)) {
    rememberBle({ address, name: (c.device && c.device.advertisement && c.device.advertisement.localName) || null });
  }
  if (transport === "ble" && c.device && Number.isFinite(c.device.rssi)) state.rssi = { rssi: c.device.rssi, at: iso() };
  setStatus("connected", `${transport} ${address}${state.model ? " (" + state.model + ")" : ""}`);
  autoPrintTask(c);   // logs a model override once
  // Label roll: connect() already read the tag (-> rfidinfofetched -> onRfid).
  // On an explicit (re)connect, read it again if that read came back empty.
  // A print never waits for this.
  const rfid = c.getRfidInfo();
  if (rfid && rfid.labelRfidInfo) {
    onRfid(rfid);
  } else if (reason === "manual") {
    await withTimeout(c.fetchRfidInfo(), RFID_FETCH_TIMEOUT_MS, "RFID read")
      .catch((e) => log(`RFID read: ${msg(e)}`));
  }
  saveLabelDb();
}

/** Caller must hold `lock`. */
async function disconnectNow(reason) {
  const c = state.client;
  state.client = null;
  if (c) {
    const periph = c.device;
    try { await withTimeout(c.disconnect(), 10000, "disconnect"); } catch (e) { log(`disconnect: ${msg(e)}`); }
    dropPeripheralListeners({ device: periph });
  }
  setStatus(onDemand() || (isBle() && CFG.disconnectAfterPrint) ? "idle" : "disconnected", reason);
}

/** Queue drained: release a Bluetooth link to save the printer battery. */
async function onQueueIdle() {
  if (!CFG.disconnectAfterPrint || !isConnected() || state.transport !== "ble") return;
  await lock.runExclusive(async () => {
    if (isConnected() && queue.pending().length === 0) await disconnectNow("queue empty, Bluetooth released (disconnect_after_print)");
  });
}

// Background upkeep: serial (and BLE with idle_disconnect_seconds = 0) stays
// connected; on-demand BLE only releases idle links. While print jobs wait
// for a Bluetooth printer, listen for its advertisement to print at once.
async function maintain() {
  if (lock.isLocked()) return;
  const pending = queue ? queue.pending().length : 0;
  if (isConnected()) {
    if (state.transport === "ble" && ble.watching) await ble.unwatch();
    if (state.transport === "ble" && onDemand() && !pending && Date.now() - state.lastActivity > CFG.idleS * 1000) {
      await lock.runExclusive(async () => {
        // re-check inside the lock: a print may have started meanwhile
        if (isConnected() && !queue.pending().length && Date.now() - state.lastActivity > CFG.idleS * 1000) {
          await disconnectNow(`idle for ${CFG.idleS}s, link released (connects on demand)`);
        }
      });
    }
    return;
  }
  const transport = pickTransport();
  if (!transport) {
    setStatus("waiting", "no NIIMBOT USB printer plugged in and no Bluetooth (host D-Bus) available");
    return;
  }
  if (transport === "ble") {
    if (!dbusPresent()) {
      setStatus("error", `host D-Bus not available (${DBUS_SOCKET} missing; add-on needs host_dbus)`);
      return;
    }
    if (pending) {
      // the queue's runner retries with backoff; the advert watch shortcuts it
      ble.watch(isOurPrinter, (info) => {
        log(`printer advertising (${info.name || info.address}, RSSI ${info.rssi ?? "?"} dBm): printing the queue`);
        if (!state.bleFound && !bleAddress() && looksLikePrinter(info.name)) rememberBle({ address: info.address, name: info.name });
        state.rssi = { rssi: info.rssi, at: info.at };
        queue.kick();
      }).catch((e) => log(`BLE watch: ${msg(e)}`));
      return;
    }
    if (ble.watching) await ble.unwatch();
    if (onDemand() || CFG.disconnectAfterPrint) {
      if (state.status === "starting" || state.status === "disconnected") setStatus("idle", "connects on demand when printing");
      return;
    }
  } else {
    if (ble.watching) await ble.unwatch();
    if (!resolveSerial()) {
      setStatus("waiting", serialAddress()
        ? `${serialAddress()} not present (printer off or unplugged?)`
        : "no NIIMBOT USB device found (printer off or unplugged?)");
      return;
    }
    if (state.status === "waiting") {   // hot-plugged: try now (and print what waits)
      state.failures = 0;
      state.nextAttemptAt = 0;
      if (pending) queue.kick();
    }
  }
  if (Date.now() < state.nextAttemptAt) return;
  if (pending) return;   // the queue runner is connecting with its own backoff
  await lock.runExclusive(() => connectNow("auto")).catch(() => { /* recorded in state */ });
}

// ---- print ---------------------------------------------------------------
const PrintOptsSchema = z.object({
  printDirection: z.enum(["left", "top"]).optional(),
  printTask: z.enum(lib.printTaskNames).optional(),
  quantity: z.number().int().min(1).max(MAX_QUANTITY).default(1),
  labelType: z.number().int().min(1).max(20).optional(),      // default: roll's RFID type, else gaps
  density: z.number().int().min(1).max(5).optional(),         // default: density option / model; clamped to the model
  labelWidth: z.number().int().min(8).max(MAX_SIDE_PX).optional(),
  labelHeight: z.number().int().min(8).max(MAX_SIDE_PX).optional(),
  threshold: z.number().int().min(1).max(255).optional(),     // default: threshold option
  imagePosition: z.enum(["centre", "center", "top", "right top", "right", "right bottom",
    "bottom", "left bottom", "left", "left top"]).default("center"),
  imageFit: z.enum(["contain", "cover", "fill", "inside", "outside"]).optional(),  // default: image_fit option
  waitUntilFinished: z.boolean().default(true),
});

const PageSchema = z.object({
  imageBase64: z.string().optional(),
  imageUrl: z.string().optional(),
  quantity: z.number().int().min(1).max(MAX_QUANTITY).optional(),
}).refine(({ imageUrl, imageBase64 }) => !!imageUrl !== !!imageBase64,
  { message: "imageUrl or imageBase64 must be defined", path: ["image"] });

const PrintSchema = PrintOptsSchema.extend({
  imageBase64: z.string().optional(),
  imageUrl: z.string().optional(),
  pages: z.array(PageSchema).min(1).max(100).optional(),
}).refine(({ imageUrl, imageBase64, pages }) => (!!imageUrl || !!imageBase64) !== !!pages,
  { message: "Provide either imageUrl/imageBase64 or pages, but not both", path: ["image"] })
  .refine(({ imageUrl, imageBase64 }) => !(imageUrl && imageBase64),
    { message: "imageUrl or imageBase64 must be defined, not both", path: ["image"] });

/**
 * imageUrl: http/https only, 15 s timeout, size cap. Errors are deliberately
 * generic for the caller (no probing of internal hosts through the error
 * text); details go to the log.
 */
async function fetchImage(url) {
  let u;
  try { u = new URL(url); } catch (_) { throw new RestError("imageUrl is not a valid URL", 400); }
  if (!["http:", "https:"].includes(u.protocol)) throw new RestError("imageUrl must be an http:// or https:// URL", 400);
  let r;
  try {
    r = await fetch(u, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS), redirect: "follow" });
  } catch (e) {
    log(`imageUrl ${u.origin}: ${msg(e)}`);
    throw new RestError("imageUrl could not be loaded", 400);
  }
  if (!r.ok || !r.body) {
    log(`imageUrl ${u.origin}: HTTP ${r.status}`);
    throw new RestError("imageUrl could not be loaded", 400);
  }
  const len = Number(r.headers.get("content-length"));
  if (len > MAX_IMAGE_BYTES) throw new RestError(`imageUrl image too large (max ${MAX_IMAGE_BYTES / 1048576} MB)`, 400);
  const parts = [];
  let size = 0;
  for await (const chunk of r.body) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new RestError(`imageUrl image too large (max ${MAX_IMAGE_BYTES / 1048576} MB)`, 400);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

// at most 2 images decoded at a time (each can be up to 40 MP)
const decodeSlots = { free: 2, waiting: [] };
async function withDecodeSlot(fn) {
  if (decodeSlots.free > 0) decodeSlots.free--;
  else await new Promise((r) => decodeSlots.waiting.push(r));
  try { return await fn(); } finally {
    const next = decodeSlots.waiting.shift();
    if (next) next(); else decodeSlots.free++;
  }
}

/** Load + flatten. Materialized now so a bad image fails BEFORE it is queued. */
async function loadImage(imageBase64, imageUrl) {
  const buf = imageBase64 !== undefined
    ? Buffer.from(String(imageBase64).replace(/^data:image\/\w+;base64,/, ""), "base64")
    : await fetchImage(imageUrl);
  return withDecodeSlot(() => sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS })
    .flatten({ background: "#fff" }).png().toBuffer());
}

/**
 * Resize to `size` (if any), centre-crop the across-head side to the
 * printhead if wider (like the NIIMBOT app; e.g. a 50 mm label = 400 px on a
 * 384 px head loses 8 px each side), threshold. Returns the final PNG.
 */
async function finishImage(o, buf, size, printDirection, printheadPx) {
  let image = sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS });
  if (size) {
    image = sharp(await image.resize(size.width, size.height, {
      kernel: sharp.kernel.nearest, fit: o.imageFit ?? CFG.imageFit, position: o.imagePosition, background: "#fff",
    }).png().toBuffer());
  }
  const { width, height } = await image.metadata();
  const crop = labelSize.centreCropAcross(width, height, printDirection, printheadPx);
  if (crop) {
    log(`image ${width}x${height} is wider than the ${printheadPx} px head: centre-cropped to ${crop.width}x${crop.height}`);
    image = image.extract(crop);
  }
  return image.threshold(o.threshold ?? CFG.threshold).png().toBuffer();
}

/**
 * Target image size, by precedence: request labelWidth+labelHeight > the
 * label_width/label_height options > the detected label roll > none (image as
 * is). A request/options setting only ONE side keeps the old behaviour (no
 * resize) and disables auto size.
 */
function targetSize(o, printDirection) {
  if (o.labelWidth !== undefined || o.labelHeight !== undefined) {
    return o.labelWidth !== undefined && o.labelHeight !== undefined
      ? { width: o.labelWidth, height: o.labelHeight, from: "request" } : null;
  }
  if (CFG.labelWidth > 0 || CFG.labelHeight > 0) {
    return CFG.labelWidth > 0 && CFG.labelHeight > 0
      ? { width: CFG.labelWidth, height: CFG.labelHeight, from: "options" } : null;
  }
  // Fit to the WHOLE label; finishImage() then centre-crops to the head.
  const g = labelGeometry(printDirection);
  return g ? { width: g.label_width_px, height: g.label_height_px, from: `label ${state.label.tpl.name || state.label.barcode}` } : null;
}

/**
 * Canvas for server-rendered (text) labels: the PRINTED area, i.e. the label
 * after the centre-crop to the head, with the feed-direction blind zone as
 * margins so auto-layout keeps content where the printer can print.
 * Size precedence like targetSize(): request > options > detected label >
 * 384x240 (B21 head x 30 mm). Without a detected roll the blind zone of gap
 * paper (the common case) is assumed.
 */
const FALLBACK_TEXT_SIZE = { width: 384, height: 240 };
function textCanvas(body = {}) {
  const dir = body.printDirection === "left" || body.printDirection === "top" ? body.printDirection : CFG.printDirection;
  const top = dir === "top";
  const head = (state.meta && state.meta.printheadPixels) || labelSize.DEFAULT_PRINTHEAD_PX;
  const g = labelGeometry(dir);
  const blind = (g && g.blind_zone) || labelSize.blindZone(labelSize.PAPER_GAP, (state.meta && state.meta.dpi) || labelSize.DEFAULT_DPI);
  const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  const bw = num(body.labelWidth), bh = num(body.labelHeight);
  let w, h, from;
  if (bw !== undefined || bh !== undefined) {
    if (!(bw > 0 && bh > 0 && bw <= 2000 && bh <= 4000)) throw new RestError("labelWidth and labelHeight must both be given (px)", 400);
    w = bw; h = bh; from = "request";
  } else if (CFG.labelWidth > 0 && CFG.labelHeight > 0) {
    w = CFG.labelWidth; h = CFG.labelHeight; from = "options";
  } else if (g) {
    w = g.width_px; h = g.height_px; from = `label ${state.label.tpl.name || state.label.barcode}`;
  } else {
    ({ width: w, height: h } = FALLBACK_TEXT_SIZE); from = "default 384x240";
  }
  // encoder packs 8 px/byte (pad to 8); never wider than the head across
  w = Math.ceil(w / 8) * 8; h = Math.ceil(h / 8) * 8;
  if (top) w = Math.min(w, head); else h = Math.min(h, head);
  const margins = top
    ? { top: blind.feed_start_px, bottom: blind.feed_end_px, left: 0, right: 0 }
    : { left: blind.feed_start_px, right: blind.feed_end_px, top: 0, bottom: 0 };
  return { width: w, height: h, margins, printDirection: dir, from };
}

// ---- auto print settings ------------------------------------------------------
/** Density: request > option (0 = auto) > the model's default; clamped to the model's range. */
function autoDensity(requested) {
  const m = state.meta || {};
  const min = Number.isFinite(m.densityMin) ? m.densityMin : 1;
  const max = Number.isFinite(m.densityMax) ? m.densityMax : 5;
  const want = requested ?? (CFG.density > 0 ? CFG.density : (Number.isFinite(m.densityDefault) ? m.densityDefault : 3));
  return Math.min(max, Math.max(min, Math.round(want)));
}

/**
 * Label (paper) type: the roll's RFID type (1 gap, 2 black mark, 5
 * transparent, ...) when the model supports it, else the cloud template's,
 * else labels with gaps (what /print always sent).
 */
const KNOWN_LABEL_TYPES = Object.values(lib.LabelType).filter((v) => typeof v === "number" && v > 0);
function autoLabelType() {
  const types = (state.meta && state.meta.paperTypes) || null;
  const ok = (t) => Number.isInteger(t) && KNOWN_LABEL_TYPES.includes(t) && (!types || types.includes(t));
  const L = state.label;
  if (L && ok(L.type)) return L.type;
  if (L && L.tpl && ok(L.tpl.paper_type)) return L.tpl.paper_type;
  return lib.LabelType.WithGaps;
}

// ---- queue -------------------------------------------------------------------------
let queue = null;     // PrintQueue, set up in main
let history = null;   // History, set up in main

const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

/**
 * Queue a print. opts: PrintOptsSchema fields (validated now, so bad
 * requests fail before they are queued); pages: [{ buf: PNG, quantity }];
 * ctx: { source, kind, template, summary, reprint_of, final }.
 */
function enqueue(opts, pages, ctx = {}) {
  const o = PrintOptsSchema.parse(opts);
  delete o.waitUntilFinished;
  const job = queue.add({ ...ctx, opts: o }, pages);
  log(`job ${job.id} queued (${ctx.kind || "image"}${ctx.template ? " " + ctx.template : ""}, via ${ctx.source || "rest"}, ` +
    `${pages.length} page(s))${queue.pending().length > 1 ? `, ${queue.pending().length - 1} ahead` : ""}`);
  return job;
}

function jobRef(j) {
  const h = history && history.byJob(j.id);
  return { job_id: j.id, state: j.state, ...(h ? { history_id: h.id } : {}) };
}

/**
 * Answer for a queued job: wait up to wait_timeout s (default option
 * wait_timeout, 30 s) -> 200 printed / error; still waiting -> 202 + job id.
 * `wait: false` -> 202 at once. Legacy `waitUntilFinished: false` -> 200
 * "Print job submitted" at once, like 1.2.
 */
async function respond(job, body = {}) {
  if (body.waitUntilFinished === false) return { message: "Print job submitted", ...jobRef(job) };
  const position = () => Math.max(0, queue.pending().findIndex((j) => j.id === job.id));
  if (body.wait === false) return { _status: 202, message: "Queued", position: position(), ...jobRef(job) };
  const t = Number.isFinite(Number(body.wait_timeout)) ? Math.min(300, Math.max(0, Number(body.wait_timeout))) : CFG.waitTimeoutS;
  const r = await queue.wait(job.id, t * 1000);
  const j = r.job || job;
  if (!r.finished) {
    const b = queue.blocked;
    return {
      _status: 202,
      message: j.state === "printing" ? "Printing (not finished yet)"
        : `Queued: ${b ? b.message : "waiting for the printer"}. It prints by itself once the printer is reachable.`,
      position: position(), reason: b ? b.state : null, ...jobRef(j),
    };
  }
  if (j.state === "done") return { message: "Printed", ...jobRef(j) };
  const status = j.state === "cancelled" ? 409 : j.state === "expired" ? 504 : 500;
  throw new RestError(`print ${j.state}: ${j.last_error || "unknown error"}`, status, { ...jobRef(j), error_state: j.error_state });
}

/** Queue -> history: every finished job (printed, failed, expired). */
function onJobFinished(job, pages, final) {
  state.lastPrintAt = iso();
  if (job.state === "done") state.lastPrintOk = true;
  if (job.state === "failed") {
    state.lastPrintOk = false;
    state.lastError = `print failed: ${job.last_error}`;
    state.lastErrorAt = iso();
  }
  if (job.state === "expired") {
    log(`job ${job.id} expired: ${job.last_error}`);
    if (CFG.notifications) {
      supervisor.callService("persistent_notification", "create", {
        notification_id: `niimblue_job_expired_${job.id}`,
        title: "Label printer: print job expired",
        message: `The label "${job.summary || job.kind}" (queued ${job.created_at}) was not printed within ` +
          `${CFG.queueMaxAgeH} h and was dropped: ${job.last_error}. Retry it from the NiimBlue panel.`,
      }).catch((e) => log(`notification failed: ${msg(e)}`));
    }
  }
  if (mqttBridge && job.state !== "done" && job.state !== "cancelled") {
    mqttBridge.result({ ok: false, action: "job", job_id: job.id, state: job.state, error: job.last_error, source: job.source });
  }
  if (job.state === "cancelled" || !history || !pages.length) return;
  const replay = { ...job.opts };
  if (final || job.final) {
    const s = pngSize(pages[0].buf);
    Object.assign(replay, { labelWidth: s.width, labelHeight: s.height, imageFit: "fill" });
  }
  const L = state.label;
  history.add({
    source: job.source, kind: job.kind, template: job.template, reprint_of: job.reprint_of, summary: job.summary,
    job_id: job.id, quantity: job.opts.quantity,
    copies: pages.reduce((n, p) => n + (p.quantity ?? job.opts.quantity ?? 1), 0),
    label: L ? { name: L.tpl ? L.tpl.name : null, barcode: L.barcode } : null,
    size: pngSize(pages[0].buf), final: !!(final || job.final), opts: replay,
    ok: job.state === "done", status: job.state === "done" ? "printed" : job.state,
    error: job.state === "done" ? null : job.last_error,
  }, pages.map((p) => ({ png: p.buf, quantity: p.quantity })));
}

/**
 * Print one queued job (the queue runner). Returns an outcome for the queue:
 * done / requeue (unreachable) / pause (printer needs a person) / fail.
 */
async function runJob(job) {
  const release = await lock.acquire();
  let started = false;
  let c = null;
  let finals = null;
  const onPkt = (e) => {
    if (!started && e && e.packet && e.packet.command === lib.RequestCommandId.PageStart) {
      started = true;
      queue.markStarted(job);   // persisted: a crash after this never re-prints by itself
    }
  };
  try {
    try {
      await connectNow("print");
    } catch (e) {
      return { action: "requeue", state: "unreachable", message: msg(e) };
    }
    c = state.client;
    state.lastActivity = Date.now();
    // the last heartbeat already says lid open / no labels: don't even start
    const block = printerErrors.heartbeatBlock(c.getHeartbeatData && c.getHeartbeatData());
    if (block) {
      setStatus("connected", `paused: ${block.message}`);
      return block;
    }
    const o = job.opts;
    const printDirection = o.printDirection ?? CFG.printDirection;
    const printTask = o.printTask ?? autoPrintTask(c);
    if (!printTask) return { action: "fail", state: "no_print_task", message: "Unable to detect print task; set 'model' in the add-on options" };
    // Size AFTER connecting: connect() has just read the roll's RFID tag. A
    // cloud lookup for a brand-new roll may still be running; it is capped at
    // CLOUD_TIMEOUT_MS and its failure only means "no auto size".
    const pending = state.label && lookups.get(state.label.barcode);
    const auto = o.labelWidth === undefined && o.labelHeight === undefined && !CFG.labelWidth && !CFG.labelHeight;
    if (pending && auto) await pending;
    // niimblue-node's encoder treats an undefined direction as "left".
    const size = targetSize(o, printDirection || "left");
    if (size && size.from !== "request") log(`image size ${size.width}x${size.height} px (${size.from})`);
    const done = [];
    try {
      for (const p of queue.pages(job)) {
        done.push({ buf: await finishImage(o, p.buf, size, printDirection || "left", c.getModelMetadata()?.printheadPixels), quantity: p.quantity });
      }
    } catch (e) {
      return { action: "fail", state: "bad_image", message: `bad image: ${msg(e)}` };
    }
    finals = done;
    const pages = [];
    for (const { buf, quantity } of finals) {
      pages.push({ encoded: await nb.ImageEncoder.encodeImage(sharp(buf), lib.PageColorType.SingleColor, printDirection), quantity });
    }
    const copies = pages.reduce((n, p) => n + (p.quantity ?? o.quantity), 0);
    const density = autoDensity(o.density);
    const labelType = o.labelType ?? autoLabelType();
    log(`job ${job.id}: printing ${pages.length} page(s), ${copies} label(s), task ${printTask}, direction ${printDirection}, ` +
      `density ${density}, label type ${labelType}`);
    // niimbluelib's status poll has no overall deadline: a printer that stops
    // reporting progress (lid open, out of labels) would hold the job lock
    // forever. Cap the job and drop the link so pending packets fail fast.
    const jobMs = Math.min(2 ** 31 - 1, JOB_TIMEOUT_BASE_MS + JOB_TIMEOUT_PER_LABEL_MS * copies);
    c.on("packetsent", onPkt);
    await withTimeout(nb.printImages(c, printTask, pages, { quantity: o.quantity, labelType, density }), jobMs, "print job");
    log(`job ${job.id}: printed`);
    event("printed", `job ${job.id}, ${copies} label(s)`);
    return { action: "done", finals, info: { printed_at: iso(), density, label_type: labelType } };
  } catch (e) {
    if (/timed out/.test(msg(e)) && c && state.client === c) {
      // Detach first so the next job starts on a fresh link, then wait for
      // the close before the lock is released.
      state.client = null;
      setStatus(onDemand() ? "idle" : "disconnected", "print job stuck, link reset");
      await withTimeout(c.disconnect(), 10000, "disconnect").catch(() => {});
    }
    const out = printerErrors.classify(e, { started });
    log(`job ${job.id}: ${out.action === "pause" ? "paused" : out.action === "fail" ? "failed" : "will retry"}: ${out.message}`);
    event(`job_${out.action}`, `${job.id}: ${out.message}`);
    if (out.action === "pause") setStatus(isConnected() ? "connected" : state.status, `paused: ${out.message}`);
    return { ...out, finals: started ? finals : null };
  } finally {
    if (c) c.off("packetsent", onPkt);
    state.lastActivity = Date.now();
    release();
    statusChanged();
  }
}

/** POST /print: parse, load the images (bad images fail now), queue. */
async function handlePrint(body, ctx = {}) {
  const o = PrintSchema.parse(body);
  const inputs = o.pages ?? [{ imageBase64: o.imageBase64, imageUrl: o.imageUrl, quantity: o.quantity }];
  const loaded = [];
  for (const p of inputs) {
    try {
      loaded.push({ buf: await loadImage(p.imageBase64, p.imageUrl), quantity: p.quantity });
    } catch (e) {
      throw new RestError(`bad image: ${msg(e)}`, 400);
    }
  }
  const opts = { ...o };
  for (const k of ["imageBase64", "imageUrl", "pages"]) delete opts[k];
  const job = enqueue(opts, loaded, { kind: "image", summary: o.imageUrl ? `image ${o.imageUrl.slice(0, 80)}` : null, ...ctx });
  return respond(job, body);
}

// ---- REST ---------------------------------------------------------------
let warnings = null;   // Warnings, set up in main
let features = null;   // REST routes from features.js, set up in main
let mqttBridge = null;

function printerInfo() {
  const m = state.meta || {};
  return m.info ? { model: m.model || state.model, ...m.info } : (state.model ? { model: state.model } : null);
}

function statusObj() {
  const q = queue ? queue.summary() : null;
  return {
    status: state.status,
    detail: state.detail,
    connected: isConnected(),
    transport: CFG.transport,
    transport_active: state.transport || pickTransport(),
    address: state.address || CFG.address || (state.bleFound && state.bleFound.address) || null,
    model: state.model,
    print_task: CFG.printTask || (isConnected() ? autoPrintTask(state.client) ?? null : null),
    battery: state.battery,
    rssi: state.rssi ? state.rssi.rssi : null,
    printer: printerInfo(),
    on_demand: onDemand(),
    idle_disconnect_seconds: isBle() ? CFG.idleS : null,
    disconnect_after_print: CFG.disconnectAfterPrint,
    density: autoDensity(undefined),
    last_error: state.lastError,
    last_error_at: state.lastErrorAt,
    last_connected_at: state.lastConnectedAt,
    last_print_at: state.lastPrintAt,
    last_print_ok: state.lastPrintOk,
    label: labelStatus(),
    label_lookup: CFG.labelLookup,
    queue: q ? { length: q.length, failed: q.failed, blocked: q.blocked ? q.blocked.state : null,
      blocked_reason: q.blocked ? q.blocked.message : null, oldest_at: q.oldest_at } : null,
    warnings: warnings ? warnings.status() : null,
  };
}

/** GET /diag: everything useful for "why does it not print?". */
function diagObj() {
  const pkgVersion = (name) => {
    try { return libRequire(`${name}/package.json`).version; } catch (_) {
      try { return nbRequire(`${name}/package.json`).version; } catch (__) { return null; }
    }
  };
  return {
    version: VERSION,
    transport: { configured: CFG.transport, active: state.transport, would_use_now: pickTransport(), address_option: CFG.address || null },
    usb: listSerial(),
    bluetooth: {
      dbus_socket: dbusPresent(),
      adapter: ble.noble ? ble.state : (state.adapter || "not used yet"),
      remembered_printer: state.bleFound,
      watching_for_printer: !!ble.watching,
      printer_rssi: state.rssi || (state.address ? ble.rssiOf(state.address) : null),
      connect_hangs: state.connectHangs,
    },
    printer: printerInfo(),
    heartbeat: isConnected() && state.client.getHeartbeatData ? state.client.getHeartbeatData() : null,
    status: statusObj(),
    queue: queue ? { ...queue.summary(), jobs: queue.list().map((j) => ({ ...j, opts: undefined })) } : null,
    events: [...state.events].reverse(),
    versions: {
      node: process.versions.node,
      "niimblue-node": (() => { try { return nbRequire("./package.json").version; } catch (_) { return null; } })(),
      niimbluelib: pkgVersion("@mmote/niimbluelib"),
      noble: pkgVersion("@stoprocent/noble"),
      sharp: sharp.versions && sharp.versions.sharp,
    },
  };
}

/** Nearby NIIMBOT printers: BLE (name, address, RSSI) + USB. */
async function scanAll(seconds) {
  const usb = listSerial().filter((d) => d.niimbot);
  let bleDevs = [];
  let bleError = null;
  if (dbusPresent()) {
    try {
      const ms = Math.min(30, Math.max(2, seconds || 8)) * 1000;
      bleDevs = await lock.runExclusive(() => bleScan(ms));
    } catch (e) { bleError = msg(e); }
  } else bleError = "no host D-Bus (Bluetooth unavailable)";
  const printers = bleDevs.filter((d) => d.likely_printer);
  return {
    usb, ble: printers, ble_other_devices: bleDevs.length - printers.length, ble_error: bleError,
    remembered: state.bleFound, scanned_at: iso(),
  };
}

/** Low labels / battery: feed the current state, notify once per condition. */
function checkWarnings() {
  if (!warnings) return;
  const L = state.label;
  const ls = L ? labelStatus() : null;
  warnings.update({
    label: L ? { key: L.uuid || L.serial || L.barcode, name: ls.name, remaining: ls.remaining, total: ls.total } : null,
    battery: Number.isFinite(state.battery) ? state.battery : null,
  });
}

function assertConnected() {
  if (!isConnected()) throw new RestError("Not connected", 400);
  state.lastActivity = Date.now();
}

function reconnect() {
  return lock.runExclusive(async () => {
    await disconnectNow("reconnect requested");
    state.failures = 0;
    state.connectHangs = 0;
    await connectNow("manual");
    if (queue.pending().length) queue.kick();
    return { message: "Connected" };
  });
}

const routes = {
  "GET /": () => ({ message: "Server is working" }),
  "GET /status": () => statusObj(),
  "GET /diag": () => diagObj(),
  "GET /scan": (body, ctx) => scanAll(int(ctx.query.get("seconds"), 8)),
  // Loaded by the designer page (sync <script>) before NiimBlue starts, so the
  // injected glue can preselect the detected label size.
  "GET /label.js": () => ({
    raw: `window.NIIMBLUE_LABEL = ${JSON.stringify(labelStatus()).replace(/</g, "\\u003c")};\n`,
    type: "application/javascript",
  }),
  "GET /connected": () => ({ connected: isConnected() }),
  "GET /info": () => {
    assertConnected();
    return {
      printerInfo: state.client.getPrinterInfo(),
      modelMetadata: state.client.getModelMetadata(),
      detectedPrintTask: state.client.getPrintTaskType(),
      printTask: autoPrintTask(state.client) ?? null,   // what /print uses (after model overrides)
      heartbeat: state.client.getHeartbeatData ? state.client.getHeartbeatData() : null,
    };
  },
  "GET /rfid": () => lock.runExclusive(async () => { assertConnected(); return state.client.fetchRfidInfo(); }),
  // Body ignored: the add-on options decide transport + address.
  "POST /connect": () => lock.runExclusive(async () => {
    if (isConnected()) return { message: "Already connected" };
    state.failures = 0;
    await connectNow("manual");
    return { message: "Connected" };
  }),
  "POST /disconnect": () => lock.runExclusive(async () => {
    await disconnectNow("disconnected by request");
    state.nextAttemptAt = Date.now() + CFG.reconnectS * 1000;
    return { message: "Disconnected" };
  }),
  "POST /reconnect": () => reconnect(),
  "POST /print": (body, ctx) => handlePrint(body, ctx),
  // 1.2 API (body {transport, timeout ms}); GET /scan is the richer one
  "POST /scan": async (body) => {
    const transport = (body && body.transport) || pickTransport() || "serial";
    if (transport === "serial") return { devices: listSerial() };
    const timeout = Math.min(30000, Math.max(1000, int(body && body.timeout, BLE_SCAN_MS)));
    return { devices: await lock.runExclusive(() => bleScan(timeout)) };
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    let tooLarge = false;
    // announced too large: answer 413 (drain the rest instead of resetting the socket)
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
      req.resume();
      return reject(new RestError("Body too large", 413));
    }
    req.on("data", (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; parts.length = 0; reject(new RestError("Body too large", 413)); return; }
      parts.push(c);
    });
    req.on("end", () => {
      const s = Buffer.concat(parts).toString().trim();
      if (!s) return resolve({});
      let j;
      try { j = JSON.parse(s); } catch (e) { return reject(new RestError(`Invalid JSON: ${msg(e)}`, 400)); }
      if (!j || typeof j !== "object" || Array.isArray(j)) return reject(new RestError("body must be a JSON object", 400));
      resolve(j);
    });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

const isLoopback = (a) => /^(127\.|::1$|::ffff:127\.)/.test(String(a || ""));
const tokenOk = (h) => {
  const m = /^Bearer\s+(.+)$/i.exec(String(h || ""));
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(CFG.apiToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

async function onRequest(req, res) {
  const [rawPath, rawQuery] = (req.url || "/").split("?");
  const url = rawPath.replace(/\/+$/, "") || "/";
  let route = routes[`${req.method} ${url}`];
  if (req.method !== "GET" || CFG.debug) log(`${req.socket.remoteAddress} ${req.method} ${url}`);
  // api_token: everything that does not come through nginx (ingress UI,
  // loopback) must authenticate. Without a token the port is open as in 1.2
  // (and not mapped to the host by default).
  if (CFG.apiToken && !isLoopback(req.socket.remoteAddress) && !tokenOk(req.headers.authorization)) {
    req.resume();
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
    res.end(JSON.stringify({ error: "missing or wrong API token (Authorization: Bearer <api_token>)" }));
    return;
  }
  try {
    if (!route && features) route = features.match(req.method, url);
    if (!route) return send(res, 404, { error: "Not found" });
    // nginx (ingress UI) tags its requests; anything else came in on :5000
    const ctx = { source: req.headers["x-niimblue-source"] === "ui" ? "ui" : "rest", query: new URLSearchParams(rawQuery || "") };
    const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : {};
    const out = await route(body, ctx);
    if (out && out.raw !== undefined && out.type) {
      res.writeHead(200, { "Content-Type": out.type, "Cache-Control": "no-store", ...(out.headers || {}) });
      res.end(out.raw);
      return;
    }
    if (out && out._status) {
      const { _status, ...rest } = out;
      return send(res, _status, rest);
    }
    send(res, 200, out);
  } catch (e) {
    if (e instanceof z.ZodError) {
      send(res, 400, { error: e.issues.map((i) => `${i.path.join("→")}: ${i.message}`).join("\n") });
    } else {
      if (!(e instanceof RestError) || e.status >= 500) log(`${req.method} ${url} -> ${msg(e)}`);
      const status = e instanceof RestError ? e.status : Number.isInteger(e.status) ? e.status : 500;
      send(res, status, { error: msg(e), status: state.status, ...(e.extra || {}) });
    }
  }
}

// ---- main -----------------------------------------------------------------
// niimbluelib fires some disconnects without a catch (heartbeat path); never
// let a rejected promise take the server down.
process.on("unhandledRejection", (e) => log(`unhandled rejection: ${msg(e)}`));

loadLabelDb();
loadPrinterFile();
const templates = new TemplateStore(path.join(CFG.dataDir, "templates"), log);
history = new History(path.join(CFG.dataDir, "history"), { max: CFG.historySize, sharp, log });
queue = new PrintQueue(path.join(CFG.dataDir, "queue"), {
  log: (m) => log(m),
  maxAgeHours: CFG.queueMaxAgeH,
  onChange: () => statusChanged(),
  onTerminal: onJobFinished,
  onIdle: onQueueIdle,
  // test hooks (not add-on options): faster retries in tests/e2e.js
  pauseMs: int(env("QUEUE_PAUSE_MS", ""), undefined),
  backoff: { min: int(env("QUEUE_BACKOFF_MIN_MS", ""), undefined), max: int(env("QUEUE_BACKOFF_MAX_MS", ""), undefined) },
});
warnings = new Warnings({
  file: path.join(CFG.dataDir, "warnings.json"),
  labelThreshold: CFG.lowLabelThreshold,
  notify: CFG.notifications,
  notifier: haNotifier(supervisor),
  log: (m) => log(m),
});
features = createFeatures({
  CFG: { ...CFG, threshold: CFG.threshold }, sharp, log, RestError, templates, history, queue,
  enqueue, respond, textCanvas,
  testInfo: () => ({
    label: state.label && state.label.tpl ? state.label.tpl.name : null,
    density: autoDensity(undefined),
    // own formatting: Alpine's Node ships English ICU data only
    time: placeholders.formatParts(placeholders.zonedParts(new Date(), CFG.timezone || undefined),
      `${CFG.dateFormat} ${CFG.timeFormat}`),
  }),
});

// status changes -> warnings + MQTT state (coalesced)
let statusTimer = null;
statusChangedHook = () => {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    checkWarnings();
    if (mqttBridge) mqttBridge.publishState(false);
  }, 300);
};

if (CFG.mqttEnabled) {
  mqttBridge = new MqttBridge({
    log: (m) => log(m),
    getModel: () => (state.meta && state.meta.model) || state.model || null,
    intervalS: CFG.reconnectS,
    quickFile: path.join(CFG.dataDir, "quick-print.json"),
    getStatus: statusObj,
    handlers: {
      reconnect: () => reconnect(),
      printText: (body, ctx) => features.printText(body, ctx),
      printTemplate: (name, body, ctx) => features.printTemplate(name, body, ctx),
      reprintLast: (ctx) => features.reprint("last", {}, ctx),
      clearQueue: () => queue.clear(),
      testPrint: (ctx) => features.testPrint({}, ctx),
      scan: () => scanAll(8),
    },
  });
  mqttBridge.start().catch((e) => log(`MQTT: ${msg(e)}`));
}

const server = http.createServer((req, res) => { onRequest(req, res); });
server.listen({ host: CFG.host, port: CFG.port }, () => {
  log(`v${VERSION} listening on ${CFG.host}:${CFG.port} (transport=${CFG.transport}` +
    `${CFG.transport === "auto" ? ` -> ${pickTransport() || "none yet"}` : ""}, ` +
    `address=${CFG.address || (state.bleFound ? `auto (remembered ${state.bleFound.address})` : "auto")}, ` +
    `printTask=${CFG.printTask || "auto"}, density=${CFG.density || "auto"}, ` +
    `idle_disconnect=${CFG.idleS || "never"}s, disconnect_after_print=${CFG.disconnectAfterPrint}, ` +
    `label size=${CFG.labelWidth || CFG.labelHeight ? `${CFG.labelWidth}x${CFG.labelHeight}` : "auto"}, ` +
    `label lookup=${CFG.labelLookup ? "on" : "off"}, mqtt=${CFG.mqttEnabled ? "on" : "off"}, ` +
    `low labels<${CFG.lowLabelThreshold || "off"}, wait=${CFG.waitTimeoutS}s, queue max age=${CFG.queueMaxAgeH || "none"}h, ` +
    `tz=${CFG.timezone || "system"})`);
  if (state.label) {
    log(`last label roll: ${state.label.barcode}${state.label.tpl ? ` (${state.label.tpl.name || "?"}, cached size)` : ""}`);
  }
  const waiting = queue.pending().length;
  if (waiting) log(`${waiting} print job(s) waiting from before the restart`);
  queue.start(runJob);
  maintain();
  checkWarnings();
  setInterval(() => {
    maintain().catch((e) => log(`maintain: ${msg(e)}`));
    checkWarnings();
  }, 2000);
});

// Release the printer cleanly on add-on stop (frees the BLE link at once).
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  log("stopping");
  server.close();
  queue.stop();
  if (mqttBridge) await withTimeout(mqttBridge.stop(), 2000, "mqtt stop").catch(() => {});
  await ble.unwatch().catch(() => {});
  const c = state.client;
  state.client = null;
  if (c) {
    try { await withTimeout(c.disconnect(), 3000, "disconnect"); } catch (_) { /* exiting */ }
    log("printer link released");
  }
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
