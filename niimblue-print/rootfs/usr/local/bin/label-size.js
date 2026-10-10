/* Label geometry for the NiimBlue print server: turns a NIIMBOT cloud label
 * template (looked up by the roll's RFID barcode) into a print canvas in px.
 * Pure functions, no I/O, so they can be unit-tested without a printer.
 *
 * ACROSS-HEAD RULE
 * ----------------
 * The cloud template's width/height (mm) describe the label in the NIIMBOT
 * app's *design* orientation, and `rotate` is the rotation the app applies to
 * that design before sending it to the printer. After that rotation the
 * image's width runs across the printhead. So:
 *
 *     rotate 90 / 270  ->  across-head = height, feed = width
 *     rotate 0 / 180   ->  across-head = width,  feed = height
 *
 * `canvasRotate` only rotates the editor view in the app; it is ignored.
 *
 * Evidence (2026-10-10):
 *   - Our roll, barcode 10262260 "T50*30-230WHITE-NM" on a B21S: cloud says
 *     width 30, height 50, rotate 270, canvasRotate 90. Physically the roll is
 *     50 mm across the head x 30 mm along the feed, and a 384x240 px image
 *     (print direction "top", width = across) printed correctly. -> rotate 270
 *     => across = height. OK.
 *   - Templates bundled in the official NIIMBOT app (6.6.9 assets):
 *     "R50*30-230..." width 50, height 30, rotate 0, canvasRotate 0 -> across
 *     = width = 50 (same physical roll family as ours). "R40*94-80..." width
 *     94, height 40, rotate 90, canvasRotate 0 -> across = height = 40, the
 *     first number of the name, as in "T50*30". A canvasRotate-based rule
 *     would give 94 mm across, which no 40-50 mm head can print. NIIMBOT
 *     names rolls "<across>*<feed>".
 * Safety net: if the rule yields an across size that cannot fit the printhead
 * while the other side would, the two are swapped (logged via `swapped`).
 *
 *   - Official app 6.6.9 (decompiled by the coordinator): B21S_C2B has print
 *     direction 0 = template width across the head; the app renders the
 *     cloud template already rotated, so our roll ends up 50 mm across x 30
 *     mm feed = 400x240 px, and the app CENTRE-crops the overwidth to the
 *     384 px head (8 px each side, CUTTING_POSITION_BOTH_SIDES).
 *
 * OVERWIDTH: the label (400 px) is wider than the head (384 px). We design /
 * fit at the full label size and centre-crop the across-head side to the
 * head, like the app (centreCropAcross), so the label's centre stays the
 * centre of the print. Pixel sizes: label_* = full label, *_px = what is sent.
 *
 * BLIND ZONE (app data): gap and transparent paper ~0.5 mm at the start and
 * the end of the feed; black-mark paper none, but 1 mm is cut at the bottom.
 * For auto-layout (keep content out); images are still sent full size.
 *
 * niimbluelib image orientation (niimblue-node ImageEncoder): print direction
 * "top" -> image width runs across the head; "left" -> the image is rotated
 * 90 deg clockwise, so image HEIGHT runs across the head.
 */
"use strict";

const DEFAULT_DPI = 203;
const DEFAULT_PRINTHEAD_PX = 384;

// NIIMBOT label types (niimbluelib LabelType / cloud paperType)
const PAPER_GAP = 1, PAPER_BLACK_MARK = 2, PAPER_TRANSPARENT = 5;

const ceil8 = (n) => Math.ceil(n / 8) * 8;
const floor8 = (n) => Math.floor(n / 8) * 8;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number.parseFloat(v));
const posNum = (v, max = 10000) => { const n = num(v); return Number.isFinite(n) && n > 0 && n <= max ? n : null; };

/** English name from a cloud template's labelNames/names, else its plain name. */
/** Cloud text is untrusted: no control characters, max 100 chars (MQTT state, logs). */
const cleanName = (v) => {
  const s = String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return s || null;
};

function englishName(data) {
  for (const list of [data.labelNames, data.names]) {
    if (!Array.isArray(list)) continue;
    const en = list.find((n) => n && /^en\b/i.test(String(n.languageCode || "")) && n.name);
    if (en) return cleanName(en.name);
  }
  return data.name ? cleanName(data.name) : null;
}

/**
 * Reduce a cloud `getCloudTemplateByOneCode` response `data` object to the
 * fields we keep in the cache. Returns null if it carries no usable size.
 */
function parseCloudTemplate(data) {
  if (!data || typeof data !== "object") return null;
  const width = posNum(data.width, 1000);
  const height = posNum(data.height, 1000);
  if (!width || !height) return null;
  const rotate = ((Math.round(num(data.rotate) || 0) % 360) + 360) % 360;
  const canvasRotate = Number.isFinite(num(data.canvasRotate)) ? num(data.canvasRotate) : null;
  const dpi = posNum(data.paccuracyName, 2000);
  return {
    name: englishName(data),
    cloud_width_mm: width,
    cloud_height_mm: height,
    rotate,
    canvas_rotate: canvasRotate,
    dpi,
    paper_type: Number.isFinite(num(data.paperType)) ? num(data.paperType) : null,
    consumable_type: Number.isFinite(num(data.consumableType)) ? num(data.consumableType) : null,
  };
}

