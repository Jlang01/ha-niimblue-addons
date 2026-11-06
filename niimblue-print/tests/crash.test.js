"use strict";
// Crash bookkeeping (lib/crash.js) and run.sh's crash-loop handling:
// backoff, crash reason in the log, ONE Home Assistant notification, and an
// add-on stop that does not wait out the backoff.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { LIB, lib, tmpDir } = require("./helpers");

const crash = lib("crash.js");
const ROOT = path.resolve(__dirname, "..");
const RUN_SH = path.join(ROOT, "rootfs/run.sh");

test("crash: record/read round trip, message and stack trimmed", () => {
  const dir = tmpDir("crash");
  assert.equal(crash.read(dir), null);
  const e = new Error("x".repeat(800));
  crash.record(dir, e, { version: "9.9.9", now: new Date("2026-11-06T10:00:00Z") });
  const raw = JSON.parse(fs.readFileSync(crash.crashFile(dir), "utf8"));
  assert.equal(raw.at_epoch, Date.parse("2026-11-06T10:00:00Z") / 1000);
  assert.equal(raw.message.length, 500);
  assert.ok(raw.stack.split("\n").length <= 12);
  assert.deepEqual(crash.read(dir), { at: "2026-11-06T10:00:00.000Z", message: "x".repeat(500), version: "9.9.9" });
  crash.record(dir, "plain string");
  assert.equal(crash.read(dir).message, "plain string");
});

test("crash: fatal handler logs, records and exits 1 on an exception thrown in a callback", () => {
  const dir = tmpDir("fatal");
  const script = `
    const crash = require(${JSON.stringify(path.join(LIB, "crash.js"))});
    crash.installFatalHandler({ dataDir: ${JSON.stringify(dir)}, version: "1.2.3" });
    setImmediate(() => { throw new TypeError("util.isError is not a function"); });
    setTimeout(() => {}, 5000);`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FATAL: uncaught exception, server exits: TypeError: util\.isError is not a function/);
  const rec = crash.read(dir);
  assert.equal(rec.message, "util.isError is not a function");
  assert.equal(rec.version, "1.2.3");
});

test("crash: recovery check dismisses the crash-loop notification and clears the flag", async () => {
  const dir = tmpDir("recover");
  const dismissed = [];
  // no flag: nothing to dismiss
  crash.scheduleRecoveryCheck({ dataDir: dir, afterMs: 5, dismiss: async (id) => dismissed.push(id) });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(dismissed, []);
  fs.writeFileSync(crash.loopFlag(dir), "");
  crash.scheduleRecoveryCheck({ dataDir: dir, afterMs: 5, dismiss: async (id) => dismissed.push(id) });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(dismissed, [crash.LOOP_NOTIFICATION_ID]);
  assert.equal(fs.existsSync(crash.loopFlag(dir)), false);
  // dismiss failing: flag kept for the next start
  fs.writeFileSync(crash.loopFlag(dir), "");
  crash.scheduleRecoveryCheck({ dataDir: dir, afterMs: 5, dismiss: async () => { throw new Error("HA down"); } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fs.existsSync(crash.loopFlag(dir)), true);
});

const haveTools = ["bash", "jq", "curl"].every((t) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0);

test("run.sh: crash loop backs off, logs the reason, notifies HA once, stops promptly", { skip: !haveTools && "needs bash, jq, curl", timeout: 30000 }, async () => {
  const dir = tmpDir("runsh");
  fs.writeFileSync(path.join(dir, "options.json"), JSON.stringify({ notifications: true }));
  // fake print server: dies at once the way the real one does (fatal handler)
  const fake = path.join(dir, "fake-server.js");
  fs.writeFileSync(fake, `
    const crash = require(${JSON.stringify(path.join(LIB, "crash.js"))});
    crash.installFatalHandler({ dataDir: process.env.DATA_DIR, version: "test" });
    setImmediate(() => { throw new Error("boom-test"); });
    setTimeout(() => {}, 5000);`);
  // fake Supervisor: records persistent_notification calls
  const calls = [];
  const sup = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
      res.end("[]");
    });
  });
  await new Promise((r) => sup.listen(0, "127.0.0.1", r));
  const out = [];
  const child = spawn("bash", [RUN_SH], {
    env: {
      ...process.env,
      NIIMBLUE_DATA: dir,
      NIIMBLUE_CONFIG_JS: path.join(dir, "config.js"),
      NIIMBLUE_SERVER: fake,
      NIIMBLUE_NO_NGINX: "1",
      NIIMBLUE_RESTART_BASE_S: "1",
      NIIMBLUE_NOTIFY_AFTER: "3",
      SUPERVISOR_URL: `http://127.0.0.1:${sup.address().port}`,
      SUPERVISOR_TOKEN: "test-token",
    },
  });
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  const text = () => out.join("");
  try {
    const deadline = Date.now() + 20000;
    while (!/notified about the crash loop/.test(text()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.match(text(), /notified about the crash loop/, text());
    // backoff doubles: 1 s, 2 s, then 4 s after the 3rd quick crash
    assert.match(text(), /exited \(code 1 after \d+s: boom-test\), quick crash #1 in a row, restarting in 1s/);
    assert.match(text(), /quick crash #2 in a row, restarting in 2s/);
    assert.match(text(), /quick crash #3 in a row, restarting in 4s/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/core/api/services/persistent_notification/create");
    assert.equal(calls[0].auth, "Bearer test-token");
    assert.equal(calls[0].body.notification_id, crash.LOOP_NOTIFICATION_ID);
    assert.match(calls[0].body.message, /Last error: boom-test/);
    assert.ok(fs.existsSync(crash.loopFlag(dir)));
    // add-on stop during the 4 s backoff: run.sh exits right away
    const t0 = Date.now();
    const exited = new Promise((r) => child.on("exit", r));
    child.kill("SIGTERM");
    await exited;
    assert.ok(Date.now() - t0 < 2000, `stop took ${Date.now() - t0} ms`);
    assert.match(text(), /Stopped\./);
  } finally {
    child.kill("SIGKILL");
    sup.close();
  }
});

test("versions in sync: config.yaml, lib package.json, package-lock, CHANGELOG top entry", () => {
  const cfg = fs.readFileSync(path.join(ROOT, "config.yaml"), "utf8").match(/^version:\s*"?([^"\s]+)"?/m)[1];
  const pkg = require(path.join(LIB, "package.json")).version;
  const lock = require(path.join(LIB, "package-lock.json"));
  const top = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8").match(/^## (\S+)/m)[1];
  assert.equal(pkg, cfg, "lib package.json version (shown in the log, /diag) must match config.yaml");
  assert.equal(lock.version, cfg);
  assert.equal(lock.packages[""].version, cfg);
  assert.equal(top, cfg, "CHANGELOG.md needs an entry for the new version");
});
