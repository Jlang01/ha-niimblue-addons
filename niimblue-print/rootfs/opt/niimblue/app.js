/* NiimBlue Print shell: status bar + tabs (Designer / Quick print / Templates /
 * History / Diagnostics). Plain JS, no framework, relative URLs only (HA ingress sub-path).
 * Talks to the print server through nginx at ./api/ (tagged as source "ui").
 */
(function () {
  "use strict";
  window.NIIMBLUE_SHELL = true;   // the designer's print bar checks this
  var API = "api";
  var $ = function (id) { return document.getElementById(id); };

  // ---- helpers ----------------------------------------------------------
  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") e.textContent = attrs[k];
      else if (k === "class") e.className = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) e.appendChild(arguments[i]);
    return e;
  }

  /** fetch JSON; rejects with the server's error text (nginx 502 = server down). */
  function api(method, path, body) {
    return fetch(API + "/" + path, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { /* not JSON */ }
        if (!r.ok) {
          var m = (j && j.error) || (r.status === 502 ? "print server is not running"
            : r.status === 504 ? "request timed out (the job may still print: check the queue)" : t || r.statusText);
          throw new Error(m);
        }
        if (j && typeof j === "object") j._status = r.status;
        return j;
      });
    });
  }

  var toastTimer = null;
  function toast(msg, ok) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (ok === false ? " err" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ok === false ? 7000 : 3500);
  }

  /** Toast for a print response: 200 printed, 202 queued (prints later). */
  function printedToast(r, extra) {
    if (r && r._status === 202) toast("Queued: " + (r.message || "waiting for the printer"), true);
    else toast("Printed ✓" + (extra || ""));
  }

  function debounce(fn, ms) {
    var t = null;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function store(k, v) {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem("nbshell_" + k));
      localStorage.setItem("nbshell_" + k, JSON.stringify(v));
    } catch (e) { return null; }
  }

  // ---- tabs ---------------------------------------------------------------
  var current = null;
  var loaders = {};
  function showTab(name) {
    if (!$("tab-" + name)) name = "designer";
    current = name;
    document.querySelectorAll(".tabs button").forEach(function (b) {
      b.setAttribute("aria-selected", String(b.dataset.tab === name));
    });
    document.querySelectorAll("main .tab").forEach(function (s) { s.hidden = s.id !== "tab-" + name; });
    if (name === "designer" && $("designer").getAttribute("src") === "about:blank") $("designer").src = "designer/";
    store("tab", name);
    if (loaders[name]) loaders[name]();
  }
  document.querySelectorAll(".tabs button").forEach(function (b) {
    b.addEventListener("click", function () { showTab(b.dataset.tab); });
  });

  // ---- status bar -----------------------------------------------------------
  var COLORS = { connected: "#43a047", idle: "#29b6f6", connecting: "#ffb300", waiting: "#ffb300",
    starting: "#ffb300", disconnected: "#ffb300" };
  var labelInfo = null;
  function chip(id, text, title, warn) {
    var c = $(id);
    c.hidden = !text;
    c.textContent = text || "";
    c.title = title || "";
    c.classList.toggle("warn", !!warn);
  }
  function refreshStatus() {
    return api("GET", "status").then(function (s) {
      $("st-dot").style.background = COLORS[s.status] || "#e53935";
      $("st-text").textContent = s.status + (s.model ? " · " + s.model : "");
      $("st-text").title = (s.detail || "") + (s.last_error ? "\nlast error: " + s.last_error : "");
      var W = s.warnings || {};
      chip("st-battery", s.battery != null ? "🔋 " + s.battery + " %" : "", "Printer battery", W.battery_low);
      var Qs = s.queue || {};
      chip("st-queue", Qs.length ? "⏳ " + Qs.length + " queued" + (Qs.blocked ? " · " + Qs.blocked.replace(/_/g, " ") : "")
        : (Qs.failed ? "⚠ " + Qs.failed + " failed" : ""), Qs.blocked_reason || "Print queue (Diagnostics tab)", !!(Qs.blocked || Qs.failed));
      var L = s.label;
      labelInfo = L;
      if (L) {
        var size = L.width_mm ? " · " + L.width_mm + "×" + L.height_mm + " mm" : "";
        chip("st-label", "🏷 " + (L.name || L.barcode) + size,
          "Label roll (RFID " + L.barcode + ")" + (L.width_px ? "\nprinted area " + L.width_px + "×" + L.height_px + " px" : ""));
        chip("st-remaining", L.remaining != null ? L.remaining + " left" : "",
          L.total != null ? L.remaining + " of " + L.total + " labels left" : "", W.labels_low);
      } else {
        chip("st-label", "🏷 no roll detected", "No RFID label roll reported yet (connect / reconnect the printer)");
        chip("st-remaining", "");
      }
    }).catch(function (e) {
      $("st-dot").style.background = "#e53935";
      $("st-text").textContent = "print server unreachable";
      $("st-text").title = String(e.message || e);
    });
  }
  $("st-reconnect").addEventListener("click", function () {
    var b = $("st-reconnect");
    b.disabled = true; b.textContent = "Reconnecting…";
    api("POST", "reconnect", {}).then(function () { toast("Printer connected"); }, function (e) { toast("Reconnect: " + e.message, false); })
      .then(function () { b.disabled = false; b.textContent = "Reconnect"; refreshStatus(); });
  });

  // ---- quick print ------------------------------------------------------------
  var Q = { align: "center" };
  function quickBody() {
    var text = $("q-text").value;
    var body = {
      text: text,
      wrap: $("q-wrap").checked,
      bold: $("q-bold").checked,
      border: $("q-border").checked,
      align: Q.align,
      font_size: $("q-fontmode").value === "fixed" ? Number($("q-fontsize").value) || 40 : "auto",
    };
    if ($("q-qr").value.trim()) body.qr = $("q-qr").value.trim();
    if ($("q-bc").value.trim()) body.barcode = { type: $("q-bctype").value, data: $("q-bc").value.trim() };
    return body;
  }
  function saveQuick() {
    var b = quickBody();
    b.qty = $("q-qty").value;
    store("quick", b);
  }
  function loadQuick(b) {
    if (!b) return;
    $("q-text").value = b.text != null ? b.text : (b.lines || []).join("\n");
    $("q-wrap").checked = !!b.wrap;
    $("q-bold").checked = !!b.bold;
    $("q-border").checked = !!b.border;
    setAlign(b.align || "center");
    var fixed = b.font_size && b.font_size !== "auto";
    $("q-fontmode").value = fixed ? "fixed" : "auto";
    $("q-fontsize").hidden = !fixed;
    if (fixed) $("q-fontsize").value = b.font_size;
    var qr = b.qr && typeof b.qr === "object" ? b.qr.data : b.qr;
    $("q-qr").value = qr || "";
    var bc = b.barcode && typeof b.barcode === "object" ? b.barcode : (b.barcode ? { data: b.barcode } : null);
    $("q-bc").value = bc ? bc.data || "" : "";
    $("q-bctype").value = bc && bc.type === "ean13" ? "ean13" : "code128";
    if (b.qty) $("q-qty").value = b.qty;
  }
  function setAlign(v) {
    Q.align = v;
    document.querySelectorAll("#q-align button").forEach(function (b) { b.classList.toggle("on", b.dataset.v === v); });
  }
  document.querySelectorAll("#q-align button").forEach(function (b) {
    b.addEventListener("click", function () { setAlign(b.dataset.v); onQuickChange(); });
  });
  $("q-fontmode").addEventListener("change", function () {
    $("q-fontsize").hidden = $("q-fontmode").value !== "fixed";
    onQuickChange();
  });

  var previewSeq = 0;
  /** Render a preview via the server; img + meta elements, body. */
  function preview(path, body, img, meta) {
    var seq = ++previewSeq;
    var b = Object.assign({}, body, { format: "json" });
    return api("POST", path, b).then(function (r) {
      if (seq !== previewSeq) return;
      img.src = "data:image/png;base64," + r.image;
      var info = [];
      if (r.width) info.push(r.width + "×" + r.height + " px" + (r.size_from ? " (" + r.size_from + ")" : ""));
      if (r.font_size) info.push("font " + r.font_size + " px");
      if (r.qr) info.push("QR " + r.qr.size_px + " px");
      if (r.barcode) info.push("barcode " + r.barcode.width_px + " px");
      meta.textContent = info.join(" · ") + ((r.warnings || []).length ? "\n⚠ " + r.warnings.join("\n⚠ ") : "");
      meta.classList.remove("err");
    }).catch(function (e) {
      if (seq !== previewSeq) return;
      img.removeAttribute("src");
      meta.textContent = e.message;
      meta.classList.add("err");
    });
  }
  var onQuickChange = debounce(function () {
    saveQuick();
    var b = quickBody();
    if (!b.text.trim() && !b.qr && !b.barcode) {
      $("q-img").removeAttribute("src");
      $("q-meta").textContent = "Type some text to see the label.";
      $("q-meta").classList.remove("err");
      return;
    }
    preview("preview/text", b, $("q-img"), $("q-meta"));
  }, 350);
  $("q-form").addEventListener("input", onQuickChange);
  $("q-form").addEventListener("change", onQuickChange);

  $("q-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body = quickBody();
    body.quantity = Math.max(1, Math.min(100, parseInt($("q-qty").value, 10) || 1));
    var btn = $("q-print");
    btn.disabled = true; btn.textContent = "Printing…";
    api("POST", "print/text", body).then(function (r) {
      printedToast(r, r.layout && r.layout.warnings.length ? " (" + r.layout.warnings[0] + ")" : "");
    }, function (e) { toast("Print failed: " + e.message, false); })
      .then(function () { btn.disabled = false; btn.textContent = "Print"; refreshStatus(); });
  });

  $("q-save").addEventListener("click", function () {
    var name = $("q-tplname").value.trim();
    if (!name) { toast("Give the template a name", false); return; }
    var body = quickBody();
    var payload = { type: "text", layout: {
      lines: body.text.split("\n"), wrap: body.wrap, bold: body.bold, border: body.border, align: body.align,
      font_size: body.font_size, qr: body.qr || null, barcode: body.barcode || null,
    } };
    if (labelInfo && labelInfo.width_px) {
      payload.label = { name: labelInfo.name, width_px: labelInfo.width_px, height_px: labelInfo.height_px };
    }
    api("PUT", "templates/" + encodeURIComponent(name), payload).then(function (r) {
      var v = r.template.variables;
      toast("Template \"" + name + "\" saved" + (v.length ? " (variables: " + v.join(", ") + ")" : ""));
      $("q-tplname").value = "";
    }, function (e) { toast("Save failed: " + e.message, false); });
  });

  loaders.quick = function () { onQuickChange(); };

  // ---- templates ----------------------------------------------------------------
  var T = { list: [], sel: null, full: null, armedDelete: false };
  function loadTemplates() {
    return api("GET", "templates").then(function (r) {
      T.list = r.templates;
      var ul = $("t-list");
      ul.textContent = "";
      $("t-empty").hidden = T.list.length > 0;
      T.list.forEach(function (t) {
        var sub = t.type === "image" ? "image" + (t.label && t.label.width_px ? " · " + t.label.width_px + "×" + t.label.height_px + " px" : "")
          : (t.variables.length ? "{{" + t.variables.join("}} {{") + "}}" : "no variables") + (t.uses_counter ? " · counter " + t.counter : "");
        var li = el("li", { class: T.sel === t.name ? "on" : "", onclick: function () { selectTemplate(t.name); } },
          el("div", null, el("div", { text: t.name }), el("div", { class: "sub", text: sub })),
          el("span", { class: "badge", text: t.type }));
        ul.appendChild(li);
      });
      if (T.sel && !T.list.some(function (t) { return t.name === T.sel; })) { T.sel = null; $("t-detail").hidden = true; }
    }).catch(function (e) { toast("Templates: " + e.message, false); });
  }
  function tplVars() {
    var vars = {};
    document.querySelectorAll("#t-vars input").forEach(function (i) { vars[i.name] = i.value; });
    return vars;
  }
  var tplPreview = debounce(function () {
    if (!T.sel) return;
    preview("preview/template/" + encodeURIComponent(T.sel), { vars: tplVars() }, $("t-img"), $("t-meta"));
  }, 350);
  function selectTemplate(name) {
    T.sel = name;
    T.armedDelete = false;
    $("t-delete").textContent = "Delete";
    document.querySelectorAll("#t-list li").forEach(function (li, i) { li.classList.toggle("on", T.list[i] && T.list[i].name === name); });
    api("GET", "templates/" + encodeURIComponent(name)).then(function (t) {
      T.full = t;
      $("t-detail").hidden = false;
      $("t-name").textContent = t.name;
      $("t-type").textContent = t.type;
      $("t-desc").textContent = t.type === "image"
        ? "Image from the designer: printed as designed (fitted to the label). Text in it cannot change — use a text template for placeholders."
        : (t.description || "") + (t.uses_counter ? " Next {{counter}}: " + t.counter + "." : "");
      $("t-edit").hidden = t.type !== "text";
      var box = $("t-vars");
      box.textContent = "";
      t.variables.forEach(function (v) {
        var saved = store("vars_" + t.name) || {};
        var input = el("input", { type: "text", name: v, placeholder: t.defaults[v] != null ? t.defaults[v] : "" });
        input.value = saved[v] != null ? saved[v] : (t.defaults[v] || "");
        box.appendChild(el("label", { class: "field" }, el("span", { text: v }), input));
      });
      if (t.print && t.print.quantity) $("t-qty").value = t.print.quantity;
      tplPreview();
    }).catch(function (e) { toast(e.message, false); });
  }
  $("t-vars").addEventListener("input", function () {
    if (T.sel) store("vars_" + T.sel, tplVars());
    tplPreview();
  });
  $("t-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!T.sel) return;
    var btn = ev.submitter || $("t-form").querySelector("button[type=submit]");
    btn.disabled = true;
    var body = { vars: tplVars(), quantity: Math.max(1, Math.min(100, parseInt($("t-qty").value, 10) || 1)) };
    api("POST", "print/template/" + encodeURIComponent(T.sel), body).then(function (r) {
      printedToast(r, r.counter_first != null ? " (#" + r.counter_first + (r.counter_last !== r.counter_first ? "–" + r.counter_last : "") + ")" : "");
    }, function (e) { toast("Print failed: " + e.message, false); })
      .then(function () { btn.disabled = false; refreshStatus(); loadTemplates(); tplPreview(); });
  });
  $("t-delete").addEventListener("click", function () {
    if (!T.sel) return;
    if (!T.armedDelete) { T.armedDelete = true; $("t-delete").textContent = "Really delete?"; return; }
    api("DELETE", "templates/" + encodeURIComponent(T.sel)).then(function () {
      toast("Deleted " + T.sel);
      T.sel = null; $("t-detail").hidden = true; loadTemplates();
    }, function (e) { toast(e.message, false); });
  });
  $("t-edit").addEventListener("click", function () {
    if (!T.full || T.full.type !== "text") return;
    loadQuick(T.full.layout);
    $("q-tplname").value = T.full.name;
    showTab("quick");
  });
  $("t-refresh").addEventListener("click", loadTemplates);
  loaders.templates = loadTemplates;

  // ---- history -------------------------------------------------------------------
  function fmtTime(iso) {
    try { return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }); } catch (e) { return iso; }
  }
  function loadHistory() {
    return api("GET", "history").then(function (r) {
      var ul = $("h-list");
      ul.textContent = "";
      $("h-empty").hidden = r.entries.length > 0;
      r.entries.forEach(function (e) {
        var state = e.ok === true ? ["ok", "printed"] : e.ok === false ? ["err", "failed"] : ["run", "printing"];
        var img = el("img", { alt: "", loading: "lazy", src: API + "/" + e.thumb });
        var btn = el("button", { type: "button", class: "btn small", text: "Reprint" });
        btn.disabled = !e.reprintable;
        btn.addEventListener("click", function () {
          btn.disabled = true;
          api("POST", "history/" + e.id + "/reprint", {}).then(function (r) { printedToast(r); },
            function (err) { toast("Reprint failed: " + err.message, false); })
            .then(function () { btn.disabled = false; loadHistory(); refreshStatus(); });
        });
        var what = e.kind + (e.template ? " · " + e.template : "") + " · via " + e.source;
        ul.appendChild(el("li", null,
          el("div", { class: "thumb" }, img),
          el("div", { class: "line" }, el("span", { text: fmtTime(e.at) }),
            el("span", { class: "badge " + state[0], text: state[1], title: e.error || "" })),
          el("div", { class: "sum", text: e.summary || "(image)" }),
          el("div", { class: "line" }, el("span", { text: what + " · " + e.copies + "×" + (e.size ? " · " + e.size.width + "×" + e.size.height : "") }), btn),
          e.error ? el("div", { class: "line", text: e.error }) : null));
      });
    }).catch(function (e) { toast("History: " + e.message, false); });
  }
  var clearArmed = false;
  $("h-clear").addEventListener("click", function () {
    if (!clearArmed) { clearArmed = true; $("h-clear").textContent = "Really clear?"; return; }
    clearArmed = false; $("h-clear").textContent = "Clear";
    api("DELETE", "history").then(loadHistory, function (e) { toast(e.message, false); });
  });
  $("h-refresh").addEventListener("click", loadHistory);
  loaders.history = loadHistory;

  // ---- diagnostics + queue ---------------------------------------------------------
  function kv(dl, rows) {
    dl.textContent = "";
    rows.forEach(function (r) {
      if (r[1] == null || r[1] === "") return;
      dl.appendChild(el("dt", { text: r[0] }));
      dl.appendChild(el("dd", { text: String(r[1]) }));
    });
  }
  function loadQueue() {
    return api("GET", "queue").then(function (q) {
      var ul = $("d-queue");
      ul.textContent = "";
      $("d-qempty").hidden = q.jobs.length > 0;
      $("d-qinfo").textContent = q.blocked ? "Waiting: " + q.blocked.message + " (since " + fmtTime(q.blocked.since) + ")" : "";
      q.jobs.forEach(function (j) {
        var cls = j.state === "failed" || j.state === "expired" ? "err" : j.state === "printing" ? "run" : "";
        var actions = el("span");
        if (j.state === "failed" || j.state === "expired") {
          actions.appendChild(el("button", { type: "button", class: "btn small", text: "Retry", onclick: function () {
            api("POST", "queue/" + j.id + "/retry", {}).then(function () { toast("Queued again"); loadQueue(); }, function (e) { toast(e.message, false); });
          } }));
        }
        if (j.state !== "printing") {
          actions.appendChild(el("button", { type: "button", class: "btn small danger", text: j.state === "queued" ? "Cancel" : "Remove", onclick: function () {
            api("DELETE", "queue/" + j.id).then(function () { loadQueue(); refreshStatus(); }, function (e) { toast(e.message, false); });
          } }));
        }
        ul.appendChild(el("li", null,
          el("div", null,
            el("div", { text: (j.summary || j.kind) + " · via " + j.source }),
            el("div", { class: "sub", text: fmtTime(j.created_at) + (j.last_error ? " · " + j.last_error : "") })),
          el("span", { class: "row" }, el("span", { class: "badge " + cls, text: j.state }), actions)));
      });
    }).catch(function (e) { toast("Queue: " + e.message, false); });
  }
  function loadDiag() {
    loadQueue();
    return api("GET", "diag").then(function (d) {
      var p = d.printer || {};
      var s = d.status || {};
      kv($("d-kv"), [
        ["Status", s.status + (s.detail ? " — " + s.detail : "")],
        ["Transport", d.transport.configured + (d.transport.active ? " → " + d.transport.active : "") + (d.transport.would_use_now && !d.transport.active ? " (would use " + d.transport.would_use_now + ")" : "")],
        ["Address", s.address],
        ["Model", p.model], ["Serial", p.serial], ["Firmware", p.firmware], ["Hardware", p.hardware],
        ["Battery", s.battery != null ? s.battery + " %" : null],
        ["Signal", d.bluetooth.printer_rssi && d.bluetooth.printer_rssi.rssi != null ? d.bluetooth.printer_rssi.rssi + " dBm" : null],
        ["Bluetooth adapter", d.bluetooth.adapter],
        ["Remembered printer", d.bluetooth.remembered_printer ? (d.bluetooth.remembered_printer.name || "") + " " + d.bluetooth.remembered_printer.address : null],
        ["USB devices", d.usb.length ? d.usb.map(function (u) { return u.address + (u.niimbot ? " (NIIMBOT)" : ""); }).join(", ") : "none"],
        ["Print task", s.print_task], ["Density", s.density],
        ["Last error", s.last_error ? s.last_error + " (" + fmtTime(s.last_error_at) + ")" : null],
        ["Versions", "add-on " + d.version + " · niimblue-node " + d.versions["niimblue-node"] + " · niimbluelib " + d.versions.niimbluelib + " · noble " + d.versions.noble],
      ]);
      var ev = $("d-events");
      ev.textContent = "";
      d.events.forEach(function (e) { ev.appendChild(el("li", { text: fmtTime(e.at) + "  " + e.type + (e.detail ? ": " + e.detail : "") })); });
      $("d-raw").textContent = JSON.stringify(d, null, 2);
    }).catch(function (e) { toast("Diagnostics: " + e.message, false); });
  }
  $("d-qrefresh").addEventListener("click", loadDiag);
  var qClearArmed = false;
  $("d-qclear").addEventListener("click", function () {
    if (!qClearArmed) { qClearArmed = true; $("d-qclear").textContent = "Really clear?"; return; }
    qClearArmed = false; $("d-qclear").textContent = "Clear";
    api("DELETE", "queue").then(function (r) { toast(r.message); loadQueue(); refreshStatus(); }, function (e) { toast(e.message, false); });
  });
  $("d-test").addEventListener("click", function () {
    var b = $("d-test");
    b.disabled = true;
    api("POST", "test", {}).then(printedToast, function (e) { toast("Test print: " + e.message, false); })
      .then(function () { b.disabled = false; loadDiag(); });
  });
  $("d-scan").addEventListener("click", function () {
    var b = $("d-scan");
    b.disabled = true; b.textContent = "Scanning…";
    var box = $("d-scanres");
    api("GET", "scan?seconds=8").then(function (r) {
      box.textContent = "";
      var ul = el("ul", { class: "list" });
      r.usb.forEach(function (u) { ul.appendChild(el("li", null, el("span", { text: "USB " + u.address }), el("span", { class: "badge", text: "usb" }))); });
      r.ble.forEach(function (d) {
        ul.appendChild(el("li", null, el("span", { text: (d.name || "?") + "  " + d.address }),
          el("span", { class: "badge", text: d.rssi != null ? d.rssi + " dBm" : "ble" })));
      });
      box.appendChild(el("p", { class: "hint", text: (r.usb.length + r.ble.length) + " printer(s) found" +
        (r.ble_other_devices ? ", " + r.ble_other_devices + " other Bluetooth device(s)" : "") + (r.ble_error ? " · Bluetooth: " + r.ble_error : "") }));
      box.appendChild(ul);
    }, function (e) { toast("Scan: " + e.message, false); })
      .then(function () { b.disabled = false; b.textContent = "Scan"; });
  });
  loaders.diag = loadDiag;

  // ---- start ----------------------------------------------------------------------
  loadQuick(store("quick"));
  showTab(store("tab") || "designer");
  refreshStatus();
  setInterval(function () { if (!document.hidden) refreshStatus(); }, 5000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refreshStatus(); });
})();
