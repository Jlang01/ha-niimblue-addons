"use strict";
/* {{placeholder}} substitution for text labels and templates.
 *
 *   {{name}}                 a variable (request `vars`, else template `defaults`)
 *   {{date}} {{time}} {{datetime}}   now, in the configured time zone
 *   {{date+7}} {{date-1}}    date offset in days (also +2w, +3m(onths), +1y)
 *   {{time+30m}} {{datetime+2h}}     offset in minutes / hours / days
 *   {{date:DD.MM.YYYY}}      own format (tokens YYYY YY MM M DD D HH H mm ss)
 *   {{counter}} {{counter:4}}         template counter (zero-padded to 4)
 *
 * Unknown variables: strict mode (templates) reports them as missing;
 * lenient mode (plain /print/text) leaves the text as it is.
 */

class PlaceholderError extends Error {
  constructor(message, missing = []) { super(message); this.status = 400; this.missing = missing; }
}

const RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const DATE_RE = /^(date|time|datetime)\s*(?:([+-])\s*(\d{1,5})\s*([dwmyh]|min)?)?\s*(?::\s*(.+))?$/i;
const COUNTER_RE = /^counter\s*(?::\s*(\d{1,2}))?$/i;
const VAR_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const BUILTINS = ["date", "time", "datetime", "counter"];

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** Wall-clock parts of `date` in time zone `tz` (undefined = process TZ). */
function zonedParts(date, tz) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz || undefined, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch (_) {
    fmt = new Intl.DateTimeFormat("en-GB", {   // bad tz name: fall back to the process zone
      hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return { Y: +p.year, M: +p.month, D: +p.day, h: +p.hour % 24, m: +p.minute, s: +p.second };
}

function formatParts(p, fmt) {
  const map = {
    YYYY: String(p.Y), YY: pad(p.Y % 100), MM: pad(p.M), M: String(p.M), DD: pad(p.D), D: String(p.D),
    HH: pad(p.h), H: String(p.h), mm: pad(p.m), ss: pad(p.s),
  };
  return fmt.replace(/YYYY|YY|MM|M|DD|D|HH|H|mm|ss/g, (t) => map[t]);
}

/** Calendar arithmetic on wall-clock parts (DST-safe for day/month/year). */
function shift(p, sign, amount, unit) {
  const n = sign === "-" ? -amount : amount;
  const d = new Date(Date.UTC(p.Y, p.M - 1, p.D, p.h, p.m, p.s));
  switch (unit) {
    case "w": d.setUTCDate(d.getUTCDate() + 7 * n); break;
    case "m": d.setUTCMonth(d.getUTCMonth() + n); break;
    case "y": d.setUTCFullYear(d.getUTCFullYear() + n); break;
    case "h": d.setUTCHours(d.getUTCHours() + n); break;
    case "min": d.setUTCMinutes(d.getUTCMinutes() + n); break;
    default: d.setUTCDate(d.getUTCDate() + n);
  }
  return { Y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, D: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() };
}

/**
 * ctx = { vars, defaults, now: Date, tz, dateFormat, timeFormat, counter: number|null, strict }
 * Returns the substituted string; collects unknown names into ctx.missing (Set).
 */
function substitute(str, ctx = {}) {
  if (typeof str !== "string" || !str.includes("{{")) return str;
  const vars = ctx.vars || {};
  const defaults = ctx.defaults || {};
  const dateFormat = ctx.dateFormat || "YYYY-MM-DD";
  const timeFormat = ctx.timeFormat || "HH:mm";
  return str.replace(RE, (whole, key) => {
    const dm = key.match(DATE_RE);
    if (dm) {
      const [, kind, sign, amount, unitRaw, fmt] = dm;
      let p = zonedParts(ctx.now || new Date(), ctx.tz);
      if (sign) {
        let unit = (unitRaw || "").toLowerCase();
        if (!unit) unit = kind.toLowerCase() === "time" ? "min" : "d";
        if (unit === "m" && kind.toLowerCase() === "time") unit = "min";   // {{time+30m}} = minutes
        p = shift(p, sign, Number(amount), unit);
      }
      const k = kind.toLowerCase();
      const f = fmt || (k === "date" ? dateFormat : k === "time" ? timeFormat : `${dateFormat} ${timeFormat}`);
      return formatParts(p, f);
    }
    const cm = key.match(COUNTER_RE);
    if (cm) {
      if (ctx.counter === null || ctx.counter === undefined) {
        if (ctx.strict) (ctx.missing ||= new Set()).add("counter");
        return whole;
      }
      return cm[1] ? pad(ctx.counter, Number(cm[1])) : String(ctx.counter);
    }
    if (VAR_RE.test(key)) {
      if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== null && vars[key] !== undefined) return String(vars[key]);
      if (Object.prototype.hasOwnProperty.call(defaults, key) && defaults[key] !== null && defaults[key] !== undefined) return String(defaults[key]);
      if (ctx.strict) (ctx.missing ||= new Set()).add(key);
    }
    return whole;
  });
}

/** Variable names used in strings (built-ins excluded), in order of appearance. */
function listVariables(strings) {
  const out = [];
  for (const s of strings) {
    if (typeof s !== "string") continue;
    for (const m of s.matchAll(RE)) {
      const key = m[1];
      if (DATE_RE.test(key) || COUNTER_RE.test(key) || !VAR_RE.test(key)) continue;
      if (!out.includes(key)) out.push(key);
    }
  }
  return out;
}

const usesCounter = (strings) => strings.some((s) => typeof s === "string" && [...s.matchAll(RE)].some((m) => COUNTER_RE.test(m[1])));

/** All placeholder-capable strings of a normalized text spec. */
function specStrings(spec) {
  return [...(spec.lines || []), spec.qr && spec.qr.data, spec.barcode && spec.barcode.data].filter((s) => typeof s === "string");
}

/** Substitute every text field of a normalized spec; returns a new spec. */
function applyToSpec(spec, ctx) {
  const sub = (s) => substitute(s, ctx);
  return {
    ...spec,
    lines: spec.lines.map(sub),
    qr: spec.qr ? { ...spec.qr, data: sub(spec.qr.data) } : null,
    barcode: spec.barcode ? { ...spec.barcode, data: sub(spec.barcode.data) } : null,
  };
}

module.exports = {
  substitute, listVariables, usesCounter, specStrings, applyToSpec, zonedParts, formatParts,
  PlaceholderError, BUILTINS,
};
