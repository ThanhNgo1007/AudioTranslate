function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeOverlaySettings(value = {}) {
  const overlay = value && typeof value === "object" ? value : {};
  const translationFontSize = numberOr(overlay.translationFontSize, numberOr(overlay.fontSize, 36));
  const opacity = numberOr(overlay.backgroundOpacity, 0.92);
  const normalizedWidth = numberOr(overlay.normalizedBounds?.width, numberOr(overlay.maxWidth, 90));
  const preset = String(overlay.preset || "bottom");
  return {
    preset: translationFontSize >= 40 ? "accessible" : translationFontSize <= 29 ? "compact" : "cinema",
    fontSize: Math.round(translationFontSize),
    sourceFontSize: Math.round(numberOr(overlay.sourceFontSize, 17)),
    fontWeight: Math.round(numberOr(overlay.fontWeight, 700)),
    lineHeight: numberOr(overlay.lineHeight, 1.24),
    backgroundOpacity: Math.round(opacity <= 1 ? opacity * 100 : opacity),
    maxWidth: Math.round(normalizedWidth * (normalizedWidth <= 1 ? 100 : 1)),
    maxLines: Math.min(2, Math.max(1, Math.round(numberOr(overlay.maxTranslationLines, 2)))),
    hideAfterMs: Math.round(numberOr(overlay.hideAfterMs, 8_000)),
    highContrast: overlay.highContrast !== false,
    position: preset === "top" ? "top" : preset === "floating" ? "center" : "bottom",
    showSource: overlay.showSource !== false,
    clickThrough: overlay.locked !== false,
    displayId: overlay.displayId === null || overlay.displayId === undefined
      ? null
      : String(overlay.displayId),
  };
}
