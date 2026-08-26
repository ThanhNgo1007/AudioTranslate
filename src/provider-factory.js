const { AzureSpeechTranslator } = require("./providers/azure-speech");
const { DemoTranslator } = require("./providers/demo");
const { AZURE_CLOUD_CONSENT, GEMINI_CLOUD_CONSENT } = require("./config");

const PROVIDER_CAPABILITIES = Object.freeze({
  azure: Object.freeze({
    fixedSourceLanguage: true,
    autoSourceLanguage: Object.freeze({
      supported: true,
      mode: "at-start",
      minCandidates: 2,
      maxCandidates: 4,
      continuous: false,
      candidatesRequired: true,
      requireFullLocales: true,
      uniqueBaseLanguages: true,
    }),
  }),
  gemini: Object.freeze({
    fixedSourceLanguage: false,
    autoSourceLanguage: Object.freeze({
      supported: true,
      mode: "continuous",
      minCandidates: 0,
      maxCandidates: 8,
      continuous: true,
      candidatesRequired: false,
      requireFullLocales: false,
      uniqueBaseLanguages: false,
      languageHints: true,
    }),
  }),
  demo: Object.freeze({
    fixedSourceLanguage: true,
    autoSourceLanguage: Object.freeze({ supported: false }),
  }),
});

function getProviderCapabilities(provider) {
  const capabilities = PROVIDER_CAPABILITIES[provider];
  if (!capabilities) throw new Error(`Unsupported provider adapter: ${provider}`);
  return capabilities;
}

function createProvider(config, sessionOptions, callbacks) {
  const common = {
    sourceLanguage: sessionOptions.sourceLanguage || config.sourceLanguage,
    sourceLanguageCandidates:
      sessionOptions.sourceLanguageCandidates || config.sourceLanguageCandidates || [],
    targetLanguage: sessionOptions.targetLanguage || config.targetLanguage,
    ...callbacks,
  };

  if (config.provider === "demo") return new DemoTranslator(common);
  if (config.provider === "azure") {
    if (config.cloudConsent !== AZURE_CLOUD_CONSENT) {
      throw new Error(
        "Azure cloud consent is missing. Run `audiotranslate setup` before sending tab audio.",
      );
    }
    return new AzureSpeechTranslator({
      ...common,
      key: config.azureSpeechKey,
      region: config.azureSpeechRegion,
    });
  }
  if (config.provider === "gemini") {
    if (config.cloudConsent !== GEMINI_CLOUD_CONSENT) {
      throw new Error(
        "Gemini cloud consent is missing. Open Control Center and approve sending the selected audio source to Google.",
      );
    }
    const { GeminiLiveTranslator } = require("./providers/gemini-live-translate");
    return new GeminiLiveTranslator({
      ...common,
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
      enableInputTranscription: config.geminiInputTranscription === true,
      echoTargetLanguage: config.geminiEchoTargetLanguage === true,
      finalDebounceMs: config.geminiFinalDebounceMs,
      enableSessionResumption: config.geminiSessionResumption !== false,
    });
  }
  throw new Error(`Unsupported provider adapter: ${config.provider}`);
}

module.exports = { createProvider, getProviderCapabilities, PROVIDER_CAPABILITIES };
