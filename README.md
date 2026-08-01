# Pressroom — Images to PDF

Convert images into a single PDF, entirely in your browser. Nothing is uploaded — all decoding, editing, and PDF generation happens client-side.

## Features

- **Add images** via file picker, drag & drop anywhere on the page, or clipboard paste (JPG, PNG, WEBP)
- **Reorder** by dragging cards — card order is page order in the PDF
- **Edit per image**: rotate (90°/180°), flip horizontal/vertical, crop (free, 1:1, 4:3, 16:9), reset to original
- **Page setup**: A4 / Letter / Legal / A3 / custom size, portrait or landscape, adjustable margins, page background color
- **Layout**: 1, 2, 4, 6, or 9 images per page with fit / fill / stretch placement
- **Extras**: page numbers, text watermark (size, rotation, opacity, position), JPEG quality slider with live file-size estimate
- **Preview** the generated PDF in-app (page navigation, zoom, full screen) before downloading

## Usage

Open `index.html` in a browser, or serve the directory locally:

```sh
python3 -m http.server
```

then visit http://localhost:8000.

Keyboard shortcuts: `Ctrl/Cmd+O` to add images, `Ctrl/Cmd+Enter` to generate the PDF, `Ctrl+V` to paste an image, `Delete` to remove a focused card.

## Tech

Vanilla HTML/CSS/JS — no build step, no dependencies to install. Three libraries load from cdnjs:

- [jsPDF](https://github.com/parallax/jsPDF) — PDF generation
- [SortableJS](https://github.com/SortableJS/Sortable) — drag-and-drop reordering
- [Cropper.js](https://github.com/fengyuanchen/cropperjs) — cropping

## Privacy

Your images never leave your device. The app makes no network requests beyond fetching fonts and the libraries above from CDNs.
