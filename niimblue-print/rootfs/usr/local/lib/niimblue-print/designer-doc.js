"use strict";
/* NiimBlue designer documents ("ExportedLabelTemplate": { canvas: fabric
 * JSON, label: label props }) for "Open in designer" from the history and
 * image templates.
 *
 *  - Prints made in the designer carry their design (`design` in /print, the
 *    image-template PUT): kept as is, so the label opens fully editable.
 *  - Everything else (text / quick print / MQTT / older entries) opens as its
 *    printed image on a label of the same size and print direction.
 *
 * The designer validates the document again (zod schema) before loading it.
 */

const MAX_DESIGN_BYTES = 4 * 1024 * 1024;
const FABRIC_VERSION = "7.4.0";   // NiimBlue v2026.10.1 (any string passes its schema)

class DesignError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const posNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Check a design sent by the designer; returns the object to store (without
 * the thumbnail, which the history/template keeps itself) or throws.
 */
function checkDesign(d) {
  if (!isObj(d)) throw new DesignError("design must be an object");
  if (!isObj(d.canvas) || !Array.isArray(d.canvas.objects)) throw new DesignError("design.canvas.objects missing");
  const L = d.label;
  if (!isObj(L) || !isObj(L.size) || !posNum(L.size.width) || !posNum(L.size.height) ||
    (L.printDirection !== "left" && L.printDirection !== "top")) {
    throw new DesignError("design.label (printDirection, size) missing");
  }
  const out = { ...d };
  delete out.thumbnailBase64;
  delete out.id;
  if (typeof out.canvas.version !== "string") out.canvas = { ...out.canvas, version: FABRIC_VERSION };
  const bytes = Buffer.byteLength(JSON.stringify(out));
  if (bytes > MAX_DESIGN_BYTES) throw new DesignError(`design too large (${Math.round(bytes / 1024)} KB, max 4 MB)`, 413);
  return out;
}

/**
 * Designer document showing a printed image: one image object at 0,0 on a
 * label of the image's size. `layout` (optional, label-size.js
 * designerLayout of the current roll): its lane split is used when the size
 * and direction match it.
 */
function imageDesign(png, { width, height, printDirection, title, layout } = {}) {
  if (!posNum(width) || !posNum(height)) throw new DesignError("image size unknown", 500);
  const dir = printDirection === "left" ? "left" : "top";
  const label = { printDirection: dir, size: { width, height } };
  if (layout && layout.lanes > 1 && layout.printDirection === dir &&
    layout.width === width && layout.height === height) {
    label.split = layout.split;
    label.splitParts = layout.splitParts;
  }
  return {
    canvas: {
      version: FABRIC_VERSION,
      objects: [{
        type: "Image",
        version: FABRIC_VERSION,
        originX: "left", originY: "top",
        left: 0, top: 0, width, height, scaleX: 1, scaleY: 1, angle: 0,
        src: `data:image/png;base64,${png.toString("base64")}`,
      }],
    },
    label,
    ...(title ? { title: String(title).slice(0, 80) } : {}),
  };
}

module.exports = { checkDesign, imageDesign, DesignError, MAX_DESIGN_BYTES, FABRIC_VERSION };
