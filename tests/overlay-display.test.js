const assert = require("node:assert/strict");
const test = require("node:test");

const { listDisplayOptions, resolveOverlayDisplay } = require("../src/overlay-display");

const displays = [
  { id: 101, label: "Built-in Retina Display", size: { width: 3024, height: 1964 } },
  { id: 202, label: "", size: { width: 1920, height: 1080 } },
];

test("display options expose only a stable id, useful label and primary flag", () => {
  assert.deepEqual(listDisplayOptions(displays, 101), [
    { id: "101", label: "Built-in Retina Display · 3024×1964", primary: true },
    { id: "202", label: "Màn hình 2 · 1920×1080", primary: false },
  ]);
});

test("saved display selection resolves exactly and falls back without throwing", () => {
  const fallback = displays[0];
  assert.equal(resolveOverlayDisplay(displays, "202", fallback), displays[1]);
  assert.equal(resolveOverlayDisplay(displays, "missing", fallback), fallback);
  assert.equal(resolveOverlayDisplay([], "202", fallback), fallback);
});

test("malformed display labels are sanitized and bounded", () => {
  const options = listDisplayOptions([
    { id: "7", label: "Private\nLabel\u0000".repeat(50), size: { width: 800, height: 600 } },
  ], null);
  assert.equal(options[0].id, "7");
  assert.doesNotMatch(options[0].label, /[\r\n\u0000]/);
  assert.ok(options[0].label.length <= 120);
});
