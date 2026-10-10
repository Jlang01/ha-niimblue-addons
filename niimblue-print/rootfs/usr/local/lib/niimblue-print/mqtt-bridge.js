"use strict";
/* MQTT: Home Assistant discovery, printer state, and print commands.
 *
 * Replaces 1.2's mqtt-discovery.sh (same topics and unique_ids, so existing
 * entities and their history stay). Broker credentials come from the
 * Mosquitto add-on via the Supervisor services API; MQTT_HOST/MQTT_PORT/
 * MQTT_USER/MQTT_PASSWORD override that (tests, external brokers).
 *
 * Topics (prefix niimblue/):
 *   availability            online/offline (retained; Last Will = offline)
 *   state                   GET /status JSON
 *   cmd/reconnect           button
 *   cmd/quick_print         button: print the quick text
 *   cmd/reprint_last        button: reprint the newest history entry
 *   cmd/clear_queue         button: drop all waiting print jobs
 *   cmd/test_print          button: print the built-in test label
 *   cmd/scan                button: scan for printers -> scan/result
 *   quick/text[/set]        text entity "Quick print text" (retained)
 *   quick/wrap[/set]        switch "Quick print wrap" (retained ON/OFF)
 *   print                   JSON like POST /print/text, or plain text
 *   print/template          JSON {name, vars, quantity}
 *   print/result            outcome of every MQTT-triggered print (not retained)
 */
const fs = require("fs");
const path = require("path");
const mqtt = require("mqtt");
const supervisor = require("./supervisor");

const P = "niimblue";
const T = {
  avail: `${P}/availability`,
  state: `${P}/state`,
  reconnect: `${P}/cmd/reconnect`,
  quickPrint: `${P}/cmd/quick_print`,
  reprintLast: `${P}/cmd/reprint_last`,
  clearQueue: `${P}/cmd/clear_queue`,
  testPrint: `${P}/cmd/test_print`,
  scan: `${P}/cmd/scan`,
  scanResult: `${P}/scan/result`,
  quickText: `${P}/quick/text`,
  quickTextSet: `${P}/quick/text/set`,
  quickWrap: `${P}/quick/wrap`,
  quickWrapSet: `${P}/quick/wrap/set`,
  print: `${P}/print`,
  printTemplate: `${P}/print/template`,
  result: `${P}/print/result`,
  haStatus: "homeassistant/status",
};
const QUICK_MAX = 255;   // HA text entity state limit

