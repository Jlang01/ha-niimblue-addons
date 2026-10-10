"use strict";
/* Font loading + measuring for server-side text labels.
 *
 * Uses opentype.js only to parse the TTF and read glyph outlines/advances.
 * Text is shaped glyph by glyph (no GSUB/GPOS shaping): opentype.js' shaping
 * engine throws on some DejaVu lookups, and plain Latin/Cyrillic/Greek label
 * text does not need it. Measuring and rendering use the same glyph walk, so
 * what fits in layout is exactly what gets drawn.
 *
 * Fonts: Alpine package font-dejavu (/usr/share/fonts/dejavu). FONT_DIR
 * overrides the search (tests, other distros). Works offline.
 */
const fs = require("fs");
const path = require("path");
const opentype = require("opentype.js");

const FILES = { regular: "DejaVuSans.ttf", bold: "DejaVuSans-Bold.ttf" };
const SEARCH_DIRS = [
  "/usr/share/fonts/dejavu",              // Alpine font-dejavu
  "/usr/share/fonts/TTF",                 // Arch
  "/usr/share/fonts/truetype/dejavu",     // Debian/Ubuntu
];

const cache = new Map();

function findFontFile(weight) {
  const file = FILES[weight] || FILES.regular;
  const dirs = [process.env.FONT_DIR, ...SEARCH_DIRS].filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, file);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`font ${file} not found (searched ${dirs.join(", ")}); install font-dejavu`);
}

/** Wrapper with the few metrics the layout needs, in font units -> px helpers. */
class Font {
  constructor(otf, file) {
    this.otf = otf;
    this.file = file;
    this.upm = otf.unitsPerEm;
    const hhea = otf.tables.hhea || {};
    this.ascent = (hhea.ascender || otf.ascender) / this.upm;     // em, > 0
    this.descent = -(hhea.descender || otf.descender) / this.upm; // em, > 0
    this.lineHeight = this.ascent + this.descent;                 // em
    this.glyphCache = new Map();
  }

  glyph(ch) {
    let g = this.glyphCache.get(ch);
    if (!g) {
      g = this.otf.charToGlyph(ch);
      this.glyphCache.set(ch, g);
    }
    return g;
  }

  /** Code points we draw: tabs -> space, other control chars dropped. */
  static chars(text) {
    return [...String(text).replace(/\t/g, " ")].filter((c) => c >= " " && c !== "\u007f");
  }

  /** Advance width of `text` at 1 px font size. */
  widthAt1(text) {
    let w = 0;
    for (const ch of Font.chars(text)) w += (this.glyph(ch).advanceWidth || 0);
    return w / this.upm;
  }

  width(text, size) { return this.widthAt1(text) * size; }

  /** SVG path data for `text` with its baseline at (x, y). */
  pathData(text, x, y, size, decimals = 2) {
    let d = "";
    let cx = x;
    const scale = size / this.upm;
    for (const ch of Font.chars(text)) {
      const g = this.glyph(ch);
      if (ch !== " ") d += g.getPath(cx, y, size).toPathData(decimals);
      cx += (g.advanceWidth || 0) * scale;
    }
    return d;
  }

  /** Characters the font has no glyph for (rendered as an empty box). */
  missing(text) {
    return [...new Set(Font.chars(text).filter((c) => c !== " " && this.glyph(c).index === 0))];
  }
}

function loadFont(weight = "regular") {
  const key = weight === "bold" ? "bold" : "regular";
  if (!cache.has(key)) {
    const file = findFontFile(key);
    const buf = fs.readFileSync(file);
    const otf = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    cache.set(key, new Font(otf, file));
  }
  return cache.get(key);
}

module.exports = { loadFont, Font, findFontFile };
