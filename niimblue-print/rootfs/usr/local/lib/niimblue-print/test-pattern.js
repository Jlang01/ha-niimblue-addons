"use strict";
/* Built-in test label, sized to the printed area (label after the centre
 * crop): shows where the printer really prints.
 *
 *   - 1 px frame on the outermost pixels + 8 px corner marks
 *   - dashed lines at the feed-direction blind zone (should print faint/none)
 *   - centre cross
 *   - 1 px line grid (8 px = 1 mm pitch) and 1/2/3 px line groups
 *   - text at 10, 14, 20, 28 px with the label / size / time
 */
const { loadFont } = require("./fonts");

function renderTestPattern(canvas, info = {}) {
  const { width: W, height: H } = canvas;
  const m = canvas.margins || {};
  const font = loadFont("regular");
  const bold = loadFont("bold");
  const p = [];
  const line = (x1, y1, x2, y2, w = 1, dash) =>
    p.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`);
  const rect = (x, y, w, h) => p.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000"/>`);
  const text = (f, s, x, y, size) => p.push(`<path d="${f.pathData(s, x, y, size)}" fill="#000"/>`);

  p.push(`<rect width="${W}" height="${H}" fill="#fff"/>`);
  // frame on the outermost pixel row/column
  rect(0, 0, W, 1); rect(0, H - 1, W, 1); rect(0, 0, 1, H); rect(W - 1, 0, 1, H);
  // corner marks 8 px x 3 px
  for (const [x, y, dx, dy] of [[0, 0, 1, 1], [W, 0, -1, 1], [0, H, 1, -1], [W, H, -1, -1]]) {
    rect(dx > 0 ? x : x - 16, dy > 0 ? y : y - 3, 16, 3);
    rect(dx > 0 ? x : x - 3, dy > 0 ? y : y - 16, 3, 16);
  }
  // blind zone limits
  if (m.top) line(0, m.top + 0.5, W, m.top + 0.5, 1, "4 4");
  if (m.bottom) line(0, H - m.bottom - 0.5, W, H - m.bottom - 0.5, 1, "4 4");
  if (m.left) line(m.left + 0.5, 0, m.left + 0.5, H, 1, "4 4");
  if (m.right) line(W - m.right - 0.5, 0, W - m.right - 0.5, H, 1, "4 4");
  // centre cross
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
  rect(cx - 12, cy, 24, 1); rect(cx, cy - 12, 1, 24);

  // 1 mm grid (8 px) in the lower-left quarter
  const gx = 16, gy = Math.floor(H / 2) + 16, gw = Math.floor(W / 2) - 32, gh = Math.floor(H / 2) - 32;
  for (let x = gx; x <= gx + gw; x += 8) rect(x, gy, 1, gh);
  for (let y = gy; y <= gy + gh; y += 8) rect(gx, y, gw, 1);
  // line widths 1, 2, 3 px (vertical groups) in the lower-right quarter
  let x = Math.floor(W / 2) + 24;
  for (const w of [1, 2, 3]) {
    for (let i = 0; i < 4; i++) { rect(x, gy, w, gh); x += w * 2; }
    x += 10;
  }

  // text samples
  const s = (n) => Math.max(8, Math.round(n * Math.min(1, H / 240)));
  let y = 8 + (m.top || 0) + font.ascent * s(20);
  text(bold, "NiimBlue test", 12, y, s(20));
  const sub = `${W}x${H} px${info.label ? ` · ${info.label}` : ""}`;
  y += font.lineHeight * s(14);
  text(font, sub, 12, y, s(14));
  y += font.lineHeight * s(10);
  text(font, `${info.time || new Date().toISOString().slice(0, 16)}${info.density ? ` · density ${info.density}` : ""}`, 12, y, s(10));
  const big = "Ag 28";
  text(font, big, W - 12 - font.width(big, s(28)), 8 + (m.top || 0) + font.ascent * s(28), s(28));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${p.join("")}</svg>`;
}

async function renderTestPng(canvas, info, sharp) {
  const svg = renderTestPattern(canvas, info);
  return sharp(Buffer.from(svg), { density: 72 }).flatten({ background: "#fff" }).greyscale()
    .threshold(128).toColourspace("b-w").png().toBuffer();
}

module.exports = { renderTestPattern, renderTestPng };
