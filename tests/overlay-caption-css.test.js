const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const css = fs.readFileSync(path.join(__dirname, "..", "src", "overlay", "styles.css"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "src", "overlay", "index.html"), "utf8");

test("overlay loads the caption composer before its renderer", () => {
  const composerIndex = html.indexOf('src="caption-composer.js"');
  const rendererIndex = html.indexOf('src="renderer.js"');
  assert.ok(composerIndex >= 0);
  assert.ok(composerIndex < rendererIndex);
});

test("caption styles do not silently clip translation or source text", () => {
  assert.doesNotMatch(css, /line-clamp/);
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis/);
  assert.match(css, /white-space:\s*pre-line/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});