/** Discovery configs: [topic, payload]. Exported for tests. */
function discoveryConfigs(model) {
  // model = the printer's real model (B21S_C2B, ...) once one was connected
  const dev = { identifiers: ["niimblue_print"], name: "NiimBlue Printer", manufacturer: "NIIMBOT", model: model || "NIIMBOT label printer" };
  const base = { availability_topic: T.avail, device: dev };
  const d = (component, id, cfg) => [`homeassistant/${component}/niimblue/${id}/config`, { ...cfg, ...base }];
  return [
    // --- unchanged from 1.2 (mqtt-discovery.sh) ---
    d("binary_sensor", "connected", {
      name: "Connected", unique_id: "niimblue_connected", device_class: "connectivity",
      state_topic: T.state, value_template: "{{ 'ON' if value_json.connected else 'OFF' }}",
    }),
    d("sensor", "status", {
      name: "Status", unique_id: "niimblue_status", icon: "mdi:printer-pos-cog",
      state_topic: T.state, value_template: "{{ value_json.status }}", json_attributes_topic: T.state,
    }),
    d("sensor", "battery", {
      name: "Battery", unique_id: "niimblue_battery", device_class: "battery", unit_of_measurement: "%",
      state_class: "measurement", entity_category: "diagnostic",
      state_topic: T.state, value_template: "{{ value_json.battery }}",
    }),
    d("sensor", "label", {
      name: "Label", unique_id: "niimblue_label", icon: "mdi:label-outline", state_topic: T.state,
      value_template: "{% set l = value_json.label %}{% if not l %}None{% elif l.name %}{{ l.name }}" +
        "{% elif l.width_mm %}{{ l.width_mm }}x{{ l.height_mm }} mm{% else %}{{ l.barcode }}{% endif %}",
      json_attributes_topic: T.state, json_attributes_template: "{{ (value_json.label or {}) | tojson }}",
    }),
    d("sensor", "labels_remaining", {
      name: "Labels remaining", unique_id: "niimblue_labels_remaining", icon: "mdi:label-multiple-outline",
      unit_of_measurement: "labels", state_class: "measurement", state_topic: T.state,
      value_template: "{{ value_json.label.remaining if value_json.label and value_json.label.remaining is not none else None }}",
    }),
    d("button", "reconnect", {
      name: "Reconnect", unique_id: "niimblue_reconnect", command_topic: T.reconnect, entity_category: "config",
    }),
    // --- new in 1.3 ---
    d("binary_sensor", "labels_low", {
      name: "Labels low", unique_id: "niimblue_labels_low", device_class: "problem", icon: "mdi:label-off-outline",
      state_topic: T.state,
      value_template: "{{ 'ON' if value_json.warnings is defined and value_json.warnings.labels_low else 'OFF' }}",
    }),
    d("text", "quick_text", {
      name: "Quick print text", unique_id: "niimblue_quick_text", icon: "mdi:form-textbox",
      command_topic: T.quickTextSet, state_topic: T.quickText, min: 0, max: QUICK_MAX, mode: "text",
    }),
    d("switch", "quick_wrap", {
      name: "Quick print wrap", unique_id: "niimblue_quick_wrap", icon: "mdi:wrap",
      command_topic: T.quickWrapSet, state_topic: T.quickWrap, payload_on: "ON", payload_off: "OFF",
    }),
    d("button", "quick_print", {
      name: "Quick print", unique_id: "niimblue_quick_print", icon: "mdi:printer", command_topic: T.quickPrint,
    }),
    d("button", "reprint_last", {
      name: "Reprint last", unique_id: "niimblue_reprint_last", icon: "mdi:history",
      command_topic: T.reprintLast,
    }),
    d("sensor", "queue_length", {
      name: "Queue length", unique_id: "niimblue_queue_length", icon: "mdi:tray-full",
      unit_of_measurement: "jobs", state_class: "measurement", state_topic: T.state,
      value_template: "{{ value_json.queue.length if value_json.queue else 0 }}",
      json_attributes_topic: T.state, json_attributes_template: "{{ (value_json.queue or {}) | tojson }}",
    }),
    d("button", "clear_queue", {
      name: "Clear queue", unique_id: "niimblue_clear_queue", icon: "mdi:tray-remove", command_topic: T.clearQueue,
    }),
    d("sensor", "rssi", {
      name: "Signal strength", unique_id: "niimblue_rssi", device_class: "signal_strength",
      unit_of_measurement: "dBm", state_class: "measurement", entity_category: "diagnostic",
      state_topic: T.state, value_template: "{{ value_json.rssi if value_json.rssi is not none else None }}",
    }),
    d("sensor", "firmware", {
      name: "Firmware", unique_id: "niimblue_firmware", icon: "mdi:chip", entity_category: "diagnostic",
      state_topic: T.state,
      value_template: "{{ value_json.printer.firmware if value_json.printer and value_json.printer.firmware else None }}",
      json_attributes_topic: T.state, json_attributes_template: "{{ (value_json.printer or {}) | tojson }}",
    }),
    d("button", "test_print", {
      name: "Test print", unique_id: "niimblue_test_print", icon: "mdi:printer-check", command_topic: T.testPrint,
      entity_category: "diagnostic",
    }),
    d("button", "scan", {
      name: "Scan", unique_id: "niimblue_scan", icon: "mdi:bluetooth-audio", command_topic: T.scan,
      entity_category: "diagnostic",
    }),
    d("sensor", "nearby_printers", {
      name: "Nearby printers", unique_id: "niimblue_nearby_printers", icon: "mdi:printer-search",
      entity_category: "diagnostic", state_topic: T.scanResult,
      value_template: "{{ (value_json.ble | count) + (value_json.usb | count) }}",
      json_attributes_topic: T.scanResult,
    }),
  ];
}

