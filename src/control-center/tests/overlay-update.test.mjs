import assert from "node:assert/strict";
import test from "node:test";

import { buildNativeOverlayPatch } from "../src/overlay-update.mjs";

const current = {
  maxWidth: 78,
  position: "bottom",
};

test("changing only the overlay position also sends real normalized bounds", () => {
  assert.deepEqual(buildNativeOverlayPatch(current, { position: "top" }), {
    preset: "top",
    normalizedBounds: {
      x: 0.10999999999999999,
      y: 0.08,
      width: 0.78,
      height: 0.2,
    },
  });

  assert.equal(buildNativeOverlayPatch(current, { position: "center" }).preset, "floating");
  assert.equal(buildNativeOverlayPatch(current, { position: "center" }).normalizedBounds.y, 0.4);
});

test("visual-only changes do not unexpectedly move the real overlay", () => {
  assert.deepEqual(buildNativeOverlayPatch(current, { fontSize: 42 }), {
    translationFontSize: 42,
  });
});

test("changing width preserves the selected real-screen position", () => {
  assert.deepEqual(buildNativeOverlayPatch({ ...current, position: "top" }, { maxWidth: 60 }).normalizedBounds, {
    x: 0.2,
    y: 0.08,
    width: 0.6,
    height: 0.2,
  });
});

test("advanced readability controls map directly to persisted native overlay settings", () => {
  assert.deepEqual(buildNativeOverlayPatch(current, {
    highContrast: false,
    sourceFontSize: 20,
    fontWeight: 650,
    lineHeight: 1.45,
    maxLines: 3,
    hideAfterMs: 12_000,
    displayId: "9001",
  }), {
    highContrast: false,
    sourceFontSize: 20,
    fontWeight: 650,
    lineHeight: 1.45,
    maxTranslationLines: 2,
    hideAfterMs: 12_000,
    displayId: "9001",
  });
});
