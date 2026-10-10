#!/usr/bin/env node
/* NiimBlue host print server for the Home Assistant add-on.
 *
 * A thin, add-on-aware wrapper around the SAME niimblue-node / niimbluelib code
 * paths the stock `niimblue-cli server` uses (same image encoder, same print
 * task flow), adding what the stock server lacks:
 *
 *   - Starts with NO printer present and keeps retrying with backoff. A printer
 *     that is switched off / unplugged / out of Bluetooth range is normal.
 *   - Serial auto-detect only ever picks a NIIMBOT device (USB vendor 3513),
 *     never some other tty (Zigbee stick, ...).
 *   - transport "ble" goes through BlueZ over D-Bus (noble's dbus binding,
 *     NOBLE_BINDINGS=dbus), so it SHARES the adapter with Home Assistant's
 *     Bluetooth integration instead of grabbing raw HCI.
 *   - Connect-on-demand: /print connects if needed. BLE links are released
 *     after an idle period so the radio and the printer battery are not held.
 *   - One job at a time: designer + automations cannot interleave packets.
 *   - GET /status: one explicit connection state for MQTT and the designer.
 *   - Label auto-size: reads the roll's RFID barcode on connect, resolves the
 *     label size (local cache /data/labels.json, else NIIMBOT's cloud) and,
 *     when no size is configured or requested, fits prints to it.
 *
 * API-compatible with `niimblue-cli server` for /connect /disconnect
 * /connected /info /rfid /print /scan, so existing rest_commands keep working.
 * Configured by env vars set in run.sh from the add-on options.
 */
"use strict";
const fs = require("fs");
const http = require("http");
const path = require("path");
const { createRequire } = require("module");

// niimblue-node is installed globally; resolve it and ITS copies of the libs so
// we share one niimbluelib instance with its printImages()/ImageEncoder.
const NB_DIR = process.env.NIIMBLUE_NODE_DIR || "/usr/local/lib/node_modules/@mmote/niimblue-node";
const nbRequire = createRequire(path.join(NB_DIR, "package.json"));
const nb = nbRequire("./");
const lib = nbRequire("@mmote/niimbluelib");
const { z } = nbRequire("zod");
const { Mutex } = nbRequire("async-mutex");
const sharp = nbRequire("sharp");
const labelSize = require(path.join(__dirname, "label-size.js"));

// ---- config (env from run.sh) ------------------------------------------
const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const bool = (v, d) => (v === undefined || v === "" ? d : !/^(false|0|no|off)$/i.test(String(v)));
const CFG = {
  transport: env("TRANSPORT", "serial") === "ble" ? "ble" : "serial",
  address: env("ADDRESS", ""),               // tty path | BLE MAC or name | "" = auto
  printTask: env("MODEL", ""),               // "" = auto-detect on connect
  reconnectS: Math.max(3, int(env("RECONNECT", "10"), 10)),
  idleS: Math.max(0, int(env("IDLE_DISCONNECT", "60"), 60)), // BLE only; 0 = stay connected
  host: env("HOST", "0.0.0.0"),
  port: int(env("PORT", "5000"), 5000),
  debug: /^(debug|trace)$/.test(env("LOG_LEVEL", "info")),
  // Size/fit defaults from the add-on options. 0/0 = auto (detected label).
  labelWidth: Math.max(0, int(env("LABEL_WIDTH", "0"), 0)),
  labelHeight: Math.max(0, int(env("LABEL_HEIGHT", "0"), 0)),
  imageFit: env("IMAGE_FIT", "contain"),
  printDirection: env("PRINT_DIRECTION", "top") === "left" ? "left" : "top",
  labelLookup: bool(env("LABEL_LOOKUP", "true"), true),   // NIIMBOT cloud lookup by roll barcode
  labelsFile: env("LABELS_FILE", "/data/labels.json"),
};
if (!["contain", "cover", "fill", "inside", "outside"].includes(CFG.imageFit)) CFG.imageFit = "contain";
if (CFG.printTask && !lib.printTaskNames.includes(CFG.printTask)) {
  console.warn(`[niimblue:server] unknown model/printTask '${CFG.printTask}', ignoring ` +
    `(valid: ${lib.printTaskNames.join(", ")})`);
  CFG.printTask = "";
}

