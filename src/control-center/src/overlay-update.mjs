export function buildNativeOverlayPatch(currentOverlay, requestedOverlay) {
  const patch = {};
  if (requestedOverlay.fontSize !== undefined) patch.translationFontSize = requestedOverlay.fontSize;
  if (requestedOverlay.backgroundOpacity !== undefined) {
    patch.backgroundOpacity = requestedOverlay.backgroundOpacity / 100;
  }
  if (requestedOverlay.showSource !== undefined) patch.showSource = requestedOverlay.showSource;
  if (requestedOverlay.highContrast !== undefined) patch.highContrast = requestedOverlay.highContrast;
  if (requestedOverlay.sourceFontSize !== undefined) patch.sourceFontSize = requestedOverlay.sourceFontSize;
  if (requestedOverlay.fontWeight !== undefined) patch.fontWeight = requestedOverlay.fontWeight;
  if (requestedOverlay.lineHeight !== undefined) patch.lineHeight = requestedOverlay.lineHeight;
  if (requestedOverlay.maxLines !== undefined) {
    const requestedLines = Number(requestedOverlay.maxLines);
    patch.maxTranslationLines = Number.isFinite(requestedLines)
      ? Math.min(2, Math.max(1, Math.round(requestedLines)))
      : 2;
  }
  if (requestedOverlay.hideAfterMs !== undefined) patch.hideAfterMs = requestedOverlay.hideAfterMs;
  if (requestedOverlay.displayId !== undefined) patch.displayId = requestedOverlay.displayId;

  const position = requestedOverlay.position ?? currentOverlay.position;
  if (requestedOverlay.position !== undefined) {
    patch.preset = position === "center" ? "floating" : position;
  }
  if (requestedOverlay.maxWidth !== undefined || requestedOverlay.position !== undefined) {
    const width = (requestedOverlay.maxWidth ?? currentOverlay.maxWidth) / 100;
    patch.normalizedBounds = {
      x: (1 - width) / 2,
      y: position === "top" ? 0.08 : position === "center" ? 0.4 : 0.72,
      width,
      height: 0.2,
    };
  }
  return patch;
}
