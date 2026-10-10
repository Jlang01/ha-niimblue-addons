"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { lib } = require("./helpers");

const ph = lib("placeholders.js");

// 2026-03-29 00:30 UTC = 01:30 CET, the night Europe/Berlin switches to CEST
const NOW = new Date("2026-03-29T00:30:00Z");
const ctx = (extra) => ({ now: NOW, tz: "Europe/Berlin", ...extra });

test("variables, defaults, untouched unknowns (lenient)", () => {
  assert.equal(ph.substitute("Hi {{name}}!", ctx({ vars: { name: "Ana" } })), "Hi Ana!");
  assert.equal(ph.substitute("{{ name }}", ctx({ defaults: { name: "Bo" } })), "Bo");
  assert.equal(ph.substitute("{{x}} {{name}}", ctx({ vars: { name: 1 } })), "{{x}} 1");
  assert.equal(ph.substitute("no braces", ctx()), "no braces");
  assert.equal(ph.substitute("{{ not a var }}", ctx()), "{{ not a var }}");
});

test("strict mode collects missing variables", () => {
  const c = ctx({ strict: true, vars: { a: "1" } });
  ph.substitute("{{a}} {{b}} {{c}} {{counter}}", c);
  assert.deepEqual([...c.missing].sort(), ["b", "c", "counter"]);
});

test("date / time / datetime in the configured time zone", () => {
  assert.equal(ph.substitute("{{date}}", ctx()), "2026-03-29");
  assert.equal(ph.substitute("{{time}}", ctx()), "01:30");
  assert.equal(ph.substitute("{{datetime}}", ctx()), "2026-03-29 01:30");
  assert.equal(ph.substitute("{{date}}", ctx({ tz: "America/New_York" })), "2026-03-28");
  assert.equal(ph.substitute("{{date}}", ctx({ dateFormat: "DD.MM.YYYY" })), "29.03.2026");
  assert.equal(ph.substitute("{{date:D.M.YY}} {{time:HH:mm:ss}}", ctx()), "29.3.26 01:30:00");
});

test("date offsets (days, weeks, months, years), DST-safe", () => {
  assert.equal(ph.substitute("{{date+7}}", ctx()), "2026-04-05");
  assert.equal(ph.substitute("{{date-1}}", ctx()), "2026-03-28");
  assert.equal(ph.substitute("{{date+2w:DD.MM.}}", ctx()), "12.04.");
  assert.equal(ph.substitute("{{date+3m}}", ctx()), "2026-06-29");
  assert.equal(ph.substitute("{{date+1y}}", ctx()), "2027-03-29");
  assert.equal(ph.substitute("{{time+45}}", ctx()), "02:15");
  assert.equal(ph.substitute("{{time+30m}}", ctx()), "02:00");
  assert.equal(ph.substitute("{{datetime+2h}}", ctx()), "2026-03-29 03:30");
});

test("bad time zone falls back instead of throwing", () => {
  assert.match(ph.substitute("{{date}}", ctx({ tz: "Mars/Olympus" })), /^\d{4}-\d{2}-\d{2}$/);
});

test("counter with zero padding", () => {
  assert.equal(ph.substitute("#{{counter}}", ctx({ counter: 7 })), "#7");
  assert.equal(ph.substitute("#{{counter:4}}", ctx({ counter: 7 })), "#0007");
  assert.equal(ph.substitute("#{{counter}}", ctx()), "#{{counter}}");   // no counter outside templates
});

test("listVariables / usesCounter ignore built-ins", () => {
  const strs = ["{{name}} {{date+3}}", "{{counter:3}} {{weight}} {{name}}", "{{time:HH}}"];
  assert.deepEqual(ph.listVariables(strs), ["name", "weight"]);
  assert.equal(ph.usesCounter(strs), true);
  assert.equal(ph.usesCounter(["{{date}}"]), false);
});

test("applyToSpec substitutes lines, QR and barcode data", () => {
  const spec = { lines: ["{{a}}"], qr: { data: "q-{{a}}", ec: "M" }, barcode: { type: "code128", data: "B{{counter:3}}" } };
  const out = ph.applyToSpec(spec, ctx({ vars: { a: "X" }, counter: 5 }));
  assert.deepEqual(out.lines, ["X"]);
  assert.equal(out.qr.data, "q-X");
  assert.equal(out.barcode.data, "B005");
  assert.equal(spec.lines[0], "{{a}}", "input not mutated");
});
