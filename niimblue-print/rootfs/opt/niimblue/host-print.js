/* NiimBlue "Print via host" button — injected by the add-on (nginx sub_filter).
 *
 * NiimBlue's built-in print uses Web Bluetooth / Web Serial from the BROWSER,
 * which cannot reach a printer plugged into the Home Assistant host. This adds
 * a button that exports the current label canvas and POSTs it to the add-on's
 * print server, which owns the printer connection (USB serial or Bluetooth).
 *
 * The canvas selector is version-sensitive (NiimBlue uses fabric.js). If export
 * grabs the wrong element, adjust CANVAS_SELECTORS below.
 *
 * Label roll: api/label.js (loaded just before this file) sets
 * window.NIIMBLUE_LABEL to the roll the printer reported (RFID + size). This
 * script runs BEFORE the NiimBlue app (module scripts are deferred), so it can
 * preselect that size by writing NiimBlue's own "last_label_props" entry in
 * localStorage. Done once per detected roll/size, so a size the user picks
 * afterwards sticks. The print bar shows the detected label.
 */
(function () {
  "use strict";
  var cfg = window.NIIMBLUE_HOST || {};
  var API = (cfg.apiBase || "api").replace(/\/$/, "");
  var DIR = cfg.printDirection === "left" ? "left" : "top";

  // --- detected label roll -> designer label size (before the app starts) ---
  // Print direction "top": image width runs across the printhead; "left": the
  // image is rotated, so its height does. Design at the WHOLE label size (like
  // NiimBlue's own 50x30 preset = 400x240); the server centre-crops what is
  // wider than the printhead, as the NIIMBOT app does.
  function labelPx(L) {
    var across = L && (L.full_across_px || L.across_px);
    if (!across || !L.feed_px) return null;
    return DIR === "left" ? { w: L.feed_px, h: across } : { w: across, h: L.feed_px };
  }

  function readLabelProps() {
    try { return JSON.parse(localStorage.getItem("last_label_props") || "null"); } catch (e) { return null; }
  }

  var preselected = null;
  (function preselectLabel(L) {
    var px = labelPx(L);
    if (!px) return;
    var key = L.barcode + ":" + px.w + "x" + px.h + ":" + DIR;
    try {
      if (localStorage.getItem("nbhost_label_applied") === key) return;
      var props = readLabelProps();
      if (!props || typeof props !== "object") props = {};
      props.printDirection = DIR;
      props.size = { width: px.w, height: px.h };
      localStorage.setItem("last_label_props", JSON.stringify(props));
      localStorage.setItem("nbhost_label_applied", key);
      preselected = (L.name || L.barcode) + " (" + px.w + "x" + px.h + " px)";
    } catch (e) { /* storage blocked: just show the label */ }
  })(window.NIIMBLUE_LABEL);

  var CANVAS_SELECTORS = [
    "canvas.lower-canvas",        // fabric.js drawing layer (most builds)
    ".workspace canvas",
    "main canvas",
    "canvas",
  ];

  function findCanvas() {
    for (var i = 0; i < CANVAS_SELECTORS.length; i++) {
      var els = document.querySelectorAll(CANVAS_SELECTORS[i]);
      // pick the largest canvas (the label, not thumbnails/icons)
      var best = null, bestArea = 0;
      els.forEach(function (c) {
        var a = c.width * c.height;
        if (a > bestArea) { best = c; bestArea = a; }
      });
      if (best) return best;
    }
    return null;
  }

  function toast(msg, ok) {
    var t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText =
      "position:fixed;bottom:70px;right:16px;z-index:100000;padding:10px 14px;" +
      "border-radius:8px;font:13px sans-serif;color:#fff;max-width:320px;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.3);background:" + (ok ? "#2e7d32" : "#c62828");
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 5000);
  }

  function print() {
    var canvas = findCanvas();
    if (!canvas) { toast("No label canvas found to print.", false); return; }

    // The encoder packs 8 pixels per byte and requires the "column count" to be
    // a multiple of 8. Which axis is "columns" depends on print direction (the
    // image gets rotated), so pad BOTH width and height up to the next multiple
    // of 8 with white (no scaling → no distortion).
    var w = canvas.width, h = canvas.height;
    var w8 = Math.ceil(w / 8) * 8;
    var h8 = Math.ceil(h / 8) * 8;
    var src = canvas;
    if (w8 !== w || h8 !== h) {
      var pad = document.createElement("canvas");
      pad.width = w8; pad.height = h8;
      var pctx = pad.getContext("2d");
      pctx.fillStyle = "#ffffff";
      pctx.fillRect(0, 0, w8, h8);
      pctx.drawImage(canvas, 0, 0);
      src = pad;
    }

    var dataUrl;
    try { dataUrl = src.toDataURL("image/png"); }
    catch (e) { toast("Canvas export failed: " + e, false); return; }

    var body = {
      imageBase64: dataUrl.replace(/^data:image\/\w+;base64,/, ""),
      printDirection: cfg.printDirection || "top",
      density: cfg.density || 3,
      threshold: cfg.threshold || 128,
      imageFit: cfg.imageFit || "contain",
      quantity: parseInt(document.getElementById("nb-qty").value, 10) || 1,
    };
    if (cfg.model) body.printTask = cfg.model;
    if (cfg.labelWidth && cfg.labelWidth > 0) body.labelWidth = cfg.labelWidth;
    if (cfg.labelHeight && cfg.labelHeight > 0) body.labelHeight = cfg.labelHeight;

    btn.disabled = true; btn.textContent = "🖨 Printing…";
    fetch(API + "/print", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      // Read as text first — an nginx 502 returns HTML, not JSON, so we must
      // not blindly JSON.parse (that produced the "unexpected character" error).
      .then(function (r) { return r.text().then(function (t) { return { status: r.status, ok: r.ok, text: t }; }); })
      .then(function (res) {
        var msg = res.text;
        try { var j = JSON.parse(res.text); msg = j.error || j.message || res.text; } catch (e) {}
        if (res.ok) {
          toast("Sent to printer ✓", true);
        } else if (res.status === 502 || res.status === 504) {
          toast("Print server is down (restarting?). Check the add-on log.", false);
        } else {
          toast("Print error (" + res.status + "): " + msg, false);
        }
      })
      .catch(function (e) { toast("Request failed: " + e, false); })
      .finally(function () { btn.disabled = false; btn.textContent = "🖨 Print via host"; refreshStatus(); });
  }

  // --- printer state dot (GET api/status) ---
  // green = connected, blue = idle (Bluetooth connects on demand),
  // amber = connecting / waiting for the printer, red = error / server down.
  var COLORS = { connected: "#43a047", idle: "#29b6f6", connecting: "#ffb300",
                 waiting: "#ffb300", starting: "#ffb300", disconnected: "#ffb300" };
  var dot = document.createElement("span");
  dot.style.cssText = "width:10px;height:10px;border-radius:50%;display:inline-block;" +
    "margin:0 4px;background:#78909c;";
  dot.title = "Printer status: unknown";

  function refreshStatus() {
    fetch(API + "/status", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        dot.style.background = COLORS[s.status] || "#e53935";
        dot.title = "Printer (" + (s.transport || "?") + "): " + s.status +
          (s.detail ? " — " + s.detail : "") +
          (s.battery != null ? " | battery " + s.battery + "%" : "");
        showLabel(s.label);
      })
      .catch(function () { dot.style.background = "#e53935"; dot.title = "Print server unreachable"; });
  }

  // --- detected label chip ---
  var chip = document.createElement("span");
  chip.style.cssText = "color:#cfd8dc;font:12px sans-serif;max-width:260px;overflow:hidden;" +
    "text-overflow:ellipsis;white-space:nowrap;display:none;";

  function showLabel(L) {
    if (!L || !L.barcode) { chip.style.display = "none"; return; }
    var px = labelPx(L);
    var size = L.width_mm ? L.width_mm + "×" + L.height_mm + " mm" : "size unknown";
    chip.textContent = "🏷 " + (L.name || L.barcode) + " · " + size +
      (L.remaining != null ? " · " + L.remaining + " left" : "");
    var tip = "Label roll in the printer: " + (L.name || "?") + "\nbarcode " + L.barcode +
      (px ? "\nlabel " + px.w + "×" + px.h + " px (direction " + DIR + ")" : "") +
      (L.clipped ? "\nwider than the printhead: " + L.crop_each_side_px + " px are cut on each side " +
        "(printed " + L.width_px + "×" + L.height_px + " px)" : "") +
      (L.remaining != null ? "\n" + L.remaining + " of " + L.total + " labels left" : "") +
      "\nsize source: " + (L.source || "none (no auto size)");
    chip.style.color = "#cfd8dc";
    var props = readLabelProps();
    if (px && props && props.size && (props.size.width !== px.w || props.size.height !== px.h)) {
      chip.style.color = "#ffb300";
      tip += "\n\nDesigner canvas is " + props.size.width + "×" + props.size.height +
        " px; prints are scaled to the label (image_fit) unless label_width/height are set." +
        "\nTo design 1:1, set the label size to " + px.w + "×" + px.h + " px.";
    }
    chip.title = tip;
    chip.style.display = "";
  }

  // --- UI: floating button + quantity ---
  var bar = document.createElement("div");
  bar.style.cssText =
    "position:fixed;bottom:16px;right:16px;z-index:100000;display:flex;gap:6px;" +
    "align-items:center;background:#263238;padding:6px 8px;border-radius:10px;" +
    "box-shadow:0 2px 10px rgba(0,0,0,.35);font:13px sans-serif;";

  var qty = document.createElement("input");
  qty.id = "nb-qty"; qty.type = "number"; qty.min = "1"; qty.value = "1";
  qty.title = "Copies";
  qty.style.cssText = "width:48px;padding:4px;border:none;border-radius:6px;";

  var btn = document.createElement("button");
  btn.textContent = "🖨 Print via host";
  btn.onclick = print;
  btn.style.cssText =
    "cursor:pointer;border:none;border-radius:6px;padding:8px 12px;" +
    "background:#00b8d4;color:#001318;font-weight:600;";

  bar.appendChild(dot); bar.appendChild(chip); bar.appendChild(qty); bar.appendChild(btn);

  function mount() {
    if (document.body) document.body.appendChild(bar);
    else setTimeout(mount, 300);
  }
  mount();
  showLabel(window.NIIMBLUE_LABEL);
  if (preselected) setTimeout(function () { toast("Label size set to the detected roll: " + preselected, true); }, 1500);
  refreshStatus();
  setInterval(refreshStatus, 10000);
})();
