/* NiimBlue "Print via host" button — injected by the add-on (nginx sub_filter).
 *
 * NiimBlue's built-in print uses Web Bluetooth / Web Serial from the BROWSER,
 * which cannot reach a printer plugged into the Home Assistant host. This adds
 * a button that exports the current label canvas and POSTs it to the add-on's
 * niimblue-node print server, which owns the host's serial connection.
 *
 * The canvas selector is version-sensitive (NiimBlue uses fabric.js). If export
 * grabs the wrong element, adjust CANVAS_SELECTORS below.
 */
(function () {
  "use strict";
  var cfg = window.NIIMBLUE_HOST || {};
  var API = (cfg.apiBase || "api").replace(/\/$/, "");

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

    // The printer encoder requires image WIDTH to be a multiple of 8 (it packs
    // 8 horizontal pixels per byte) — otherwise: "column must be a multiple of
    // 8". Pad the right edge with white up to the next multiple of 8 (no scaling,
    // so no distortion).
    var w = canvas.width, h = canvas.height;
    var w8 = Math.ceil(w / 8) * 8;
    var src = canvas;
    if (w8 !== w) {
      var pad = document.createElement("canvas");
      pad.width = w8; pad.height = h;
      var pctx = pad.getContext("2d");
      pctx.fillStyle = "#ffffff";
      pctx.fillRect(0, 0, w8, h);
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
          toast("Print server is down (it may have crashed on a serial error). Check the add-on log.", false);
        } else {
          toast("Print error (" + res.status + "): " + msg, false);
        }
      })
      .catch(function (e) { toast("Request failed: " + e, false); })
      .finally(function () { btn.disabled = false; btn.textContent = "🖨 Print via host"; });
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

  bar.appendChild(qty); bar.appendChild(btn);

  function mount() {
    if (document.body) document.body.appendChild(bar);
    else setTimeout(mount, 300);
  }
  mount();
})();
