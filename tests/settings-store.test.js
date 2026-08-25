const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SettingsStore, sanitizeSettings } = require("../src/settings-store");

test("sanitizeSettings clamps presentation values and strips unknown fields", () => {
  const value = sanitizeSettings({
    provider: "gemini",
    secret: "must-not-survive",
    source: { kind: "file", targetLanguage: "vi", languageHints: ["en-US", "en-US"] },
    overlay: { translationFontSize: 200, backgroundOpacity: -1, maxTranslationLines: 9 },
  });
  assert.equal(value.provider, "gemini");
  assert.equal(value.secret, undefined);
  assert.deepEqual(value.source.languageHints, ["en-US"]);
  assert.equal(value.overlay.translationFontSize, 64);
  assert.equal(value.overlay.backgroundOpacity, 0.3);
  assert.equal(value.overlay.maxTranslationLines, 2);
});

test("sanitizeSettings fails closed to defaults for valid non-object JSON", () => {
  for (const value of [null, [], "gemini", 42, true]) {
    const settings = sanitizeSettings(value);
    assert.equal(settings.provider, "demo");
    assert.equal(settings.source.kind, "tab");
    assert.equal(settings.cloud.consent, "");
  }
});

test("SettingsStore writes non-secret JSON atomically with restrictive mode", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audio-translate-settings-"));
  const filePath = path.join(directory, "settings.json");
  const store = new SettingsStore(filePath);
  store.load();
  const snapshot = store.update({ provider: "gemini", overlay: { locked: false } });
  assert.equal(snapshot.provider, "gemini");
  assert.equal(snapshot.overlay.locked, false);
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(persisted.provider, "gemini");
  assert.equal(persisted.apiKey, undefined);
  if (process.platform !== "win32") assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("SettingsStore recovers from a valid JSON primitive without retaining unknown data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audio-translate-settings-"));
  const filePath = path.join(directory, "settings.json");
  fs.writeFileSync(filePath, "null\n");
  const store = new SettingsStore(filePath);
  const snapshot = store.load();
  assert.equal(snapshot.provider, "demo");
  assert.equal(snapshot.source.language, "auto");
  assert.doesNotMatch(JSON.stringify(snapshot), /apiKey|secret/i);
});
