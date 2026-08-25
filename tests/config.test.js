const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getConfig,
  parseArgs,
  toBoolean,
  toLanguageList,
  toMaxCloudMinutes,
  toPort,
} = require("../src/config");

test("parseArgs supports space, equals and boolean forms", () => {
  assert.deepEqual(parseArgs(["--source", "ja-JP", "--target=vi", "--preview"]), {
    source: "ja-JP",
    target: "vi",
    preview: true,
  });
});

test("getConfig gives CLI arguments precedence over environment", () => {
  const config = getConfig(
    ["--provider", "demo", "--port", "45000", "--show-source=false"],
    {
      AUDIOTRANSLATE_PROVIDER: "azure",
      AUDIOTRANSLATE_PORT: "43765",
      AUDIOTRANSLATE_SHOW_SOURCE: "true",
    },
  );
  assert.equal(config.provider, "demo");
  assert.equal(config.port, 45000);
  assert.equal(config.showSource, false);
});

test("typed zero-valued CLI options retain precedence over environment", () => {
  const config = getConfig(
    [],
    {
      AUDIOTRANSLATE_PORT: "43765",
      AUDIOTRANSLATE_MAX_CLOUD_MINUTES: "30",
    },
    { port: 0, "max-cloud-minutes": 0 },
  );

  assert.equal(config.port, 0);
  assert.equal(config.maxCloudMinutes, 0);
});

test("boolean and port validation are deterministic", () => {
  assert.equal(toBoolean("yes", false), true);
  assert.equal(toBoolean("off", true), false);
  assert.throws(() => toBoolean("sometimes", false), /Invalid boolean value/);
  assert.equal(toPort("0"), 0);
  assert.throws(() => toPort("70000"), /Invalid WebSocket port/);
  assert.throws(() => toPort("43765oops"), /Invalid WebSocket port/);
  assert.deepEqual(toLanguageList("en-US, ja-JP,ko-KR"), ["en-US", "ja-JP", "ko-KR"]);
});

test("auto source candidates can be configured from CLI", () => {
  const config = getConfig(
    ["--source", "auto", "--source-candidates", "en-US,ja-JP,ko-KR"],
    {},
  );
  assert.equal(config.sourceLanguage, "auto");
  assert.deepEqual(config.sourceLanguageCandidates, ["en-US", "ja-JP", "ko-KR"]);
});

test("safe defaults use demo and cloud duration is bounded", () => {
  const config = getConfig([], {});
  assert.equal(config.provider, "demo");
  assert.deepEqual(config.allowedExtensionIds, ["docfjemeacdakckkamiiopljhmgjgfgl"]);
  assert.equal(config.cloudConsent, "");
  assert.equal(config.maxCloudMinutes, 0);
  assert.equal(toMaxCloudMinutes("30"), 30);
  assert.throws(() => toMaxCloudMinutes("1441"), /Invalid maximum cloud minutes/);
  assert.throws(() => toMaxCloudMinutes("30minutes"), /Invalid maximum cloud minutes/);
});

test("Gemini provider reads model and API key without exposing them elsewhere", () => {
  const config = getConfig(["--provider", "gemini", "--source", "auto"], {
    GEMINI_API_KEY: "private-gemini-key",
    GEMINI_LIVE_MODEL: "gemini-3.5-live-translate-preview",
  });
  assert.equal(config.provider, "gemini");
  assert.equal(config.sourceLanguage, "auto");
  assert.equal(config.geminiApiKey, "private-gemini-key");
  assert.equal(config.geminiModel, "gemini-3.5-live-translate-preview");
  assert.equal(config.geminiSessionResumption, false);
  assert.equal(config.sourceLanguage, "auto");
  assert.deepEqual(config.sourceLanguageCandidates, []);
});

test("provider-specific candidate defaults do not silently constrain Gemini auto detection", () => {
  assert.deepEqual(getConfig(["--provider", "gemini"], {}).sourceLanguageCandidates, []);
  assert.deepEqual(getConfig(["--provider", "azure"], {}).sourceLanguageCandidates, [
    "en-US",
    "ja-JP",
    "ko-KR",
    "zh-CN",
  ]);
});
