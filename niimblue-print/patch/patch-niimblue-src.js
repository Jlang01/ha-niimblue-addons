// Build-time patches to the NiimBlue source (run in the cloned /src before
// `vite build`). Written against NiimBlue v2026.10.1 (pinned in the
// Dockerfile). Adapts the UI for host-side printing and adds what the add-on
// needs on top:
//   1. BrowserWarning -> nothing (no "browser doesn't support bluetooth/serial")
//   2. PrintPreview   -> the preview's own Print button prints VIA HOST
//      (window.NIIMBLUE_HOST from our injected config.js), always enabled, all
//      pages (CSV); the browser "system printer" button is removed; grayscale
//      post-processing is disabled (the host prints black/white only).
//   3. LabelDesigner  -> object clipboard: Ctrl+C / Ctrl+X / Ctrl+V copy, cut
//      and paste designer objects (NiimBlue itself only pastes OS text/images).
//      + window.nbhostDesigner { exportLabel(), open(label) } for the add-on:
//      prints carry their editable design; history / image templates open
//      in the designer.
//   4. LabelPropsEditor -> "Use detected roll" button (size, direction and
//      lane split of the roll in the printer) + warnings when the size does
//      not fit that roll.
// A patch that does not apply FAILS the build: otherwise e.g. the preview's
// Print button would silently fall back to Web Bluetooth (which cannot reach
// the printer on the HA host). Re-check these anchors when bumping NiimBlue.
const fs = require("fs");

function must(cond, msg) {
  if (!cond) {
    console.error("[patch-src] ERROR:", msg);
    process.exit(1);
  }
}

/** Replace exactly one occurrence of `anchor` (string or regex) or fail. */
function replaceOnce(src, anchor, replacement, what) {
  if (typeof anchor === "string") {
    const n = src.split(anchor).length - 1;
    must(n === 1, `${what}: anchor found ${n} times (expected 1)`);
    return src.replace(anchor, () => replacement);
  }
  const m = src.match(new RegExp(anchor.source, anchor.flags.replace("g", "") + "g"));
  must(m && m.length === 1, `${what}: pattern matched ${m ? m.length : 0} times (expected 1)`);
  return src.replace(anchor, () => replacement);
}

function patchFile(file, fn) {
  must(fs.existsSync(file), `${file} not found`);
  const before = fs.readFileSync(file, "utf8");
  const after = fn(before);
  must(after !== before, `${file}: nothing changed`);
  fs.writeFileSync(file, after);
}

// 1) Silence the unsupported-browser banner ------------------------------
const bw = "src/components/basic/BrowserWarning.svelte";
must(fs.existsSync(bw), "BrowserWarning.svelte not found");
fs.writeFileSync(bw, '<script lang="ts"></script>\n');
console.log("[patch-src] BrowserWarning emptied");

