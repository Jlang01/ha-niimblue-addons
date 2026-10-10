"use strict";
/* Test-only preload: `node -r tests/fake-printer.js print-server.js`.
 *
 * Swaps niimbluelib's serial/BLE clients and niimblue-node's printImages for
 * fakes, so the whole server (REST, queue, text, templates, history,
 * warnings, MQTT) runs end to end without a printer. Nothing is sent
 * anywhere; every "printed" page is logged (and described in $FAKE_PRINT_DIR).
 *
 * Behaviour switches = files in $FAKE_CTRL_DIR (checked on every call):
 *   offline       connect() fails ("Device not found")
 *   lid_open      heartbeat says lid open, print fails with PrintError 1
 *   drop_mid_job  the link drops after the first page started
 * Env: FAKE_RFID_REMAINING (150), FAKE_BATTERY (80)
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");

const OUT = process.env.FAKE_PRINT_DIR || "";
const CTRL = process.env.FAKE_CTRL_DIR || "";
const flag = (name) => !!CTRL && fs.existsSync(path.join(CTRL, name));
let printed = 0;

class FakePrintError extends Error {
  constructor(message, reasonId) { super(message); this.reasonId = reasonId; }
}

class FakeClient {
  constructor() { this.connected = false; this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  off(ev, fn) { this.handlers[ev] = (this.handlers[ev] || []).filter((f) => f !== fn); }
  emit(ev, e) { (this.handlers[ev] || []).forEach((f) => f(e)); }
  setPort(p) { this.port = p; }
  setAddress(a) { this.port = a; }
  async connect() {
    if (flag("offline")) throw new Error("Device not found");
    this.connected = true;
    this.emit("rfidinfofetched", { info: this.getRfidInfo() });
    return {};
  }
  async disconnect() {
    const was = this.connected;
    this.connected = false;
    if (was) this.emit("disconnect", {});
  }
  isConnected() { return this.connected; }
  getPrinterInfo() {
    return { batteryPercents: Number(process.env.FAKE_BATTERY || 80), serial: "C2BF926031720", softwareVersion: "5.18",
      hardwareVersion: "4.10", protocolVersion: 4, modelId: 776 };
  }
  getModelMetadata() {
    return { model: "B21S_C2B", dpi: 203, printheadPixels: 384, printDirection: "top", densityMin: 1, densityMax: 5,
      densityDefault: 3, paperTypes: [1, 2, 5] };
  }
  getHeartbeatData() { return flag("lid_open") ? { lidClosed: false, paperInserted: true } : { lidClosed: true, paperInserted: true }; }
  getPrintTaskType() { return "D110"; }
  getRfidInfo() {
    const remaining = Number(process.env.FAKE_RFID_REMAINING || 150);
    return { labelRfidInfo: { tagPresent: true, barCode: "10262260", uuid: "fake-uuid-1", serialNumber: "S1",
      allPaper: 230, usedPaper: 230 - remaining, consumablesType: 1 } };
  }
  async fetchRfidInfo() { return this.getRfidInfo(); }
}

const realLoad = Module._load;
Module._load = function (request) {
  const real = realLoad.apply(this, arguments);
  if (request === "@mmote/niimbluelib" && real && real.NiimbotNodeSerialClient && !real.__fake) {
    return { ...real, NiimbotNodeSerialClient: FakeClient, NiimbotNodeBleClient: FakeClient, __fake: true };
  }
  if (request === "./" && real && real.printImages && !real.__fake) {
    return {
      ...real,
      __fake: true,
      printImages: async (client, task, pages, opts) => {
        if (flag("lid_open")) throw new FakePrintError("Print error 1: CoverOpen", 1);
        let n = 0;
        for (const p of pages) {
          client.emit("packetsent", { packet: { command: 3 } });   // PageStart
          if (flag("drop_mid_job") && n === 0) {
            await client.disconnect();
            throw new Error("Not connected");
          }
          n++;
          printed++;
          const enc = p.encoded;
          console.log(`[fake-printer] page ${printed}: task ${task}, ${enc.cols}x${enc.rows}, ` +
            `qty ${p.quantity ?? opts.quantity}, density ${opts.density}, labelType ${opts.labelType}`);
          if (OUT) fs.writeFileSync(path.join(OUT, `printed-${printed}.json`), JSON.stringify({ task, cols: enc.cols, rows: enc.rows, quantity: p.quantity ?? opts.quantity, density: opts.density }));
        }
      },
    };
  }
  return real;
};
