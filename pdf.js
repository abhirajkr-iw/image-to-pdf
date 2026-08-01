/* ============================================================
   pdf.js — PDF layout + generation (jsPDF)
   - Grid layout engine for 1 / 2 / 4 / 6 / 9 images per page
   - Fit / Fill / Stretch placement, margins, backgrounds
   - Page numbers, text watermark, quality-controlled JPEG output
   - Per-image processing cache so re-generating after small
     changes only re-encodes what actually changed
   - In-memory preview (blob URL in an iframe) with page nav,
     zoom, and full screen
   ============================================================ */
"use strict";

window.I2P = window.I2P || {};

I2P.pdf = (() => {
  const { $, toast, progress, formatBytes, nextFrame, debounce } = I2P.ui;

  const PAGE_SIZES = {            // mm, portrait
    a4:     { w: 210, h: 297 },
    letter: { w: 215.9, h: 279.4 },
    legal:  { w: 215.9, h: 355.6 },
    a3:     { w: 297, h: 420 },
  };

  const RENDER_DPI = 150;                    // print-quality target
  const PX_PER_MM = RENDER_DPI / 25.4;
  const MAX_EDGE_PX = 4200;                  // memory guard per placed image

  let lastBlob = null;      // most recently generated PDF
  let lastUrl = null;       // blob: URL for the preview iframe
  let lastPageCount = 1;
  let previewPage = 1;
  let previewZoom = 100;    // percent, for viewers that honor #zoom=

  /* ============================================================
     Layout engine
     ============================================================ */

  /** Grid (cols × rows) for an images-per-page choice + orientation. */
  function gridFor(perPage, orientation) {
    const portrait = orientation === "portrait";
    switch (perPage) {
      case 1: return { cols: 1, rows: 1 };
      case 2: return portrait ? { cols: 1, rows: 2 } : { cols: 2, rows: 1 };
      case 4: return { cols: 2, rows: 2 };
      case 6: return portrait ? { cols: 2, rows: 3 } : { cols: 3, rows: 2 };
      case 9: return { cols: 3, rows: 3 };
      default: return { cols: 1, rows: 1 };
    }
  }

  /** Resolve page width/height in mm from settings (orientation applied). */
  function pageDims(s) {
    let { w, h } = s.pageSize === "custom"
      ? { w: s.customW, h: s.customH }
      : PAGE_SIZES[s.pageSize];
    if (s.orientation === "landscape") [w, h] = [h, w];
    return { w, h };
  }

  /**
   * Compute cell rectangles for one page.
   * The gutter between cells matches the page margin (capped) so the
   * grid reads as one composed sheet.
   */
  function cellRects(s) {
    const { w, h } = pageDims(s);
    const { cols, rows } = gridFor(s.perPage, s.orientation);
    const margin = Math.min(s.margin, w / 4, h / 4);   // never let margins eat the page
    const gutter = Math.min(margin, 8) || (s.perPage > 1 ? 4 : 0);

    const innerW = w - margin * 2 - gutter * (cols - 1);
    const innerH = h - margin * 2 - gutter * (rows - 1);
    const cellW = innerW / cols;
    const cellH = innerH / rows;

    const rects = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        rects.push({
          x: margin + c * (cellW + gutter),
          y: margin + r * (cellH + gutter),
          w: cellW,
          h: cellH,
        });
      }
    }
    return { rects, pageW: w, pageH: h };
  }

  /* ============================================================
     Image processing (with cache)
     ============================================================ */

  /**
   * Render one image for its cell and encode it as JPEG.
   * Cached per item under a key covering everything that affects the
   * output, so unchanged images are reused across generations.
   *
   * @returns {Promise<{dataUrl:string, wMM:number, hMM:number, xOff:number, yOff:number}>}
   *          placement is relative to the cell's top-left, in mm.
   */
  async function processForCell(item, cell, s) {
    const key = [
      item.srcVersion, item.rotation, item.flipH, item.flipV,
      s.fitMode, s.quality, s.background,
      cell.w.toFixed(1), cell.h.toFixed(1),
    ].join("|");

    if (item._pdfCache && item._pdfCache.key === key) return item._pdfCache.value;

    const edited = await I2P.preview.drawEdited(item, 0);   // full-res edited canvas
    const imgW = edited.width, imgH = edited.height;
    const cellAR = cell.w / cell.h;
    const imgAR = imgW / imgH;

    // --- decide placed size (mm) and source crop (px) per fit mode ---
    let wMM, hMM, sx = 0, sy = 0, sw = imgW, sh = imgH;

    if (s.fitMode === "fit") {
      if (imgAR > cellAR) { wMM = cell.w; hMM = cell.w / imgAR; }
      else                { hMM = cell.h; wMM = cell.h * imgAR; }
    } else if (s.fitMode === "fill") {
      wMM = cell.w; hMM = cell.h;
      if (imgAR > cellAR) { sw = Math.round(imgH * cellAR); sx = Math.round((imgW - sw) / 2); }
      else                { sh = Math.round(imgW / cellAR); sy = Math.round((imgH - sh) / 2); }
    } else { // stretch
      wMM = cell.w; hMM = cell.h;
    }

    // --- render to an output canvas at target DPI (capped) ---
    let outW = Math.round(wMM * PX_PER_MM);
    let outH = Math.round(hMM * PX_PER_MM);
    const cap = Math.min(1, MAX_EDGE_PX / Math.max(outW, outH));
    outW = Math.max(1, Math.round(outW * cap));
    outH = Math.max(1, Math.round(outH * cap));
    // Never upscale beyond the source pixels.
    const noUp = Math.min(1, sw / outW, sh / outH);
    if (noUp < 1) { outW = Math.max(1, Math.round(outW * noUp)); outH = Math.max(1, Math.round(outH * noUp)); }

    const canvas = document.createElement("canvas");
    canvas.width = outW; canvas.height = outH;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = s.background;               // JPEG has no alpha: bake page bg behind PNGs
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(edited, sx, sy, sw, sh, 0, 0, outW, outH);

    const dataUrl = canvas.toDataURL("image/jpeg", s.quality / 100);

    const value = {
      dataUrl, wMM, hMM,
      xOff: (cell.w - wMM) / 2,
      yOff: (cell.h - hMM) / 2,
      bytes: Math.round((dataUrl.length - "data:image/jpeg;base64,".length) * 0.75),
    };
    item._pdfCache = { key, value };
    return value;
  }

  /* ============================================================
     Page furniture: numbers & watermark
     ============================================================ */

  function hexToRgb(hex) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [51, 51, 51];
  }

  function drawPageNumber(doc, s, pageNum, totalPages, pageW, pageH) {
    if (s.pnPos === "none") return;
    const [r, g, b] = hexToRgb(s.pnColor);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(s.pnSize);
    doc.setTextColor(r, g, b);
    const label = `${pageNum} / ${totalPages}`;
    const pad = 7;
    if (s.pnPos === "bottom-center") doc.text(label, pageW / 2, pageH - pad, { align: "center" });
    else if (s.pnPos === "bottom-right") doc.text(label, pageW - pad, pageH - pad, { align: "right" });
    else if (s.pnPos === "top-right") doc.text(label, pageW - pad, pad + s.pnSize * 0.35, { align: "right" });
  }

  function drawWatermark(doc, s, pageW, pageH) {
    if (!s.wmOn || !s.wmText.trim()) return;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(s.wmSize);
    doc.setTextColor(120, 120, 120);

    const pad = 14;
    let x = pageW / 2, y = pageH / 2, align = "center";
    switch (s.wmPos) {
      case "top-left":     x = pad;         y = pad + s.wmSize * 0.35; align = "left";  break;
      case "top-right":    x = pageW - pad; y = pad + s.wmSize * 0.35; align = "right"; break;
      case "bottom-left":  x = pad;         y = pageH - pad;           align = "left";  break;
      case "bottom-right": x = pageW - pad; y = pageH - pad;           align = "right"; break;
    }

    let usedGState = false;
    try {
      if (doc.saveGraphicsState && doc.GState) {
        doc.saveGraphicsState();
        doc.setGState(new doc.GState({ opacity: s.wmOpacity / 100 }));
        usedGState = true;
      }
    } catch (_) { /* fall through to a light gray approximation */ }

    if (!usedGState) {
      const shade = Math.round(255 - (s.wmOpacity / 100) * 135);
      doc.setTextColor(shade, shade, shade);
    }

    doc.text(s.wmText, x, y, { align, angle: s.wmRot });
    if (usedGState) doc.restoreGraphicsState();
  }

  /* ============================================================
     Generation
     ============================================================ */

  /**
   * Build the PDF in memory.
   * @returns {Promise<Blob|null>} null if there was nothing to do
   */
  async function generate() {
    const items = I2P.app.state.images;
    const s = I2P.app.readSettings();

    if (!items.length) { toast("No images selected — add some first.", "warning"); return null; }
    if (typeof window.jspdf === "undefined") {
      toast("The PDF library hasn't loaded yet. Check your connection and reload once.", "error");
      return null;
    }

    const { rects, pageW, pageH } = cellRects(s);
    const perPage = rects.length;
    const totalPages = Math.ceil(items.length / perPage);

    progress.show(`Setting ${totalPages} page${totalPages > 1 ? "s" : ""}…`);
    await nextFrame();

    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({
        orientation: s.orientation,
        unit: "mm",
        format: s.pageSize === "custom" ? [pageW, pageH] : s.pageSize,
        compress: true,
      });

      for (let p = 0; p < totalPages; p++) {
        if (p > 0) doc.addPage([pageW, pageH], s.orientation);

        // Page background (skip pure white — that's the paper itself).
        if (s.background.toLowerCase() !== "#ffffff") {
          const [r, g, b] = hexToRgb(s.background);
          doc.setFillColor(r, g, b);
          doc.rect(0, 0, pageW, pageH, "F");
        }

        for (let cIdx = 0; cIdx < perPage; cIdx++) {
          const itemIdx = p * perPage + cIdx;
          if (itemIdx >= items.length) break;
          const item = items[itemIdx];
          const cell = rects[cIdx];

          progress.set(itemIdx / items.length, `Placing image ${itemIdx + 1} of ${items.length}…`);
          await nextFrame();

          const img = await processForCell(item, cell, s);
          doc.addImage(img.dataUrl, "JPEG", cell.x + img.xOff, cell.y + img.yOff, img.wMM, img.hMM);
        }

        drawWatermark(doc, s, pageW, pageH);
        drawPageNumber(doc, s, p + 1, totalPages, pageW, pageH);
      }

      progress.set(1, "Finishing PDF…");
      await nextFrame();

      const blob = doc.output("blob");
      setResult(blob, totalPages);
      return blob;

    } catch (err) {
      console.error(err);
      const oom = /memory|allocation|invalid array/i.test(String(err && err.message));
      toast(
        oom
          ? "Ran out of memory building the PDF. Lower the quality slider or work in smaller batches."
          : "Something went wrong while building the PDF. Try again, or lower the quality setting.",
        "error"
      );
      return null;
    } finally {
      progress.hide();
    }
  }

  function setResult(blob, pageCount) {
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastBlob = blob;
    lastUrl = URL.createObjectURL(blob);
    lastPageCount = pageCount;
    previewPage = 1;
    previewZoom = 100;
    I2P.app.setDirty(false);
    $("#btnDownload").disabled = false;
  }

  /** True if a generated PDF exists and settings/images haven't changed. */
  function hasFreshResult() {
    return !!lastBlob && !I2P.app.state.dirty;
  }

  /* ============================================================
     Preview modal (iframe over the in-memory blob)
     ============================================================ */

  function openPreview() {
    if (!lastBlob) return;
    updateFrame(true);
    I2P.ui.openModal("pdfModal");
  }

  function updateFrame(reset = false) {
    if (reset) { previewPage = 1; previewZoom = 100; }
    // #page / #zoom fragments are honored by Chrome, Edge and Firefox's
    // built-in viewers; other viewers simply ignore them.
    $("#pdfFrame").src = `${lastUrl}#page=${previewPage}&zoom=${previewZoom}`;
    $("#pdfPageInfo").textContent = `Page ${previewPage} / ${lastPageCount}`;
  }

  function download() {
    if (!lastBlob) return;
    const name = I2P.app.readSettings().filename || "images";
    const a = document.createElement("a");
    a.href = lastUrl;
    a.download = `${name}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(`Saved ${name}.pdf (${formatBytes(lastBlob.size)})`, "success");
  }

  /* ============================================================
     Size estimate (debounced; sampled at low resolution)
     ============================================================ */

  const updateEstimate = debounce(async () => {
    const el = $("#estimate");
    const items = I2P.app.state.images;
    if (!items.length) { el.textContent = "Estimated PDF size: —"; return; }

    const s = I2P.app.readSettings();
    el.textContent = "Estimated PDF size: calculating…";

    try {
      // JPEG size grows ~linearly with pixel count at a fixed quality,
      // so encode a small sample and scale by the real pixel budget.
      const { rects } = cellRects(s);
      const cell = rects[0];
      const cellPx = Math.min(cell.w * PX_PER_MM, MAX_EDGE_PX) * Math.min(cell.h * PX_PER_MM, MAX_EDGE_PX);

      let total = 0;
      const SAMPLE = 320;
      for (const item of items) {
        const canvas = await I2P.preview.drawEdited(item, SAMPLE);
        const ctx = canvas.getContext("2d");
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = s.background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", s.quality / 100);
        const sampleBytes = (dataUrl.length - 23) * 0.75;
        const samplePx = canvas.width * canvas.height;

        const dims = I2P.preview.effectiveDims(item);
        const targetPx = Math.min(dims.w * dims.h, cellPx);
        total += sampleBytes * (targetPx / samplePx);
      }
      total += 3000 + items.length * 400;   // structural overhead
      el.textContent = `Estimated PDF size: ~${formatBytes(total)}`;
    } catch (_) {
      el.textContent = "Estimated PDF size: —";
    }
  }, 500);

  /* ---------------- preview modal wiring ---------------- */

  document.addEventListener("DOMContentLoaded", () => {
    $("#pdfPrev").addEventListener("click", () => {
      if (previewPage > 1) { previewPage--; updateFrame(); }
    });
    $("#pdfNext").addEventListener("click", () => {
      if (previewPage < lastPageCount) { previewPage++; updateFrame(); }
    });
    $("#pdfZoomIn").addEventListener("click", () => {
      previewZoom = Math.min(300, previewZoom + 25); updateFrame();
    });
    $("#pdfZoomOut").addEventListener("click", () => {
      previewZoom = Math.max(25, previewZoom - 25); updateFrame();
    });
    $("#pdfFullscreen").addEventListener("click", () => {
      const card = document.getElementById("pdfModalCard");
      if (document.fullscreenElement) document.exitFullscreen();
      else if (card.requestFullscreen) card.requestFullscreen();
      else toast("Full screen isn't available in this browser.", "warning");
    });
    $("#pdfDownload").addEventListener("click", download);
  });

  return { generate, openPreview, download, hasFreshResult, updateEstimate };
})();
