"use strict";
/* Print history: the last N print jobs with the images that were (or would
 * have been) sent, so any of them can be printed again.
 *
 *   /data/history/index.json   { version, entries: [newest first] }
 *   /data/history/<id>-<n>.png pages (final 1-bit images when the job got
 *                              that far, else the submitted input image)
 *   /data/history/<id>-thumb.png
 *
 * Entry: { id, at, source, via, template, summary, ok, error, quantity,
 *          copies, label: {name, width_px, height_px}, final, pages:
 *          [{file, quantity}], opts: {print options needed for a reprint} }
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { writeJsonAtomic, readJson } = require("./persist");

const MAX_PAGES_STORED = 100;
const THUMB_MAX = 256;

class History {
  constructor(dir, { max = 20, sharp, log = () => {} } = {}) {
    this.dir = dir;
    this.max = max;
    this.sharp = sharp;
    this.log = log;
    this.entries = [];
    this.load();
  }

  get indexFile() { return path.join(this.dir, "index.json"); }

  load() {
    const d = readJson(this.indexFile, null, this.log);
    if (d && Array.isArray(d.entries)) this.entries = d.entries.filter((e) => e && e.id && Array.isArray(e.pages));
  }

  save() {
    writeJsonAtomic(this.indexFile, { version: 1, entries: this.entries });
  }

  list() { return this.entries.map((e) => ({ ...e, thumb: `history/${e.id}/thumb.png` })); }

  get(id) { return this.entries.find((e) => e.id === id) || null; }

  last() { return this.entries[0] || null; }

  /**
   * Record a job. pages = [{ png: Buffer, quantity? }]. The entry is in the
   * list when this returns (synchronously, before the first await); the
   * thumbnail follows. Never throws (history must not break printing).
   */
  async add(info, pages) {
    let entry = null;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
      const kept = pages.slice(0, MAX_PAGES_STORED);
      const files = kept.map((p, i) => {
        const file = `${id}-${i}.png`;
        fs.writeFileSync(path.join(this.dir, file), p.png);
        return { file, quantity: p.quantity ?? null };
      });
      entry = {
        id,
        at: new Date().toISOString(),
        ...info,
        pages: files,
        pages_total: pages.length,
        reprintable: files.length > 0 && files.length === pages.length,
      };
      this.entries.unshift(entry);
      for (const old of this.entries.splice(this.max)) this.removeFiles(old);
      this.save();
      if (kept[0] && this.sharp) {
        const thumb = await this.sharp(kept[0].png)
          .resize(THUMB_MAX, THUMB_MAX, { fit: "inside", withoutEnlargement: true })
          .png().toBuffer();
        if (this.get(id)) fs.writeFileSync(path.join(this.dir, `${id}-thumb.png`), thumb);
      }
      return entry;
    } catch (e) {
      this.log(`history: could not record print: ${e.message}`);
      return entry;
    }
  }

  /** Newest entry recorded for a queue job. */
  byJob(jobId) { return this.entries.find((e) => e.job_id === jobId) || null; }

  /** Update fields of an entry (e.g. the outcome of a job that finished later). */
  update(id, fields) {
    const e = this.get(id);
    if (!e) return;
    Object.assign(e, fields);
    try { this.save(); } catch (err) { this.log(`history: save failed: ${err.message}`); }
  }

  removeFiles(entry) {
    for (const f of [...(entry.pages || []).map((p) => p.file), `${entry.id}-thumb.png`]) {
      try { fs.rmSync(path.join(this.dir, f), { force: true }); } catch (_) { /* gone */ }
    }
  }

  /** Page images of an entry: [{ buf, quantity }]. */
  pages(id) {
    const e = this.get(id);
    if (!e) return null;
    return e.pages.map((p) => ({ buf: fs.readFileSync(path.join(this.dir, p.file)), quantity: p.quantity }));
  }

  thumb(id) {
    if (!/^[a-z0-9]+$/.test(id) || !this.get(id)) return null;
    const f = path.join(this.dir, `${id}-thumb.png`);
    if (fs.existsSync(f)) return fs.readFileSync(f);
    // thumbnail still being made: the first page will do
    const e = this.get(id);
    const p = e.pages[0] && path.join(this.dir, e.pages[0].file);
    return p && fs.existsSync(p) ? fs.readFileSync(p) : null;
  }

  clear() {
    for (const e of this.entries) this.removeFiles(e);
    this.entries = [];
    this.save();
  }
}

module.exports = { History, MAX_PAGES_STORED };
