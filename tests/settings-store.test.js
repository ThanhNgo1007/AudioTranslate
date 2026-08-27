const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SettingsStore, sanitizeSettings } = require("../src/settings-store");

test("fresh settings recommend contextual translation without changing caption display", () => {
  const settings = sanitizeSettings({});

  assert.equal(settings.version, 3);
  assert.deepEqual(settings.captions, {
    mode: "fastest",
    echoTargetLanguage: false,
    resetGapMs: 1100,
    finalDebounceMs: 120,
  });
  assert.deepEqual(settings.translation, {
    mode: "balanced",
    transcriptionModel: "gemini-3.5-transcribe-live",
    textModel: "gemini-3.5-flash-lite",
    contextTurns: 4,
    partialThrottleMs: 450,
    glossary: "",
    characterContext: "",
  });
  assert.equal(settings.overlay.showSource, false);
});

test("version two settings keep the direct fastest route until the user opts in", () => {
  const settings = sanitizeSettings({ version: 2, provider: "gemini" });

  assert.equal(settings.version, 3);
  assert.equal(settings.translation.mode, "fastest");
  assert.equal(settings.translation.transcriptionModel, "gemini-3.5-transcribe-live");
  assert.equal(settings.translation.textModel, "gemini-3.5-flash-lite");
});

test("contextual translation settings are bounded and unknown fields are stripped", () => {
  const settings = sanitizeSettings({
    version: 3,
    translation: {
      mode: "cinematic-turbo",
      transcriptionModel: "  bad\nmodel  ",
      textModel: "gemini-3.5-flash-lite",
      contextTurns: 999,
      partialThrottleMs: 1,
      glossary: `  Hero = Anh hùng\r\n${"g".repeat(5_000)}`,
      characterContext: `  Alex is Sam's older sister.\u0000${"c".repeat(5_000)}`,
      secret: "must-not-survive",
    },
  });

  assert.equal(settings.translation.mode, "balanced");
  assert.equal(settings.translation.transcriptionModel, "gemini-3.5-transcribe-live");
  assert.equal(settings.translation.textModel, "gemini-3.5-flash-lite");
  assert.equal(settings.translation.contextTurns, 6);
  assert.equal(settings.translation.partialThrottleMs, 250);
  assert.equal(settings.translation.glossary.length, 4_000);
  assert.match(settings.translation.glossary, /^Hero = Anh hùng\n/);
  assert.equal(settings.translation.characterContext.length, 4_000);
  assert.doesNotMatch(settings.translation.characterContext, /\u0000/);
  assert.equal(settings.translation.secret, undefined);
});

test("legacy source-caption settings migrate without overriding an explicit profile", () => {
  const legacyBilingual = sanitizeSettings({ overlay: { showSource: true } });
  assert.equal(legacyBilingual.captions.mode, "bilingual");
  assert.equal(legacyBilingual.overlay.showSource, true);

  const explicitFastest = sanitizeSettings({
    captions: { mode: "fastest" },
    overlay: { showSource: true },
  });
  assert.equal(explicitFastest.captions.mode, "fastest");
  assert.equal(explicitFastest.overlay.showSource, false);

  const invalid = sanitizeSettings({ captions: { mode: "turbo" } });
  assert.equal(invalid.captions.mode, "fastest");
});

test("caption timing settings are finite integers within safe bounds", () => {
  const settings = sanitizeSettings({
    captions: {
      echoTargetLanguage: true,
      resetGapMs: -10,
      finalDebounceMs: 9999,
    },
  });

  assert.equal(settings.captions.echoTargetLanguage, true);
  assert.equal(settings.captions.resetGapMs, 250);
  assert.equal(settings.captions.finalDebounceMs, 1000);
});

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
