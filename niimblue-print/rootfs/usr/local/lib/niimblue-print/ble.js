"use strict";
/* Bluetooth LE helpers on noble (the same instance niimbluelib uses, with its
 * BlueZ D-Bus binding, so HA's own Bluetooth keeps working):
 *
 *   - adapter state (poweredOn / poweredOff / unauthorized / unsupported ...)
 *   - scan(ms): nearby devices with name, address and RSSI
 *   - a passive "watch" while print jobs wait: listens to advertisements and
 *     calls onSeen() as soon as the printer advertises (switched on / back in
 *     range), so the queue prints within seconds instead of on the next poll
 *
 * All noble calls are guarded: a missing D-Bus socket or adapter must never
 * take the server down. The caller must stop watching before niimbluelib
 * connects (its own discovery start/stop would fight ours).
 */

class Ble {
  /**
   * noble: lazily resolved noble instance (function returning it), so noble
   * is only initialised when Bluetooth is actually used.
   * opts = { log, looksLikePrinter(name), onState(state) }
   */
  constructor(getNoble, opts = {}) {
    this.getNoble = getNoble;
    this.log = opts.log || (() => {});
    this.looksLikePrinter = opts.looksLikePrinter || (() => false);
    this.onState = opts.onState || (() => {});
    this.noble = null;
    this.watching = null;      // { match, onSeen }
    this.lastSeen = new Map(); // address -> { name, rssi, at }
  }

  init() {
    if (this.noble) return this.noble;
    if (this.initError) throw this.initError;
    const noble = this.getNoble();
    // Start noble's binding NOW, inside try: noble otherwise starts it on the
    // next tick, where a throw (no dbus-next, no bus) would crash the server.
    try {
      void noble.state;
    } catch (e) {
      this.initError = new Error(`Bluetooth unavailable: ${e.message || e}`);
      this.log(this.initError.message);
      this.onState("unsupported");
      throw this.initError;
    }
    noble.on("stateChange", (s) => {
      this.log(`Bluetooth adapter: ${s}`);
      this.onState(s);
      if (s === "poweredOn" && this.watching) this.startScan();
    });
    noble.on("discover", (p) => this.onDiscover(p));
    noble.on("warning", (w) => this.log(`noble: ${w}`));
    this.noble = noble;
    return noble;
  }

  get state() {
    try { return this.noble ? this.noble.state : "not initialised"; } catch (_) { return "unknown"; }
  }

  onDiscover(p) {
    const name = (p.advertisement && p.advertisement.localName) || "";
    const info = { address: p.address, name: name || null, rssi: Number.isFinite(p.rssi) ? p.rssi : null, at: new Date().toISOString() };
    if (p.address) this.lastSeen.set(p.address.toLowerCase(), info);
    if (this.scanSink) this.scanSink(info);
    const w = this.watching;
    if (!w) return;
    if (w.match(info)) {
      const now = Date.now();
      if (now - (w.lastFire || 0) < 5000) return;   // adverts repeat: kick at most every 5 s
      w.lastFire = now;
      w.onSeen(info);
    }
  }

  /** RSSI of an address from the last advertisement, or null. */
  rssiOf(address) {
    const s = address && this.lastSeen.get(String(address).toLowerCase());
    return s ? { rssi: s.rssi, at: s.at } : null;
  }

  async startScan() {
    try {
      const n = this.init();
      if (n.state !== "poweredOn") await n.waitForPoweredOnAsync(5000);
      await n.startScanningAsync([], true);   // duplicates: keep RSSI fresh
    } catch (e) {
      this.log(`Bluetooth scan not started: ${e.message || e}`);
    }
  }

  async stopScan() {
    try { if (this.noble) await this.noble.stopScanningAsync(); } catch (_) { /* not scanning */ }
  }

  /** Listen for the printer's advertisements. match(info) -> bool. */
  async watch(match, onSeen) {
    const was = !!this.watching;
    this.watching = { match, onSeen, lastFire: 0 };
    if (!was) {
      this.log("waiting for the printer's Bluetooth advertisement ...");
      await this.startScan();
    }
  }

  async unwatch() {
    if (!this.watching) return;
    this.watching = null;
    await this.stopScan();
  }

  /** Active scan for `ms`: [{ address, name, rssi, likely_printer }], printers first. */
  async scan(ms = 8000) {
    const n = this.init();
    if (n.state !== "poweredOn") await n.waitForPoweredOnAsync(5000);
    const found = new Map();
    this.scanSink = (info) => {
      const prev = found.get(info.address);
      found.set(info.address, { ...prev, ...info, name: info.name || (prev && prev.name) || null });
    };
    try {
      await n.startScanningAsync([], true);
      await new Promise((r) => setTimeout(r, ms));
    } finally {
      this.scanSink = null;
      if (!this.watching) await this.stopScan();
    }
    return [...found.values()]
      .map((d) => ({ ...d, likely_printer: this.looksLikePrinter(d.name) }))
      .sort((a, b) => (b.likely_printer - a.likely_printer) || ((b.rssi ?? -999) - (a.rssi ?? -999)));
  }
}

module.exports = { Ble };