/** Quick-print text as typed in HA: a literal "\n" is a line break. */
const quickLines = (text) => String(text || "").replace(/\\n/g, "\n");

/** Parse a niimblue/print payload: JSON object, or plain text. */
function parsePrintPayload(payload) {
  const s = payload.toString("utf8").trim();
  if (!s) throw Object.assign(new Error("empty payload"), { status: 400 });
  if (s.startsWith("{")) {
    try { return JSON.parse(s); } catch (e) { throw Object.assign(new Error(`invalid JSON: ${e.message}`), { status: 400 }); }
  }
  return { text: quickLines(s) };
}

class MqttBridge {
  /**
   * opts = { log, getModel(), intervalS, quickFile, getStatus(), handlers: {
   *   reconnect(), printText(body, ctx), printTemplate(name, body, ctx), reprintLast(ctx),
   *   clearQueue(), testPrint(ctx), scan() } }
   */
  constructor(opts) {
    this.o = opts;
    this.log = opts.log || console.log;
    this.client = null;
    this.timer = null;
    this.stopped = false;
    this.lastState = null;
    this.quick = { text: "", wrap: false };
    try {
      const q = JSON.parse(fs.readFileSync(opts.quickFile, "utf8"));
      this.quick = { text: String(q.text || "").slice(0, QUICK_MAX), wrap: !!q.wrap };
    } catch (_) { /* defaults */ }
  }

  saveQuick() {
    try {
      fs.mkdirSync(path.dirname(this.o.quickFile), { recursive: true });
      fs.writeFileSync(this.o.quickFile, JSON.stringify(this.quick));
    } catch (e) { this.log(`quick print state not saved: ${e.message}`); }
  }

  async credentials() {
    const e = process.env;
    if (e.MQTT_HOST) {
      return { host: e.MQTT_HOST, port: Number(e.MQTT_PORT || 1883), username: e.MQTT_USER || "", password: e.MQTT_PASSWORD || "", ssl: false };
    }
    for (let attempt = 1; !this.stopped; attempt++) {
      try {
        return await supervisor.mqttService();
      } catch (err) {
        // Supervisor/Mosquitto may still be starting: retry fast for a minute, then slowly
        if (attempt <= 6 || attempt % 10 === 0) this.log(`MQTT service lookup failed (attempt ${attempt}): ${err.message}`);
        await new Promise((r) => setTimeout(r, attempt <= 6 ? 10000 : 60000));
      }
    }
    return null;
  }

  async start() {
    const c = await this.credentials();
    if (!c || this.stopped) return;
    const url = `${c.ssl ? "mqtts" : "mqtt"}://${c.host}:${c.port}`;
    this.log(`MQTT broker: ${c.host}:${c.port}`);
    this.client = mqtt.connect(url, {
      username: c.username || undefined,
      password: c.password || undefined,
      clientId: `niimblue_print_${Math.random().toString(16).slice(2, 8)}`,
      keepalive: 30,
      reconnectPeriod: 5000,
      will: { topic: T.avail, payload: "offline", retain: true, qos: 1 },
    });
    this.client.on("connect", () => this.onConnect());
    this.client.on("message", (topic, payload) => { this.onMessage(topic, payload); });
    this.client.on("error", (e) => this.log(`MQTT error: ${e.message}`));
    let wasOffline = false;
    this.client.on("offline", () => { if (!wasOffline) this.log("MQTT offline, reconnecting ..."); wasOffline = true; });
    this.client.on("connect", () => { wasOffline = false; });
    this.timer = setInterval(() => this.publishState(true), Math.max(3, this.o.intervalS || 10) * 1000);
  }

  pub(topic, payload, retain = false) {
    if (!this.client || !this.client.connected) return;
    const s = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.client.publish(topic, s, { retain, qos: 0 });
  }

  publishDiscovery() {
    this.model = this.o.getModel ? this.o.getModel() : null;
    for (const [topic, cfg] of discoveryConfigs(this.model)) this.pub(topic, cfg, true);
    this.pub(T.avail, "online", true);
    this.pub(T.quickText, this.quick.text, true);
    this.pub(T.quickWrap, this.quick.wrap ? "ON" : "OFF", true);
    this.publishState(true);
  }

