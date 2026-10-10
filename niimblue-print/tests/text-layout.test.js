"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { lib, B21S_CANVAS } = require("./helpers");

const { normalizeSpec, layoutLabel, MIN_FONT } = lib("text-layout.js");
const { prepare } = lib("text-render.js");

const layout = (body, canvas = B21S_CANVAS) => {
  const spec = normalizeSpec(body);
  return layoutLabel(spec, canvas, prepare(spec));
};

/** Every glyph box (advance width x line height) is inside the safe area. */
function assertInsideSafeArea(l, canvas = B21S_CANVAS) {
  const m = canvas.margins;
  for (const line of l.lines) {
    assert.ok(line.x >= m.left - 0.01, `line '${line.text}' starts left of the area (${line.x})`);
    assert.ok(line.x + line.width <= canvas.width - m.right + 0.01, `line '${line.text}' overflows right`);
    const font = prepare({ bold: false }).font;
    assert.ok(line.baseline - font.ascent * l.font_size >= m.top - 0.01, `line '${line.text}' enters the top blind zone`);
    assert.ok(line.baseline + font.descent * l.font_size <= canvas.height - m.bottom + 0.01, `line '${line.text}' enters the bottom blind zone`);
  }
}

test("normalizeSpec: defaults and text splitting", () => {
  const s = normalizeSpec({ text: "\nA\nB\n\n" });
  assert.deepEqual(s.lines, ["A", "B"]);
  assert.equal(s.wrap, false);
  assert.equal(s.align, "center");
  assert.equal(s.font_size, "auto");
  assert.equal(s.bold, false);
  assert.equal(normalizeSpec({ lines: ["x\ny", "z"] }).lines.length, 3);
  assert.equal(normalizeSpec({ text: "x", align: "centre" }).align, "center");
  assert.equal(normalizeSpec({ text: "x", wrap: "true" }).wrap, true);
});

test("normalizeSpec: validation errors are 400s", () => {
  for (const body of [{}, { text: "   " }, { text: "x", align: "middle" }, { text: "x", font_size: 2 },
    { text: "x", font_size: "huge" }, { lines: Array(50).fill("x") }, { text: "x", margin: -1 }]) {
    assert.throws(() => normalizeSpec(body), (e) => e.status === 400, JSON.stringify(body));
  }
  // a QR or barcode alone is fine
  assert.doesNotThrow(() => normalizeSpec({ qr: "x" }));
  assert.doesNotThrow(() => normalizeSpec({ barcode: { type: "code128", data: "1" } }));
});

test("auto size: short text gets big, longer text gets smaller", () => {
  const big = layout({ text: "Hi" });
  const small = layout({ text: "Hello wonderful world" });
  assert.ok(big.font_size > 100, `expected >100 px, got ${big.font_size}`);
  assert.ok(small.font_size < big.font_size);
  assertInsideSafeArea(big);
  assertInsideSafeArea(small);
});

test("auto size: height bound for many short lines, width bound for one long line", () => {
  const tall = layout({ lines: ["a", "b", "c", "d"] });
  const lh = prepare({ bold: false }).font.lineHeight;
  // 240 - 2*4 blind - 2*8 margin = 216 px for 4 lines
  assert.ok(Math.abs(tall.font_size - Math.floor((216 / (4 * lh)) * 2) / 2) < 0.6);
  const wide = layout({ text: "abcdefghijklmnopqrstuvwxyz" });
  const used = wide.lines[0].width;
  assert.ok(used <= 384 - 16 && used > 384 - 16 - 20, `width fills the label: ${used}`);
  assertInsideSafeArea(tall);
  assertInsideSafeArea(wide);
});

test("wrap=false keeps every input line on one line", () => {
  const text = "Selbstgemachte Erdbeermarmelade mit Vanille";
  const l = layout({ text, wrap: false });
  assert.deepEqual(l.lines.map((x) => x.text), [text]);
  assertInsideSafeArea(l);
});

test("wrap=true word-wraps and ends up larger than wrap=false", () => {
  const text = "Selbstgemachte Erdbeermarmelade mit Vanille und einem Schuss Rum";
  const off = layout({ text, wrap: false });
  const on = layout({ text, wrap: true });
  assert.ok(on.lines.length > 1);
  assert.ok(on.font_size > off.font_size * 1.5, `${on.font_size} vs ${off.font_size}`);
  // no word broken: every output line is made of whole input words
  const words = new Set(text.split(" "));
  for (const line of on.lines) for (const w of line.text.split(" ")) assert.ok(words.has(w), `broken word '${w}'`);
  assertInsideSafeArea(on);
});

