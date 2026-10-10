"use strict";
/* Text label -> SVG (glyph outlines as paths, QR/barcode as whole-pixel
 * rects) -> PNG via sharp/librsvg. No font lookup happens in librsvg (text
 * is already outlines), so the result is identical offline and on any host.
 *
 *   renderText(body | spec, canvas, { sharp, threshold }) -> { png, layout, spec }
 */
const { loadFont } = require("./fonts");
const { encodeQr, encodeBarcode } = require("./codes");
const { normalizeSpec, layoutLabel } = require("./text-layout");

const r2 = (v) => Math.round(v * 100) / 100;

function qrPath(qrMatrix, q) {
  // one sub-path per run of dark modules in a row (compact, crisp)
  let d = "";
  for (let y = 0; y < q.n; y++) {
    let x = 0;
    while (x < q.n) {
      if (!qrMatrix.dark(x, y)) { x++; continue; }
      let e = x;
      while (e < q.n && qrMatrix.dark(e, y)) e++;
      d += `M${q.x + x * q.module} ${q.y + y * q.module}h${(e - x) * q.module}v${q.module}h${-(e - x) * q.module}z`;
      x = e;
    }
  }
  return d;
}

function buildSvg(layout, deps) {
  const { width: W, height: H } = layout;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="#fff"/>`,
  ];
  if (layout.border) {
    const b = layout.border;
    parts.push(`<rect x="${r2(b.x)}" y="${r2(b.y)}" width="${r2(b.w)}" height="${r2(b.h)}" rx="${b.radius}" ` +
      `fill="none" stroke="#000" stroke-width="${b.stroke}"/>`);
  }
  if (layout.lines.length) {
    const d = layout.lines.map((l) => deps.font.pathData(l.text, l.x, l.baseline, layout.font_size)).join("");
    if (d) parts.push(`<path d="${d}" fill="#000"/>`);
  }
  if (layout.qr) parts.push(`<path d="${qrPath(deps.qr, layout.qr)}" fill="#000" shape-rendering="crispEdges"/>`);
  if (layout.barcode) {
    const b = layout.barcode;
    const d = b.bars.map((bar) => `M${bar.x} ${b.y}h${bar.w}v${b.h}h${-bar.w}z`).join("");
    parts.push(`<path d="${d}" fill="#000" shape-rendering="crispEdges"/>`);
    if (b.hrt) parts.push(`<path d="${deps.hrtFont.pathData(b.hrt.text, b.hrt.x, b.hrt.baseline, b.hrt.size)}" fill="#000"/>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

/** Font + codes the layout needs for a spec. */
function prepare(spec) {
  return {
    font: loadFont(spec.bold ? "bold" : "regular"),
    hrtFont: loadFont("regular"),
    qr: spec.qr ? encodeQr(spec.qr.data, spec.qr.ec) : null,
    barcode: spec.barcode ? encodeBarcode(spec.barcode) : null,
  };
}

/**
 * Render a text label. `input` is a raw body (normalized here) or an
 * already-normalized spec (has `lines` + `wrap` booleans, flag `_normalized`).
 * opts.threshold: when set, the PNG is reduced to pure black/white at that
 * threshold (what the printer will print); otherwise anti-aliased grey.
 */
async function renderText(input, canvas, opts = {}) {
  const sharp = opts.sharp;
  if (!sharp) throw new Error("renderText: sharp missing");
  const spec = input && input._normalized ? input : { ...normalizeSpec(input), _normalized: true };
  const deps = prepare(spec);
  const layout = layoutLabel(spec, canvas, deps);
  const svg = buildSvg(layout, deps);
  let img = sharp(Buffer.from(svg), { density: 72 }).flatten({ background: "#fff" }).greyscale();
  if (opts.threshold) img = img.threshold(opts.threshold).toColourspace("b-w");
  const png = await img.png({ compressionLevel: 9 }).toBuffer();
  return { png, layout, spec, svg };
}

/** Compact, JSON-friendly summary of a layout (for responses / previews). */
function layoutInfo(layout) {
  return {
    width: layout.width,
    height: layout.height,
    font_size: layout.font_size,
    lines: layout.lines.map((l) => l.text),
    qr: layout.qr ? { size_px: layout.qr.size, module_px: layout.qr.module } : null,
    barcode: layout.barcode ? { width_px: layout.barcode.w, module_px: layout.barcode.module } : null,
    warnings: layout.warnings,
  };
}

module.exports = { renderText, buildSvg, layoutInfo, prepare };