  onConnect() {
    this.log("MQTT connected, publishing discovery");
    this.client.subscribe([T.reconnect, T.quickPrint, T.reprintLast, T.quickTextSet, T.quickWrapSet,
      T.print, T.printTemplate, T.haStatus, T.clearQueue, T.testPrint, T.scan], { qos: 0 });
    this.publishDiscovery();
  }

  /** Publish /status. force=false skips when nothing changed. */
  publishState(force = false) {
    if (!this.client || !this.client.connected) return;
    // printer model learnt (first connect): refresh the device info
    if (this.o.getModel && this.o.getModel() !== this.model) this.publishDiscovery();
    // periodic: re-assert availability (a stale Last Will "offline" never sticks)
    if (force) this.pub(T.avail, "online", true);
    let s;
    try { s = JSON.stringify(this.o.getStatus()); } catch (e) { this.log(`state: ${e.message}`); return; }
    if (!force && s === this.lastState) return;
    this.lastState = s;
    this.pub(T.state, s);
  }

  result(obj) { this.pub(T.result, { at: new Date().toISOString(), ...obj }); }

  async run(what, fn) {
    try {
      const { _status, ...r } = (await fn()) || {};
      this.log(`MQTT ${what}: ${r.message || "ok"}`);
      this.result({ ok: true, action: what, ...(_status === 202 ? { queued: true } : {}), ...r });
    } catch (e) {
      this.log(`MQTT ${what} failed: ${e.message}`);
      this.result({ ok: false, action: what, error: e.message });
    } finally {
      this.publishState(true);
    }
  }

  async onMessage(topic, payload) {
    const h = this.o.handlers;
    const ctx = { source: "mqtt" };
    switch (topic) {
      case T.haStatus:
        if (payload.toString() === "online") setTimeout(() => this.publishDiscovery(), 2000 + Math.random() * 3000);
        return;
      case T.reconnect:
        this.log("Reconnect requested (MQTT)");
        return this.run("reconnect", () => h.reconnect());
      case T.quickTextSet:
        this.quick.text = payload.toString("utf8").slice(0, QUICK_MAX);
        this.saveQuick();
        this.pub(T.quickText, this.quick.text, true);
        return;
      case T.quickWrapSet: {
        const on = /^(on|true|1)$/i.test(payload.toString().trim());
        this.quick.wrap = on;
        this.saveQuick();
        this.pub(T.quickWrap, on ? "ON" : "OFF", true);
        return;
      }
      case T.quickPrint:
        return this.run("quick_print", () => {
          if (!this.quick.text.trim()) throw new Error("quick print text is empty");
          return h.printText({ text: quickLines(this.quick.text), wrap: this.quick.wrap }, ctx);
        });
      case T.reprintLast:
        return this.run("reprint_last", () => h.reprintLast(ctx));
      case T.clearQueue:
        return this.run("clear_queue", () => h.clearQueue());
      case T.testPrint:
        return this.run("test_print", () => h.testPrint(ctx));
      case T.scan:
        try {
          const r = await h.scan();
          this.pub(T.scanResult, r, true);
          this.log(`MQTT scan: ${r.ble.length} BLE + ${r.usb.length} USB printer(s)`);
        } catch (e) { this.log(`MQTT scan failed: ${e.message}`); }
        return;
      case T.print:
        return this.run("print", () => h.printText(parsePrintPayload(payload), ctx));
      case T.printTemplate:
        return this.run("print_template", () => {
          const body = parsePrintPayload(payload);
          if (!body.name) throw new Error("niimblue/print/template needs JSON with \"name\"");
          return h.printTemplate(body.name, body, ctx);
        });
      default:
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.client) {
      if (this.client.connected) {
        await new Promise((r) => this.client.publish(T.avail, "offline", { retain: true, qos: 1 }, () => r()));
      }
      await new Promise((r) => this.client.end(false, {}, () => r()));
    }
  }
}

module.exports = { MqttBridge, discoveryConfigs, parsePrintPayload, quickLines, TOPICS: T, QUICK_MAX };
