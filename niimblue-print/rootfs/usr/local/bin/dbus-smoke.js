#!/usr/bin/env node
"use strict";
/* Build-time smoke test of the Bluetooth client stack on THIS Node.js.
 *
 * Bluetooth printing goes noble -> dbus-next -> BlueZ. The fake-printer e2e
 * never touches D-Bus, so a runtime break in that path (1.3.0: Node 24 removed
 * util.isError, which dbus-next's optional usocket called on the first write)
 * only showed up on a real printer. This connects dbus-next, resolved exactly
 * as noble resolves it, to the bus in DBUS_SYSTEM_BUS_ADDRESS (the Dockerfile
 * starts a private dbus-daemon for it) and makes one method call.
 *
 * Deliberately WITHOUT print-server.js's util.isError polyfill: the image must
 * work without it. Exit 0 = OK, 1 = broken (fails the image build).
 */
const path = require("path");
const { createRequire } = require("module");

const LIB_DIR = process.env.NIIMBLUE_LIB_DIR || path.join(__dirname, "../lib/niimblue-print");
const TIMEOUT_MS = 10000;

function fail(msg) {
  console.error(`[dbus-smoke] FAILED: ${msg}`);
  process.exit(1);
}
process.on("uncaughtException", (e) => fail(e && e.stack ? e.stack : String(e)));
process.on("unhandledRejection", (e) => fail(e && e.stack ? e.stack : String(e)));
setTimeout(() => fail(`no answer from D-Bus within ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS).unref();

(async () => {
  if (!process.env.DBUS_SYSTEM_BUS_ADDRESS) fail("DBUS_SYSTEM_BUS_ADDRESS not set");
  const nbRequire = createRequire(path.join(LIB_DIR, "node_modules/@mmote/niimblue-node/package.json"));
  const libRequire = createRequire(nbRequire.resolve("@mmote/niimbluelib"));
  const noblePkg = libRequire.resolve("@stoprocent/noble/package.json");
  const dbusFrom = createRequire(path.join(path.dirname(noblePkg), "lib/dbus/bindings.js"));
  const dbusPath = dbusFrom.resolve("dbus-next");
  let socket = "net (Node built-in)";
  try {
    createRequire(dbusPath).resolve("usocket");
    socket = "usocket (native)";
  } catch (_) { /* not installed: dbus-next uses net.createConnection */ }

  const dbus = dbusFrom("dbus-next");
  const bus = dbus.systemBus();
  bus.on("error", (e) => fail(`bus error: ${e && e.message ? e.message : e}`));
  const obj = await bus.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus");
  const names = await obj.getInterface("org.freedesktop.DBus").ListNames();
  if (!Array.isArray(names) || !names.includes("org.freedesktop.DBus")) fail(`unexpected ListNames answer: ${JSON.stringify(names)}`);
  bus.disconnect();
  console.log(`[dbus-smoke] OK: Node ${process.versions.node}, dbus-next ${dbusFrom("dbus-next/package.json").version} ` +
    `via ${socket}, ${names.length} bus name(s)`);
  process.exit(0);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