test("wrap=true: a very long word is broken only when nothing else fits", () => {
  const long = "Donaudampfschifffahrtsgesellschaftskapitänsmützenabzeichenherstellungsbetriebsleitung";
  const l = layout({ text: `${long} ${long}`, wrap: true });
  assert.ok(l.font_size >= MIN_FONT);
  assert.match(l.warnings.join(" "), /broken/);
  assert.ok(l.lines.length >= 3, "the word was split over several lines");
  assertInsideSafeArea(l);
  // the same word alone still fits whole at a smaller size (no break needed)
  const one = layout({ text: "Donaudampfschifffahrt", wrap: true });
  assert.deepEqual(one.lines.map((x) => x.text), ["Donaudampfschifffahrt"]);
  assert.equal(one.warnings.length, 0);
});

test("wrap=false: text that cannot fit at the minimum size is a 400", () => {
  assert.throws(() => layout({ text: "x".repeat(400), wrap: false }), (e) => e.status === 400);
});

test("fixed font_size is honoured when it fits, shrunk with a warning when not", () => {
  const ok = layout({ text: "Hi", font_size: 40 });
  assert.equal(ok.font_size, 40);
  assert.equal(ok.warnings.length, 0);
  const shrunk = layout({ text: "Hello wonderful world", font_size: 200 });
  assert.ok(shrunk.font_size < 200);
  assert.match(shrunk.warnings.join(" "), /shrunk/);
  assertInsideSafeArea(shrunk);
});

test("alignment: left / center / right", () => {
  const L = layout({ lines: ["a", "wide line"], align: "left" });
  assert.ok(Math.abs(L.lines[0].x - L.lines[1].x) < 0.01);
  const R = layout({ lines: ["a", "wide line"], align: "right" });
  assert.ok(Math.abs((R.lines[0].x + R.lines[0].width) - (R.lines[1].x + R.lines[1].width)) < 0.01);
  const C = layout({ lines: ["a", "wide line"] });
  const mid = (x) => x.x + x.width / 2;
  assert.ok(Math.abs(mid(C.lines[0]) - mid(C.lines[1])) < 0.01);
});

test("multi-line block is vertically centred between the blind zones", () => {
  const l = layout({ lines: ["one", "two"], font_size: 30 });
  const font = prepare({ bold: false }).font;
  const top = l.lines[0].baseline - font.ascent * 30;
  const bottom = l.lines[1].baseline + font.descent * 30;
  assert.ok(Math.abs((top - 4) - (240 - 4 - bottom)) < 0.6);
});

test("QR beside the text on a landscape label, below on a portrait one", () => {
  const land = layout({ text: "WLAN", qr: "WIFI:T:WPA;S:x;P:y;;" });
  assert.ok(land.qr.x > land.lines[0].x + land.lines[0].width, "QR right of the text");
  assert.ok(land.qr.module >= 2);
  assert.ok(land.qr.y >= 4 && land.qr.y + land.qr.size <= 236, "QR outside blind zone");
  const portrait = { width: 240, height: 384, margins: { top: 4, bottom: 4, left: 0, right: 0 } };
  const port = layout({ text: "WLAN", qr: "WIFI:T:WPA;S:x;P:y;;" }, portrait);
  assert.ok(port.qr.y > port.lines[0].baseline, "QR below the text");
});

test("QR alone is centred and as big as possible", () => {
  const l = layout({ qr: "https://example.com" });
  assert.equal(l.lines.length, 0);
  assert.ok(l.qr.size > 180);
  assert.ok(Math.abs((l.qr.x + l.qr.size / 2) - 192) <= 1);
});

test("too much QR data is a 400, not an unreadable code", () => {
  assert.throws(() => layout({ text: "x", qr: "y".repeat(1100) }), (e) => e.status === 400);
});

test("barcode band below the text, whole-pixel modules, centred", () => {
  const l = layout({ text: "Artikel", barcode: { type: "ean13", data: "400638133393" } });
  assert.ok(l.barcode.y > l.lines[0].baseline - 1);
  assert.ok(Number.isInteger(l.barcode.module) && l.barcode.module >= 2);
  assert.ok(Math.abs((l.barcode.x + l.barcode.w / 2) - 192) <= 1);
  assert.equal(l.barcode.hrt.text, "4006381333931");
});

test("border shrinks the text area", () => {
  const plain = layout({ text: "Hi" });
  const framed = layout({ text: "Hi", border: true });
  assert.ok(framed.border && framed.border.stroke >= 2);
  assert.ok(framed.font_size < plain.font_size);
});

test("bold text is wider, so it is set smaller", () => {
  const text = "Wide words here";
  assert.ok(layout({ text, bold: true }).font_size < layout({ text }).font_size);
});
