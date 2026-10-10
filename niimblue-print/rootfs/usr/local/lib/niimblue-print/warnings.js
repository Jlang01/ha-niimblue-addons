"use strict";
/* Low labels / low battery warnings.
 *
 * Each condition raises ONE Home Assistant persistent notification and then
 * stays quiet until it resets:
 *   labels low : remaining < threshold. Resets when a different roll is
 *                detected (RFID uuid/serial/barcode) or remaining rises
 *                back to >= threshold; the notification is dismissed then.
 *   battery low: battery < 20 %. Resets at >= 25 % (hysteresis, so a value
 *                flickering around 20 does not spam).
 * State survives restarts in /data/warnings.json. The flags are also exposed
 * in /status (`warnings`) for the MQTT "Labels low" binary sensor.
 */
const { writeJsonAtomic, readJson } = require("./persist");

const BATTERY_LOW = 20;
const BATTERY_OK = 25;
const IDS = { labels: "niimblue_labels_low", battery: "niimblue_battery_low" };

class Warnings {
  /**
   * opts = { file, labelThreshold, notify: bool, notifier: { create(id, title, msg), dismiss(id) }, log }
   */
  constructor(opts) {
    this.file = opts.file;
    this.labelThreshold = opts.labelThreshold ?? 20;
    this.notifyEnabled = opts.notify !== false;
    this.notifier = opts.notifier;
    this.log = opts.log || (() => {});
    this.st = { labels: { key: null, notified: false }, battery: { notified: false } };
    this.flags = { labels_low: false, battery_low: false };
    const d = readJson(this.file, {}, this.log) || {};
    if (d.labels) this.st.labels = { ...this.st.labels, ...d.labels };
    if (d.battery) this.st.battery = { ...this.st.battery, ...d.battery };
  }

  save() {
    try { writeJsonAtomic(this.file, this.st); } catch (e) { this.log(`warnings: save failed: ${e.message}`); }
  }

  send(kind, on, title, message) {
    if (!this.notifyEnabled || !this.notifier) return Promise.resolve();
    // sequential, so a dismiss + create for the same id keep their order
    this.chain = (this.chain || Promise.resolve()).then(() =>
      (on ? this.notifier.create(IDS[kind], title, message) : this.notifier.dismiss(IDS[kind])))
      .catch((e) => this.log(`warnings: notification ${on ? "create" : "dismiss"} failed: ${e.message}`));
    return this.chain;
  }

  /**
   * Feed the current state. label = { key, name, remaining, total } | null,
   * battery = number | null. Returns the flags. Notifications are sent in
   * the background (never throws).
   */
  update({ label, battery }) {
    const jobs = [];
    let changed = false;

    // --- labels -------------------------------------------------------
    const L = this.st.labels;
    const thr = this.labelThreshold;
    const remaining = label && Number.isFinite(label.remaining) ? label.remaining : null;
    const low = thr > 0 && remaining !== null && remaining < thr;
    this.flags.labels_low = low;
    if (label && label.key && L.key !== label.key) {
      // another roll: a pending warning belongs to the old one
      if (L.notified) { jobs.push(this.send("labels", false)); L.notified = false; }
      L.key = label.key;
      changed = true;
    }
    if (low && !L.notified) {
      L.notified = true;
      changed = true;
      this.log(`labels low: ${remaining} left on ${label.name || "the roll"}`);
      jobs.push(this.send("labels", true, "Label printer: labels running low",
        `Only ${remaining} label${remaining === 1 ? "" : "s"} left on the ${label.name || "label"} roll` +
        `${label.total ? ` (of ${label.total})` : ""}. Time to get a new roll.`));
    } else if (!low && remaining !== null && L.notified) {
      L.notified = false;
      changed = true;
      jobs.push(this.send("labels", false));
    }

    // --- battery ------------------------------------------------------
    const B = this.st.battery;
    if (Number.isFinite(battery)) {
      this.flags.battery_low = battery < BATTERY_LOW;
      if (battery < BATTERY_LOW && !B.notified) {
        B.notified = true;
        changed = true;
        this.log(`battery low: ${battery} %`);
        jobs.push(this.send("battery", true, "Label printer: battery low",
          `The label printer's battery is at ${battery} %. Charge it soon.`));
      } else if (battery >= BATTERY_OK && B.notified) {
        B.notified = false;
        changed = true;
        jobs.push(this.send("battery", false));
      }
    }
    if (changed) this.save();
    this.pending = Promise.all(jobs);
    return { ...this.flags };
  }

  status() {
    return {
      ...this.flags,
      low_label_threshold: this.labelThreshold,
      battery_low_below: BATTERY_LOW,
      notifications: this.notifyEnabled,
    };
  }
}

/** Notifier backed by HA's persistent_notification service. */
function haNotifier(supervisor) {
  return {
    create: (id, title, message) => supervisor.callService("persistent_notification", "create",
      { notification_id: id, title, message }),
    dismiss: (id) => supervisor.callService("persistent_notification", "dismiss", { notification_id: id }),
  };
}

module.exports = { Warnings, haNotifier, BATTERY_LOW, BATTERY_OK, IDS };
