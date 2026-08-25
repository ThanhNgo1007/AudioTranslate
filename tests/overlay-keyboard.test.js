const assert = require("node:assert/strict");
const test = require("node:test");

const { commandForOverlayKey } = require("../src/overlay/keyboard");

test("Escape locks the real interactive overlay", () => {
  assert.deepEqual(commandForOverlayKey("Escape"), { type: "lock" });
});

test("arrow keys keep precise and accelerated overlay nudging", () => {
  assert.deepEqual(commandForOverlayKey("ArrowLeft", false), { type: "nudge", x: -2, y: 0 });
  assert.deepEqual(commandForOverlayKey("ArrowDown", true), { type: "nudge", x: 0, y: 10 });
  assert.equal(commandForOverlayKey("Enter"), null);
});
