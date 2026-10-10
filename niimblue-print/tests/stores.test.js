"use strict";
// Templates (CRUD + counter), history persistence, warnings state machine.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { lib, sharp, tmpDir } = require("./helpers");

const { TemplateStore } = lib("templates.js");
const { History } = lib("history.js");
const { Warnings } = lib("warnings.js");

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAG7buVgAAAABJRU5ErkJggg==";

test("templates: put/get/list/delete, names are file-safe", () => {
  const store = new TemplateStore(tmpDir("tpl"));
  const s = store.put("Gewürz & Glas", { lines: ["{{name}}", "{{date}}"], wrap: true, defaults: { name: "Salz" } });
  assert.equal(s.type, "text");
  assert.deepEqual(s.variables, ["name"]);
  // "/" is not allowed, but other unicode is
  assert.throws(() => store.put("a/b", { text: "x" }), (e) => e.status === 400);
  store.put("Gewürzglas", { text: "{{name}}\n#{{counter:3}}" });
  store.put("logo", { imageBase64: PNG_1x1, label: { name: "T50*30", width_px: 400, height_px: 240 } });
  const names = store.list().map((t) => t.name);
  assert.deepEqual(names, ["Gewürz & Glas", "Gewürzglas", "logo"]);
  const files = fs.readdirSync(store.dir);
  assert.ok(files.every((f) => !f.includes("/")));
  const full = store.describe("Gewürzglas");
  assert.deepEqual(full.layout.lines, ["{{name}}", "#{{counter:3}}"]);
  assert.equal(full.uses_counter, true);
  assert.equal(store.describe("logo").type, "image");
  assert.throws(() => store.get("nope"), (e) => e.status === 404);
  store.delete("logo");
  assert.throws(() => store.delete("logo"), (e) => e.status === 404);
});

test("templates: validation", () => {
  const store = new TemplateStore(tmpDir("tplv"));
  assert.throws(() => store.put("x", { text: "a", align: "diagonal" }), (e) => e.status === 400);
  assert.throws(() => store.put("x", { imageBase64: "bm90IGEgcG5n" }), /PNG/);
  assert.throws(() => store.put("", { text: "a" }), (e) => e.status === 400);
  assert.throws(() => store.put(".hidden", { text: "a" }), (e) => e.status === 400);
  assert.throws(() => store.put("x", { text: "a", density: 9 }), /density/);
});

test("templates: counter numbers are reserved when queued, never handed out twice", async () => {
  const store = new TemplateStore(tmpDir("tplc"));
  store.put("n", { text: "#{{counter}}", counter: 10 });
  const job = (qty) => store.withCounter("n", async (t) => {
    await new Promise((r) => setTimeout(r, 5));   // rendering takes a moment
    return { result: { start: t.counter.next }, used: qty };
  });
  // concurrent prints: the second sees the numbers the first reserved
  const [a, b] = await Promise.all([job(3), job(2)]);
  assert.equal(a.start, 10);
  assert.equal(b.start, 13);
  // a render error (nothing queued) reserves nothing
  await assert.rejects(store.withCounter("n", async () => { throw new Error("bad var"); }), /bad var/);
  const c = await job(1);
  assert.equal(c.start, 15);
  assert.equal(store.get("n").counter.next, 16);
  // re-saving keeps the counter; an explicit counter resets it
  store.put("n", { text: "#{{counter}} v2" });
  assert.equal(store.get("n").counter.next, 16);
  store.put("n", { text: "#{{counter}}", counter: 1 });
  assert.equal(store.get("n").counter.next, 1);
});

test("templates: a failing job does not block the queue", async () => {
  const store = new TemplateStore(tmpDir("tplq"));
  store.put("n", { text: "x" });
  await assert.rejects(store.withCounter("n", async () => { throw new Error("boom"); }), /boom/);
  await assert.rejects(store.withCounter("missing", async () => ({})), (e) => e.status === 404);
  const r = await store.withCounter("n", async () => ({ result: 42, used: 0 }));
  assert.equal(r, 42);
});

