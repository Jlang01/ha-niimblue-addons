"use strict";
/* Crash bookkeeping, shared with run.sh:
 *
 *   last-crash.json      written synchronously by the fatal handler right
 *                        before the process dies: { at, at_epoch, message,
 *                        stack, version, pid }. run.sh reads `message` for
 *                        its log line and the crash-loop notification; the
 *                        next server start reports it on /status + /diag.
 *   crash-loop-notified  flag file run.sh creates when it raised the HA
 *                        "print server keeps crashing" notification. A server
 *                        that then stays up for a while dismisses it again.
 *
 * Must not depend on anything that could itself fail to load (only fs/path):
 * it is installed before the rest of the server is required.
 */
const fs = require("fs");
const path = require("path");

const CRASH_FILE = "last-crash.json";
const LOOP_FLAG = "crash-loop-notified";
const LOOP_NOTIFICATION_ID = "niimblue_crash_loop";
const STACK_LINES = 12;

const crashFile = (dataDir) => path.join(dataDir, CRASH_FILE);
const loopFlag = (dataDir) => path.join(dataDir, LOOP_FLAG);

function errText(e) {
  if (e instanceof Error) return e.message || e.name || String(e);
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch (_) { return String(e); }
}

/** Write the crash record (sync: the process is about to exit). Never throws. */
function record(dataDir, err, { version = null, now = new Date() } = {}) {
  const rec = {
    at: now.toISOString(),
    at_epoch: Math.floor(now.getTime() / 1000),
    message: errText(err).slice(0, 500),
    stack: err && err.stack ? String(err.stack).split("\n").slice(0, STACK_LINES).join("\n") : null,
    version,
    pid: process.pid,
  };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${crashFile(dataDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 1));
    fs.renameSync(tmp, crashFile(dataDir));
  } catch (_) { /* best effort: the log line still has it */ }
  return rec;
}

/** The last recorded crash, or null. */
function read(dataDir) {
  try {
    const r = JSON.parse(fs.readFileSync(crashFile(dataDir), "utf8"));
    return r && r.at ? { at: r.at, message: r.message || null, version: r.version || null } : null;
  } catch (_) {
    return null;
  }
}

/**
 * Last-resort handler: an exception nobody caught (typically thrown inside a
 * native socket callback, where no try/catch of ours can reach) leaves the
 * process in an unknown state. Log it clearly, record it, exit non-zero;
 * run.sh restarts the server (with backoff) and the queue survives in /data.
 */
function installFatalHandler({ dataDir, version = () => null, log = (m) => console.error(m), exit = (c) => process.exit(c) }) {
  let dying = false;
  const handler = (err) => {
    if (dying) return;   // a second throw while we are exiting
    dying = true;
    const v = typeof version === "function" ? version() : version;
    try { log(`FATAL: uncaught exception, server exits: ${err && err.stack ? err.stack : errText(err)}`); } catch (_) { /* stdout gone */ }
    record(dataDir, err, { version: v });
    exit(1);
  };
  process.on("uncaughtException", handler);
  return handler;
}

/**
 * After the server has been up for `afterMs`, take back run.sh's crash-loop
 * notification (if it raised one): the problem went away.
 */
function scheduleRecoveryCheck({ dataDir, afterMs, dismiss, log = () => {} }) {
  const t = setTimeout(async () => {
    if (!fs.existsSync(loopFlag(dataDir))) return;
    try {
      await dismiss(LOOP_NOTIFICATION_ID);
      fs.rmSync(loopFlag(dataDir), { force: true });
      log(`up for ${Math.round(afterMs / 60000)} min without crashing: crash-loop notification dismissed`);
    } catch (e) {
      log(`could not dismiss the crash-loop notification: ${errText(e)}`);
    }
  }, afterMs);
  if (t.unref) t.unref();
  return t;
}

module.exports = {
  CRASH_FILE, LOOP_FLAG, LOOP_NOTIFICATION_ID,
  crashFile, loopFlag, record, read, installFatalHandler, scheduleRecoveryCheck,
};
