const test = require("node:test");
const assert = require("node:assert/strict");
const { createProvider, getProviderCapabilities } = require("../src/provider-factory");
const { GEMINI_CLOUD_CONSENT } = require("../src/config");

test("provider factory fails closed instead of routing an unknown provider to Azure", () => {
  assert.throws(() => getProviderCapabilities("unknown"), /Unsupported provider adapter/);
  assert.throws(
    () =>
      createProvider(
        { provider: "unknown" },
        { sourceLanguage: "en-US", targetLanguage: "vi" },
        {},
      ),
    /Unsupported provider adapter/,
  );
});

test("Azure provider requires explicit tab-audio cloud consent", () => {
  assert.throws(
    () =>
      createProvider(
        { provider: "azure", azureSpeechKey: "key", azureSpeechRegion: "region" },
        { sourceLanguage: "en-US", targetLanguage: "vi" },
        {},
      ),
    /cloud consent is missing/i,
  );
});

test("Gemini provider requires its own selected-audio consent", () => {
  assert.throws(
    () =>
      createProvider(
        { provider: "gemini", geminiApiKey: "key" },
        { sourceLanguage: "auto", sourceLanguageCandidates: [], targetLanguage: "vi" },
        {},
      ),
    /Gemini cloud consent is missing/i,
  );
  const capabilities = getProviderCapabilities("gemini");
  assert.equal(capabilities.fixedSourceLanguage, false);
  assert.equal(capabilities.autoSourceLanguage.minCandidates, 0);
  assert.equal(capabilities.autoSourceLanguage.continuous, true);

  const privacyMode = createProvider(
    {
      provider: "gemini",
      geminiApiKey: "key",
      cloudConsent: GEMINI_CLOUD_CONSENT,
      geminiSessionResumption: false,
    },
    { sourceLanguage: "auto", sourceLanguageCandidates: [], targetLanguage: "vi" },
    {},
  );
  assert.equal(privacyMode.enableSessionResumption, false);
});
