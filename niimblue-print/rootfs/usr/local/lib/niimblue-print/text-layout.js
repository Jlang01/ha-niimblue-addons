"use strict";
/* Text label layout (pure: no image libraries, no I/O besides font metrics).
 *
 *   normalizeSpec(body)                -> validated text spec
 *   layoutLabel(spec, canvas, deps)    -> positioned lines / QR / barcode / border
 *
 * canvas = { width, height, margins: {top, right, bottom, left} } in px. The
 * caller (print-server) sizes the canvas to the PRINTED image (label after the
 * centre-crop to the head) and puts the feed-direction blind zone into the
 * margins, so nothing is laid out where the printer cannot print.
 *
 * Auto font size: the largest size at which all text fits the text box.
 *   wrap=false: every input line stays one line (shrinks until the widest fits)
 *   wrap=true : word-wraps; a word wider than the box is broken only when no
 *               readable size fits it whole.
 * A fixed font_size is used when it fits, otherwise shrunk (with a warning).
 */
const { Font } = require("./fonts");

class LayoutError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const MIN_FONT = 8;          // px; 1 mm at 203 dpi, smaller is unreadable on a thermal head
const BREAK_BELOW = 20;      // px; below this, wrap=true may break an over-long word
const MAX_FONT = 400;
const MAX_LINES = 40;
const MAX_CHARS = 2000;
const DEFAULT_MARGIN = 8;    // px (1 mm) inside the printable area
const ALIGNS = ["left", "center", "right"];

const bool = (v, d) => (v === undefined || v === null || v === "" ? d
  : typeof v === "boolean" ? v : !/^(false|0|no|off)$/i.test(String(v)));

/** Validate + normalize a /print/text body (also used for text templates). */
function normalizeSpec(body = {}) {
  if (!body || typeof body !== "object") throw new LayoutError("body must be a JSON object");
  let lines;
  if (Array.isArray(body.lines)) lines = body.lines.map((l) => (l === null || l === undefined ? "" : String(l)));
  else if (body.text !== undefined && body.text !== null) lines = String(body.text).split(/\r?\n/);
  else lines = [];
  // one entry with embedded newlines in `lines` is split too
  lines = lines.flatMap((l) => l.split(/\r?\n/));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length > MAX_LINES) throw new LayoutError(`too many lines (max ${MAX_LINES})`);
  if (lines.join("").length > MAX_CHARS) throw new LayoutError(`text too long (max ${MAX_CHARS} characters)`);

  const align = body.align === undefined || body.align === null ? "center" : String(body.align).toLowerCase();
  if (!ALIGNS.includes(align === "centre" ? "center" : align)) {
    throw new LayoutError(`align must be one of ${ALIGNS.join(", ")}`);
  }

  let fontSize = "auto";
  if (body.font_size !== undefined && body.font_size !== null && body.font_size !== "" && body.font_size !== "auto") {
    fontSize = Number(body.font_size);
    if (!Number.isFinite(fontSize) || fontSize < MIN_FONT || fontSize > MAX_FONT) {
      throw new LayoutError(`font_size must be "auto" or ${MIN_FONT}-${MAX_FONT} (px)`);
    }
  }

  let qr = null;
  if (body.qr !== undefined && body.qr !== null && body.qr !== "") {
    qr = typeof body.qr === "object" ? { data: String(body.qr.data ?? ""), ec: body.qr.ec || "M" } : { data: String(body.qr), ec: "M" };
    if (!qr.data) qr = null;
  }

  let barcode = null;
  if (body.barcode !== undefined && body.barcode !== null && body.barcode !== "") {
    const b = typeof body.barcode === "object" ? body.barcode : { data: body.barcode };
    if (b.data !== undefined && b.data !== null && String(b.data) !== "") {
      barcode = { type: String(b.type || "code128").toLowerCase(), data: String(b.data), text: bool(b.text, true) };
    }
  }

  let margin = DEFAULT_MARGIN;
  if (body.margin !== undefined && body.margin !== null && body.margin !== "") {
    margin = Number(body.margin);
    if (!Number.isFinite(margin) || margin < 0 || margin > 100) throw new LayoutError("margin must be 0-100 (px)");
  }

  const spec = {
    lines,
    wrap: bool(body.wrap, false),
    align: align === "centre" ? "center" : align,
    font_size: fontSize,
    bold: bool(body.bold, false),
    qr,
    barcode,
    border: bool(body.border, false),
    margin,
  };
  if (!spec.lines.some((l) => l.trim()) && !qr && !barcode) throw new LayoutError("nothing to print: no text, qr or barcode");
  return spec;
}

