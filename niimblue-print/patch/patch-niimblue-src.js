// Build-time patches to the NiimBlue source (run in the cloned /src before
// `vite build`). Adapts the UI for host-side printing:
//   1. BrowserWarning -> nothing (no "browser doesn't support bluetooth/serial")
//   2. PrintPreview   -> the preview's own Print button prints VIA HOST
//      (uses window.NIIMBLUE_HOST from our injected config.js), always enabled;
//      the browser "system printer" button is removed.
// A patch that does not apply FAILS the build: otherwise the preview's Print
// button would silently fall back to Web Bluetooth (which cannot reach the
// printer on the HA host). NiimBlue is pinned in the Dockerfile; re-check
// these anchors when bumping it.
const fs = require("fs");

function must(cond, msg) {
  if (!cond) {
    console.error("[patch-src] ERROR:", msg);
    process.exit(1);
  }
}

// 1) Silence the unsupported-browser banner ------------------------------
const bw = "src/components/basic/BrowserWarning.svelte";
if (fs.existsSync(bw)) {
  fs.writeFileSync(bw, '<script lang="ts"></script>\n');
  console.log("[patch-src] BrowserWarning emptied");
} else must(false, "BrowserWarning.svelte not found");

// 2) PrintPreview: host-print the preview canvas -------------------------
const pf = "src/components/PrintPreview.svelte";
let s = fs.readFileSync(pf, "utf8");
const before = s;

const hostFn = `  const onPrintViaHost = async () => {
    printState = "sending"; error = "";
    try {
      await generatePreviewData(0);
      // no padding needed: niimbluelib's encoder pads the columns to 8 itself
      const cfg = window.NIIMBLUE_HOST || {};
      const body = {
        imageBase64: previewCanvas.toDataURL("image/png").replace(/^data:image\\/\\w+;base64,/, ""),
        printDirection: labelProps.printDirection || "top",
        density,
        quantity,
      };
      if (cfg.model) body.printTask = cfg.model;
      const r = await fetch((cfg.apiBase || "../api") + "/print", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const t = await r.text();
      if (r.status === 202) { error = "Queued: the printer is not reachable right now, the label prints as soon as it is (see the Queue in the Diagnostics tab)."; }
      else if (r.status === 504) { error = "Still printing or queued (the request timed out). Check the queue before printing again."; }
      else if (!r.ok) { let m = t; try { m = JSON.parse(t).error || m; } catch (e) {} error = "Host print error: " + m; }
    } catch (e) { error = String(e); }
    printState = "idle";
  };

`;

// 2a) inject the host-print function before the system-printer handler
const anchor = "  const onPrintOnSystemPrinter = async () => {";
if (s.includes(anchor)) {
  s = s.replace(anchor, hostFn + anchor);
  console.log("[patch-src] onPrintViaHost injected");
} else must(false, "onPrintOnSystemPrinter anchor not found");

// 2b) remove the browser "system printer" button
const sysBtn = /\s*<button\s+type="button"\s+class="btn btn-secondary"\s+title=\{\$tr\("preview\.print\.system"\)\}\s+onclick=\{onPrintOnSystemPrinter\}>[\s\S]*?<\/button>/;
if (sysBtn.test(s)) { s = s.replace(sysBtn, ""); console.log("[patch-src] system-printer button removed"); }
else must(false, "system-printer button not matched");

// 2c) repurpose the primary Print button -> host print, always enabled
const primary = /<button type="button" class="btn btn-primary" disabled=\{\$disconnected \|\| printState !== "idle"\} onclick=\{onPrint\}>[\s\S]*?<\/button>/;
if (primary.test(s)) {
  s = s.replace(primary,
    '<button type="button" class="btn btn-primary" disabled={printState !== "idle"} onclick={onPrintViaHost}>\n' +
    '      <MdIcon icon="print" /> {$tr("preview.print")}\n' +
    "    </button>");
  console.log("[patch-src] primary print button repurposed to host");
} else must(false, "primary print button not matched");

if (s !== before) fs.writeFileSync(pf, s);
console.log("[patch-src] done");
