import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOverlaySettings } from "../src/overlay-snapshot.mjs";

test("native overlay snapshot exposes every advanced readability control", () => {
  assert.deepEqual(normalizeOverlaySettings({
    translationFontSize: 41,
    sourceFontSize: 21,
    fontWeight: 750,
    lineHeight: 1.5,
    backgroundOpacity: 0.84,
    maxWidth: 82,
    maxTranslationLines: 3,
    hideAfterMs: 12_000,
    highContrast: false,
    showSource: false,
    locked: false,
    preset: "floating",
    displayId: "42",
    normalizedBounds: { width: 0.82 },
  }), {
    preset: "accessible",
    fontSize: 41,
    sourceFontSize: 21,
    fontWeight: 750,
    lineHeight: 1.5,
    backgroundOpacity: 84,
    maxWidth: 82,
    maxLines: 2,
    hideAfterMs: 12_000,
    highContrast: false,
    position: "center",
    showSource: false,
    clickThrough: false,
    displayId: "42",
  });
});

test("missing fields receive safe settings-store defaults", () => {
  const value = normalizeOverlaySettings({});
  assert.equal(value.maxLines, 2);
  assert.equal(value.highContrast, true);
  assert.equal(value.hideAfterMs, 8_000);
  assert.equal(value.sourceFontSize, 17);
  assert.equal(value.displayId, null);
});
