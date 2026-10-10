"use strict";
/* Home Assistant Supervisor API (add-on side): MQTT broker credentials and
 * Home Assistant Core service calls (needs `homeassistant_api: true`).
 *
 * Under s6-overlay the token may only exist in s6's container environment,
 * not in this process' env: fall back to it (same as 1.1.1's MQTT fix).
 * SUPERVISOR_URL overrides the endpoint (tests).
 */
const fs = require("fs");

const BASE = () => (process.env.SUPERVISOR_URL || "http://supervisor").replace(/\/$/, "");
const TIMEOUT_MS = 10000;

function token() {
  if (process.env.SUPERVISOR_TOKEN) return process.env.SUPERVISOR_TOKEN;
  try { return fs.readFileSync("/run/s6/container_environment/SUPERVISOR_TOKEN", "utf8").trim(); } catch (_) { return ""; }
}

async function api(pathname, { method = "GET", body } = {}) {
  const t = token();
  if (!t) throw new Error("no SUPERVISOR_TOKEN available");
  const r = await fetch(`${BASE()}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${pathname}: ${text.slice(0, 200)}`);
  try { return text ? JSON.parse(text) : {}; } catch (_) { return { raw: text }; }
}

/** { host, port, username, password, ssl } from the Mosquitto add-on. */
async function mqttService() {
  const j = await api("/services/mqtt");
  if (!j || !j.data || !j.data.host) throw new Error("MQTT service not provided (is the Mosquitto add-on running?)");
  return j.data;
}

/** POST /core/api/services/<domain>/<service> */
function callService(domain, service, data) {
  return api(`/core/api/services/${domain}/${service}`, { method: "POST", body: data });
}

module.exports = { token, api, mqttService, callService };
