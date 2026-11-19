"use strict";
// Multi-lane rolls ("T10*20/4L-1200WHITE" = 4 labels of 10x20 mm side by side).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { lib, sharp, tmpDir } = require("./helpers");

const labelSize = require(path.resolve(__dirname, "../rootfs/usr/local/bin/label-size.js"));
const { createFeatures } = lib("features.js");
const { TemplateStore } = lib("templates.js");

const B21S = { printheadPx: 384, dpi: 203 };
const T10x20x4 = { name: "T10*20/4L-1200WHITE", cloud_width_mm: 40, cloud_height_mm: 20, rotate: 0, paper_type: 1 };

test("lanesFromName: only the /<N>L suffix counts", () => {
  assert.equal(labelSize.lanesFromName("T10*20/4L-1200WHITE"), 4);
  assert.equal(labelSize.lanesFromName("T12*40/2L-160WHITE"), 2);
  assert.equal(labelSize.lanesFromName("T50*30-230WHITE-NM"), 1);
  assert.equal(labelSize.lanesFromName("R40*94-80"), 1);
  assert.equal(labelSize.lanesFromName(null), 1);
  assert.equal(labelSize.lanesFromName("X/1L"), 1);
});

test("designerLayout: 4 lanes of 10x20 mm -> direction left, 160x320, 4 horizontal parts", () => {
  const d = labelSize.designerLayout(T10x20x4, { ...B21S, printDirection: "top" });
  assert.deepEqual(
    { dir: d.printDirection, w: d.width, h: d.height, split: d.split, parts: d.splitParts },
    { dir: "left", w: 160, h: 320, split: "horizontal", parts: 4 });
  // each lane is edited landscape: 20 x 10 mm
  assert.equal(d.lane_width_px, 160);
  assert.equal(d.lane_height_px, 80);
  assert.equal(d.lane_width_mm, 20);
  assert.equal(d.lane_height_mm, 10);
  // the canvas is exactly what the server fits "left" prints to
  const g = labelSize.labelCanvas(T10x20x4, { ...B21S, printDirection: "left" });
  assert.equal(g.label_width_px, d.width);
  assert.equal(g.label_height_px, d.height);
});

test("designerLayout: wide lanes stay direction top with a vertical split", () => {
  const tpl = { name: "T20*10/2L-500WHITE", cloud_width_mm: 40, cloud_height_mm: 10, rotate: 0 };
  const d = labelSize.designerLayout(tpl, { ...B21S, printDirection: "left" });
  assert.equal(d.printDirection, "top");
  assert.equal(d.split, "vertical");
  assert.equal(d.splitParts, 2);
  assert.equal(d.width, 320);
  assert.equal(d.height, 80);
});

test("designerLayout: single-lane roll keeps the configured direction, no split", () => {
  const tpl = { name: "T50*30-230WHITE-NM", cloud_width_mm: 30, cloud_height_mm: 50, rotate: 270 };
  const top = labelSize.designerLayout(tpl, { ...B21S, printDirection: "top" });
  assert.deepEqual([top.printDirection, top.width, top.height, top.split, top.lanes], ["top", 400, 240, "none", 1]);
  const left = labelSize.designerLayout(tpl, { ...B21S, printDirection: "left" });
  assert.deepEqual([left.printDirection, left.width, left.height], ["left", 240, 400]);
});

test("text on a 4-lane roll is laid out per lane and repeated on every lane", async () => {
  const canvas = {
    width: 160, height: 320, printDirection: "left", from: "label T10*20/4L (4 lanes)",
    margins: { left: 4, right: 4, top: 0, bottom: 0 }, lanes: 4, laneAxis: "y",
  };
  const f = createFeatures({
    CFG: { threshold: 128 }, sharp, log() {}, RestError: Error,
    textCanvas: () => canvas,
    templates: {}, history: {}, queue: {},
  });
  const r = await f.previewText({ text: "AB", format: "json" });
  // the layout is the lane's (160x80), the image the whole row
  assert.equal(r.width, 160);
  assert.equal(r.height, 80);
  const png = Buffer.from(r.image, "base64");
  const meta = await sharp(png).metadata();
  assert.deepEqual([meta.width, meta.height], [160, 320]);
  // every lane carries identical ink, and none crosses a lane edge
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const lane = (i) => data.subarray(i * 80 * info.width, (i + 1) * 80 * info.width);
  const ink = (buf) => buf.reduce((n, v) => n + (v < 128 ? 1 : 0), 0);
  assert.ok(ink(lane(0)) > 50, "lane 0 has text");
  for (let i = 1; i < 4; i++) assert.ok(lane(i).equals(lane(0)), `lane ${i} equals lane 0`);
  for (const y of [0, 79, 80, 159, 160, 239, 240, 319]) {
    const row = data.subarray(y * info.width, (y + 1) * info.width);
    assert.equal(ink(row), 0, `row ${y} (lane edge) is blank`);
  }
});

test("centrePadAcross: a row narrower than the head is centred on it", () => {
  // 4-lane roll, direction left: 160 x 320, height across -> 32 px each side
  assert.deepEqual(labelSize.centrePadAcross(160, 320, "left", 384), { top: 32, bottom: 32, left: 0, right: 0 });
  assert.deepEqual(labelSize.centrePadAcross(320, 160, "top", 384), { left: 32, right: 32, top: 0, bottom: 0 });
  // odd difference: the extra pixel goes after
  assert.deepEqual(labelSize.centrePadAcross(376 - 3, 100, "top", 384), { left: 5, right: 6, top: 0, bottom: 0 });
  // full head / wider (cropped instead) / unknown head: nothing
  assert.equal(labelSize.centrePadAcross(384, 240, "top", 384), null);
  assert.equal(labelSize.centrePadAcross(400, 240, "top", 384), null);
  assert.equal(labelSize.centrePadAcross(320, 160, "top", undefined), null);
});

