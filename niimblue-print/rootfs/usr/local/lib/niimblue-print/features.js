"use strict";
/* REST features on top of the print core (print-server.js):
 *
 *   POST /print/text            text label -> print
 *   POST /preview/text          text label -> PNG (or JSON with format:"json")
 *   GET  /templates             list
 *   GET|PUT|DELETE /templates/{name}
 *   POST /print/template/{name}    {vars, quantity}
 *   POST /preview/template/{name}  {vars} -> PNG / JSON (first label)
 *   GET  /history  DELETE /history
 *   GET  /history/{id}/thumb.png   GET /history/{id}/{n}.png
 *   POST /history/{id}/reprint     ({id} may be "last")
 *   GET  /history/{id}/design      NiimBlue designer document ("Open in designer")
 *   GET  /templates/{name}/design  same for an image template
 *   GET  /queue  DELETE /queue  DELETE /queue/{id}  POST /queue/{id}/retry
 *   POST /test                     built-in test label
 *
 * Every print goes through the persistent queue (core.submit): the request
 * waits up to `wait_timeout` s for the label to print (200), else answers
 * 202 with the job id; the job prints once the printer is reachable.
 * The core passes in what it owns (queue, label geometry, stores), so this
 * file holds no printer state.
 */
const { renderText, layoutInfo } = require("./text-render");
const { normalizeSpec } = require("./text-layout");
const ph = require("./placeholders");
const { renderTestPng } = require("./test-pattern");
const designerDoc = require("./designer-doc");

const MAX_COUNTER_LABELS = 100;   // one rendered page per label when {{counter}} is used

/**
 * core = {
 *   CFG: { timezone, dateFormat, timeFormat, threshold },
 *   sharp, log, RestError,
 *   enqueue(opts, pages[{buf, quantity}], ctx) -> job      (validates, queues)
 *   respond(job, body) -> response (200 printed / 202 queued / error)
 *   textCanvas(body) -> { width, height, margins, printDirection, from, lanes?, laneAxis? }
 *   labelLayout() -> designer layout of the roll in the printer (label-size.js) | null
 *   testInfo() -> { label, density }
 *   templates: TemplateStore, history: History, queue: PrintQueue,
 * }
 */