const NIIMBOT_USB_VID = "3513";
const BACKOFF_MAX_S = 300;
const BLE_SCAN_MS = 8000;
const CONNECT_TIMEOUT_MS = 30000;
const BLE_CONNECT_ATTEMPTS = 3;
const HEARTBEAT_MAX_FAILS = 5;
const JOB_TIMEOUT_BASE_MS = 60000;
const JOB_TIMEOUT_PER_LABEL_MS = 20000;

const log = (...a) => console.log("[niimblue:server]", ...a);
const msg = (e) => (e instanceof Error ? e.message : String(e));
const iso = () => new Date().toISOString();

class RestError extends Error {
  constructor(message, status = 500) { super(message); this.status = status; }
}

// ---- state --------------------------------------------------------------
// status: starting | waiting | connecting | connected | idle | disconnected | error
const state = {
  client: null,
  status: "starting",
  detail: "",
  address: null,          // device path / BLE address actually in use
  bleFound: null,         // BLE printer found by scan (in-memory, address option empty)
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
  label: null,            // roll from RFID: {barcode, uuid, serial, total, used, seenAt, tpl, source}
  meta: null,             // {model, dpi, printheadPixels, printDirection} of the last connected printer
};
const lock = new Mutex();   // serializes connect / disconnect / print / scan

const isConnected = () => !!state.client && state.client.isConnected();
const onDemand = () => CFG.transport === "ble" && CFG.idleS > 0;

function setStatus(status, detail = "") {
  if (state.status === status && state.detail === detail) return;
  state.status = status;
  state.detail = detail;
  log(`${status}${detail ? ": " + detail : ""}`);
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

// ---- device resolution: serial -----------------------------------------
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
  if (CFG.address) return fs.existsSync(CFG.address) ? CFG.address : null;
  const hit = listSerial().find((d) => d.niimbot);
  return hit ? hit.address : null;
}

// ---- device resolution: Bluetooth LE -----------------------------------
// Model names from niimbluelib (B21, B21S, D110, ...). A NIIMBOT advertises as
// "<MODEL>-<serial>", e.g. "B21S-C2B...", so match the part before the dash.
const MODEL_HEADS = new Set(Object.values(lib.PrinterModel).map((m) => String(m).split("_")[0].toUpperCase()));
const looksLikePrinter = (name) => MODEL_HEADS.has(String(name || "").split(/[-_\s]/)[0].toUpperCase());

// dbus-next emits an unhandled 'error' (= process crash) when the bus socket is
// missing, so check before noble touches it.
const DBUS_SOCKET = (env("DBUS_SYSTEM_BUS_ADDRESS", "").match(/unix:path=([^,;]+)/) || [])[1]
  || "/run/dbus/system_bus_socket";
function assertDbus() {
  if (!fs.existsSync(DBUS_SOCKET)) {
    throw new RestError(`host D-Bus not available (${DBUS_SOCKET} missing; add-on needs host_dbus)`, 503);
  }
}

async function bleScan(timeoutMs) {
  assertDbus();
  const devs = await lib.NiimbotNodeBleClient.scan(timeoutMs);
  const uniq = new Map();
  for (const d of devs) uniq.set(d.address, { ...d, likely_printer: looksLikePrinter(d.name) });
  return [...uniq.values()].sort((a, b) => b.likely_printer - a.likely_printer);
}