/** Across-head / feed size in mm for a parsed template (see rule above). */
function orientMm(tpl, printheadMm) {
  const turned = tpl.rotate === 90 || tpl.rotate === 270;
  let across = turned ? tpl.cloud_height_mm : tpl.cloud_width_mm;
  let feed = turned ? tpl.cloud_width_mm : tpl.cloud_height_mm;
  let swapped = false;
  // Physically impossible -> swap. 10% slack: B21 rolls are 50 mm on a 48 mm head.
  if (printheadMm && across > printheadMm * 1.1 && feed <= printheadMm * 1.1) {
    [across, feed] = [feed, across];
    swapped = true;
  }
  return { across_mm: across, feed_mm: feed, swapped };
}

/**
 * Print canvas for a parsed template.
 * @param tpl          parseCloudTemplate() result
 * @param opts.printheadPx  model printhead width in px (niimbluelib metadata)
 * @param opts.dpi          printer dpi (model metadata); falls back to the
 *                          template's dpi, then 203
 * @param opts.printDirection "top" (width = across) | "left" (height = across)
 */
function labelCanvas(tpl, opts = {}) {
  const dpi = posNum(opts.dpi, 2000) || tpl.dpi || DEFAULT_DPI;
  const head = floor8(posNum(opts.printheadPx, 100000) || DEFAULT_PRINTHEAD_PX);
  const dpmm = dpi / 25.4;
  const { across_mm, feed_mm, swapped } = orientMm(tpl, head / dpmm);
  const full_across_px = ceil8(Math.round(across_mm * dpmm));
  const across_px = Math.min(head, full_across_px);
  const feed_px = ceil8(Math.round(feed_mm * dpmm));
  const dir = opts.printDirection === "left" ? "left" : "top";
  const top = dir === "top";
  return {
    print_direction: dir,
    dpi,
    printhead_px: head,
    across_mm,
    feed_mm,
    full_across_px,               // whole label across the head (design size)
    across_px,                    // printable part = what is sent
    feed_px,
    clipped: full_across_px > head,   // label wider than the head: edges unprintable
    crop_each_side_px: Math.floor((full_across_px - across_px) / 2),
    swapped,
    // image size SENT to the printer for this print direction (after crop)
    width_px: top ? across_px : feed_px,
    height_px: top ? feed_px : across_px,
    // whole label for this print direction: design / fit at this size, the
    // server centre-crops the across-head side to the head
    label_width_px: top ? full_across_px : feed_px,
    label_height_px: top ? feed_px : full_across_px,
    width_mm: top ? across_mm : feed_mm,
    height_mm: top ? feed_mm : across_mm,
    blind_zone: blindZone(tpl.paper_type, dpi),
  };
}

/**
 * Feed-direction margins the printer cannot reliably print (app data, see
 * header), for keeping auto-laid-out content clear. px rounded up.
 */
function blindZone(paperType, dpi = DEFAULT_DPI) {
  const px = (mm) => Math.ceil(mm * dpi / 25.4);
  if (paperType === PAPER_GAP || paperType === PAPER_TRANSPARENT) {
    return { feed_start_mm: 0.5, feed_end_mm: 0.5, feed_start_px: px(0.5), feed_end_px: px(0.5) };
  }
  if (paperType === PAPER_BLACK_MARK) {   // no blind zone, but 1 mm cut at the bottom
    return { feed_start_mm: 0, feed_end_mm: 1, feed_start_px: 0, feed_end_px: px(1) };
  }
  return { feed_start_mm: 0, feed_end_mm: 0, feed_start_px: 0, feed_end_px: 0 };
}

/**
 * Centre-crop rectangle (sharp extract() args) when the across-head side of a
 * width x height image exceeds the head, else null. Like the NIIMBOT app
 * (both sides cut equally), so the label centre stays centred.
 */
function centreCropAcross(width, height, printDirection, printheadPx) {
  const head = floor8(posNum(printheadPx, 100000) || 0);
  if (!head) return null;
  const top = printDirection !== "left";
  const across = top ? width : height;
  if (across <= head) return null;
  const off = Math.floor((across - head) / 2);
  return top
    ? { left: off, top: 0, width: head, height }
    : { left: 0, top: off, width, height: head };
}

module.exports = {
  parseCloudTemplate, labelCanvas, orientMm, englishName, blindZone, centreCropAcross,
  DEFAULT_DPI, DEFAULT_PRINTHEAD_PX, PAPER_GAP, PAPER_BLACK_MARK, PAPER_TRANSPARENT,
};
