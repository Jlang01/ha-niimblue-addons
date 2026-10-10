#!/usr/bin/env node
"use strict";
/* End-to-end check of the print server WITHOUT a printer (fake-printer.js
 * preload), with a real MQTT broker and a fake Supervisor API:
 *
 *   NIIMBLUE_NODE_DIR=/path/to/node_modules/@mmote/niimblue-node \
 *   node tests/e2e.js [outDir]
 *
 * Needs: niimblue-node 1.4.1 (NIIMBLUE_NODE_DIR, else the lib's own
 * node_modules), `mosquitto` on PATH (MQTT part is skipped otherwise), the
 * lib's node_modules (npm install in rootfs/usr/local/lib/niimblue-print).
 * Writes sample PNGs to outDir. Exit code 0 = all checks passed.
 */
const { spawn, execFileSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");
const LIB = path.join(ROOT, "rootfs/usr/local/lib/niimblue-print");
const mqtt = require(path.join(LIB, "node_modules/mqtt"));
const sharp = require(path.join(LIB, "node_modules/sharp"));
const TMP = process.env.TMPDIR || os.tmpdir();
const OUT = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(TMP, "nb-e2e-out-")));
fs.mkdirSync(OUT, { recursive: true });
const DATA = fs.mkdtempSync(path.join(TMP, "nb-e2e-data-"));
const CTRL = fs.mkdtempSync(path.join(TMP, "nb-e2e-ctrl-"));
const PORT = 5600 + Math.floor(Math.random() * 300);
const MQTT_PORT = PORT + 1000;
const API = `http://127.0.0.1:${PORT}`;
const TOKEN = "e2e-secret";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctrl = (name, on) => (on ? fs.writeFileSync(path.join(CTRL, name), "1") : fs.rmSync(path.join(CTRL, name), { force: true }));
let failures = 0;
const results = [];

async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failures++;
    results.push(`FAIL ${name}: ${e.message}`);
  }
}