// ---- quantity counts labels; {{counter}} numbers the lanes ------------------
const LANE_CANVAS = () => ({
  width: 160, height: 320, printDirection: "left", from: "label T10*20/4L (4 lanes)",
  margins: { left: 4, right: 4, top: 0, bottom: 0 }, lanes: 4, laneAxis: "y",
});

function laneFeatures(canvas, store) {
  const jobs = [];
  const f = createFeatures({
    CFG: { threshold: 128 }, sharp, log() {}, RestError: class extends Error {
      constructor(m, s) { super(m); this.status = s; }
    },
    textCanvas: () => canvas,
    enqueue: (opts, pages, ctx) => { const j = { id: `j${jobs.length}`, opts, pages, ctx }; jobs.push(j); return j; },
    respond: async (job) => ({ id: job.id }),
    templates: store || {}, history: {}, queue: {},
  });
  return { f, jobs };
}

async function laneInk(png, lanes = 4) {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const h = info.height / lanes;
  return Array.from({ length: lanes }, (_, i) => data.subarray(i * h * info.width, (i + 1) * h * info.width));
}
const inkOf = (buf) => buf.reduce((n, v) => n + (v < 128 ? 1 : 0), 0);

test("counter template on a 4-lane roll: 6 labels -> rows 1-4 and 5-6, two lanes blank", async () => {
  const store = new TemplateStore(tmpDir("lanes"));
  store.put("num", { type: "text", layout: { lines: ["#{{counter}}"], font_size: 40 } });
  const { f, jobs } = laneFeatures(LANE_CANVAS(), store);
  const r = await f.printTemplate("num", { quantity: 6 });
  assert.deepEqual([r.counter_first, r.counter_last, r.lanes, r.rows, r.labels, r.blank_lanes], [1, 6, 4, 2, 6, 2]);
  const { pages, opts } = jobs[0];
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((p) => p.quantity), [1, 1]);
  assert.equal(opts.quantity, 1);
  const row1 = await laneInk(pages[0].buf);
  const row2 = await laneInk(pages[1].buf);
  for (const l of row1) assert.ok(inkOf(l) > 50, "row 1: every lane numbered");
  // four different numbers on row 1 (no lane equals another)
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) assert.ok(!row1[a].equals(row1[b]), `lanes ${a}/${b} differ`);
  assert.ok(inkOf(row2[0]) > 50 && inkOf(row2[1]) > 50, "row 2: #5 #6");
  assert.equal(inkOf(row2[2]), 0, "row 2 lane 3 blank");
  assert.equal(inkOf(row2[3]), 0, "row 2 lane 4 blank");
  // lane 1 of row 2 (#5) is not a repeat of lane 1 of row 1 (#1)
  assert.ok(!row2[0].equals(row1[0]));
  // the counter advanced by the labels printed, not by the lanes on the paper
  assert.equal(store.get("num").counter.next, 7);
  // the preview shows the next row: #7 #8 #9 #10 on four lanes
  const p = await f.previewTemplate("num", { format: "json" });
  const prev = await laneInk(Buffer.from(p.image, "base64"));
  for (const l of prev) assert.ok(inkOf(l) > 50);
  assert.ok(!prev[0].equals(prev[1]));
});

test("4-lane roll: plain text and fixed templates print ceil(labels / 4) rows", async () => {
  const store = new TemplateStore(tmpDir("lanes2"));
  store.put("fix", { type: "text", layout: { lines: ["Hi"] } });
  const { f, jobs } = laneFeatures(LANE_CANVAS(), store);
  const t = await f.printText({ text: "AB", quantity: 6 });
  assert.deepEqual([t.rows, t.labels, t.blank_lanes], [2, 8, undefined]);
  assert.equal(jobs[0].pages[0].quantity, 2);
  assert.equal(jobs[0].opts.quantity, 2);
  await f.printText({ text: "AB", quantity: 1 });
  assert.equal(jobs[1].pages[0].quantity, 1);
  const r = await f.printTemplate("fix", { quantity: 4 });
  assert.deepEqual([r.rows, r.labels], [1, 4]);
  assert.equal(jobs[2].pages[0].quantity, 1);
  assert.equal(store.get("fix").counter.next, 1);
});

test("single-lane roll: quantity and numbering unchanged (one label per page)", async () => {
  const store = new TemplateStore(tmpDir("lanes3"));
  store.put("num", { type: "text", layout: { lines: ["#{{counter}}"] } });
  const canvas = { width: 384, height: 240, printDirection: "top", from: "label", margins: { left: 0, right: 0, top: 4, bottom: 4 } };
  const { f, jobs } = laneFeatures(canvas, store);
  const r = await f.printTemplate("num", { quantity: 3 });
  assert.deepEqual([r.counter_first, r.counter_last, r.lanes], [1, 3, undefined]);
  assert.equal(jobs[0].pages.length, 3);
  const t = await f.printText({ text: "x", quantity: 5 });
  assert.equal(t.rows, undefined);
  assert.equal(jobs[1].pages[0].quantity, 5);
});
