import assert from "node:assert/strict";
import test from "node:test";

import { rendererOwnedSourceLabel } from "../src/source-display.mjs";

test("selected file label comes from the renderer-owned basename, never main-process copy", () => {
  assert.equal(rendererOwnedSourceLabel({
    sourceKind: "file",
    selectedFileName: "/private/movie/final-cut.mp4",
    mainLabel: "Tệp đã chọn · chỉ giải mã trong bộ nhớ",
  }), "final-cut.mp4");
  assert.equal(rendererOwnedSourceLabel({
    sourceKind: "file",
    selectedFileName: "C:\\Users\\viewer\\dialogue.wav",
    mainLabel: "/secret/path/from-main.wav",
  }), "dialogue.wav");
});

test("tab selection is renderer-owned while idle fallbacks may come from main", () => {
  assert.equal(rendererOwnedSourceLabel({
    sourceKind: "browser-tab",
    tabSourceSelected: true,
    mainLabel: "Gateway chưa mở",
  }), "Tab Chrome / Edge đã chọn");
  assert.equal(rendererOwnedSourceLabel({
    sourceKind: "browser-tab",
    tabSourceSelected: false,
    mainLabel: "Gateway chưa mở",
  }), "Gateway chưa mở");
});
