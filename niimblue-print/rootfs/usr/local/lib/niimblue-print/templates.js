"use strict";
/* Saved label templates: /data/templates/<name>.json
 *
 *   type "text"  : a /print/text layout (lines, wrap, align, font_size, bold,
 *                  qr, barcode, border, margin) whose text fields may contain
 *                  {{placeholders}}; rendered fresh for every print.
 *   type "image" : a PNG made in the designer, printed as is (fitted to the
 *                  label like /print). Its text is pixels, so placeholders and
 *                  {{counter}} cannot work there.
 *
 * File: { version, name, type, description, layout | image, defaults,
 *         label: {name, width_px, height_px} (what it was made for),
 *         print: {density, labelWidth, labelHeight}, counter: {next},
 *         created_at, updated_at }
 */
const fs = require("fs");
const path = require("path");
const { normalizeSpec } = require("./text-layout");
const ph = require("./placeholders");
const { writeJsonAtomic, readJson } = require("./persist");

class TemplateError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const NAME_MAX = 64;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const LAYOUT_KEYS = ["lines", "text", "wrap", "align", "font_size", "bold", "qr", "barcode", "border", "margin"];

function checkName(name) {
  const n = String(name ?? "").trim();
  if (!n || n.length > NAME_MAX) throw new TemplateError(`template name must be 1-${NAME_MAX} characters`);
  if (/[\\/\u0000-\u001f\u007f]/.test(n) || n.startsWith(".")) {
    throw new TemplateError("template name must not contain / \\ or control characters, nor start with '.'");
  }
  return n;
}

// percent-encoding keeps any name filesystem-safe and reversible
const fileFor = (dir, name) => path.join(dir, `${encodeURIComponent(name)}.json`);

/** Layout spec as stored (raw fields; normalized again on every use). */
function pickLayout(src) {
  const out = {};
  for (const k of LAYOUT_KEYS) if (src[k] !== undefined) out[k] = src[k];
  if (out.text !== undefined && out.lines === undefined) {
    out.lines = String(out.text).split(/\r?\n/);
  }
  delete out.text;
  return out;
}

function cleanDefaults(d) {
  if (d === undefined || d === null) return {};
  if (typeof d !== "object" || Array.isArray(d)) throw new TemplateError("defaults must be an object");
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(k)) throw new TemplateError(`bad variable name '${k}'`);
    out[k] = v === null || v === undefined ? "" : String(v);
  }
  return out;
}

const posInt = (v) => (v === undefined || v === null || v === "" ? undefined
  : Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : NaN);

class TemplateStore {
  constructor(dir, log = () => {}) {
    this.dir = dir;
    this.log = log;
    this.queue = Promise.resolve();   // serializes counter use per store
  }

  ensureDir() { fs.mkdirSync(this.dir, { recursive: true }); }

  readFile(file) {
    return readJson(file, null, this.log);
  }

  writeAtomic(file, obj) {
    writeJsonAtomic(file, obj, 2);
  }

  /** Summary entry for lists (no image data). */
  summary(t) {
    const strings = t.type === "text" ? this.layoutStrings(t) : [];
    return {
      name: t.name,
      type: t.type,
      description: t.description || "",
      variables: ph.listVariables(strings),
      uses_counter: ph.usesCounter(strings),
      counter: t.counter ? t.counter.next : 1,
      defaults: t.defaults || {},
      label: t.label || null,
      updated_at: t.updated_at || null,
    };
  }

  layoutStrings(t) {
    const L = t.layout || {};
    return [...(L.lines || []), typeof L.qr === "object" && L.qr ? L.qr.data : L.qr,
      typeof L.barcode === "object" && L.barcode ? L.barcode.data : L.barcode].filter((s) => typeof s === "string");
  }