test("history: persists, caps at max, deletes evicted files, thumbnails", async () => {
  const dir = tmpDir("hist");
  const png = await sharp({ create: { width: 384, height: 240, channels: 3, background: "#fff" } }).png().toBuffer();
  const h = new History(dir, { max: 3, sharp });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const e = await h.add({ source: i % 2 ? "mqtt" : "rest", ok: true, summary: `job ${i}`, opts: { quantity: 1 } },
      [{ png, quantity: 1 }]);
    ids.push(e.id);
  }
  assert.equal(h.list().length, 3);
  assert.equal(h.last().summary, "job 4");
  assert.ok(!fs.existsSync(path.join(dir, `${ids[0]}-0.png`)), "evicted page deleted");
  assert.ok(!fs.existsSync(path.join(dir, `${ids[0]}-thumb.png`)), "evicted thumb deleted");
  const thumb = h.thumb(ids[4]);
  const meta = await sharp(thumb).metadata();
  assert.ok(meta.width <= 256 && meta.height <= 256);
  h.update(ids[4], { ok: false, error: "late failure" });
  // reload from disk
  const h2 = new History(dir, { max: 3, sharp });
  assert.deepEqual(h2.list().map((e) => e.summary), ["job 4", "job 3", "job 2"]);
  assert.equal(h2.get(ids[4]).error, "late failure");
  assert.equal(h2.pages(ids[3])[0].buf.length, png.length);
  assert.equal(h2.thumb("../../etc"), null);
  h2.clear();
  assert.equal(new History(dir, { sharp }).list().length, 0);
});

test("warnings: one notification per condition, reset on new roll / recovery, persisted", async () => {
  const file = path.join(tmpDir("warn"), "warnings.json");
  const calls = [];
  const notifier = {
    create: async (id) => { calls.push(`create ${id}`); },
    dismiss: async (id) => { calls.push(`dismiss ${id}`); },
  };
  const mk = () => new Warnings({ file, labelThreshold: 20, notifier });
  let w = mk();
  const roll = (key, remaining) => ({ key, name: "T50*30", remaining, total: 230 });

  assert.equal(w.update({ label: roll("A", 50), battery: 80 }).labels_low, false);
  assert.equal(w.update({ label: roll("A", 19), battery: 80 }).labels_low, true);
  w.update({ label: roll("A", 18), battery: 80 });
  w.update({ label: roll("A", 17), battery: 80 });
  await w.pending; await w.chain;
  assert.deepEqual(calls, ["create niimblue_labels_low"], "only once");

  // restart: still notified, no repeat
  w = mk();
  w.update({ label: roll("A", 16), battery: 80 });
  await w.chain;
  assert.deepEqual(calls, ["create niimblue_labels_low"]);

  // new roll: dismissed
  w.update({ label: roll("B", 230), battery: 80 });
  await w.chain;
  assert.deepEqual(calls.slice(1), ["dismiss niimblue_labels_low"]);
  // the new roll runs low too: notified again
  w.update({ label: roll("B", 5), battery: 80 });
  await w.chain;
  assert.equal(calls.at(-1), "create niimblue_labels_low");

  // battery with hysteresis
  calls.length = 0;
  w.update({ label: null, battery: 19 });
  w.update({ label: null, battery: 21 });   // not yet recovered
  w.update({ label: null, battery: 18 });
  w.update({ label: null, battery: null }); // unknown: no change
  await w.chain;
  assert.deepEqual(calls, ["create niimblue_battery_low"]);
  w.update({ label: null, battery: 25 });
  await w.chain;
  assert.deepEqual(calls, ["create niimblue_battery_low", "dismiss niimblue_battery_low"]);
});

test("warnings: threshold 0 disables labels low, notifications off still sets flags", async () => {
  const calls = [];
  const notifier = { create: async () => calls.push("c"), dismiss: async () => calls.push("d") };
  const w0 = new Warnings({ file: path.join(tmpDir("w0"), "w.json"), labelThreshold: 0, notifier });
  assert.equal(w0.update({ label: { key: "A", remaining: 1 }, battery: null }).labels_low, false);
  const off = new Warnings({ file: path.join(tmpDir("w1"), "w.json"), labelThreshold: 20, notify: false, notifier });
  assert.equal(off.update({ label: { key: "A", remaining: 1 }, battery: 5 }).labels_low, true);
  await off.chain;
  assert.deepEqual(calls, []);
});