function createFeatures(core) {
  const { CFG, sharp, RestError, templates, history, queue } = core;
  const submit = (opts, pages, ctx, body) => core.respond(core.enqueue(opts, pages, ctx), body || {});

  const phCtx = (extra) => ({
    tz: CFG.timezone || undefined,
    dateFormat: CFG.dateFormat,
    timeFormat: CFG.timeFormat,
    now: new Date(),
    ...extra,
  });

  /** Print options a text/template body may carry (passed to the core). */
  function printOpts(body, canvas, extra = {}) {
    const o = {
      // the rendered image IS the print image: exact size, no refit
      labelWidth: canvas.width,
      labelHeight: canvas.height,
      imageFit: "fill",
      printDirection: canvas.printDirection,
      quantity: 1,
      ...extra,
    };
    for (const k of ["density", "printTask", "labelType", "threshold"]) {
      if (body[k] !== undefined) o[k] = body[k];
    }
    return o;
  }

  const quantityOf = (body, def = 1) => {
    const q = body.quantity === undefined || body.quantity === null || body.quantity === "" ? def : Number(body.quantity);
    if (!Number.isInteger(q) || q < 1 || q > 100) throw new RestError("quantity must be 1-100", 400);
    return q;
  };

  const summaryOf = (spec) => [spec.lines.filter((l) => l.trim()).join(" / "),
    spec.qr ? `[QR ${spec.qr.data.slice(0, 40)}]` : "", spec.barcode ? `[${spec.barcode.type} ${spec.barcode.data}]` : ""]
    .filter(Boolean).join(" ").slice(0, 160);

  /** Labels per printed row: canvas.lanes on a multi-lane roll, else 1. */
  const lanesOf = (canvas) => (canvas.lanes > 1 ? canvas.lanes : 1);
  /** Rows to print for `labels` labels (a row is printed whole). */
  const rowsFor = (labels, canvas) => Math.ceil(labels / lanesOf(canvas));

  /**
   * Render one printed label (= one row on a multi-lane roll). `spec` is one
   * spec (repeated on every lane) or an array with one spec per lane (null
   * = lane left blank).
   */
  async function render(spec, canvas, threshold) {
    try {
      if (canvas.lanes > 1) {
        const specs = Array.isArray(spec) ? spec : new Array(canvas.lanes).fill(spec);
        return await renderLanes(specs, canvas, threshold);
      }
      return await renderText({ ...(Array.isArray(spec) ? spec[0] : spec), _normalized: true }, canvas, { sharp, threshold });
    } catch (e) {
      if (e.status === 400) throw new RestError(e.message, 400);
      throw e;
    }
  }

  /**
   * Multi-lane roll (canvas.lanes from core.textCanvas): lay each label out
   * on its own lane, so the text does not run across the gaps between the
   * labels. specs[i] is lane i's spec (null: blank); the same spec on equal
   * lanes renders once. Lane edges are rounded to whole px; the layout
   * returned is the first filled lane's.
   */
  async function renderLanes(specs, canvas, threshold) {
    const n = canvas.lanes;
    const alongX = canvas.laneAxis === "x";
    const total = alongX ? canvas.width : canvas.height;
    const edge = (i) => Math.round((total * i) / n);
    const tiles = [];
    const done = [];   // [{ spec, size, r }]
    let first = null;
    for (let i = 0; i < n; i++) {
      const spec = specs[i];
      if (!spec) continue;
      const size = edge(i + 1) - edge(i);
      const laneCanvas = { ...canvas, lanes: 1, width: alongX ? size : canvas.width, height: alongX ? canvas.height : size };
      let hit = done.find((d) => d.spec === spec && d.size === size);
      if (!hit) {
        hit = { spec, size, r: await renderText({ ...spec, _normalized: true }, laneCanvas, { sharp, threshold }) };
        done.push(hit);
      }
      if (!first) first = hit.r;
      tiles.push({ input: hit.r.png, left: alongX ? edge(i) : 0, top: alongX ? 0 : edge(i) });
    }
    if (!first) throw new RestError("nothing to print", 400);
    let img = sharp({ create: { width: canvas.width, height: canvas.height, channels: 3, background: "#fff" } })
      .composite(tiles).greyscale();
    if (threshold) img = img.threshold(threshold).toColourspace("b-w");
    const png = await img.png({ compressionLevel: 9 }).toBuffer();
    return { png, layout: first.layout, spec: first.spec };
  }

  function normalize(body) {
    try { return normalizeSpec(body); } catch (e) { throw new RestError(e.message, e.status || 400); }
  }

  // ---- text ---------------------------------------------------------------
  /** Plain text print: built-in placeholders + body.vars, unknown ones stay as typed. */
  function textSpec(body) {
    const spec = normalize(body);
    return ph.applyToSpec(spec, phCtx({ vars: body.vars || {}, strict: false }));
  }

  async function printText(body = {}, ctx = {}) {
    const spec = textSpec(body);
    const quantity = quantityOf(body);
    const canvas = core.textCanvas(body);
    const r = await render(spec, canvas);
    // multi-lane roll: quantity counts labels; a row is printed whole, so a
    // partly used last row is filled with the same text too
    const rows = rowsFor(quantity, canvas);
    const res = await submit(printOpts(body, canvas, { quantity: rows }), [{ buf: r.png, quantity: rows }],
      { ...ctx, kind: "text", summary: summaryOf(spec), final: true }, body);
    return { ...res, layout: layoutInfo(r.layout), size_from: canvas.from, ...laneInfo(canvas, rows) };
  }

  /** Response fields for a multi-lane roll ({} otherwise). */
  const laneInfo = (canvas, rows, blank = 0) => (lanesOf(canvas) > 1
    ? { lanes: lanesOf(canvas), rows, labels: rows * lanesOf(canvas) - blank, ...(blank ? { blank_lanes: blank } : {}) }
    : {});

  async function previewResponse(png, layout, canvas, body) {
    if (body.format === "json") {
      return { image: png.toString("base64"), mime: "image/png", ...layoutInfo(layout), size_from: canvas.from };
    }
    return { raw: png, type: "image/png", headers: { "X-Label-Size": `${canvas.width}x${canvas.height}` } };
  }

  async function previewText(body = {}) {
    const spec = textSpec(body);
    const canvas = core.textCanvas(body);
    const r = await render(spec, canvas, body.threshold || CFG.threshold || 128);
    return previewResponse(r.png, r.layout, canvas, body);
  }

  // ---- templates ------------------------------------------------------------
  function templateSpec(t, vars, counter, strict = true) {
    const spec = normalize(t.layout);
    const ctx = phCtx({ vars: vars || {}, defaults: t.defaults || {}, counter, strict });
    const out = ph.applyToSpec(spec, ctx);
    if (ctx.missing && ctx.missing.size) {
      throw new RestError(`template '${t.name}': missing variable(s): ${[...ctx.missing].join(", ")}`, 400);
    }
    return out;
  }

  function getTemplate(name) {
    try { return templates.get(name); } catch (e) { throw new RestError(e.message, e.status || 400); }
  }

  function templateCanvas(t, body) {
    const p = t.print || {};
    const sizeBody = { ...body };
    if (sizeBody.labelWidth === undefined && p.labelWidth && p.labelHeight) {
      sizeBody.labelWidth = p.labelWidth;
      sizeBody.labelHeight = p.labelHeight;
    }
    return core.textCanvas(sizeBody);
  }

  async function printTemplate(name, body = {}, ctx = {}) {
    getTemplate(name);   // 404 before queueing
    // Rendering + queueing run with the template's counter reserved; the
    // wait for the printer happens outside, so other template prints go on.
    const out = await templates.withCounter(name, async (t) => {
      const p = t.print || {};
      const quantity = quantityOf(body, p.quantity || 1);
      const merged = { ...body, density: body.density ?? p.density };
      const hctx = { ...ctx, kind: "template", template: t.name };

      if (t.type === "image") {
        const opts = { quantity };
        for (const k of ["density", "printTask", "labelType", "threshold", "printDirection"]) {
          if (merged[k] !== undefined) opts[k] = merged[k];
        }
        // made in the designer: print in the direction it was designed for
        if (opts.printDirection === undefined && t.design) opts.printDirection = t.design.label.printDirection;
        const job = core.enqueue(opts, [{ buf: Buffer.from(t.image, "base64"), quantity }],
          { ...hctx, summary: `template ${t.name}`, design: t.design || null });
        return { result: { job, extra: { template: t.name } }, used: 0 };
      }

      const canvas = templateCanvas(t, body);
      const counterUsed = ph.usesCounter(ph.specStrings(normalize(t.layout)));
      const start = t.counter ? t.counter.next : 1;
      const lanes = lanesOf(canvas);
      const rows = rowsFor(quantity, canvas);
      const pages = [];
      let first;
      let blank = 0;
      if (counterUsed) {
        // one number per label: on a multi-lane roll the lanes of a row get
        // consecutive numbers (1 2 3 4 | 5 6 7 8 ...); lanes after the last
        // number stay blank, so no number is used without being printed
        if (quantity > MAX_COUNTER_LABELS) throw new RestError(`max ${MAX_COUNTER_LABELS} numbered labels per print`, 400);
        blank = rows * lanes - quantity;
        for (let row = 0; row < rows; row++) {
          const specs = [];
          for (let l = 0; l < lanes; l++) {
            const i = row * lanes + l;
            specs.push(i < quantity ? templateSpec(t, body.vars, start + i) : null);
          }
          const r = await render(specs, canvas);
          if (!first) first = { r, spec: specs[0] };
          pages.push({ buf: r.png, quantity: 1 });
        }
      } else {
        const spec = templateSpec(t, body.vars, start);
        const r = await render(spec, canvas);
        first = { r, spec };
        pages.push({ buf: r.png, quantity: rows });
      }
      const job = core.enqueue(printOpts(merged, canvas, { quantity: counterUsed ? 1 : rows }), pages,
        { ...hctx, summary: `${t.name}: ${summaryOf(first.spec)}`, final: true });
      return {
        result: {
          job,
          extra: {
            template: t.name, layout: layoutInfo(first.r.layout), size_from: canvas.from,
            ...laneInfo(canvas, rows, blank),
            ...(counterUsed ? { counter_first: start, counter_last: start + quantity - 1 } : {}),
          },
        },
        used: counterUsed ? quantity : 0,
      };
    });
    return { ...(await core.respond(out.job, body)), ...out.extra };
  }

  async function previewTemplate(name, body = {}) {
    const t = getTemplate(name);
    if (t.type === "image") {
      const png = Buffer.from(t.image, "base64");
      if (body.format === "json") return { image: t.image, mime: "image/png", label: t.label || null, warnings: [] };
      return { raw: png, type: "image/png" };
    }
    const canvas = templateCanvas(t, body);
    // preview: missing variables show as their {{name}} instead of failing.
    // The first printed row: on a multi-lane roll with {{counter}}, the next
    // numbers lane by lane (as printTemplate numbers them)
    const next = t.counter ? t.counter.next : 1;
    const counterUsed = ph.usesCounter(ph.specStrings(normalize(t.layout)));
    const spec = counterUsed && lanesOf(canvas) > 1
      ? Array.from({ length: lanesOf(canvas) }, (_, l) => templateSpec(t, body.vars, next + l, false))
      : templateSpec(t, body.vars, next, false);
    const r = await render(spec, canvas, body.threshold || CFG.threshold || 128);
    return previewResponse(r.png, r.layout, canvas, body);
  }

  // ---- history ----------------------------------------------------------------
  function historyEntry(id) {
    const e = id === "last" ? history.last() : history.get(id);
    if (!e) throw new RestError(id === "last" ? "no print in the history yet" : `history entry '${id}' not found`, 404);
    return e;
  }

  async function reprint(id, body = {}, ctx = {}) {
    const e = historyEntry(id);
    if (!e.reprintable) throw new RestError("this print was not stored completely and cannot be reprinted", 409);
    const pages = history.pages(e.id);
    const opts = { ...(e.opts || {}) };
    if (body.density !== undefined) opts.density = body.density;
    if (body.quantity !== undefined) {
      const q = quantityOf(body);
      opts.quantity = q;
      if (pages.length === 1) pages[0].quantity = q;
    }
    const res = await submit(opts, pages, {
      ...ctx, kind: "reprint", template: e.template || null, summary: `reprint: ${e.summary || e.id}`,
      reprint_of: e.id, final: !!e.final, design: history.design(e.id),
    }, body);
    return { ...res, reprint_of: e.id };
  }

  // ---- open in designer -----------------------------------------------------------
  /**
   * Designer document for a printed / template image without a stored design:
   * the image on a label of its size. Direction: the given one, else the
   * roll's designer direction when the size is the roll's, else the option.
   */
  async function imageDoc(png, printDirection, title) {
    const m = await sharp(png).metadata();
    const layout = core.labelLayout ? core.labelLayout() : null;
    const rollSize = layout && layout.width === m.width && layout.height === m.height;
    const dir = printDirection || (rollSize ? layout.printDirection : CFG.printDirection) || "top";
    return designerDoc.imageDesign(png, { width: m.width, height: m.height, printDirection: dir, title, layout });
  }

  async function historyDesign(id) {
    const e = historyEntry(id);
    const d = history.design(e.id);
    if (d) return { source: "design", design: d };
    const page = (history.pages(e.id) || [])[0];
    if (!page) throw new RestError("this print has no stored image", 404);
    return { source: "image", design: await imageDoc(page.buf, e.opts && e.opts.printDirection, e.summary) };
  }

  async function templateDesign(name) {
    let t;
    try { t = templates.get(name); } catch (e) { throw new RestError(e.message, e.status || 400); }
    if (t.type !== "image") throw new RestError("text templates are edited in Quick print, not in the designer", 409);
    if (t.design) return { source: "design", design: t.design };
    return { source: "image", design: await imageDoc(Buffer.from(t.image, "base64"), null, t.name) };
  }

  /** Test label sized to the printed area (border, marks, grid, text sizes). */
  async function testPrint(body = {}, ctx = {}) {
    const canvas = core.textCanvas(body);
    const info = core.testInfo();
    const png = await renderTestPng(canvas, info, sharp);
    if (body.preview) return { raw: png, type: "image/png" };
    const quantity = quantityOf(body);
    const res = await submit(printOpts(body, canvas, { quantity }), [{ buf: png, quantity }],
      { ...ctx, kind: "test", summary: `test label ${canvas.width}x${canvas.height}`, final: true }, body);
    return { ...res, size_from: canvas.from };
  }

  const wrapQueue = (fn) => {
    try { return fn(); } catch (e) { throw new RestError(e.message, e.status || 400); }
  };

  // ---- routes -----------------------------------------------------------------
  const P = (re) => new RegExp(`^${re}$`);
  const routes = [
    ["POST", P("/print/text"), (m, body, ctx) => printText(body, ctx)],
    ["POST", P("/preview/text"), (m, body) => previewText(body)],
    ["GET", P("/templates"), () => ({ templates: templates.list() })],
    ["GET", P("/templates/([^/]+)"), (m) => {
      try { return templates.describe(m[1]); } catch (e) { throw new RestError(e.message, e.status || 400); }
    }],
    ["PUT", P("/templates/([^/]+)"), (m, body) => {
      try { return { message: "saved", template: templates.put(m[1], body) }; } catch (e) {
        throw new RestError(e.message, e.status || 400);
      }
    }],
    ["DELETE", P("/templates/([^/]+)"), (m) => {
      try { return templates.delete(m[1]); } catch (e) { throw new RestError(e.message, e.status || 400); }
    }],
    ["POST", P("/print/template/([^/]+)"), (m, body, ctx) => printTemplate(m[1], body, ctx)],
    ["POST", P("/preview/template/([^/]+)"), (m, body) => previewTemplate(m[1], body)],
    ["GET", P("/history"), () => ({ entries: history.list(), max: history.max })],
    ["DELETE", P("/history"), () => { history.clear(); return { message: "history cleared" }; }],
    ["GET", P("/history/([a-z0-9]+)/thumb\\.png"), (m) => {
      const png = history.thumb(m[1]);
      if (!png) throw new RestError("not found", 404);
      return { raw: png, type: "image/png" };
    }],
    ["GET", P("/history/([a-z0-9]+)/(\\d+)\\.png"), (m) => {
      const e = historyEntry(m[1]);
      const p = (history.pages(e.id) || [])[Number(m[2])];
      if (!p) throw new RestError("not found", 404);
      return { raw: p.buf, type: "image/png" };
    }],
    ["POST", P("/history/([a-z0-9]+)/reprint"), (m, body, ctx) => reprint(m[1], body, ctx)],
    ["GET", P("/history/([a-z0-9]+)/design"), (m) => historyDesign(m[1])],
    ["GET", P("/templates/([^/]+)/design"), (m) => templateDesign(m[1])],
    ["GET", P("/queue"), () => ({ jobs: queue.list(), ...queue.summary() })],
    ["DELETE", P("/queue"), () => queue.clear()],
    ["DELETE", P("/queue/([a-z0-9]+)"), (m) => wrapQueue(() => queue.cancel(m[1]))],
    ["POST", P("/queue/([a-z0-9]+)/retry"), (m) => wrapQueue(() => queue.retry(m[1]))],
    ["POST", P("/test"), (m, body, ctx) => testPrint(body, ctx)],
  ];

  /** Match "METHOD /path" -> { handler, params } (params URL-decoded). */
  function match(method, url) {
    for (const [mth, re, fn] of routes) {
      if (mth !== method) continue;
      const m = url.match(re);
      if (!m) continue;
      let params;
      try { params = m.map((s) => (s === undefined ? s : decodeURIComponent(s))); } catch (_) {
        throw new RestError("bad URL encoding", 400);
      }
      return (body, ctx) => fn(params, body, ctx);
    }
    return null;
  }

  return { match, printText, previewText, printTemplate, previewTemplate, reprint, testPrint };
}

module.exports = { createFeatures };