  list() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")); } catch (_) { /* none yet */ }
    return files.map((f) => this.readFile(path.join(this.dir, f)))
      .filter((t) => t && t.name)
      .map((t) => this.summary(t))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name) {
    const n = checkName(name);
    const t = this.readFile(fileFor(this.dir, n));
    if (!t) throw new TemplateError(`template '${n}' not found`, 404);
    return t;
  }

  /** Full template incl. image, plus the summary fields. */
  describe(name) {
    const t = this.get(name);
    return { ...t, ...this.summary(t) };
  }

  /** Create or replace. Keeps the counter unless body.counter is given. */
  put(name, body = {}) {
    const n = checkName(name);
    if (!body || typeof body !== "object") throw new TemplateError("body must be a JSON object");
    const file = fileFor(this.dir, n);
    const old = this.readFile(file);
    const now = new Date().toISOString();
    const image = body.imageBase64 ?? body.image;
    const type = body.type || (image ? "image" : "text");
    const t = {
      version: 1,
      name: n,
      type,
      description: body.description ? String(body.description).slice(0, 200) : "",
      defaults: cleanDefaults(body.defaults),
      label: body.label && typeof body.label === "object" ? {
        name: body.label.name ? String(body.label.name).slice(0, 80) : null,
        width_px: posInt(body.label.width_px) || null,
        height_px: posInt(body.label.height_px) || null,
      } : (old && old.label) || null,
      print: {},
      counter: { next: old && old.counter ? old.counter.next : 1 },
      created_at: (old && old.created_at) || now,
      updated_at: now,
    };
    for (const k of ["density", "labelWidth", "labelHeight", "quantity"]) {
      const v = posInt(body[k] ?? (body.print || {})[k]);
      if (Number.isNaN(v)) throw new TemplateError(`${k} must be a positive integer`);
      if (v !== undefined) t.print[k] = v;
    }
    if (t.print.density !== undefined && t.print.density > 5) throw new TemplateError("density must be 1-5");
    if (body.counter !== undefined && body.counter !== null) {
      const c = Number(body.counter);
      if (!Number.isInteger(c) || c < 0) throw new TemplateError("counter must be an integer >= 0");
      t.counter.next = c;
    }
    if (type === "image") {
      if (typeof image !== "string" || !image) throw new TemplateError("image template needs imageBase64 (PNG)");
      const b64 = image.replace(/^data:image\/\w+;base64,/, "");
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) throw new TemplateError("imageBase64 must be a PNG");
      if (bytes.length > IMAGE_MAX_BYTES) throw new TemplateError("image too large (max 4 MB)");
      t.image = b64;
    } else if (type === "text") {
      const layout = pickLayout(body.layout && typeof body.layout === "object" ? body.layout : body);
      normalizeSpec(layout);   // validate now (throws 400 with the reason)
      t.layout = layout;
    } else {
      throw new TemplateError("type must be 'text' or 'image'");
    }
    this.writeAtomic(file, t);
    return this.summary(t);
  }

  delete(name) {
    const n = checkName(name);
    try { fs.unlinkSync(fileFor(this.dir, n)); } catch (e) {
      if (e.code === "ENOENT") throw new TemplateError(`template '${n}' not found`, 404);
      throw e;
    }
    return { message: `template '${n}' deleted` };
  }

  /**
   * Run fn(template) with the counter reserved: template prints run one at
   * a time, so two prints never get the same numbers. fn returns
   * { result, used }; the counter advances by `used` as soon as fn has
   * queued its labels (numbers are reserved by the queued job, so a job that
   * is cancelled or fails later leaves a gap, but a number is never printed
   * twice, also not across restarts).
   */
  withCounter(name, fn) {
    const run = this.queue.then(async () => {
      const t = this.get(name);
      const r = await fn(t);
      if (r.used > 0) {
        const file = fileFor(this.dir, t.name);
        const cur = this.readFile(file);
        if (cur) {
          cur.counter = { next: Math.max((cur.counter && cur.counter.next) || 0, t.counter.next + r.used) };
          this.writeAtomic(file, cur);
        }
      }
      return r.result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

module.exports = { TemplateStore, TemplateError, checkName, pickLayout };
