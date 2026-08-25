import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { sourceLanguageOptions, targetLanguageOptions } from "../src/language-options.mjs";

test("Control Center target language values match the runtime and first-run default", () => {
  const values = targetLanguageOptions.map(({ value }) => value);
  assert.equal(values.includes("vi"), true);
  assert.equal(values.includes("en"), true);
  assert.equal(values.includes("zh-Hans"), true);
  assert.equal(values.includes("vi-VN"), false);
});

test("fixed source language options use transcription locales while keeping auto detection", () => {
  const values = sourceLanguageOptions.map(({ value }) => value);
  assert.equal(values[0], "auto");
  assert.equal(values.includes("en-US"), true);
  assert.equal(values.includes("vi-VN"), true);
  assert.equal(values.includes("fr-FR"), true);
});

test("development and fallback snapshots use a selectable translation target", () => {
  for (const file of ["../src/bridge.ts", "../src/App.tsx"]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /languages:\s*\{\s*source:\s*"auto",\s*target:\s*"vi-VN"\s*\}/);
  }
});
