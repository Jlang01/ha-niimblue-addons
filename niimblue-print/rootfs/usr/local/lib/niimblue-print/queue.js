"use strict";
/* Persistent print queue: /data/queue
 *
 * Every print becomes a job; jobs print strictly in order, one at a time,
 * and survive restarts. While the printer is off / asleep / out of range the
 * queue waits and retries with backoff (5 s -> 60 s); kick() retries at once
 * (printer advertisement seen, USB plugged in, adapter back, new job, ...).
 *
 *   index.json   { version, jobs: [...] }   active + recently failed jobs
 *   <id>-<n>.png page images (input or rendered; finished at print time)
 *
 * Job: { id, created_at, updated_at, state, source, kind, template, summary,
 *        opts, final, pages: [{file, quantity}], attempts, last_error,
 *        error_state, started_at, finished_at, history_id }
 * state: queued | printing | done | failed | expired | cancelled
 *
 * The runner (print-server) returns for each attempt:
 *   { action: "done", info, finals }    printed (finals = images sent, for history)
 *   { action: "requeue", message }      printer unreachable: wait + retry
 *   { action: "requeue_once", message } unknown pre-print error: retry, max 3x
 *   { action: "pause", state, message } printer needs a person: wait + retry
 *   { action: "fail", state, message }  give up (manual retry)
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { writeJsonAtomic, readJson } = require("./persist");

const TERMINAL = ["done", "failed", "expired", "cancelled"];
const BACKOFF_MIN_MS = 5000;
const BACKOFF_MAX_MS = 60000;
const PAUSE_RETRY_MS = 15000;
const MAX_ATTEMPTS = 3;
const KEEP_FINISHED = 30;   // failed/expired jobs kept for retry / inspection

class PrintQueue {
  /**
   * opts = { log, maxAgeHours, onChange(queue), onTerminal(job, pages, final), onIdle(),
   *          backoff: {min, max}, pauseMs }
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.log = opts.log || (() => {});
    this.maxAgeMs = Math.max(0, Number(opts.maxAgeHours ?? 24)) * 3600 * 1000;
    this.onChange = opts.onChange || (() => {});
    this.onTerminal = opts.onTerminal || (() => {});
    this.onIdle = opts.onIdle || null;
    this.backoffMin = (opts.backoff && opts.backoff.min) || BACKOFF_MIN_MS;
    this.backoffMax = (opts.backoff && opts.backoff.max) || BACKOFF_MAX_MS;
    this.pauseMs = opts.pauseMs || PAUSE_RETRY_MS;
    this.jobs = [];
    this.waiters = new Map();     // id -> [resolve]
    this.runner = null;
    this.running = false;
    this.delay = 0;
    this.wakeTimer = null;
    this.wake = null;
    this.blocked = null;          // { state, message, since } while waiting for the printer
    this.load();
  }

  get indexFile() { return path.join(this.dir, "index.json"); }

  load() {
    const d = readJson(this.indexFile, null, this.log);
    if (d && Array.isArray(d.jobs)) this.jobs = d.jobs.filter((j) => j && j.id && Array.isArray(j.pages));
    // a job that was printing when the server died: if no page had started
    // (it was still connecting) it simply waits again; otherwise we cannot
    // know how far it got -> failed, manual retry (never print a label twice)
    for (const j of this.jobs) {
      if (j.state === "printing" && !j.page_started) {
        Object.assign(j, { state: "queued", attempts: Math.max(0, (j.attempts || 1) - 1) });
      } else if (j.state === "printing") {
        Object.assign(j, { state: "failed", error_state: "interrupted", finished_at: new Date().toISOString(),
          last_error: "the print server restarted while this job was printing; check the printer, then retry" });
      }
    }
    if (this.jobs.length) this.save();
  }

  save() {
    try {
      writeJsonAtomic(this.indexFile, { version: 1, jobs: this.jobs });
    } catch (e) {
      this.log(`queue: save failed: ${e.message}`);
    }
  }

  changed() {
    this.save();
    try { this.onChange(this); } catch (_) { /* observer */ }
  }

  /** Add a job. pages: [{ buf: PNG, quantity }]. Returns the job. */
  add(info, pages) {
    fs.mkdirSync(this.dir, { recursive: true });
    const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
    const files = pages.map((p, i) => {
      const file = `${id}-${i}.png`;
      fs.writeFileSync(path.join(this.dir, file), p.buf);
      return { file, quantity: p.quantity ?? null };
    });
    const now = new Date().toISOString();
    const job = {
      id, created_at: now, updated_at: now, state: "queued",
      source: info.source || "rest", kind: info.kind || "image", template: info.template || null,
      summary: info.summary || null, reprint_of: info.reprint_of || null,
      opts: info.opts || {}, final: !!info.final, pages: files,
      attempts: 0, last_error: null, error_state: null,
    };
    this.jobs.push(job);
    this.changed();
    this.kick();
    return job;
  }

  get(id) { return this.jobs.find((j) => j.id === id) || null; }

  list() { return this.jobs.map((j) => ({ ...j })); }

  pending() { return this.jobs.filter((j) => j.state === "queued" || j.state === "printing"); }

  pages(job) {
    return job.pages.map((p) => ({ buf: fs.readFileSync(path.join(this.dir, p.file)), quantity: p.quantity }));
  }

  summary() {
    const by = (s) => this.jobs.filter((j) => j.state === s).length;
    const q = this.jobs.filter((j) => j.state === "queued");
    return {
      length: by("queued") + by("printing"),
      queued: by("queued"),
      printing: by("printing"),
      failed: by("failed"),
      expired: by("expired"),
      oldest_at: q.length ? q[0].created_at : null,
      blocked: this.blocked,
    };
  }

  removeFiles(job) {
    for (const p of job.pages || []) { try { fs.rmSync(path.join(this.dir, p.file), { force: true }); } catch (_) { /* gone */ } }
  }

  /** The printer got the first page of this job: from now on no automatic retry. */
  markStarted(job) {
    if (job.page_started) return;
    job.page_started = true;
    this.save();
  }

  /** Wait until the job is finished or `timeoutMs` passed. -> { job, finished } */
  wait(id, timeoutMs) {
    const job = this.get(id);
    if (!job) return Promise.resolve({ job: null, finished: true });
    if (TERMINAL.includes(job.state)) return Promise.resolve({ job: { ...job }, finished: true });
    return new Promise((resolve) => {
      const list = this.waiters.get(id) || [];
      const done = (j) => { clearTimeout(t); resolve({ job: j, finished: true }); };
      const t = setTimeout(() => {
        const l = this.waiters.get(id) || [];
        this.waiters.set(id, l.filter((f) => f !== done));
        const cur = this.get(id);
        resolve({ job: cur ? { ...cur } : null, finished: false });
      }, Math.max(0, timeoutMs));
      list.push(done);
      this.waiters.set(id, list);
    });
  }

  /** End a job. `finals` = the images that went to the printer (if any). */
  finish(job, state, fields = {}, finals = null) {
    Object.assign(job, fields, { state, updated_at: new Date().toISOString(), finished_at: new Date().toISOString() });
    let pages = [];
    try { pages = this.pages(job); } catch (_) { /* files gone */ }
    try { this.onTerminal(job, finals || pages, !!finals); } catch (e) { this.log(`queue: onTerminal: ${e.message}`); }
    const snapshot = { ...job };
    for (const r of this.waiters.get(job.id) || []) r(snapshot);
    this.waiters.delete(job.id);
    if (state === "done" || state === "cancelled") {
      this.jobs = this.jobs.filter((j) => j !== job);
      this.removeFiles(job);
    }
    // cap kept failed/expired jobs
    const old = this.jobs.filter((j) => TERMINAL.includes(j.state));
    for (const j of old.slice(0, Math.max(0, old.length - KEEP_FINISHED))) {
      this.jobs = this.jobs.filter((x) => x !== j);
      this.removeFiles(j);
    }
    this.changed();
  }

  /** Cancel a queued / failed / expired job (not one that is printing). */
  cancel(id) {
    const job = this.get(id);
    if (!job) { const e = new Error(`job '${id}' not found`); e.status = 404; throw e; }
    if (job.state === "printing") { const e = new Error("job is printing right now and cannot be cancelled"); e.status = 409; throw e; }
    if (TERMINAL.includes(job.state)) {
      this.jobs = this.jobs.filter((j) => j !== job);
      this.removeFiles(job);
      this.changed();
      return { message: `job ${id} removed` };
    }
    this.finish(job, "cancelled", { last_error: "cancelled" });
    return { message: `job ${id} cancelled` };
  }

  /** Put a failed / expired job back in the queue (at its original place). */
  retry(id) {
    const job = this.get(id);
    if (!job) { const e = new Error(`job '${id}' not found`); e.status = 404; throw e; }
    if (!["failed", "expired"].includes(job.state)) {
      const e = new Error(`job is ${job.state}; only failed or expired jobs can be retried`); e.status = 409; throw e;
    }
    Object.assign(job, { state: "queued", attempts: 0, error_state: null, finished_at: null, page_started: false,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    // re-dated, so it is not expired at once; keep queue order by moving it to the end
    this.jobs = [...this.jobs.filter((j) => j !== job), job];
    this.changed();
    this.kick();
    return { message: `job ${id} queued again`, job: { ...job } };
  }

  /** Remove everything that is not printing right now. */
  clear() {
    let n = 0;
    for (const j of [...this.jobs]) {
      if (j.state === "printing") continue;
      n++;
      if (TERMINAL.includes(j.state)) { this.jobs = this.jobs.filter((x) => x !== j); this.removeFiles(j); } else this.finish(j, "cancelled", { last_error: "queue cleared" });
    }
    this.changed();
    return { message: `${n} job(s) removed` };
  }

  /** Expire queued jobs older than maxAge. Returns the expired jobs. */
  expire(now = Date.now()) {
    if (!this.maxAgeMs) return [];
    const out = [];
    for (const j of [...this.jobs]) {
      if (j.state !== "queued") continue;
      if (now - Date.parse(j.created_at) > this.maxAgeMs) {
        this.finish(j, "expired", { last_error: `not printed within ${Math.round(this.maxAgeMs / 3600000)} h (${j.last_error || "printer unreachable"})` });
        out.push(j);
      }
    }
    return out;
  }

  // ---- worker -------------------------------------------------------------
  /** runner(job) -> outcome (see header). Starts the worker loop. */
  start(runner) {
    this.runner = runner;
    this.loop();
    this.expiryTimer = setInterval(() => this.expire(), 60000);
    if (this.expiryTimer.unref) this.expiryTimer.unref();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.expiryTimer);
    this.kick();
  }

  /** Retry now (skips the current backoff wait). */
  kick() {
    this.delay = 0;
    if (this.wake) this.wake();
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(t); this.wake = null; resolve(); };
    });
  }

  async loop() {
    if (this.running) return;
    this.running = true;
    while (!this.stopped) {
      this.expire();
      const job = this.jobs.find((j) => j.state === "queued");
      if (!job) {
        if (this.blocked) { this.blocked = null; this.changed(); }
        // queue drained after printing: let the server release the printer
        if (this.onIdle && this.ranSinceIdle) {
          this.ranSinceIdle = false;
          try { await this.onIdle(); } catch (_) { /* best effort */ }
        }
        await this.sleep(3600 * 1000);   // until add()/kick()
        continue;
      }
      Object.assign(job, { state: "printing", started_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      job.attempts++;
      this.ranSinceIdle = true;
      this.changed();
      let out;
      try {
        out = await this.runner(job);
      } catch (e) {
        out = { action: "requeue_once", state: "error", message: e.message || String(e) };
      }
      if (this.stopped && out.action !== "done") {
        // shutting down mid-attempt: leave it queued for the next start
        Object.assign(job, { state: "queued", attempts: Math.max(0, job.attempts - 1) });
        this.save();
        break;
      }
      if (out.action === "done") {
        this.blocked = null;
        this.delay = 0;
        this.finish(job, "done", { last_error: null, error_state: null, ...(out.info || {}) }, out.finals || null);
        continue;
      }
      if (out.action === "fail" || (out.action === "requeue_once" && job.attempts >= MAX_ATTEMPTS)) {
        this.finish(job, "failed", { last_error: out.message, error_state: out.state || "error" }, out.finals || null);
        continue;
      }
      // wait and retry: back in the queue, keeping its place
      let wait;
      if (out.action === "pause") {
        wait = this.pauseMs;
        job.attempts = Math.max(0, job.attempts - 1);   // the printer said no: nothing was tried
      } else {
        if (out.action === "requeue") job.attempts = Math.max(0, job.attempts - 1);   // unreachable: does not count
        this.delay = this.delay ? Math.min(this.backoffMax, this.delay * 2) : this.backoffMin;
        wait = this.delay;
      }
      Object.assign(job, { state: "queued", last_error: out.message, error_state: out.state || null, updated_at: new Date().toISOString() });
      this.blocked = { state: out.state || "waiting", message: out.message, since: (this.blocked && this.blocked.since) || new Date().toISOString(), retry_in_s: Math.round(wait / 1000) };
      this.changed();
      await this.sleep(wait);
    }
    this.running = false;
  }
}

module.exports = { PrintQueue, TERMINAL, MAX_ATTEMPTS, BACKOFF_MIN_MS, BACKOFF_MAX_MS };