// ---- wrapping -------------------------------------------------------------
/** Break one word into pieces that each fit maxW (character granularity). */
function breakWord(font, word, size, maxW) {
  const out = [];
  let cur = "";
  for (const ch of [...word]) {
    if (cur && font.width(cur + ch, size) > maxW) { out.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Greedy word wrap of `paragraphs` at `size`. Returns lines, or null when a
 * single word is wider than maxW and breakWords is false.
 */
function wrapLines(font, paragraphs, size, maxW, breakWords) {
  const out = [];
  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let cur = "";
    for (let w of words) {
      if (font.width(w, size) > maxW) {
        if (!breakWords) return null;
        const pieces = breakWord(font, w, size, maxW);
        // first piece may still join the current line if it fits
        for (let i = 0; i < pieces.length - 1; i++) {
          if (cur) { out.push(cur); cur = ""; }
          out.push(pieces[i]);
        }
        w = pieces[pieces.length - 1];
      }
      const cand = cur ? `${cur} ${w}` : w;
      if (cur && font.width(cand, size) > maxW) { out.push(cur); cur = w; } else cur = cand;
    }
    out.push(cur);
  }
  return out;
}

const floorHalf = (v) => Math.floor(v * 2) / 2;

/**
 * Fit text into a box. Returns { size, lines, warnings }.
 * Throws LayoutError when even MIN_FONT does not fit.
 */
function fitText(font, rawLines, box, spec) {
  const warnings = [];
  const lh = font.lineHeight;
  const paragraphs = rawLines.map((l) => l.replace(/\s+$/, ""));
  const fixed = spec.font_size === "auto" ? null : spec.font_size;

  if (!spec.wrap) {
    const lines = paragraphs.map((l) => l.trim() ? l.replace(/^\s+/, "") : "");
    const widest = Math.max(0, ...lines.map((l) => font.widthAt1(l)));
    const byH = box.h / (lines.length * lh);
    const byW = widest > 0 ? box.w / widest : Infinity;
    const best = Math.min(MAX_FONT, floorHalf(Math.min(byH, byW)));
    let size = fixed ?? best;
    if (fixed && fixed > best) {
      warnings.push(`font_size ${fixed} does not fit, shrunk to ${best}`);
      size = best;
    }
    if (size < MIN_FONT) {
      throw new LayoutError(`text does not fit on the label even at ${MIN_FONT} px ` +
        "(shorten it, use fewer lines, or set wrap: true)");
    }
    return { size, lines, warnings };
  }

  const fits = (size, breakWords) => {
    const lines = wrapLines(font, paragraphs, size, box.w, breakWords);
    if (!lines || lines.length > MAX_LINES * 2) return null;
    return lines.length * lh * size <= box.h + 1e-6 ? lines : null;
  };
  const search = (breakWords) => {
    const hi0 = Math.min(MAX_FONT, floorHalf(box.h / lh));
    if (hi0 < MIN_FONT || !fits(MIN_FONT, breakWords)) return null;
    let lo = MIN_FONT, hi = hi0;          // invariant: lo fits
    while (hi - lo > 0.5) {
      const mid = floorHalf((lo + hi) / 2);
      if (mid <= lo) break;
      if (fits(mid, breakWords)) lo = mid; else hi = mid;
    }
    if (hi > lo && fits(hi, breakWords)) lo = hi;
    return { size: lo, lines: fits(lo, breakWords) };
  };

  if (fixed) {
    const lines = fits(fixed, false) || fits(fixed, true);
    if (lines) return { size: fixed, lines, warnings };
  }
  // Whole words first. Break a word only if it does not fit at all, or if
  // keeping it whole forces tiny text (< BREAK_BELOW px) and breaking at
  // least doubles the size.
  let r = search(false);
  if (!r || r.size < BREAK_BELOW) {
    const broken = search(true);
    if (broken && (!r || broken.size >= 2 * r.size)) {
      r = broken;
      warnings.push("a word was too long for the label and was broken");
    }
  }
  if (!r) throw new LayoutError(`text does not fit on the label even at ${MIN_FONT} px (shorten it)`);
  if (fixed) warnings.push(`font_size ${fixed} does not fit, shrunk to ${r.size}`);
  return { size: r.size, lines: r.lines, warnings };
}

// ---- whole label ------------------------------------------------------------
/**
 * deps = { font: Font (regular or bold, matching spec.bold), hrtFont: Font,
 *          qr: encodeQr() result | null, barcode: encodeBarcode() result | null }
 */
function layoutLabel(spec, canvas, deps) {
  const { width: W, height: H } = canvas;
  const m = canvas.margins || {};
  const pad = spec.margin ?? DEFAULT_MARGIN;
  const box = {
    x: (m.left || 0) + pad,
    y: (m.top || 0) + pad,
    w: W - (m.left || 0) - (m.right || 0) - 2 * pad,
    h: H - (m.top || 0) - (m.bottom || 0) - 2 * pad,
  };
  if (box.w < 16 || box.h < 16) throw new LayoutError(`label too small (${W}x${H} px) for the margins`);
  const out = { width: W, height: H, box: { ...box }, lines: [], font_size: null, warnings: [] };

  if (spec.border) {
    const bw = Math.max(2, Math.round(Math.min(box.w, box.h) / 80));
    out.border = { x: box.x + bw / 2, y: box.y + bw / 2, w: box.w - bw, h: box.h - bw, stroke: bw, radius: bw * 3 };
    const inset = bw * 3;
    box.x += inset; box.y += inset; box.w -= 2 * inset; box.h -= 2 * inset;
  }

  const hasText = spec.lines.some((l) => l.trim());
  const gap = Math.max(6, Math.round(Math.min(W, H) / 40));
  const tb = { ...box };              // what is left for the text

  // QR: beside the text on landscape boxes, below it on portrait ones.
  if (deps.qr) {
    const n = deps.qr.n;
    const alone = !hasText && !deps.barcode;
    const landscape = tb.w >= tb.h;
    let side;
    if (alone) side = Math.min(tb.w, tb.h);
    else if (landscape) side = Math.min(tb.h, Math.floor(tb.w * (hasText ? 0.45 : 0.5)));
    else side = Math.min(tb.w, Math.floor(tb.h * 0.45));
    const module = Math.floor(side / n);
    if (module < 2) {
      throw new LayoutError(`QR code too dense for this label (${n}x${n} modules in ${side} px; ` +
        "shorten the QR data)");
    }
    const size = module * n;
    let qx, qy;
    if (alone) { qx = tb.x + Math.floor((tb.w - size) / 2); qy = tb.y + Math.floor((tb.h - size) / 2); }
    else if (landscape) {
      qx = tb.x + tb.w - size; qy = tb.y + Math.floor((tb.h - size) / 2);
      tb.w -= size + gap;
    } else {
      qx = tb.x + Math.floor((tb.w - size) / 2); qy = tb.y + tb.h - size;
      tb.h -= size + gap;
    }
    out.qr = { x: qx, y: qy, module, n, size };
  }

  // Barcode: a band at the bottom of what is left (full text-column width).
  if (deps.barcode) {
    const bc = deps.barcode;
    let quiet = 10;
    let module = Math.floor(tb.w / (bc.modules + 2 * quiet));
    if (module < 1) { quiet = 2; module = Math.floor(tb.w / (bc.modules + 2 * quiet)); }
    if (module < 1) {
      throw new LayoutError(`barcode too long for this label (${bc.modules} modules in ${tb.w} px)`);
    }
    if (module === 1) out.warnings.push("barcode bars are 1 px (0.125 mm) wide; it may not scan reliably");
    const band = hasText ? Math.round(tb.h * 0.45) : tb.h;
    let hrt = null;
    let barsH = band;
    if (spec.barcode.text !== false) {
      const size = Math.max(MIN_FONT, Math.min(24, Math.round(band * 0.22)));
      const hrtW = deps.hrtFont.width(bc.text, size);
      const fitSize = hrtW > tb.w ? Math.max(MIN_FONT, floorHalf(size * tb.w / hrtW)) : size;
      const hh = Math.ceil(deps.hrtFont.lineHeight * fitSize);
      barsH = band - hh;
      hrt = { size: fitSize, text: bc.text, height: hh };
    }
    if (barsH < 16) throw new LayoutError("not enough room for the barcode (shorter text or no QR)");
    const bwid = bc.modules * module;
    const bx = tb.x + Math.floor((tb.w - bwid) / 2);
    const by = tb.y + tb.h - band;
    const bars = [];
    let x = bx;
    bc.widths.forEach((w, i) => {
      if (i % 2 === 0) bars.push({ x, w: w * module });
      x += w * module;
    });
    out.barcode = { x: bx, y: by, w: bwid, h: barsH, module, bars, type: bc.type };
    if (hrt) {
      const tw = deps.hrtFont.width(hrt.text, hrt.size);
      out.barcode.hrt = {
        text: hrt.text, size: hrt.size,
        x: tb.x + (tb.w - tw) / 2,
        baseline: by + barsH + deps.hrtFont.ascent * hrt.size,
      };
    }
    tb.h -= band + (hasText ? gap : 0);
  }

  if (hasText) {
    if (tb.w < MIN_FONT || tb.h < MIN_FONT) throw new LayoutError("no room left for the text next to the QR/barcode");
    const font = deps.font;
    const fit = fitText(font, spec.lines, tb, spec);
    out.font_size = fit.size;
    out.warnings.push(...fit.warnings);
    const lh = font.lineHeight * fit.size;
    const blockTop = tb.y + (tb.h - fit.lines.length * lh) / 2;
    fit.lines.forEach((text, i) => {
      const w = font.width(text, fit.size);
      const x = spec.align === "left" ? tb.x : spec.align === "right" ? tb.x + tb.w - w : tb.x + (tb.w - w) / 2;
      out.lines.push({ text, x, baseline: blockTop + i * lh + font.ascent * fit.size, width: w });
    });
    const missing = font.missing(spec.lines.join(""));
    if (missing.length) out.warnings.push(`no glyph in the font for: ${missing.join(" ")}`);
  }
  out.text_box = tb;
  return out;
}

module.exports = {
  normalizeSpec, layoutLabel, fitText, wrapLines, LayoutError,
  MIN_FONT, MAX_FONT, DEFAULT_MARGIN, Font,
};
