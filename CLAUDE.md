# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Pressroom" — a fully client-side images→PDF converter. Vanilla JS static site: no build step, no package manager, no tests, no framework. Libraries (jsPDF, SortableJS, Cropper.js) load from cdnjs via `<script>` tags in `index.html`.

## Running

Open `index.html` directly, or serve the directory (e.g. `python3 -m http.server`) and open it in a browser. There is no build, lint, or test command.

## Architecture

Five classic scripts (not ES modules) that each attach one namespace to the global `window.I2P`. **Load order in `index.html` matters** — later modules call earlier ones at definition time:

1. `ui.js` → `I2P.ui` — DOM helpers (`$`, `$$`), toasts, modal open/close (custom `modal:open`/`modal:close` events), progress overlay.
2. `crop.js` → `I2P.crop` — Cropper.js modal; on apply, hands the cropped blob to `I2P.app.applyCrop`.
3. `preview.js` → `I2P.preview` — image cards, lazy thumbnails (IntersectionObserver), SortableJS reordering, zoom lightbox. Owns `drawEdited(item, maxDim)`, the single transform-aware renderer (rotation/flip → canvas) used by thumbnails, crop, zoom, **and** PDF generation.
4. `pdf.js` → `I2P.pdf` — jsPDF layout engine (1/2/4/6/9-per-page grids, fit/fill/stretch, watermark, page numbers), size estimator, preview modal (blob URL in an iframe using `#page=`/`#zoom=` fragments).
5. `app.js` → `I2P.app` — state owner and orchestrator: the `state.images` array (array order **is** PDF page order), file intake (picker / drag-drop / paste) with validation, edit operations, settings reading (`readSettings()` reads the sidebar DOM directly — there is no separate settings state), keyboard shortcuts.

All modules register their event wiring inside their own `DOMContentLoaded` listener.

### Image item lifecycle and cache invalidation

Each image is a plain object in `state.images` with two version counters that drive every cache:

- `srcVersion` — bumps when the working source blob changes (crop applied or reset). Invalidates the decoded bitmap cache (`_bitmap`/`_bitmapVersion` in preview.js).
- `editVersion` — bumps on any visual change (via `app.js` `touch()`). Invalidates thumbnails (`_thumbVersion`).
- `_pdfCache` — per-item processed-JPEG cache in pdf.js, keyed on a string of `srcVersion` + transforms + relevant settings; unchanged images skip re-encoding on regeneration.

Cropping **bakes** the current rotation/flip into a new source blob (`croppedBlob`) and resets the transform fields; the original `file` is never mutated, so "Reset edits" can always restore it. If you add a new visual edit, route it through `touch()` and include its value in the `_pdfCache` key in `processForCell`.

The global `state.dirty` flag tracks whether the last generated PDF is stale (any settings change or edit sets it); `hasFreshResult()` lets "Download" reuse the previous blob without regenerating.

### Conventions

- Guard against a CDN library being absent (`typeof jspdf/Sortable/Cropper === "undefined"`) with a toast, since the app may load offline.
- Report user-facing outcomes (skips, errors, successes) through `I2P.ui.toast`, never `alert`.
- Blob URLs and ImageBitmaps are explicitly revoked/closed when replaced or removed (see `disposeItem`, modal close handlers) — keep that discipline for anything new that allocates them.
- PDF math is in millimetres; raster output targets 150 DPI capped at `MAX_EDGE_PX` and never upscales past source pixels.
