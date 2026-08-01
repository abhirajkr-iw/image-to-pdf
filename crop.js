/* ============================================================
   crop.js — crop tool built on Cropper.js
   Opens a modal for one image item, and on "Crop" replaces the
   item's working source with the cropped result. The untouched
   original is always kept so "Reset edits" can restore it.
   ============================================================ */
"use strict";

window.I2P = window.I2P || {};

I2P.crop = (() => {
  const { $, $$, openModal, closeModal, toast } = I2P.ui;

  let cropper = null;      // active Cropper.js instance
  let activeItem = null;   // image item being cropped

  /** Open the crop modal for an image item. */
  function open(item) {
    if (typeof Cropper === "undefined") {
      toast("The crop library hasn't loaded yet. Check your connection and reload once.", "error");
      return;
    }
    activeItem = item;

    const img = $("#cropImage");
    destroy();

    // Crop operates on the current *edited* source so crops can be stacked,
    // rendered with rotation/flips applied (what you see is what you crop).
    I2P.preview.renderEditedBlobUrl(item).then((url) => {
      img.src = url;
      img.alt = `Cropping ${item.name}`;
      openModal("cropModal");

      // Reset ratio choice to "Free" each time the tool opens.
      const free = $$('input[name="cropRatio"]').find((r) => r.value === "free");
      if (free) free.checked = true;

      cropper = new Cropper(img, {
        viewMode: 1,
        autoCropArea: 0.9,
        background: false,
        responsive: true,
        checkOrientation: false,
      });
    }).catch(() => {
      toast("Couldn't open this image for cropping.", "error");
    });
  }

  function destroy() {
    if (cropper) { cropper.destroy(); cropper = null; }
    const img = $("#cropImage");
    if (img.src && img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
    img.removeAttribute("src");
  }

  /* ---------------- wiring ---------------- */

  document.addEventListener("DOMContentLoaded", () => {

    // Aspect-ratio segmented control.
    $$('input[name="cropRatio"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        if (!cropper) return;
        cropper.setAspectRatio(radio.value === "free" ? NaN : parseFloat(radio.value));
      });
    });

    // Reset the crop box (not the image edits).
    $("#cropReset").addEventListener("click", () => {
      if (!cropper) return;
      cropper.reset();
      const free = $$('input[name="cropRatio"]').find((r) => r.value === "free");
      if (free) { free.checked = true; cropper.setAspectRatio(NaN); }
    });

    // Apply the crop back to the item.
    $("#cropApply").addEventListener("click", () => {
      if (!cropper || !activeItem) return;

      let canvas;
      try {
        canvas = cropper.getCroppedCanvas({
          maxWidth: 8000,
          maxHeight: 8000,
          imageSmoothingQuality: "high",
        });
      } catch (err) {
        toast("Cropping failed — the image may be too large for this device's memory.", "error");
        return;
      }
      if (!canvas) { toast("Nothing to crop yet — adjust the crop box first.", "warning"); return; }

      const item = activeItem;
      canvas.toBlob((blob) => {
        if (!blob) { toast("Couldn't save the crop. Try a smaller crop area.", "error"); return; }
        // The crop was taken from the *rendered* (rotated/flipped) view,
        // so the new source already bakes those in — clear the transforms.
        I2P.app.applyCrop(item, blob);
        closeModal("cropModal");
        toast(`Cropped ${item.name}`, "success");
      }, "image/png");
    });

    // Clean up the Cropper instance whenever the modal closes.
    document.getElementById("cropModal").addEventListener("modal:close", () => {
      destroy();
      activeItem = null;
    });
  });

  return { open };
})();
