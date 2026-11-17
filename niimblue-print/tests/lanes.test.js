"use strict";
// Multi-lane rolls ("T10*20/4L-1200WHITE" = 4 labels of 10x20 mm side by side).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { lib, sharp } = require("./helpers");

const labelSize = require(path.resolve(__dirname, "../rootfs/usr/local/bin/label-size.js"));
const { createFeatures } = lib("features.js");

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