async function resolveBle() {
  if (CFG.address) return CFG.address;
  if (state.bleFound) return state.bleFound.address;
  setStatus("connecting", "scanning for a NIIMBOT printer over Bluetooth ...");
  const hit = (await bleScan(BLE_SCAN_MS)).find((d) => d.likely_printer);
  if (!hit) return null;
  state.bleFound = hit;
  log(`found ${hit.name} (${hit.address}). Tip: set 'address: ${hit.address}' to skip the scan.`);
  return hit.address;
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

const labelDb = { labels: {}, current: null, printer: null };
const lookups = new Map();   // barcode -> in-flight cloud lookup promise
const lookupBackoff = new Map();  // barcode -> do not retry before (ms)
let lastSavedDb = null;

function loadLabelDb() {
  try {
    const d = JSON.parse(fs.readFileSync(CFG.labelsFile, "utf8"));
    if (d && typeof d.labels === "object" && d.labels) labelDb.labels = d.labels;
    if (d && d.current && d.current.barcode) labelDb.current = d.current;
    if (d && d.printer) labelDb.printer = d.printer;
  } catch (e) {
    if (e.code !== "ENOENT") log(`label cache ${CFG.labelsFile} unreadable, starting empty: ${msg(e)}`);
  }
  if (labelDb.printer) state.meta = labelDb.printer;
  // Last roll seen: shown in /status until the printer reports again (a new
  // connect re-reads the tag before any auto-sized print).
  const cur = labelDb.current;
  if (cur) {
    const tpl = labelDb.labels[cur.barcode] || null;
    state.label = { ...cur, tpl, source: tpl ? "cache" : null };
  }
}

function saveLabelDb() {
  try {
    labelDb.current = state.label
      ? { barcode: state.label.barcode, uuid: state.label.uuid, serial: state.label.serial,
          total: state.label.total, used: state.label.used, seenAt: state.label.seenAt }
      : null;
    labelDb.printer = state.meta;
    const data = JSON.stringify({ version: 1, ...labelDb }, null, 2);
    if (data === lastSavedDb) return;   // BLE connects per print: skip no-op writes
    fs.mkdirSync(path.dirname(CFG.labelsFile), { recursive: true });
    const tmp = `${CFG.labelsFile}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, CFG.labelsFile);
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
  const cached = labelDb.labels[barcode];
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
function makeClient(address) {
  const c = CFG.transport === "ble" ? new lib.NiimbotNodeBleClient() : new lib.NiimbotNodeSerialClient();
  if (CFG.transport === "ble") c.setAddress(address); else c.setPort(address);
  let lastProgress = "";
  c.on("printprogress", (e) => {
    const p = `page ${e.page}/${e.pagesTotal}, print ${e.pagePrintProgress}%, feed ${e.pageFeedProgress}%`;
    if (p !== lastProgress) log(p);     // status is polled every 500 ms: log changes only
    lastProgress = p;
  });
  c.on("heartbeat", () => {
    const b = c.getPrinterInfo().batteryPercents;
    if (b !== undefined) state.battery = b;
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
  if (state.failures >= 3) state.bleFound = null;
  const retry = onDemand() ? "will retry on next print" : `retrying in ${delay}s`;
  setStatus("error", `${state.lastError} (${retry})`);
}

/** Caller must hold `lock`. No-op if already connected. */
async function connectNow(reason) {
  if (isConnected()) return;
  let address;
  try {
    if (CFG.transport === "ble") assertDbus();
    address = CFG.transport === "ble" ? await resolveBle() : resolveSerial();
  } catch (e) {
    failed(e);
    throw new RestError(`Bluetooth scan failed: ${msg(e)}`, 503);
  }
  if (!address) {
    const why = CFG.transport === "ble"
      ? "no NIIMBOT printer found over Bluetooth (switched on and in range?)"
      : CFG.address
        ? `${CFG.address} not present (printer off or unplugged?)`
        : "no NIIMBOT USB device found (printer off or unplugged?)";
    if (CFG.transport === "ble") failed(new Error(why)); else setStatus("waiting", why);
    throw new RestError(why, 503);
  }
  // BLE on a marginal link: BlueZ drops/re-adds the device object and LE
  // connects abort now and then. A couple of quick retries (each re-runs
  // discovery) turn most of those into a successful print.
  const attempts = CFG.transport === "ble" ? BLE_CONNECT_ATTEMPTS : 1;
  let c;
  for (let i = 1; ; i++) {
    setStatus("connecting", `${CFG.transport} ${address} (${reason}${attempts > 1 ? `, try ${i}/${attempts}` : ""})`);
    c = makeClient(address);
    state.client = c;
    try {
      await withTimeout(c.connect(), CONNECT_TIMEOUT_MS, "connect");
      break;
    } catch (e) {
      state.client = null;
      c.disconnect().catch(() => {});
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
  state.address = address;
  state.failures = 0;
  state.lastConnectedAt = iso();
  state.lastActivity = Date.now();
  const info = c.getPrinterInfo();
  if (info.batteryPercents !== undefined) state.battery = info.batteryPercents;
  const meta = c.getModelMetadata();
  state.model = meta?.model ?? state.model;
  if (meta) {
    state.meta = { model: meta.model, dpi: meta.dpi, printheadPixels: meta.printheadPixels, printDirection: meta.printDirection };
  }
  setStatus("connected", `${CFG.transport} ${address}${state.model ? " (" + state.model + ")" : ""}`);
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
  if (meta) saveLabelDb();
}

/** Caller must hold `lock`. */
async function disconnectNow(reason) {
  const c = state.client;
  state.client = null;
  if (c) {
    try { await withTimeout(c.disconnect(), 10000, "disconnect"); } catch (e) { log(`disconnect: ${msg(e)}`); }
  }
  setStatus(onDemand() ? "idle" : "disconnected", reason);
}

// Background upkeep: serial (and BLE with idle_disconnect_seconds = 0) stays
// connected; on-demand BLE only releases idle links and never scans by itself.
async function maintain() {
  if (lock.isLocked()) return;
  if (isConnected()) {
    if (onDemand() && Date.now() - state.lastActivity > CFG.idleS * 1000) {
      await lock.runExclusive(() => disconnectNow(`idle for ${CFG.idleS}s, link released (connects on demand)`));
    }
    return;
  }
  if (CFG.transport === "ble" && !fs.existsSync(DBUS_SOCKET)) {
    setStatus("error", `host D-Bus not available (${DBUS_SOCKET} missing; add-on needs host_dbus)`);
    return;
  }
  if (onDemand()) {
    if (state.status === "starting") setStatus("idle", "connects on demand when printing");
    return;
  }
  if (CFG.transport === "serial") {
    if (!resolveSerial()) {
      setStatus("waiting", CFG.address
        ? `${CFG.address} not present (printer off or unplugged?)`
        : "no NIIMBOT USB device found (printer off or unplugged?)");
      return;
    }
    if (state.status === "waiting") { state.failures = 0; state.nextAttemptAt = 0; } // hot-plugged: try now
  }
  if (Date.now() < state.nextAttemptAt) return;
  await lock.runExclusive(() => connectNow("auto")).catch(() => { /* recorded in state */ });
}

// ---- print ---------------------------------------------------------------
const PageSchema = z.object({
  imageBase64: z.string().optional(),
  imageUrl: z.string().optional(),
  quantity: z.number().min(1).optional(),
}).refine(({ imageUrl, imageBase64 }) => !!imageUrl !== !!imageBase64,
  { message: "imageUrl or imageBase64 must be defined", path: ["image"] });

const PrintSchema = z.object({
  printDirection: z.enum(["left", "top"]).optional(),
  printTask: z.enum(lib.printTaskNames).optional(),
  quantity: z.number().min(1).default(1),
  labelType: z.number().min(1).default(lib.LabelType.WithGaps),
  density: z.number().min(1).default(3),
  imageBase64: z.string().optional(),
  imageUrl: z.string().optional(),
  pages: z.array(PageSchema).min(1).optional(),
  labelWidth: z.number().positive().optional(),
  labelHeight: z.number().positive().optional(),
  threshold: z.number().min(1).max(255).default(128),
  imagePosition: z.enum(["centre", "center", "top", "right top", "right", "right bottom",
    "bottom", "left bottom", "left", "left top"]).default("center"),
  imageFit: z.enum(["contain", "cover", "fill", "inside", "outside"]).optional(),  // default: image_fit option
  waitUntilFinished: z.boolean().default(true),
}).refine(({ imageUrl, imageBase64, pages }) => (!!imageUrl || !!imageBase64) !== !!pages,
  { message: "Provide either imageUrl/imageBase64 or pages, but not both", path: ["image"] })
  .refine(({ imageUrl, imageBase64 }) => !(imageUrl && imageBase64),
    { message: "imageUrl or imageBase64 must be defined, not both", path: ["image"] });

/** Load + flatten. Materialized now so a bad image fails BEFORE we touch the printer. */
async function loadImage(imageBase64, imageUrl) {
  const image = imageBase64 !== undefined
    ? await nb.loadImageFromBase64(imageBase64)
    : await nb.loadImageFromUrl(imageUrl);
  return image.flatten({ background: "#fff" }).png().toBuffer();
}

/**
 * Resize to `size` (if any), centre-crop the across-head side to the
 * printhead if wider (like the NIIMBOT app; e.g. a 50 mm label = 400 px on a
 * 384 px head loses 8 px each side), threshold.
 */
async function finishImage(o, buf, size, printDirection, printheadPx) {
  let image = sharp(buf);
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
  return sharp(await image.threshold(o.threshold).png().toBuffer());
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

async function handlePrint(body) {
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

  // Hold the lock for the WHOLE job (also when the caller does not wait).
  const release = await lock.acquire();
  let job;
  try {
    await connectNow("print");
    state.lastActivity = Date.now();
    const c = state.client;
    const printDirection = o.printDirection ?? c.getModelMetadata()?.printDirection;
    const printTask = o.printTask ?? autoPrintTask(c);
    if (!printTask) throw new RestError("Unable to detect print task; set 'model' in the add-on options", 400);
    // Size AFTER connecting: connect() has just read the roll's RFID tag. A
    // cloud lookup for a brand-new roll may still be running; it is capped at
    // CLOUD_TIMEOUT_MS and its failure only means "no auto size".
    const pending = state.label && lookups.get(state.label.barcode);
    const auto = o.labelWidth === undefined && o.labelHeight === undefined && !CFG.labelWidth && !CFG.labelHeight;
    if (pending && auto) await pending;
    // niimblue-node's encoder treats an undefined direction as "left".
    const size = targetSize(o, printDirection || "left");
    if (size && size.from !== "request") log(`image size ${size.width}x${size.height} px (${size.from})`);
    const pages = [];
    for (const { buf, quantity } of loaded) {
      let image;
      try {
        image = await finishImage(o, buf, size, printDirection || "left", c.getModelMetadata()?.printheadPixels);
      } catch (e) {
        throw new RestError(`bad image: ${msg(e)}`, 400);
      }
      pages.push({ encoded: await nb.ImageEncoder.encodeImage(image, lib.PageColorType.SingleColor, printDirection), quantity });
    }
    const copies = pages.reduce((n, p) => n + (p.quantity ?? o.quantity), 0);
    log(`printing ${pages.length} page(s), ${copies} label(s), task ${printTask}, direction ${printDirection}`);
    // niimbluelib's status poll has no overall deadline: a printer that stops
    // reporting progress (lid open, out of labels) would hold the job lock
    // forever. Cap the job and drop the link so pending packets fail fast.
    const jobMs = JOB_TIMEOUT_BASE_MS + JOB_TIMEOUT_PER_LABEL_MS * copies;
    job = withTimeout(
      nb.printImages(c, printTask, pages, { quantity: o.quantity, labelType: o.labelType, density: o.density }),
      jobMs, "print job",
    ).catch(async (e) => {
      if (/timed out/.test(msg(e)) && state.client === c) {
        // Detach first so the next job starts on a fresh link, then wait for
        // the close before the lock is released.
        state.client = null;
        setStatus(onDemand() ? "idle" : "disconnected", "print job stuck, link reset");
        await withTimeout(c.disconnect(), 10000, "disconnect").catch(() => {});
      }
      throw e;
    });
  } catch (e) {
    release();
    throw e;
  }
  const done = job.then(
    () => { state.lastPrintOk = true; log("print finished"); },
    (e) => {
      state.lastPrintOk = false;
      state.lastError = `print failed: ${msg(e)}`;
      state.lastErrorAt = iso();
      log(state.lastError);
      throw e;
    },
  ).finally(() => {
    state.lastPrintAt = iso();
    state.lastActivity = Date.now();
    release();
  });
  if (!o.waitUntilFinished) {
    done.catch(() => { /* logged above */ });
    return { message: "Print job submitted" };
  }
  try {
    await done;
  } catch (e) {
    throw new RestError(`print failed: ${msg(e)}`, 500);
  }
  return { message: "Printed" };
}

// ---- REST ---------------------------------------------------------------
function statusObj() {
  return {
    status: state.status,
    detail: state.detail,
    connected: isConnected(),
    transport: CFG.transport,
    address: state.address || CFG.address || (state.bleFound && state.bleFound.address) || null,
    model: state.model,
    print_task: CFG.printTask || (isConnected() ? autoPrintTask(state.client) ?? null : null),
    battery: state.battery,
    on_demand: onDemand(),
    idle_disconnect_seconds: CFG.transport === "ble" ? CFG.idleS : null,
    last_error: state.lastError,
    last_error_at: state.lastErrorAt,
    last_connected_at: state.lastConnectedAt,
    last_print_at: state.lastPrintAt,
    last_print_ok: state.lastPrintOk,
    label: labelStatus(),
    label_lookup: CFG.labelLookup,
  };
}

function assertConnected() {
  if (!isConnected()) throw new RestError("Not connected", 400);
  state.lastActivity = Date.now();
}

const routes = {
  "GET /": () => ({ message: "Server is working" }),
  "GET /status": () => statusObj(),
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
    };
  },
  "GET /rfid": async () => { assertConnected(); return state.client.fetchRfidInfo(); },
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
  "POST /reconnect": () => lock.runExclusive(async () => {
    await disconnectNow("reconnect requested");
    state.failures = 0;
    state.bleFound = null;
    await connectNow("manual");
    return { message: "Connected" };
  }),
  "POST /print": (body) => handlePrint(body),
  "POST /scan": (body) => {
    const transport = (body && body.transport) || CFG.transport;
    if (transport === "serial") return { devices: listSerial() };
    const timeout = Math.min(30000, Math.max(1000, int(body && body.timeout, BLE_SCAN_MS)));
    return lock.runExclusive(async () => ({ devices: await bleScan(timeout) }));
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) { reject(new RestError("Body too large", 413)); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => {
      const s = Buffer.concat(parts).toString().trim();
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(new RestError(`Invalid JSON: ${msg(e)}`, 400)); }
    });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function onRequest(req, res) {
  const url = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
  const route = routes[`${req.method} ${url}`];
  if (req.method !== "GET" || CFG.debug) log(`${req.socket.remoteAddress} ${req.method} ${url}`);
  if (!route) return send(res, 404, { error: "Not found" });
  try {
    const body = req.method === "POST" ? await readBody(req) : {};
    const out = await route(body);
    if (out && typeof out.raw === "string" && out.type) {
      res.writeHead(200, { "Content-Type": out.type, "Cache-Control": "no-store" });
      res.end(out.raw);
      return;
    }
    send(res, 200, out);
  } catch (e) {
    if (e instanceof z.ZodError) {
      send(res, 400, { error: e.issues.map((i) => `${i.path.join("→")}: ${i.message}`).join("\n") });
    } else {
      if (!(e instanceof RestError) || e.status >= 500) log(`${req.method} ${url} -> ${msg(e)}`);
      send(res, e instanceof RestError ? e.status : 500, { error: msg(e), status: state.status });
    }
  }
}

// ---- main -----------------------------------------------------------------
// niimbluelib fires some disconnects without a catch (heartbeat path); never
// let a rejected promise take the server down.
process.on("unhandledRejection", (e) => log(`unhandled rejection: ${msg(e)}`));

loadLabelDb();
const server = http.createServer((req, res) => { onRequest(req, res); });
server.listen({ host: CFG.host, port: CFG.port }, () => {
  log(`listening on ${CFG.host}:${CFG.port} (transport=${CFG.transport}, ` +
    `address=${CFG.address || "auto"}, printTask=${CFG.printTask || "auto"}` +
    `${CFG.transport === "ble" ? `, idle_disconnect=${CFG.idleS || "never"}s` : ""}, ` +
    `label size=${CFG.labelWidth || CFG.labelHeight ? `${CFG.labelWidth}x${CFG.labelHeight}` : "auto"}, ` +
    `label lookup=${CFG.labelLookup ? "on" : "off"})`);
  if (state.label) {
    log(`last label roll: ${state.label.barcode}${state.label.tpl ? ` (${state.label.tpl.name || "?"}, cached size)` : ""}`);
  }
  maintain();
  setInterval(() => { maintain().catch((e) => log(`maintain: ${msg(e)}`)); }, 2000);
});

// Release the printer cleanly on add-on stop (frees the BLE link at once).
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  log("stopping");
  server.close();
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
