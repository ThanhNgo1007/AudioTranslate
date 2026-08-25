(function exposeOverlayKeyboard(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AudioTranslateOverlayKeyboard = api;
})(typeof globalThis === "object" ? globalThis : this, function createOverlayKeyboard() {
  "use strict";

  function commandForOverlayKey(key, shiftKey = false) {
    if (key === "Escape") return { type: "lock" };
    const directions = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[key];
    if (!direction) return null;
    const amount = shiftKey ? 10 : 2;
    return { type: "nudge", x: direction[0] * amount, y: direction[1] * amount };
  }

  return Object.freeze({ commandForOverlayKey });
});
