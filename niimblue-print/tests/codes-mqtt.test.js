"use strict";
// QR/barcode encoding (decoded back with zbarimg when installed) and the MQTT
// discovery payloads / command parsing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { lib, sharp, tmpDir, B21S_CANVAS } = require("./helpers");

const { encodeQr, encodeBarcode, ean13Check } = lib("codes.js");
const { renderText } = lib("text-render.js");
const mq = lib("mqtt-bridge.js");

let zbar = null;
try { execFileSync("zbarimg", ["--version"], { stdio: "ignore" }); zbar = "zbarimg"; } catch (_) { /* not installed */ }

async function decode(body) {
  const { png } = await renderText(body, B21S_CANVAS, { sharp, threshold: 128 });
  const f = path.join(tmpDir("zbar"), "label.png");
  fs.writeFileSync(f, png);
  return execFileSync(zbar, ["-q", "--raw", f], { encoding: "utf8" }).trim().split("\n");
}

test("ean13 check digit", () => {
  assert.equal(ean13Check("400638133393"), "1");
  assert.equal(encodeBarcode({ type: "ean13", data: "400638133393" }).text, "4006381333931");
  assert.throws(() => encodeBarcode({ type: "ean13", data: "4006381333932" }), /check digit/);
  assert.throws(() => encodeBarcode({ type: "ean13", data: "12" }), (e) => e.status === 400);
  assert.throws(() => encodeBarcode({ type: "upc", data: "1" }), (e) => e.status === 400);
  assert.throws(() => encodeBarcode({ type: "code128", data: "ä" }), /ASCII/);
});

test("QR matrix is square with a finder pattern", () => {
  const q = encodeQr("hello");
  assert.ok(q.n >= 21);
  for (let i = 0; i < 7; i++) assert.ok(q.dark(i, 0) && q.dark(0, i), "finder top-left");
});

test("rendered QR and barcodes scan back (zbarimg)", { skip: !zbar && "zbarimg not installed" }, async () => {
  assert.deepEqual(await decode({ qr: "https://example.com/ä?x=1" }), ["https://example.com/ä?x=1"]);
  assert.deepEqual(await decode({ qr: "Grüße ^_^ €" }), ["Grüße ^_^ €"]);
  assert.deepEqual(await decode({ qr: "plain ^ascii^" }), ["plain ^ascii^"]);
  assert.deepEqual(await decode({ text: "WLAN", qr: "WIFI:T:WPA;S:Gast;P:pw;;" }), ["WIFI:T:WPA;S:Gast;P:pw;;"]);
  assert.deepEqual(await decode({ text: "Artikel", barcode: { type: "ean13", data: "400638133393" } }), ["4006381333931"]);
  assert.deepEqual(await decode({ barcode: { type: "code128", data: "NB-000123" } }), ["NB-000123"]);
});

test("MQTT discovery configs are valid JSON with stable unique_ids", () => {
  const cfgs = mq.discoveryConfigs("B1");
  const ids = new Set();
  for (const [topic, cfg] of cfgs) {
    const parsed = JSON.parse(JSON.stringify(cfg));
    assert.match(topic, /^homeassistant\/(sensor|binary_sensor|button|text|switch)\/niimblue\/[a-z_]+\/config$/);
    assert.ok(parsed.unique_id.startsWith("niimblue_"));
    assert.ok(!ids.has(parsed.unique_id));
    ids.add(parsed.unique_id);
    assert.equal(parsed.availability_topic, "niimblue/availability");
    assert.deepEqual(parsed.device.identifiers, ["niimblue_print"]);
    assert.ok(parsed.state_topic || parsed.command_topic);
  }
  // the 1.2 entities keep their ids (entity history survives the update)
  for (const id of ["niimblue_connected", "niimblue_status", "niimblue_battery", "niimblue_label",
    "niimblue_labels_remaining", "niimblue_reconnect"]) assert.ok(ids.has(id), id);
  for (const id of ["niimblue_labels_low", "niimblue_quick_text", "niimblue_quick_wrap", "niimblue_quick_print",
    "niimblue_reprint_last"]) assert.ok(ids.has(id), id);
  const text = cfgs.find(([t]) => t.includes("/text/"))[1];
  assert.equal(text.max, 255);
});

test("MQTT print payload: JSON or plain text with \\n line breaks", () => {
  assert.deepEqual(mq.parsePrintPayload(Buffer.from('{"lines":["a"],"wrap":true}')), { lines: ["a"], wrap: true });
  assert.deepEqual(mq.parsePrintPayload(Buffer.from("Milch\\n2026-10-10")), { text: "Milch\n2026-10-10" });
  assert.throws(() => mq.parsePrintPayload(Buffer.from("{bad")), (e) => e.status === 400);
  assert.throws(() => mq.parsePrintPayload(Buffer.from("  ")), (e) => e.status === 400);
});
