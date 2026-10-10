"use strict";
/* QR codes and 1D barcodes as plain module data (no images): bwip-js'
 * encoders (pure JS, offline) via bwipjs.raw(), drawn by text-render.js with
 * whole-pixel modules so they stay crisp on a 203 dpi thermal head.
 */
const bwipjs = require("bwip-js");

class CodeError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const QR_MAX_BYTES = 1200;
const BARCODE_TYPES = ["code128", "ean13"];

/**
 * bwip-js input for QR data. bwip-js sends the UTF-8 bytes of the string; for
 * non-ASCII data an ECI 26 (UTF-8) marker is added so scanners don't guess
 * another charset (zbar e.g. reads unmarked "ä" as Shift-JIS). With the
 * marker, parsefnc is on, so a literal "^" has to be doubled.
 */
function qrInput(s) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(s)) return { text: s };
  return { text: `^ECI000026${s.replace(/\^/g, "^^")}`, parsefnc: true };
}

/**
 * QR matrix: { n, dark(x, y) }. ecLevel L|M|Q|H (default M: survives a bit
 * of thermal smudge, still compact).
 */
function encodeQr(data, ecLevel = "M") {
  const s = String(data ?? "");
  if (!s) throw new CodeError("qr: empty data");
  if (Buffer.byteLength(s, "utf8") > QR_MAX_BYTES) {
    throw new CodeError(`qr: data too long (max ${QR_MAX_BYTES} bytes for a label)`);
  }
  if (!/^[LMQH]$/.test(ecLevel)) ecLevel = "M";
  let r;
  try {
    r = bwipjs.raw({ bcid: "qrcode", ...qrInput(s), eclevel: ecLevel });
  } catch (e) {
    throw new CodeError(`qr: ${e.message || e}`);
  }
  const { pixs, pixx, pixy } = r[0];
  if (pixx !== pixy) throw new CodeError("qr: unexpected non-square matrix");
  return { kind: "qr", n: pixx, dark: (x, y) => pixs[y * pixx + x] === 1 };
}

/** EAN-13 check digit for 12 digits. */
function ean13Check(d12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}

/**
 * 1D barcode: { kind, type, widths: [bar, space, bar, ...] in modules,
 * modules: total width in modules, text: human-readable line }.
 */
function encodeBarcode(spec) {
  const type = String(spec.type || "code128").toLowerCase();
  if (!BARCODE_TYPES.includes(type)) throw new CodeError(`barcode.type must be one of ${BARCODE_TYPES.join(", ")}`);
  let data = String(spec.data ?? "");
  if (!data) throw new CodeError("barcode: empty data");
  let text = data;
  if (type === "ean13") {
    data = data.replace(/[\s-]/g, "");
    if (!/^\d{12,13}$/.test(data)) throw new CodeError("barcode: ean13 needs 12 or 13 digits");
    const check = ean13Check(data.slice(0, 12));
    if (data.length === 13 && data[12] !== check) {
      throw new CodeError(`barcode: ean13 check digit is wrong (expected ${check})`);
    }
    data = data.slice(0, 12) + check;
    text = data;
  } else {
    if (data.length > 80) throw new CodeError("barcode: code128 data too long (max 80 characters)");
    if (/[^\x20-\x7e]/.test(data)) throw new CodeError("barcode: code128 supports printable ASCII only");
  }
  let r;
  try {
    r = bwipjs.raw({ bcid: type, text: data });
  } catch (e) {
    throw new CodeError(`barcode: ${e.message || e}`);
  }
  const widths = r[0].sbs;
  return { kind: "barcode", type, widths, modules: widths.reduce((a, b) => a + b, 0), text };
}

module.exports = { encodeQr, encodeBarcode, ean13Check, CodeError, BARCODE_TYPES, QR_MAX_BYTES };