// 2) PrintPreview: host-print the preview canvas -------------------------
patchFile("src/components/dialogs/PrintPreview.svelte", (s) => {
  // Own state: NiimBlue's printState drives its Web Bluetooth progress/cancel UI.
  const hostFn = `  let hostPrinting = $state(false);
  const onPrintViaHost = async () => {
    hostPrinting = true; error = "";
    const shown = currentPage;
    try {
      // every page (CSV rows), as the preview renders it: post-processing,
      // offset and mirror applied; niimbluelib's encoder pads columns itself
      const pages = [];
      for (let p = 0; p < pagesTotal; p++) {
        currentPage = p;
        await generatePreviewData(p);
        pages.push({
          imageBase64: previewCanvas.toDataURL("image/png").replace(/^data:image\\/\\w+;base64,/, ""),
          quantity: params.quantity,
        });
      }
      const cfg = window.NIIMBLUE_HOST || {};
      // the design itself, so the history can open it in the designer again
      const design = { canvas: canvasCallback(), label: $state.snapshot(labelProps), ...(csvEnabled ? { csv: { data: csvData } } : {}) };
      const body = { pages, printDirection: labelProps.printDirection || "top", density: params.density, quantity: params.quantity, design };
      if (cfg.model) body.printTask = cfg.model;
      const r = await fetch((cfg.apiBase || "../api") + "/print", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const t = await r.text();
      if (r.status === 202) { error = "Queued: the printer is not reachable right now, the label prints as soon as it is (see the Queue in the Diagnostics tab)."; }
      else if (r.status === 504) { error = "Still printing or queued (the request timed out). Check the queue before printing again."; }
      else if (!r.ok) { let m = t; try { m = JSON.parse(t).error || m; } catch (e) {} error = "Host print error: " + m; }
      else { Toasts.message(pages.length > 1 ? \`Printed \${pages.length} pages\` : "Printed"); }
    } catch (e) { error = String(e); }
    if (currentPage !== shown) { currentPage = shown; await generatePreviewData(shown); }
    hostPrinting = false;
  };

`;
  s = replaceOnce(s, "  const onPrintOnSystemPrinter = async () => {", hostFn + "  const onPrintOnSystemPrinter = async () => {",
    "onPrintViaHost injection");
  console.log("[patch-src] onPrintViaHost injected");

  s = replaceOnce(s,
    /\s*<button\s+type="button"\s+class="btn btn-secondary"\s+title=\{\$tr\("preview\.print\.system"\)\}\s+onclick=\{onPrintOnSystemPrinter\}>[\s\S]*?<\/button>/,
    "", "system-printer button");
  console.log("[patch-src] system-printer button removed");

  s = replaceOnce(s,
    /<button type="button" class="btn btn-primary" disabled=\{\$disconnected \|\| printState !== "idle"\} onclick=\{onPrint\}>[\s\S]*?<\/button>/,
    '<button type="button" class="btn btn-primary" disabled={hostPrinting} onclick={onPrintViaHost}>\n' +
    '      {#if hostPrinting}\n' +
    '        <span class="spinner-border spinner-border-sm"></span> {$tr("preview.print.state.sending")}\n' +
    '      {:else}\n' +
    '        <MdIcon icon="print" /> {$tr("preview.print")}\n' +
    '      {/if}\n' +
    "    </button>",
    "primary print button");
  console.log("[patch-src] primary print button repurposed to host");

  // The host prints 1-bit: grayscale would be thresholded at 50 % on the server.
  s = replaceOnce(s, '<option value="grayscale">',
    '<option value="grayscale" disabled title="Not available: the add-on prints black and white">',
    "grayscale option");
  console.log("[patch-src] grayscale post-process disabled");

  // A grayscale choice saved earlier (or locked) must not survive.
  s = replaceOnce(s, "    loadProps();\n",
    '    loadProps();\n    if (params.postProcess === "grayscale") params.postProcess = "threshold";\n',
    "grayscale reset after loadProps");

  // Toasts: make sure the import exists (it does in 2026.10.1).
  must(/import \{ Toasts \} from "\$\/utils\/toasts";/.test(s), "PrintPreview: Toasts import missing");
  return s;
});
must(fs.readFileSync("src/utils/toasts.ts", "utf8").includes("static message("), "Toasts.message() missing");

