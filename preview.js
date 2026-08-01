/* ============================================================
   preview.js — image cards, thumbnails, reordering, lightbox
   - Renders one card per image with lazy, transform-aware thumbs
   - SortableJS drag-and-drop reordering (order == PDF page order)
   - Zoom lightbox with zoom in / out
   ============================================================ */
"use strict";

window.I2P = window.I2P || {};

I2P.preview = (() => {
  const { $, $$, formatBytes, escapeHtml, toast } = I2P.ui;

  const THUMB_MAX = 480;           // px, longest edge of a thumbnail
  let sortable = null;
  let observer = null;             // IntersectionObserver for lazy thumbs

  /* ============================================================
     Decoding & transform-aware drawing
     ============================================================ */

  /**
   * Decode an item's current working source (cropped blob if present,
   * else the original file) into a drawable bitmap. Results are cached
   * on the item and invalidated by app.js when the source changes.
   */
  async function getBitmap(item) {
    if (item._bitmap && item._bitmapVersion === item.srcVersion) return item._bitmap;

    // Free the previous decode before making a new one.
    if (item._bitmap && item._bitmap.close) { try { item._bitmap.close(); } catch (_) {} }

    const blob = item.croppedBlob || item.file;
    let bmp;
    if ("createImageBitmap" in window) {
      bmp = await createImageBitmap(blob);
    } else {
      // Fallback decode path for older browsers.
      bmp = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
        img.src = url;
      });
    }
    item._bitmap = bmp;
    item._bitmapVersion = item.srcVersion;
    return bmp;
  }

  /**
   * Draw an item's bitmap onto a canvas with its rotation/flip applied.
   * @param {object} item
   * @param {number} maxDim  longest output edge in px (0 = native size)
   * @returns {Promise<HTMLCanvasElement>}
   */
  async function drawEdited(item, maxDim = 0) {
    const bmp = await getBitmap(item);
    const rot = ((item.rotation % 360) + 360) % 360;
    const swap = rot === 90 || rot === 270;

    const srcW = bmp.width, srcH = bmp.height;
    const outW0 = swap ? srcH : srcW;
    const outH0 = swap ? srcW : srcH;

    let scale = 1;
    if (maxDim > 0) scale = Math.min(1, maxDim / Math.max(outW0, outH0));
    const outW = Math.max(1, Math.round(outW0 * scale));
    const outH = Math.max(1, Math.round(outH0 * scale));

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";

    ctx.translate(outW / 2, outH / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.scale(item.flipH ? -1 : 1, item.flipV ? -1 : 1);
    const dw = (swap ? outH : outW), dh = (swap ? outW : outH);
    ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
    return canvas;
  }

  /** Render the item's edited view to a blob: URL (used by crop & zoom). */
  async function renderEditedBlobUrl(item, maxDim = 4096) {
    const canvas = await drawEdited(item, maxDim);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("render failed");
    return URL.createObjectURL(blob);
  }

  /* ============================================================
     Cards
     ============================================================ */

  /** Effective (post-rotation) pixel dimensions for display & layout. */
  function effectiveDims(item) {
    const swap = item.rotation === 90 || item.rotation === 270;
    return swap ? { w: item.height, h: item.width } : { w: item.width, h: item.height };
  }

  function isEdited(item) {
    return item.rotation !== 0 || item.flipH || item.flipV || !!item.croppedBlob;
  }

  /** Build the DOM for one image card. */
  function buildCard(item) {
    const li = document.createElement("li");
    li.className = "image-card";
    li.dataset.id = item.id;

    li.innerHTML = `
      <span class="page-chip" aria-label="PDF position"></span>
      <div class="card-thumb" aria-hidden="true"></div>
      <div class="card-meta">
        <p class="card-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</p>
        <p class="card-stats">
          <span class="stat-size">${formatBytes(item.size)}</span>
          <span class="stat-dims"></span>
          <span class="edited-flag" hidden>edited</span>
        </p>
      </div>
      <div class="card-actions">
        <button type="button" class="icon-btn" data-act="rotl" aria-label="Rotate ${escapeHtml(item.name)} 90° left" title="Rotate left">⟲</button>
        <button type="button" class="icon-btn" data-act="rotr" aria-label="Rotate ${escapeHtml(item.name)} 90° right" title="Rotate right">⟳</button>
        <button type="button" class="icon-btn" data-act="crop" aria-label="Crop ${escapeHtml(item.name)}" title="Crop">⛶</button>
        <button type="button" class="icon-btn" data-act="zoom" aria-label="Zoom into ${escapeHtml(item.name)}" title="Zoom">🔍</button>
        <span class="spacer"></span>
        <span class="card-menu-wrap">
          <button type="button" class="icon-btn" data-act="menu" aria-label="More edits for ${escapeHtml(item.name)}" aria-haspopup="true" aria-expanded="false" title="More edits">⋯</button>
          <span class="card-menu" role="menu" hidden>
            <button type="button" role="menuitem" data-act="rot180">Rotate 180°</button>
            <button type="button" role="menuitem" data-act="fliph">Flip horizontally</button>
            <button type="button" role="menuitem" data-act="flipv">Flip vertically</button>
            <button type="button" role="menuitem" data-act="reset">Reset edits</button>
          </span>
        </span>
        <button type="button" class="icon-btn danger" data-act="remove" aria-label="Remove ${escapeHtml(item.name)}" title="Remove">🗑</button>
      </div>`;

    updateCardMeta(li, item);
    observer.observe(li);        // thumbnail renders lazily when visible
    return li;
  }

  function updateCardMeta(li, item) {
    const { w, h } = effectiveDims(item);
    li.querySelector(".stat-dims").textContent = `${w} × ${h}`;
    li.querySelector(".edited-flag").hidden = !isEdited(item);
  }

  /** (Re)draw one card's thumbnail canvas. */
  async function renderThumb(li, item) {
    const holder = li.querySelector(".card-thumb");
    try {
      const canvas = await drawEdited(item, THUMB_MAX);
      canvas.setAttribute("aria-hidden", "true");
      holder.replaceChildren(canvas);
      item._thumbVersion = item.editVersion;
    } catch (err) {
      holder.innerHTML = `<span style="font-size:12px;color:var(--danger);padding:8px;">Preview failed</span>`;
    }
  }

  /** Refresh page-number chips (P.01, P.02 …) after any reorder/removal. */
  function renumber() {
    const items = I2P.app.state.images;
    items.forEach((item, i) => {
      const li = $(`.image-card[data-id="${item.id}"]`);
      if (li) li.querySelector(".page-chip").textContent = `P.${String(i + 1).padStart(2, "0")}`;
    });
  }

  /** Add a card for a new item. */
  function addCard(item) {
    const grid = $("#imageGrid");
    grid.appendChild(buildCard(item));
    renumber();
  }

  /** Refresh an existing card after edits (thumb if visible, meta always). */
  function refreshCard(item) {
    const li = $(`.image-card[data-id="${item.id}"]`);
    if (!li) return;
    updateCardMeta(li, item);
    // Only redraw immediately if the card is on screen; otherwise the
    // IntersectionObserver re-renders it when it scrolls into view.
    const rect = li.getBoundingClientRect();
    const visible = rect.bottom > 0 && rect.top < window.innerHeight;
    if (visible) renderThumb(li, item);
    else item._thumbVersion = -1; // mark stale
  }

  function removeCard(id) {
    const li = $(`.image-card[data-id="${id}"]`);
    if (li) { observer.unobserve(li); li.remove(); }
    renumber();
  }

  function clearAllCards() {
    $$("#imageGrid .image-card").forEach((li) => observer.unobserve(li));
    $("#imageGrid").replaceChildren();
  }

  /* ============================================================
     Zoom lightbox
     ============================================================ */

  let zoomScale = 1;
  let zoomUrl = null;

  async function openZoom(item) {
    try {
      const url = await renderEditedBlobUrl(item);
      zoomUrl = url;
      zoomScale = 1;
      const img = $("#zoomImage");
      img.src = url;
      img.alt = `Full preview of ${item.name}`;
      img.style.transform = "scale(1)";
      $("#zoomLevel").textContent = "100%";
      $("#zoomTitle").textContent = item.name;
      I2P.ui.openModal("zoomModal");
    } catch (err) {
      toast("Couldn't open this image.", "error");
    }
  }

  function setZoom(next) {
    zoomScale = Math.min(6, Math.max(0.2, next));
    $("#zoomImage").style.transform = `scale(${zoomScale})`;
    $("#zoomLevel").textContent = Math.round(zoomScale * 100) + "%";
  }

  /* ============================================================
     Event wiring
     ============================================================ */

  function closeAllMenus(except = null) {
    $$(".card-menu").forEach((m) => {
      if (m !== except) {
        m.hidden = true;
        const btn = m.parentElement.querySelector('[data-act="menu"]');
        if (btn) btn.setAttribute("aria-expanded", "false");
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {

    // Lazy thumbnail rendering: draw when a card enters the viewport,
    // re-draw if its edits changed while off-screen.
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const li = entry.target;
        const item = I2P.app.getItem(li.dataset.id);
        if (item && item._thumbVersion !== item.editVersion) renderThumb(li, item);
      }
    }, { rootMargin: "300px" });

    // Drag-and-drop ordering.
    if (typeof Sortable !== "undefined") {
      sortable = new Sortable($("#imageGrid"), {
        animation: 150,
        ghostClass: "sortable-ghost",
        chosenClass: "sortable-chosen",
        onEnd() {
          const order = $$("#imageGrid .image-card").map((li) => li.dataset.id);
          I2P.app.reorder(order);
          renumber();
        },
      });
    }

    // Card action buttons (event delegation).
    $("#imageGrid").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) { closeAllMenus(); return; }
      const li = btn.closest(".image-card");
      const item = I2P.app.getItem(li.dataset.id);
      if (!item) return;

      const act = btn.dataset.act;
      if (act === "menu") {
        const menu = btn.parentElement.querySelector(".card-menu");
        const opening = menu.hidden;
        closeAllMenus(opening ? menu : null);
        menu.hidden = !opening;
        btn.setAttribute("aria-expanded", String(opening));
        return;
      }
      closeAllMenus();

      switch (act) {
        case "rotl":   I2P.app.rotate(item, -90); break;
        case "rotr":   I2P.app.rotate(item, 90);  break;
        case "rot180": I2P.app.rotate(item, 180); break;
        case "fliph":  I2P.app.flip(item, "h");   break;
        case "flipv":  I2P.app.flip(item, "v");   break;
        case "reset":  I2P.app.resetEdits(item);  break;
        case "crop":   I2P.crop.open(item);       break;
        case "zoom":   openZoom(item);            break;
        case "remove": I2P.app.removeImage(item.id); break;
      }
    });

    // Close overflow menus when clicking elsewhere.
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".card-menu-wrap")) closeAllMenus();
    });

    // Zoom modal controls.
    $("#zoomIn").addEventListener("click", () => setZoom(zoomScale * 1.25));
    $("#zoomOut").addEventListener("click", () => setZoom(zoomScale / 1.25));
    document.getElementById("zoomModal").addEventListener("modal:close", () => {
      if (zoomUrl) { URL.revokeObjectURL(zoomUrl); zoomUrl = null; }
      $("#zoomImage").removeAttribute("src");
    });
  });

  return {
    addCard, refreshCard, removeCard, clearAllCards, renumber,
    drawEdited, renderEditedBlobUrl, effectiveDims, isEdited,
  };
})();
