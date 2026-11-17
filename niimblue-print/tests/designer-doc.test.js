"use strict";
// "Open in designer": designer documents for history entries / image templates.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { lib, sharp, tmpDir } = require("./helpers");

const { checkDesign, imageDesign } = lib("designer-doc.js");
const { History } = lib("history.js");
const { TemplateStore } = lib("templates.js");

const DESIGN = {
  canvas: { version: "7.4.0", objects: [{ type: "Textbox", text: "Salz", left: 10, top: 10 }] },
  label: { printDirection: "left", size: { width: 160, height: 320 }, split: "horizontal", splitParts: 4 },
  thumbnailBase64: "data:image/jpeg;base64,xxxx",
};
const png = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: "#fff" } }).png().toBuffer();

test("checkDesign keeps the document, drops the thumbnail, rejects junk", () => {
  const d = checkDesign(DESIGN);
  assert.equal(d.thumbnailBase64, undefined);
  assert.deepEqual(d.label, DESIGN.label);
  assert.equal(d.canvas.objects.length, 1);
  assert.throws(() => checkDesign(null), /object/);
  assert.throws(() => checkDesign({ canvas: { objects: [] } }), /label/);
  assert.throws(() => checkDesign({ canvas: {}, label: DESIGN.label }), /objects/);
  assert.throws(() => checkDesign({ ...DESIGN, label: { ...DESIGN.label, printDirection: "up" } }), /label/);
  const big = { ...DESIGN, canvas: { version: "7", objects: [{ type: "Image", src: "x".repeat(5 * 1024 * 1024) }] } };
  assert.throws(() => checkDesign(big), /too large/);
});

test("imageDesign: image at 0,0 on a label of its size; lane split only when it is the roll", async () => {
  const buf = await png(160, 320);
  const layout = { lanes: 4, printDirection: "left", width: 160, height: 320, split: "horizontal", splitParts: 4 };
  const d = imageDesign(buf, { width: 160, height: 320, printDirection: "left", title: "Salz", layout });
  assert.deepEqual(d.label, { printDirection: "left", size: { width: 160, height: 320 }, split: "horizontal", splitParts: 4 });
  const o = d.canvas.objects[0];
  assert.deepEqual([o.type, o.left, o.top, o.width, o.height, o.originX, o.originY], ["Image", 0, 0, 160, 320, "left", "top"]);
  assert.match(o.src, /^data:image\/png;base64,/);
  const other = imageDesign(buf, { width: 160, height: 320, printDirection: "top", layout });
  assert.equal(other.label.split, undefined);
});

test("history stores the design next to the pages and removes it with the entry", async () => {
  const dir = tmpDir("hist");
  const h = new History(dir, { max: 1, sharp });
  const e = await h.add({ kind: "image", design: checkDesign(DESIGN) }, [{ png: await png(160, 320) }]);
  assert.equal(e.has_design, true);
  assert.equal(e.design, undefined, "the design is not in the index");
  assert.deepEqual(h.design(e.id).label, DESIGN.label);
  const e2 = await h.add({ kind: "text" }, [{ png: await png(160, 320) }]);
  assert.equal(e2.has_design, false);
  assert.equal(h.design(e2.id), null);
  assert.equal(fs.existsSync(path.join(dir, `${e.id}-design.json`)), false, "evicted entry's design deleted");
});

test("image templates keep a valid design, drop a bad one", async () => {
  const store = new TemplateStore(tmpDir("tpl"));
  const image = (await png(160, 320)).toString("base64");
  assert.equal(store.put("salz", { type: "image", imageBase64: image, design: DESIGN }).has_design, true);
  assert.deepEqual(store.get("salz").design.label, DESIGN.label);
  assert.equal(store.put("salz", { type: "image", imageBase64: image, design: { nope: 1 } }).has_design, false);
  assert.equal(store.put("salz", { type: "image", imageBase64: image }).has_design, false);
});