async function call(method, url, body, raw = false, headers = {}) {
  const r = await fetch(API + url, {
    method, headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return { status: r.status, type: r.headers.get("content-type"), buf: Buffer.from(await r.arrayBuffer()) };
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

async function until(fn, ms = 20000, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(step);
  }
}

// --- fake Supervisor (core API) ---------------------------------------------
const notifications = [];
const sup = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => { b += c; });
  req.on("end", () => {
    notifications.push({ url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("[]");
  });
});

// --- label cache: the B21S roll, so no cloud lookup happens ------------------
fs.writeFileSync(path.join(DATA, "labels.json"), JSON.stringify({
  version: 1,
  labels: { 10262260: { name: "T50*30-230WHITE-NM", cloud_width_mm: 30, cloud_height_mm: 50, rotate: 270,
    canvas_rotate: 90, dpi: 203, paper_type: 1, consumable_type: 1, fetched_at: "2026-10-10T00:00:00Z" } },
}));

let srv = null;
let log = "";
function startServer(extraEnv = {}) {
  const nbDir = process.env.NIIMBLUE_NODE_DIR || path.join(LIB, "node_modules/@mmote/niimblue-node");
  const env = {
    ...process.env, NIIMBLUE_NODE_DIR: nbDir, PORT: String(PORT), HOST: "0.0.0.0", TRANSPORT: "auto", ADDRESS: "/dev/null",
    DATA_DIR: DATA, LABELS_FILE: path.join(DATA, "labels.json"), RECONNECT: "3",
    MQTT_ENABLED: brokerOn ? "true" : "false", MQTT_HOST: "127.0.0.1", MQTT_PORT: String(MQTT_PORT),
    SUPERVISOR_URL: `http://127.0.0.1:${sup.address().port}`, SUPERVISOR_TOKEN: "test-token",
    FAKE_RFID_REMAINING: "12", FAKE_BATTERY: "15", FAKE_PRINT_DIR: OUT, FAKE_CTRL_DIR: CTRL,
    TIMEZONE: "Europe/Berlin", DATE_FORMAT: "DD.MM.YYYY", MODEL: "", DENSITY: "0",
    QUEUE_PAUSE_MS: "1500", QUEUE_BACKOFF_MIN_MS: "800", QUEUE_BACKOFF_MAX_MS: "2000",
    WAIT_TIMEOUT: "10", API_TOKEN: TOKEN,
    // hermetic: never touch the dev machine's real Bluetooth
    DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${path.join(CTRL, "no-dbus-socket")}`,
    ...extraEnv,
  };
  srv = spawn(process.execPath, ["-r", path.join(__dirname, "fake-printer.js"),
    path.join(ROOT, "rootfs/usr/local/bin/print-server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  srv.stdout.on("data", (d) => { log += d; });
  srv.stderr.on("data", (d) => { log += d; });
  return until(async () => { try { return (await call("GET", "/status")).status === 200; } catch (_) { return false; } }, 15000, 100);
}

let brokerOn = false;
(async () => {
  await new Promise((r) => sup.listen(0, "127.0.0.1", r));
  let broker = null;
  try { execFileSync("which", ["mosquitto"], { stdio: "ignore" }); brokerOn = true; } catch (_) { brokerOn = false; }
  if (brokerOn) {
    const conf = path.join(DATA, "mosquitto.conf");
    fs.writeFileSync(conf, `listener ${MQTT_PORT} 127.0.0.1\nallow_anonymous true\npersistence false\n`);
    broker = spawn("mosquitto", ["-c", conf], { stdio: "ignore" });
    await sleep(500);
  }

  // MQTT observer
  const seen = new Map();   // topic -> [payloads]
  let mc = null;
  if (brokerOn) {
    mc = mqtt.connect(`mqtt://127.0.0.1:${MQTT_PORT}`);
    mc.on("message", (t, p) => { if (!seen.has(t)) seen.set(t, []); seen.get(t).push(p.toString()); });
    await new Promise((r) => mc.on("connect", r));
    mc.subscribe(["homeassistant/#", "niimblue/#"]);
  }
  const lastResult = () => JSON.parse((seen.get("niimblue/print/result") || ["{}"]).at(-1));

  await startServer();
  try {
    await until(async () => (await call("GET", "/status")).json.connected);

    await check("status: fake B21S connected, 384x240 printed / 400x240 label, printer info, auto density", async () => {
      const s = (await call("GET", "/status")).json;
      assert.equal(s.connected, true);
      assert.equal(s.transport, "auto");
      assert.equal(s.transport_active, "serial");
      assert.equal(s.print_task, "B1");
      assert.equal(s.density, 3);
      assert.equal(s.label.width_px, 384);
      assert.equal(s.label.label_width_px, 400);
      assert.equal(s.label.remaining, 12);
      assert.equal(s.label.paper_type, 1);
      assert.equal(s.printer.firmware, "5.18");
      assert.equal(s.printer.serial, "C2BF926031720");
      assert.equal(s.queue.length, 0);
    });

    await check("POST /preview/text -> PNG 384x240 + JSON variant", async () => {
      const r = await call("POST", "/preview/text", { lines: ["Erdbeer-", "marmelade", "{{date}}"], bold: true }, true);
      assert.equal(r.status, 200);
      assert.equal(r.type, "image/png");
      assert.equal(r.buf.readUInt32BE(16), 384);
      assert.equal(r.buf.readUInt32BE(20), 240);
      fs.writeFileSync(path.join(OUT, "preview-text.png"), r.buf);
      const j = (await call("POST", "/preview/text", { text: "Datum {{date}}", format: "json" })).json;
      assert.match(j.lines[0], /^Datum \d{2}\.\d{2}\.\d{4}$/);
      assert.equal(j.size_from, "label T50*30-230WHITE-NM");
    });

    await check("POST /print/text -> 200 Printed (queued + printed within wait), history ok", async () => {
      const r = await call("POST", "/print/text", { text: "Hallo Welt", quantity: 2, density: 4 });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.message, "Printed");
      assert.ok(r.json.job_id);
      const h = (await call("GET", "/history")).json.entries[0];
      assert.equal(r.json.history_id, h.id);
      assert.equal(h.ok, true);
      assert.equal(h.kind, "text");
      assert.equal(h.source, "rest");
      assert.deepEqual(h.size, { width: 384, height: 240 });
      assert.equal(h.opts.density, 4);
      assert.match(log, /page \d+: task B1, 384x240, qty 2, density 4, labelType 1/);
    });

    await check("validation errors are 400 JSON; nothing is queued", async () => {
      assert.equal((await call("POST", "/print/text", {})).status, 400);
      assert.equal((await call("POST", "/print/text", { text: "x", align: "nope" })).status, 400);
      assert.equal((await call("POST", "/print/text", { text: "x", quantity: 0 })).status, 400);
      assert.equal((await call("POST", "/print/text", { text: "x", barcode: { type: "ean13", data: "1" } })).status, 400);
      assert.equal((await call("POST", "/print", { imageBase64: "bm90IGFuIGltYWdl" })).status, 400);
      assert.equal((await call("POST", "/print", { imageBase64: "x", quantity: 5000 })).status, 400);
      assert.equal((await call("POST", "/print", { imageBase64: "x", labelWidth: 50000, labelHeight: 10 })).status, 400);
      assert.equal((await call("GET", "/queue")).json.length, 0);
    });

    await check("text template with {{counter}}: 3 numbered pages, counter reserved 1 -> 4", async () => {
      let r = await call("PUT", `/templates/${encodeURIComponent("Vorrat Glas")}`,
        { lines: ["{{name}}", "#{{counter:3}}  {{date}}"], description: "Gläser" });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.template.variables, ["name"]);
      r = await call("POST", `/print/template/${encodeURIComponent("Vorrat Glas")}`, { vars: { name: "Zucker" }, quantity: 3 });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.counter_first, 1);
      assert.equal(r.json.counter_last, 3);
      const t = (await call("GET", `/templates/${encodeURIComponent("Vorrat Glas")}`)).json;
      assert.equal(t.counter, 4);
      const h = (await call("GET", "/history")).json.entries[0];
      assert.equal(h.pages.length, 3);
      assert.equal(h.template, "Vorrat Glas");
      const p = await call("POST", `/preview/template/${encodeURIComponent("Vorrat Glas")}`, { vars: { name: "Mehl" } }, true);
      fs.writeFileSync(path.join(OUT, "preview-template-counter.png"), p.buf);
      for (let i = 0; i < 3; i++) {
        const pg = await call("GET", `/history/${h.id}/${i}.png`, undefined, true);
        fs.writeFileSync(path.join(OUT, `printed-template-${i + 1}.png`), pg.buf);
      }
    });

    await check("template: missing variable -> 400, unknown template -> 404", async () => {
      const r = await call("POST", `/print/template/${encodeURIComponent("Vorrat Glas")}`, { vars: {} });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /missing variable\(s\): name/);
      assert.equal((await call("POST", "/print/template/nope", {})).status, 404);
    });

    await check("image template (designer PNG 400x240) prints centre-cropped to 384", async () => {
      const preview = await call("POST", "/preview/text", { text: "LOGO" }, true);
      const design = await sharp({ create: { width: 400, height: 240, channels: 3, background: "#fff" } })
        .composite([{ input: preview.buf, left: 8, top: 0 }]).png().toBuffer();
      let r = await call("PUT", "/templates/logo", { type: "image", imageBase64: design.toString("base64"),
        label: { name: "T50*30-230WHITE-NM", width_px: 400, height_px: 240 } });
      assert.equal(r.status, 200, r.text);
      r = await call("POST", "/print/template/logo", { quantity: 1 });
      assert.equal(r.status, 200, r.text);
      assert.match(log, /centre-cropped to 384x240/);
      const list = (await call("GET", "/templates")).json.templates;
      assert.deepEqual(list.map((t) => t.name).sort(), ["Vorrat Glas", "logo"]);
    });

    await check("history reprint (id and 'last'), thumbnails", async () => {
      const entries = (await call("GET", "/history")).json.entries;
      const textEntry = entries.find((e) => e.kind === "text");
      let r = await call("POST", `/history/${textEntry.id}/reprint`, {});
      assert.equal(r.status, 200, r.text);
      r = await call("POST", "/history/last/reprint", {});
      assert.equal(r.status, 200, r.text);
      const newest = (await call("GET", "/history")).json.entries[0];
      assert.equal(newest.kind, "reprint");
      const th = await call("GET", `/history/${newest.id}/thumb.png`, undefined, true);
      assert.equal(th.type, "image/png");
      assert.equal((await call("POST", "/history/zzz/reprint", {})).status, 404);
    });

    await check("printer off: 202 + job id, prints by itself when it comes back", async () => {
      await call("POST", "/disconnect", {});
      ctrl("offline", true);
      const r = await call("POST", "/print/text", { text: "später", wait_timeout: 2 });
      assert.equal(r.status, 202, r.text);
      assert.equal(r.json.state, "queued");
      const q = (await call("GET", "/queue")).json;
      assert.equal(q.length, 1);
      assert.equal(q.jobs[0].id, r.json.job_id);
      const st = (await call("GET", "/status")).json;
      assert.equal(st.queue.blocked, "unreachable");
      const w = await call("POST", "/print/text", { text: "noch einer", wait: false });
      assert.equal(w.status, 202);
      assert.equal(w.json.position, 1);
      ctrl("offline", false);
      await until(async () => (await call("GET", "/queue")).json.length === 0, 15000);
      const h = (await call("GET", "/history")).json.entries;
      assert.equal(h[1].job_id, r.json.job_id);   // printed in order
      assert.equal(h[0].job_id, w.json.job_id);
      assert.equal(h[0].ok, true);
    });

    await check("legacy waitUntilFinished:false -> 200 'Print job submitted'", async () => {
      const r = await call("POST", "/print/text", { text: "legacy", waitUntilFinished: false });
      assert.equal(r.status, 200);
      assert.equal(r.json.message, "Print job submitted");
      await until(async () => (await call("GET", "/queue")).json.length === 0);
    });

    await check("lid open: queue pauses (reason lid_open), resumes when closed", async () => {
      ctrl("lid_open", true);
      const r = await call("POST", "/print/text", { text: "Deckel", wait_timeout: 2 });
      assert.equal(r.status, 202, r.text);
      assert.equal(r.json.reason, "lid_open");
      assert.match(r.json.message, /lid is open/);
      ctrl("lid_open", false);
      await until(async () => (await call("GET", "/queue")).json.length === 0, 10000);
      assert.equal((await call("GET", "/history")).json.entries[0].ok, true);
    });

    await check("link drops after a page started: job failed (no auto retry), manual retry prints", async () => {
      ctrl("drop_mid_job", true);
      const r = await call("POST", "/print/text", { text: "halb", wait_timeout: 5 });
      ctrl("drop_mid_job", false);
      assert.equal(r.status, 500, r.text);
      assert.equal(r.json.state, "failed");
      assert.equal(r.json.error_state, "interrupted");
      const q = (await call("GET", "/queue")).json;
      assert.equal(q.failed, 1);
      const h = (await call("GET", "/history")).json.entries[0];
      assert.equal(h.ok, false);
      const rr = await call("POST", `/queue/${r.json.job_id}/retry`, {});
      assert.equal(rr.status, 200, rr.text);
      await until(async () => (await call("GET", "/queue")).json.length === 0 && (await call("GET", "/queue")).json.failed === 0, 10000);
      assert.equal((await call("GET", "/history")).json.entries[0].ok, true);
    });

    await check("cancel + clear queue", async () => {
      await call("POST", "/disconnect", {});
      ctrl("offline", true);
      const a = await call("POST", "/print/text", { text: "a", wait: false });
      const b = await call("POST", "/print/text", { text: "b", wait: false });
      assert.equal((await call("DELETE", `/queue/${a.json.job_id}`)).status, 200);
      assert.equal((await call("GET", "/queue")).json.length, 1);
      assert.equal((await call("DELETE", "/queue")).status, 200);
      assert.equal((await call("GET", "/queue")).json.length, 0);
      assert.equal((await call("DELETE", `/queue/${b.json.job_id}`)).status, 404);
    });

    await check("queued job survives a server restart and prints afterwards", async () => {
      const r = await call("POST", "/print/text", { text: "nach Neustart", wait: false });
      assert.equal(r.status, 202);
      srv.kill("SIGKILL");
      await sleep(300);
      ctrl("offline", false);
      await startServer();
      await until(async () => (await call("GET", "/history")).json.entries.some((e) => e.job_id === r.json.job_id && e.ok), 15000);
      assert.match(log, /1 print job\(s\) waiting from before the restart/);
    });

    await check("low labels + low battery -> one HA notification each, with the token", async () => {
      await sleep(1000);
      const creates = notifications.filter((n) => n.url.endsWith("/persistent_notification/create"));
      const ids = creates.map((n) => n.body.notification_id).sort();
      assert.deepEqual(ids, ["niimblue_battery_low", "niimblue_labels_low"]);
      assert.equal(creates[0].auth, "Bearer test-token");
      const s = (await call("GET", "/status")).json;
      assert.equal(s.warnings.labels_low, true);
      assert.equal(s.warnings.battery_low, true);
    });

    await check("POST /test prints the test label; preview PNG", async () => {
      const p = await call("POST", "/test", { preview: true }, true);
      assert.equal(p.type, "image/png");
      fs.writeFileSync(path.join(OUT, "test-label.png"), p.buf);
      const r = await call("POST", "/test", {});
      assert.equal(r.status, 200, r.text);
      assert.equal((await call("GET", "/history")).json.entries[0].kind, "test");
    });

    await check("GET /diag and GET /scan", async () => {
      const d = (await call("GET", "/diag")).json;
      assert.equal(d.version, "1.3.0");
      assert.equal(d.transport.active, "serial");
      assert.ok(d.events.length >= 1);
      assert.ok(d.versions["niimblue-node"]);
      assert.ok(d.queue);
      const s = (await call("GET", "/scan?seconds=2")).json;
      assert.ok(Array.isArray(s.usb) && Array.isArray(s.ble));
    });

    await check("api_token: required for non-loopback clients only", async () => {
      assert.equal((await call("GET", "/status")).status, 200);   // loopback (= nginx/ingress): no token
      const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
      if (!lan) { results.push("skip api_token LAN part: no non-loopback IPv4"); return; }
      const url = `http://${lan.address}:${PORT}/status`;
      let r = await fetch(url);
      assert.equal(r.status, 401);
      r = await fetch(url, { headers: { Authorization: "Bearer wrong" } });
      assert.equal(r.status, 401);
      r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(r.status, 200);
    });

    await check("imageUrl: only http(s), unreachable -> 400 without internals", async () => {
      let r = await call("POST", "/print", { imageUrl: "file:///etc/passwd" });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /http/);
      r = await call("POST", "/print", { imageUrl: "http://127.0.0.1:1/x.png" });
      assert.equal(r.status, 400);
    });

    if (mc) {
      await check("MQTT: discovery (18 entities, real model) + availability + state", async () => {
        await sleep(500);
        const cfgTopics = [...seen.keys()].filter((t) => t.startsWith("homeassistant/") && t.endsWith("/config"));
        assert.equal(cfgTopics.length, 18, cfgTopics.join(", "));
        const last = (t) => JSON.parse(seen.get(t).at(-1));
        for (const t of cfgTopics) last(t);
        assert.equal(last("homeassistant/sensor/niimblue/status/config").device.model, "B21S_C2B");
        assert.equal(seen.get("niimblue/availability").at(-1), "online");
        const st = JSON.parse(seen.get("niimblue/state").at(-1));
        assert.equal(st.warnings.labels_low, true);
        assert.equal(st.printer.firmware, "5.18");
        assert.equal(st.queue.length, 0);
      });

      await check("MQTT: quick text/wrap are retained, Quick print button prints", async () => {
        mc.publish("niimblue/quick/text/set", "Milch\\nfrisch {{date}}");
        mc.publish("niimblue/quick/wrap/set", "ON");
        await sleep(300);
        assert.equal(seen.get("niimblue/quick/text").at(-1), "Milch\\nfrisch {{date}}");
        assert.equal(seen.get("niimblue/quick/wrap").at(-1), "ON");
        mc.publish("niimblue/cmd/quick_print", "PRESS");
        await until(() => lastResult().action === "quick_print", 8000);
        const res = lastResult();
        assert.equal(res.ok, true, JSON.stringify(res));
        assert.deepEqual(res.layout.lines.slice(0, 1), ["Milch"]);
        assert.equal((await call("GET", "/history")).json.entries[0].source, "mqtt");
      });

      await check("MQTT: niimblue/print (JSON + plain), print/template, Reprint last, Test print, Clear queue", async () => {
        const step = async (topic, payload, action) => {
          const n = (seen.get("niimblue/print/result") || []).length;
          mc.publish(topic, payload);
          await until(() => (seen.get("niimblue/print/result") || []).length > n, 8000);
          const r = lastResult();
          assert.equal(r.action, action);
          return r;
        };
        let r = await step("niimblue/print", JSON.stringify({ text: "Per MQTT", qr: "https://example.com" }), "print");
        assert.equal(r.ok, true, JSON.stringify(r));
        r = await step("niimblue/print", "nur Text", "print");
        assert.equal(r.ok, true, JSON.stringify(r));
        r = await step("niimblue/print/template", JSON.stringify({ name: "Vorrat Glas", vars: { name: "Salz" }, quantity: 1 }), "print_template");
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.counter_first, 4);
        r = await step("niimblue/print", "{bad json", "print");
        assert.equal(r.ok, false);
        r = await step("niimblue/cmd/reprint_last", "PRESS", "reprint_last");
        assert.equal(r.ok, true, JSON.stringify(r));
        r = await step("niimblue/cmd/test_print", "PRESS", "test_print");
        assert.equal(r.ok, true, JSON.stringify(r));
        r = await step("niimblue/cmd/clear_queue", "PRESS", "clear_queue");
        assert.equal(r.ok, true, JSON.stringify(r));
        mc.publish("niimblue/cmd/scan", "PRESS");
        await until(() => seen.has("niimblue/scan/result"), 15000);
        JSON.parse(seen.get("niimblue/scan/result").at(-1));
      });
    }

    await check("history keeps at most 20 entries, evicted files deleted", async () => {
      for (let i = 0; i < 12; i++) await call("POST", "/print/text", { text: `n${i}`, wait: false });
      await until(async () => (await call("GET", "/queue")).json.length === 0, 20000);
      await sleep(500);
      const h = (await call("GET", "/history")).json;
      assert.equal(h.entries.length, 20);
      const files = fs.readdirSync(path.join(DATA, "history")).filter((f) => f.endsWith(".png"));
      const expected = h.entries.reduce((n, e) => n + e.pages.length + 1, 0);
      assert.equal(files.length, expected);
    });

    await check("templates DELETE", async () => {
      assert.equal((await call("DELETE", "/templates/logo")).status, 200);
      assert.equal((await call("GET", "/templates/logo")).status, 404);
    });

    await check("old /print API (imageBase64, fitted to the label) still answers 200 Printed", async () => {
      const img = await sharp({ create: { width: 100, height: 60, channels: 3, background: "#000" } }).png().toBuffer();
      const r = await call("POST", "/print", { imageBase64: img.toString("base64"), quantity: 1 });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.message, "Printed");
      assert.match(log, /image size 400x240 px \(label T50\*30-230WHITE-NM\)/);
    });
  } finally {
    if (mc) mc.end(true);
    if (srv) srv.kill("SIGTERM");
    await sleep(500);
    if (broker) broker.kill();
    sup.close();
  }
  fs.writeFileSync(path.join(OUT, "server.log"), log);
  console.log(results.join("\n"));
  console.log(`\n${results.length - failures}/${results.length} passed. Samples + server.log in ${OUT}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
