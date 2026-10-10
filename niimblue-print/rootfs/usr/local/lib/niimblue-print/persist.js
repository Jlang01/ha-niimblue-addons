"use strict";
/* Small JSON persistence helpers for /data (labels, queue, history,
 * templates, warnings):
 *   writeJsonAtomic: tmp file + fsync + rename (+ dir fsync), so a power cut
 *                    leaves either the old or the new file, never half a file
 *   readJson:        missing -> fallback; unreadable/corrupt -> the file is
 *                    renamed to <name>.bad (kept for inspection, not silently
 *                    overwritten) and the fallback is used
 */
const fs = require("fs");
const path = require("path");

function writeJsonAtomic(file, obj, pretty = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const data = typeof obj === "string" ? obj : JSON.stringify(obj, null, pretty);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dfd = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch (_) { /* directory fsync not supported: fine */ }
}

function readJson(file, fallback, log = () => {}) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") log(`${file} unreadable (${e.message}), using defaults`);
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const bad = `${file}.bad`;
    try { fs.renameSync(file, bad); } catch (_) { /* keep going */ }
    log(`${file} is corrupt (${e.message}); moved to ${path.basename(bad)}, starting fresh`);
    return fallback;
  }
}

module.exports = { writeJsonAtomic, readJson };