// 3) LabelDesigner: object clipboard -------------------------------------
patchFile("src/components/LabelDesigner.svelte", (s) => {
  const clipFns = `  // ---- [nbhost] object clipboard (Ctrl+C / Ctrl+X / Ctrl+V) ----------------
  // NiimBlue itself only pastes what the OS clipboard holds (text -> new text
  // box, image -> image), so Ctrl+C / Ctrl+V of a selected object pasted some
  // old text instead. Copy/cut now put the selected objects on the clipboard
  // in a private format (plus their text as text/plain for other apps) and
  // paste puts them back. Event based (no navigator.clipboard): works over
  // plain http, inside the Home Assistant frame and across browser tabs.
  const NBHOST_MIME = "application/x-niimblue-objects+json";
  let nbhostClip: { json: string; text: string } | null = null; // this tab's last copy
  let nbhostClipPreferred = false; // copied without a copy event: trust nbhostClip until the window loses focus
  let nbhostPasteN = 0; // pastes of nbhostClip so far: repeated pastes step down-right
  const NBHOST_PASTE_STEP = 10; // px per repeated paste (5 px read as a smudge)
  let nbhostCopyHandled = false;

  const nbhostCanUseObjects = (): boolean =>
    !!fabricCanvas &&
    fabricCanvas.getActiveObjects().length > 0 &&
    !LabelDesignerUtils.isAnyInputFocused(fabricCanvas) &&
    document.querySelectorAll(".dropdown-menu.show, .modal.show").length === 0 &&
    !window.getSelection()?.toString();

  const nbhostSerializeSelection = (): { json: string; text: string } => {
    const canvas = fabricCanvas!;
    const objs = canvas.getActiveObjects();
    // leave the multi-selection so every object reports canvas coordinates
    const multi = canvas.getActiveObject() instanceof fabric.ActiveSelection;
    if (multi) canvas.discardActiveObject();
    const objects = objs.map((o) => o.toObject());
    if (multi) canvas.setActiveObject(new fabric.ActiveSelection(objs));
    canvas.requestRenderAll();
    const text = objs
      .filter((o) => o instanceof fabric.FabricText)
      .map((o) => (o as fabric.FabricText).text)
      .join("\\n");
    return { json: JSON.stringify({ niimblue: 1, objects }), text };
  };

  const nbhostCopy = (event: ClipboardEvent | null, cut: boolean): boolean => {
    if (!nbhostCanUseObjects()) return false;
    const clip = nbhostSerializeSelection();
    nbhostClip = clip;
    nbhostPasteN = cut ? 0 : 1;
    if (event && event.clipboardData) {
      event.preventDefault();
      event.clipboardData.setData(NBHOST_MIME, clip.json);
      event.clipboardData.setData("text/plain", clip.text);
      nbhostClipPreferred = false;
    } else {
      nbhostClipPreferred = true;
    }
    if (cut) {
      deleteSelected();
      undo.push(fabricCanvas!, labelProps);
    }
    return true;
  };
  const nbhostOnCopy = (event: ClipboardEvent) => { nbhostCopyHandled = true; nbhostCopy(event, false); };
  const nbhostOnCut = (event: ClipboardEvent) => { nbhostCopyHandled = true; nbhostCopy(event, true); };
  // Some browsers fire no copy event while no page text is selected: then
  // keep the objects in this tab only.
  const nbhostArmCopyFallback = (cut: boolean) => {
    nbhostCopyHandled = false;
    setTimeout(() => { if (!nbhostCopyHandled) nbhostCopy(null, cut); }, 0);
  };
  const nbhostOnBlur = () => { nbhostClipPreferred = false; };

  const nbhostPlace = async (objects: object[], shift: number) => {
    const canvas = fabricCanvas!;
    const objs = (await fabric.util.enlivenObjects(objects)) as fabric.FabricObject[];
    if (objs.length === 0) return;
    for (const o of objs) {
      o.set({ left: o.left + shift, top: o.top + shift, snapAngle: OBJECT_DEFAULTS.snapAngle });
      // pasted into a smaller label: keep it reachable
      if (o.left > labelProps.size.width - GRID_SIZE) o.set({ left: 0 });
      if (o.top > labelProps.size.height - GRID_SIZE) o.set({ top: 0 });
      o.setCoords();
    }
    canvas.discardActiveObject();
    canvas.add(...objs);
    canvas.setActiveObject(objs.length === 1 ? objs[0] : new fabric.ActiveSelection(objs));
    canvas.requestRenderAll();
    undo.push(canvas, labelProps);
  };

  /** Paste our objects if the clipboard holds them. Sync: preventDefault must happen now. */
  const nbhostPasteObjects = (event: ClipboardEvent): boolean => {
    const data = event.clipboardData;
    let json = data ? data.getData(NBHOST_MIME) : "";
    let fromThisTab = !!nbhostClip && json === nbhostClip.json;
    if (!json && nbhostClip && data) {
      // no private data (copied without a copy event, or the browser dropped
      // the custom type): use this tab's copy if the clipboard still matches it
      const text = data.getData("text/plain");
      const hasImage = Array.from(data.items).some((i) => i.type.includes("image"));
      if (nbhostClipPreferred || (!hasImage && text !== "" && text === nbhostClip.text)) {
        json = nbhostClip.json;
        fromThisTab = true;
      }
    }
    if (!json) return false;
    let parsed: { objects?: object[] } | null = null;
    try { parsed = JSON.parse(json); } catch (e) { return false; }
    if (!parsed || !Array.isArray(parsed.objects) || parsed.objects.length === 0) return false;
    event.preventDefault();
    const shift = fromThisTab ? NBHOST_PASTE_STEP * nbhostPasteN : 0;
    if (fromThisTab) nbhostPasteN++;
    nbhostPlace(parsed.objects, shift).catch((e) => Toasts.error(e));
    return true;
  };

`;
  s = replaceOnce(s, "  const onPaste = async (event: ClipboardEvent) => {", clipFns + "  const onPaste = async (event: ClipboardEvent) => {",
    "object clipboard functions");

  // paste: our objects first, else NiimBlue's OS text/image paste
  s = replaceOnce(s,
    "    if (event.clipboardData != null) {\n      event.preventDefault();\n      const obj = await LabelDesignerObjectHelper.addObjectFromClipboard",
    "    if (nbhostPasteObjects(event)) {\n      return;\n    }\n\n" +
    "    if (event.clipboardData != null) {\n      event.preventDefault();\n      const obj = await LabelDesignerObjectHelper.addObjectFromClipboard",
    "onPaste hook");

  // Ctrl+C / Ctrl+X: let the browser fire copy/cut (no preventDefault); the
  // fallback runs only if it does not
  s = replaceOnce(s, "    // Ctrl + D\n",
    '    // [nbhost] Ctrl + C / Ctrl + X (objects)\n    if (cmdOrCtrl && (key === "c" || key === "x") && !e.shiftKey && !e.altKey) {\n' +
    '      if (nbhostCanUseObjects()) nbhostArmCopyFallback(key === "x");\n      return;\n    }\n\n    // Ctrl + D\n',
    "Ctrl+C/X key handler");

  s = replaceOnce(s, "onpaste={onPaste} />",
    "onpaste={onPaste} oncopy={nbhostOnCopy} oncut={nbhostOnCut} onblur={nbhostOnBlur} />",
    "window copy/cut listeners");

  for (const need of ["import * as fabric from \"fabric\";", "GRID_SIZE", "OBJECT_DEFAULTS", "import { Toasts }"]) {
    must(s.includes(need), `LabelDesigner: ${need} not available`);
  }
  console.log("[patch-src] object clipboard (Ctrl+C/X/V) added");

  // window.nbhostDesigner: the add-on's print bar exports the editable design
  // with every print / image template, the sidebar shell opens history
  // entries and templates ("Open in designer") through open().
  s = replaceOnce(s, "  import {\n    type ExportedLabelTemplate,\n",
    "  import {\n    ExportedLabelTemplateSchema,\n    type ExportedLabelTemplate,\n", "ExportedLabelTemplateSchema import");
  s = replaceOnce(s, '    window.addEventListener("hashchange", loadLabelFromUrl);\n',
    '    window.addEventListener("hashchange", loadLabelFromUrl);\n' +
    "    // [nbhost] hooks for the add-on (print bar, sidebar shell)\n" +
    "    (window as any).nbhostDesigner = {\n" +
    "      exportLabel: () => {\n" +
    "        const l: any = exportCurrentLabel();\n" +
    "        delete l.thumbnailBase64;\n" +
    "        return l;\n" +
    "      },\n" +
    "      open: async (raw: unknown): Promise<boolean> => {\n" +
    "        const label = ExportedLabelTemplateSchema.parse(raw);\n" +
    "        if (hasUnsavedChanges) {\n" +
    "          const r = await appConfirm({ title: \"Replace the label in the designer? Its unsaved changes are lost.\", buttons: [\"yes\", \"no\"] });\n" +
    "          if (r !== \"yes\") return false;\n" +
    "        }\n" +
    "        onLoadRequested(label);\n" +
    "        return true;\n" +
    "      },\n" +
    "    };\n",
    "nbhostDesigner hooks");
  for (const need of ["const exportCurrentLabel = ", "const onLoadRequested = ", "import { appConfirm }", "let hasUnsavedChanges"]) {
    must(s.includes(need), `LabelDesigner: ${need} not available`);
  }
  console.log("[patch-src] designer hooks (export / open) added");
  return s;
});

