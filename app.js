/* ============================================================
   app.js — application state and orchestration
   - Image list state (order == PDF order)
   - Uploads: file picker, drag & drop, clipboard paste
   - Validation: type, corruption, size, duplicates
   - Edit operations (rotate / flip / crop / reset)
   - Settings panel binding + dirty tracking
   - Keyboard shortcuts
   ============================================================ */
"use strict";

window.I2P = window.I2P || {};

I2P.app = (() => {
  const { $, $$, toast, formatBytes } = I2P.ui;

  const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];
  const EXT_RE = /\.(jpe?g|png|webp)$/i;
  const MAX_FILE_BYTES = 80 * 1024 * 1024;   // refuse absurd single files
  const WARN_PIXELS = 50e6;                  // ~50 MP: decodes may be slow

  const state = {
    images: [],     // ordered list of image items
    dirty: true,    // true when the last generated PDF is stale
  };

  let uid = 0;

  /* ============================================================
     State helpers
     ============================================================ */

  function getItem(id) {
    return state.images.find((it) => it.id === id) || null;
  }

  function setDirty(v = true) {
    state.dirty = v;
  }

  function touch(item) {
    item.editVersion++;
    setDirty(true);
    I2P.pdf.updateEstimate();
  }

  function readSettings() {
    const bgSel = $("#bgSelect").value;
    return {
      pageSize:   $("#pageSize").value,
      customW:    clampNum($("#customW").value, 30, 2000, 210),
      customH:    clampNum($("#customH").value, 30, 2000, 297),
      orientation: $$('input[name="orientation"]').find((r) => r.checked).value,
      margin:     clampNum($("#margin").value, 0, 40, 10),
      background: bgSel === "custom" ? $("#bgCustom").value : bgSel,
      perPage:    parseInt($$('input[name="perPage"]').find((r) => r.checked).value, 10),
      fitMode:    $("#fitMode").value,
      quality:    clampNum($("#quality").value, 10, 100, 80),
      pnPos:      $("#pnPos").value,
      pnSize:     clampNum($("#pnSize").value, 6, 36, 10),
      pnColor:    $("#pnColor").value,
      wmOn:       $("#wmOn").checked,
      wmText:     $("#wmText").value,
      wmSize:     clampNum($("#wmSize").value, 8, 120, 42),
      wmRot:      clampNum($("#wmRot").value, -90, 90, 45),
      wmOpacity:  clampNum($("#wmOpacity").value, 5, 100, 20),
      wmPos:      $("#wmPos").value,
      filename:   sanitizeFilename($("#filename").value),
    };
  }

  function clampNum(v, min, max, fallback) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  function sanitizeFilename(name) {
    const clean = String(name).replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "").trim();
    return clean || "images";
  }

  /* ============================================================
     Adding images
     ============================================================ */

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    let added = 0, skipped = 0;

    for (const file of files) {
      // Type check (some OSes give pasted files an empty type — fall back to extension).
      const typeOk = ACCEPTED.includes(file.type) || (!file.type && EXT_RE.test(file.name));
      if (!typeOk) {
        toast(`Skipped "${file.name}" — only JPG, PNG and WEBP are supported.`, "warning");
        skipped++;
        continue;
      }

      if (file.size > MAX_FILE_BYTES) {
        toast(`Skipped "${file.name}" — over ${formatBytes(MAX_FILE_BYTES)}.`, "warning");
        skipped++;
        continue;
      }

      // Duplicate check (same name + byte size).
      if (state.images.some((it) => it.name === file.name && it.size === file.size)) {
        toast(`Skipped duplicate "${file.name}".`, "warning");
        skipped++;
        continue;
      }

      // Decode to validate the file and read its dimensions.
      let dims;
      try {
        dims = await readDimensions(file);
      } catch (_) {
        toast(`Skipped "${file.name}" — the file appears to be corrupted or unreadable.`, "error");
        skipped++;
        continue;
      }

      if (dims.w * dims.h > WARN_PIXELS) {
        toast(`"${file.name}" is very large (${dims.w}×${dims.h}); previews may be slow.`, "warning");
      }

      const item = {
        id: `img-${++uid}`,
        file,
        name: file.name || `pasted-${uid}.png`,
        size: file.size,
        width: dims.w,
        height: dims.h,
        rotation: 0,
        flipH: false,
        flipV: false,
        croppedBlob: null,     // working source after a crop
        srcVersion: 0,         // bumps when the source blob changes
        editVersion: 0,        // bumps on any visual change
        _thumbVersion: -1,
        _pdfCache: null,
        _bitmap: null,
        _bitmapVersion: -1,
      };

      state.images.push(item);
      I2P.preview.addCard(item);
      added++;
    }

    if (added) {
      toast(`Added ${added} image${added > 1 ? "s" : ""}.`, "success");
      setDirty(true);
      I2P.pdf.updateEstimate();
    }
    syncChrome();
  }

  /** Decode just enough of a file to get its natural pixel dimensions. */
  function readDimensions(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        if (!img.naturalWidth || !img.naturalHeight) reject(new Error("empty image"));
        else resolve({ w: img.naturalWidth, h: img.naturalHeight });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode error")); };
      img.src = url;
    });
  }

  /* ============================================================
     Removing & ordering
     ============================================================ */

  function disposeItem(item) {
    if (item._bitmap && item._bitmap.close) { try { item._bitmap.close(); } catch (_) {} }
    item._bitmap = null;
    item._pdfCache = null;
    item.croppedBlob = null;
  }

  function removeImage(id) {
    const idx = state.images.findIndex((it) => it.id === id);
    if (idx === -1) return;
    const [item] = state.images.splice(idx, 1);
    disposeItem(item);
    I2P.preview.removeCard(id);
    setDirty(true);
    I2P.pdf.updateEstimate();
    syncChrome();
    toast(`Removed ${item.name}.`, "info");
  }

  function clearAll() {
    if (!state.images.length) return;
    state.images.forEach(disposeItem);
    state.images.length = 0;
    I2P.preview.clearAllCards();
    setDirty(true);
    I2P.pdf.updateEstimate();
    syncChrome();
    toast("Cleared all images.", "info");
  }

  /** Apply a new order (array of ids) coming from drag-and-drop. */
  function reorder(idOrder) {
    const map = new Map(state.images.map((it) => [it.id, it]));
    const next = idOrder.map((id) => map.get(id)).filter(Boolean);
    if (next.length === state.images.length) {
      state.images.splice(0, state.images.length, ...next);
      setDirty(true);
    }
  }

  /* ============================================================
     Edits
     ============================================================ */

  function rotate(item, deg) {
    item.rotation = ((item.rotation + deg) % 360 + 360) % 360;
    touch(item);
    I2P.preview.refreshCard(item);
  }

  function flip(item, axis) {
    // Under 90°/270° rotation the visual horizontal/vertical axes swap.
    const swapped = item.rotation === 90 || item.rotation === 270;
    const prop = (axis === "h") !== swapped ? "flipH" : "flipV";
    item[prop] = !item[prop];
    touch(item);
    I2P.preview.refreshCard(item);
  }

  /** Called by crop.js: the crop result becomes the new working source. */
  function applyCrop(item, blob) {
    item.croppedBlob = blob;
    // The crop was taken from the rendered view, so transforms are baked in.
    item.rotation = 0;
    item.flipH = false;
    item.flipV = false;
    item.srcVersion++;
    // Update displayed dimensions from the new source lazily:
    readDimensions(blob).then((d) => {
      item.width = d.w; item.height = d.h;
      I2P.preview.refreshCard(item);
    }).catch(() => {});
    touch(item);
    I2P.preview.refreshCard(item);
  }

  function resetEdits(item) {
    if (!I2P.preview.isEdited(item)) { toast("No edits to reset on this image.", "info"); return; }
    item.croppedBlob = null;
    item.rotation = 0;
    item.flipH = false;
    item.flipV = false;
    item.srcVersion++;
    readDimensions(item.file).then((d) => {
      item.width = d.w; item.height = d.h;
      I2P.preview.refreshCard(item);
    }).catch(() => {});
    touch(item);
    I2P.preview.refreshCard(item);
    toast(`Reset edits on ${item.name}.`, "info");
  }

  /* ============================================================
     Chrome (header + empty state) sync
     ============================================================ */

  function syncChrome() {
    const n = state.images.length;
    $("#countChip").textContent = `${n} image${n === 1 ? "" : "s"}`;
    $("#btnClear").disabled = n === 0;
    $("#btnGenerate").disabled = n === 0;
    $("#btnDownload").disabled = n === 0;
    $("#gridHint").hidden = n < 2;
    $("#dropzone").classList.toggle("compact", n > 0);
  }

  /* ============================================================
     Generate / download flow
     ============================================================ */

  async function generateAndPreview() {
    const blob = await I2P.pdf.generate();
    if (blob) I2P.pdf.openPreview();
  }

  async function downloadFlow() {
    // Reuse the last PDF if nothing changed; otherwise rebuild first.
    if (I2P.pdf.hasFreshResult()) { I2P.pdf.download(); return; }
    const blob = await I2P.pdf.generate();
    if (blob) I2P.pdf.download();
  }

  /* ============================================================
     Wiring
     ============================================================ */

  document.addEventListener("DOMContentLoaded", () => {
    const dropzone = $("#dropzone");
    const fileInput = $("#fileInput");

    /* ---- picker ---- */
    const openPicker = () => fileInput.click();
    $("#btnAdd").addEventListener("click", openPicker);
    dropzone.addEventListener("click", openPicker);
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
    });
    fileInput.addEventListener("change", () => {
      addFiles(fileInput.files);
      fileInput.value = "";   // allow re-selecting the same files
    });

    /* ---- drag & drop (accept drops anywhere on the page) ---- */
    let dragDepth = 0;
    document.addEventListener("dragenter", (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
        dragDepth++;
        dropzone.classList.add("dragover");
      }
    });
    document.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dropzone.classList.remove("dragover");
    });
    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      dropzone.classList.remove("dragover");
      if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    /* ---- clipboard paste ---- */
    document.addEventListener("paste", (e) => {
      if (e.target.matches("input, textarea")) return;   // don't hijack text fields
      const files = [];
      for (const clip of e.clipboardData ? e.clipboardData.items : []) {
        if (clip.kind === "file") {
          const f = clip.getAsFile();
          if (f) {
            // Pasted screenshots are usually all called "image.png" — make them unique.
            const named = new File([f], f.name === "image.png" ? `pasted-${Date.now()}.png` : f.name, { type: f.type });
            files.push(named);
          }
        }
      }
      if (files.length) { e.preventDefault(); addFiles(files); }
    });

    /* ---- header actions ---- */
    $("#btnClear").addEventListener("click", clearAll);

    /* ---- generate & download ---- */
    $("#btnGenerate").addEventListener("click", generateAndPreview);
    $("#btnDownload").addEventListener("click", downloadFlow);

    /* ---- settings: conditional rows ---- */
    $("#pageSize").addEventListener("change", () => {
      $("#customSizeRow").hidden = $("#pageSize").value !== "custom";
    });
    $("#bgSelect").addEventListener("change", () => {
      $("#bgCustom").hidden = $("#bgSelect").value !== "custom";
    });
    $("#pnPos").addEventListener("change", () => {
      $(".pn-extra").hidden = $("#pnPos").value === "none";
    });
    $("#wmOn").addEventListener("change", () => {
      $(".wm-extra").hidden = !$("#wmOn").checked;
    });

    /* ---- settings: live outputs ---- */
    $("#margin").addEventListener("input", () => { $("#marginOut").value = $("#margin").value; });
    $("#quality").addEventListener("input", () => { $("#qualityOut").value = $("#quality").value; });
    $("#wmOpacity").addEventListener("input", () => { $("#wmOpacityOut").value = $("#wmOpacity").value; });

    /* ---- any settings change marks the PDF stale ---- */
    document.querySelector(".sidebar").addEventListener("change", () => {
      setDirty(true);
      I2P.pdf.updateEstimate();
    });

    /* ---- keyboard shortcuts ---- */
    document.addEventListener("keydown", (e) => {
      const meta = e.ctrlKey || e.metaKey;
      const typing = e.target.matches("input, textarea, select");
      if (meta && e.key.toLowerCase() === "o") { e.preventDefault(); openPicker(); }
      else if (meta && e.key === "Enter" && !$("#btnGenerate").disabled && !I2P.ui.anyModalOpen()) {
        e.preventDefault(); generateAndPreview();
      }
      else if ((e.key === "Delete" || e.key === "Backspace") && !typing && !I2P.ui.anyModalOpen()) {
        const card = e.target.closest && e.target.closest(".image-card");
        if (card) { e.preventDefault(); removeImage(card.dataset.id); }
      }
    });

    /* ---- warn before leaving with unsaved work ---- */
    window.addEventListener("beforeunload", (e) => {
      if (state.images.length && state.dirty) { e.preventDefault(); e.returnValue = ""; }
    });

    syncChrome();
    I2P.pdf.updateEstimate();
  });

  return {
    state, getItem, setDirty, readSettings,
    addFiles, removeImage, clearAll, reorder,
    rotate, flip, applyCrop, resetEdits,
  };
})();
