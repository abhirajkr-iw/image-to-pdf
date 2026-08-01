/* ============================================================
   ui.js — shared UI utilities (toasts, modals, progress, helpers)
   Attaches to the global I2P namespace. Loaded first.
   ============================================================ */
"use strict";

window.I2P = window.I2P || {};

I2P.ui = (() => {

  /* ---------------- helpers ---------------- */

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Format bytes as a human-readable string. */
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let v = bytes / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? v.toFixed(2) : v.toFixed(1)} ${units[i]}`;
  }

  /** Debounce: run fn once, `wait` ms after the last call. */
  function debounce(fn, wait = 300) {
    let t = null;
    return function debounced(...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  /** Yield to the event loop so the UI can paint during long work. */
  const nextFrame = () =>
    new Promise((resolve) =>
      "requestAnimationFrame" in window ? requestAnimationFrame(() => resolve()) : setTimeout(resolve, 0)
    );

  /** Escape a string for safe use in innerHTML. */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------------- toasts ---------------- */

  const TOAST_MS = 4200;

  /**
   * Show a toast notification.
   * @param {string} message
   * @param {"info"|"success"|"warning"|"error"} type
   */
  function toast(message, type = "info") {
    const stack = $("#toastStack");
    if (!stack) return;

    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.setAttribute("role", type === "error" ? "alert" : "status");
    el.textContent = message;

    // Keep the stack tidy: max 4 visible toasts.
    while (stack.children.length >= 4) stack.firstChild.remove();
    stack.appendChild(el);

    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity .25s";
      setTimeout(() => el.remove(), 260);
    }, TOAST_MS);
  }

  /* ---------------- modals ---------------- */

  let lastFocused = null;

  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal || !modal.hidden) return;
    lastFocused = document.activeElement;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    // Move focus into the dialog for keyboard / screen-reader users.
    const target = modal.querySelector("[autofocus]") || modal.querySelector("button, input, select");
    if (target) target.focus();
    modal.dispatchEvent(new CustomEvent("modal:open"));
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    if (!$$(".modal:not([hidden])").length) document.body.style.overflow = "";
    modal.dispatchEvent(new CustomEvent("modal:close"));
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  }

  function anyModalOpen() {
    return $$(".modal:not([hidden])").length > 0;
  }

  // Close buttons ([data-close]) and backdrop clicks.
  document.addEventListener("click", (e) => {
    const closer = e.target.closest("[data-close]");
    if (closer) { closeModal(closer.dataset.close); return; }
    if (e.target.classList && e.target.classList.contains("modal")) {
      closeModal(e.target.id);
    }
  });

  // Escape closes the topmost open modal.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = $$(".modal:not([hidden])");
    if (open.length) closeModal(open[open.length - 1].id);
  });

  /* ---------------- progress overlay ---------------- */

  const progress = {
    show(label = "Working…") {
      $("#progressLabel").textContent = label;
      this.set(0);
      $("#progressOverlay").hidden = false;
    },
    set(fraction, label) {
      const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
      $("#progressBar").style.width = pct + "%";
      $("#progressPct").textContent = pct + "%";
      if (label) $("#progressLabel").textContent = label;
    },
    hide() { $("#progressOverlay").hidden = true; },
  };

  return { $, $$, formatBytes, debounce, nextFrame, escapeHtml, toast, openModal, closeModal, anyModalOpen, progress };
})();