// 4) LabelPropsEditor: "Use detected roll" + fit warnings ------------------
// The add-on knows the roll in the printer (RFID -> NIIMBOT cloud, incl. the
// lane count of multi-lane rolls like "T10*20/4L"): /api/status -> label.
// designer = { printDirection, width, height (px), split, splitParts, lanes,
// lane_width_mm, lane_height_mm } (label-size.js designerLayout). The button
// fills the form like a preset (Apply still applies); warnings check the
// FORM values, so they update while editing.
patchFile("src/components/dialogs/LabelPropsEditor.svelte", (s) => {
  const state = `  let modalRef: AppModal;

  // [nbhost] label roll detected by the add-on
  type NbhostDesigner = {
    printDirection: PrintDirection; width: number; height: number; split: LabelSplit; splitParts: number;
    lanes: number; lane_width_mm: number; lane_height_mm: number;
  };
  type NbhostRoll = { name?: string | null; barcode?: string; width_mm?: number | null; height_mm?: number | null; designer?: NbhostDesigner | null };
  let nbhostRoll = $state<NbhostRoll | null>((window as any).NIIMBLUE_LABEL ?? null);
  const nbhostLoadRoll = async () => {
    try {
      const cfg = (window as any).NIIMBLUE_HOST || {};
      const r = await fetch((cfg.apiBase || "../api") + "/status", { cache: "no-store" });
      if (r.ok) nbhostRoll = (await r.json()).label ?? null;
    } catch (e) {
      /* keep the value from page load */
    }
  };
  onMount(() => {
    nbhostLoadRoll();
  });
  const nbhostRollName = $derived(nbhostRoll ? nbhostRoll.name || nbhostRoll.barcode || "?" : "");
  const nbhostUseRoll = () => {
    const d = nbhostRoll?.designer;
    if (!d) return;
    prevUnit = "px";
    unit = "px";
    width = d.width;
    height = d.height;
    printDirection = d.printDirection;
    if (d.lanes > 1) {
      shape = shape === "circle" ? "rect" : shape;
      split = d.split;
      splitParts = d.splitParts;
      if (mirror === "flip" && d.splitParts !== 2) mirror = "copy";
    } else {
      if (shape === "circle" && width !== height) shape = "rect";
      split = "none";
      mirror = "none";
    }
    tailLength = 0;
    selectedPresetIndex = -1;
  };
  // form values in px (what Apply would set)
  const nbhostRollWarnings = $derived.by<string[]>(() => {
    const d = nbhostRoll?.designer;
    if (!d) return [];
    const out: string[] = [];
    const k = unit === "mm" ? dpmm : 1;
    const top = printDirection === "top";
    const across = Math.round((top ? width : height) * k);
    const feed = Math.round((top ? height : width) * k);
    const rollAcross = d.printDirection === "top" ? d.width : d.height;
    const rollFeed = d.printDirection === "top" ? d.height : d.width;
    const roll = \`\${nbhostRollName} (\${top ? rollAcross : rollFeed}x\${top ? rollFeed : rollAcross} px in this direction)\`;
    if (across > rollAcross + 8) {
      out.push(\`Does not fit the roll in the printer: \${across} px across the printhead, the label is only \${rollAcross} px (\${roll}). The edges print beside the label.\`);
    } else if (Math.abs(across - rollAcross) > 8 || Math.abs(feed - rollFeed) > 8) {
      out.push(\`Size does not match the roll in the printer, \${roll}: prints are scaled to fit the label.\`);
    }
    if (d.lanes > 1) {
      const want = top ? "vertical" : "horizontal";
      if (split !== want || splitParts !== d.lanes) {
        out.push(\`The roll has \${d.lanes} labels side by side (one print = one row): set Label split to \${want}, \${d.lanes} parts, to design each label.\`);
      }
    }
    return out;
  });
`;
  s = replaceOnce(s, "  let modalRef: AppModal;\n", state, "roll state");

  s = replaceOnce(s, "  {#each warnings as line (line)}\n",
    '  {#if nbhostRoll?.designer}\n' +
    '    <div class="mb-2 d-flex align-items-center gap-2 flex-wrap">\n' +
    '      <button class="btn btn-sm btn-outline-info" onclick={nbhostUseRoll} title="Fill in the size of the label roll in the printer, then press Apply">\n' +
    '        <MdIcon icon="label" /> Use detected roll\n' +
    '      </button>\n' +
    '      <span class="text-secondary small">\n' +
    '        {nbhostRollName}{#if nbhostRoll.width_mm} · {nbhostRoll.width_mm}×{nbhostRoll.height_mm} mm{/if}\n' +
    '        {#if nbhostRoll.designer.lanes > 1}\n' +
    '          · {nbhostRoll.designer.lanes} labels side by side, each {nbhostRoll.designer.lane_width_mm}×{nbhostRoll.designer.lane_height_mm} mm.\n' +
    '          Mirror “copy” repeats the first label on all of them.\n' +
    '        {/if}\n' +
    '      </span>\n' +
    '    </div>\n' +
    '  {/if}\n\n' +
    '  {#each nbhostRollWarnings as line (line)}\n' +
    '    <div class="mb-1 text-warning">{line}</div>\n' +
    '  {/each}\n\n' +
    "  {#each warnings as line (line)}\n",
    "roll button + warnings markup");

  for (const need of ["import { onMount, tick } from \"svelte\";", "type LabelSplit,", "import type { PrintDirection }",
    "let selectedPresetIndex", "let prevUnit", "let dpmm", "let mirror", "let shape", "let tailLength", "import MdIcon"]) {
    must(s.includes(need), `LabelPropsEditor: ${need} not available`);
  }
  console.log("[patch-src] label props: detected roll button + fit warnings");
  return s;
});

console.log("[patch-src] done");
