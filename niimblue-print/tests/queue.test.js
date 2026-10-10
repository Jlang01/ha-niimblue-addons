"use strict";
// Print queue (order, retry/backoff, pause, fail-after-start, restart,
// expiry, waiters) and the printer error classification.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { lib, tmpDir } = require("./helpers");

const { PrintQueue } = lib("queue.js");
const { classify, heartbeatBlock } = lib("printer-errors.js");

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const mk = (dir, opts = {}) => new PrintQueue(dir, { backoff: { min: 20, max: 80 }, pauseMs: 30, ...opts });
const page = () => [{ buf: PNG, quantity: 1 }];

test("classify: printer conditions pause, link errors requeue, anything after PageStart fails", () => {
  const pe = (id) => Object.assign(new Error(`Print error ${id}`), { reasonId: id });
  assert.equal(classify(pe(1)).action, "pause");
  assert.equal(classify(pe(1)).state, "lid_open");
  assert.equal(classify(pe(2)).state, "no_labels");
  assert.equal(classify(pe(1), { started: true }).action, "fail");
  assert.equal(classify(pe(6)).action, "fail");                         // data error: permanent
  assert.equal(classify(new Error("Device not found")).action, "requeue");
  assert.equal(classify(new Error("Timeout waiting response")).action, "requeue");
  const mid = classify(new Error("Not connected"), { started: true });
  assert.equal(mid.action, "fail");
  assert.equal(mid.state, "interrupted");
  assert.equal(classify(new Error("weird")).action, "requeue_once");
  assert.equal(heartbeatBlock({ lidClosed: false }).state, "lid_open");
  assert.equal(heartbeatBlock({ lidClosed: true, paperInserted: false }).state, "no_labels");
  assert.equal(heartbeatBlock({ lidClosed: true, paperInserted: true }), null);
  assert.equal(heartbeatBlock({}), null);
});

test("queue: strict order, unreachable printer waits (attempts not counted), then prints", async () => {
  const q = mk(tmpDir("q1"));
  const printed = [];
  let online = false;
  const a = q.add({ summary: "a" }, page());
  const b = q.add({ summary: "b" }, page());
  q.start(async (job) => {
    if (!online) return { action: "requeue", state: "unreachable", message: "Device not found" };
    printed.push(job.summary);
    return { action: "done" };
  });
  const w = await q.wait(a.id, 100);
  assert.equal(w.finished, false);
  assert.equal(q.summary().blocked.state, "unreachable");
  assert.equal(q.get(a.id).attempts, 0);
  online = true;
  q.kick();
  const r = await q.wait(b.id, 2000);
  assert.equal(r.finished, true);
  assert.equal(r.job.state, "done");
  assert.deepEqual(printed, ["a", "b"]);
  assert.equal(q.list().length, 0, "done jobs leave the queue");
  assert.equal(q.summary().blocked, null);
  q.stop();
});

test("queue: pause keeps the job, fail is final, retry re-queues, requeue_once gives up after 3", async () => {
  const q = mk(tmpDir("q2"));
  let mode = "pause";
  let calls = 0;
  q.start(async () => {
    calls++;
    if (mode === "pause") return { action: "pause", state: "lid_open", message: "lid open" };
    if (mode === "fail") return { action: "fail", state: "interrupted", message: "half printed" };
    if (mode === "weird") return { action: "requeue_once", state: "error", message: "weird" };
    return { action: "done" };
  });
  const j = q.add({}, page());
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(q.get(j.id).state, "queued");
  assert.equal(q.get(j.id).error_state, "lid_open");
  mode = "fail";
  const r = await q.wait(j.id, 2000);
  assert.equal(r.job.state, "failed");
  const n = calls;
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(calls, n, "failed job is not retried by itself");
  mode = "ok";
  q.retry(j.id);
  assert.equal((await q.wait(j.id, 2000)).job.state, "done");
  mode = "weird";
  const k = q.add({}, page());
  const rk = await q.wait(k.id, 3000);
  assert.equal(rk.job.state, "failed");
  assert.equal(rk.job.attempts, 3);
  assert.throws(() => q.retry("nope"), (e) => e.status === 404);
  q.stop();
});

test("queue: survives a restart; only a job whose page had started becomes failed", () => {
  const dir = tmpDir("q3");
  const q = mk(dir);
  const a = q.add({ summary: "waiting" }, page());
  const b = q.add({ summary: "was printing" }, page());
  const c = q.add({ summary: "was connecting" }, page());
  q.get(b.id).state = "printing";
  q.markStarted(q.get(b.id));
  q.get(c.id).state = "printing";
  q.save();
  const q2 = mk(dir);
  assert.equal(q2.get(a.id).state, "queued");
  assert.equal(q2.get(b.id).state, "failed");
  assert.equal(q2.get(b.id).error_state, "interrupted");
  assert.equal(q2.get(c.id).state, "queued");
  assert.deepEqual(q2.pending().map((j) => j.id), [a.id, c.id]);
  assert.equal(q2.pages(q2.get(a.id))[0].buf.length, PNG.length);
});

test("queue: expiry, cancel, clear, corrupt index quarantined", async () => {
  const dir = tmpDir("q4");
  const ended = [];
  const q = mk(dir, { maxAgeHours: 1, onTerminal: (j) => ended.push(j.state) });
  const old = q.add({}, page());
  q.get(old.id).created_at = new Date(Date.now() - 2 * 3600e3).toISOString();
  const expired = q.expire();
  assert.equal(expired.length, 1);
  assert.equal(q.get(old.id).state, "expired");
  const c = q.add({}, page());
  q.cancel(c.id);
  assert.equal(q.get(c.id), null);
  assert.ok(!fs.existsSync(path.join(dir, `${c.id}-0.png`)));
  q.add({}, page());
  q.clear();
  assert.equal(q.list().length, 0);
  assert.deepEqual(ended, ["expired", "cancelled", "cancelled"]);
  fs.writeFileSync(path.join(dir, "index.json"), "{broken");
  const q2 = mk(dir);
  assert.equal(q2.list().length, 0);
  assert.ok(fs.existsSync(path.join(dir, "index.json.bad")));
});
