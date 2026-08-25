function sanitizedLabel(value, fallback) {
  if (typeof value !== "string") return fallback;
  const label = value.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return label ? label.slice(0, 90) : fallback;
}

function dimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function listDisplayOptions(displays, primaryId) {
  if (!Array.isArray(displays)) return [];
  return displays.slice(0, 16).flatMap((display, index) => {
    if (!display || display.id === null || display.id === undefined) return [];
    const id = String(display.id).slice(0, 80);
    if (!id) return [];
    const fallback = `Màn hình ${index + 1}`;
    const name = sanitizedLabel(display.label, fallback);
    const width = dimension(display.size?.width);
    const height = dimension(display.size?.height);
    return [{
      id,
      label: width && height ? `${name} · ${width}×${height}` : name,
      primary: primaryId !== null && primaryId !== undefined && id === String(primaryId),
    }];
  });
}

function resolveOverlayDisplay(displays, requestedId, fallback) {
  if (!Array.isArray(displays) || requestedId === null || requestedId === undefined) return fallback;
  const id = String(requestedId);
  return displays.find((display) => String(display?.id) === id) || fallback;
}

module.exports = { listDisplayOptions, resolveOverlayDisplay };
