const test = require("node:test");
const assert = require("node:assert/strict");
const { AzureSpeechTranslator } = require("../src/providers/azure-speech");

function fakeSdk() {
  const state = { recognizers: [], languageConfig: null, speechConfig: null };

  class SpeechConfig {
    constructor() {
      this.properties = new Map();
      this.targets = [];
    }
    addTargetLanguage(language) {
      this.targets.push(language);
    }
    setProperty(key, value) {
      this.properties.set(key, value);
    }
  }

  class Recognizer {
    constructor(speechConfig, audioConfig) {
      this.speechConfig = speechConfig;
      this.audioConfig = audioConfig;
      this.mode = "fixed";
      state.recognizers.push(this);
    }
    startContinuousRecognitionAsync(resolve) {
      resolve();
    }
    stopContinuousRecognitionAsync(resolve) {
      resolve();
    }
    close(resolve) {
      resolve();
    }
    static FromConfig(speechConfig, languageConfig, audioConfig) {
      const recognizer = new Recognizer(speechConfig, audioConfig);
      recognizer.mode = "auto";
      recognizer.languageConfig = languageConfig;
      return recognizer;
    }
  }

  const sdk = {
    SpeechTranslationConfig: {
      fromSubscription() {
        state.speechConfig = new SpeechConfig();
        return state.speechConfig;
      },
    },
    AutoDetectSourceLanguageConfig: {
      fromLanguages(languages) {
        state.languageConfig = { languages: [...languages], mode: null };
        return state.languageConfig;
      },
    },
    LanguageIdMode: { AtStart: "AtStart" },
    TranslationRecognizer: Recognizer,
    AudioStreamFormat: {
      getWaveFormatPCM() {
        return {};
      },
    },
    AudioInputStream: {
      createPushStream() {
        return { write() {}, close() {} };
      },
    },
    AudioConfig: {
      fromStreamInput() {
        return {};
      },
    },
    PropertyId: {
      Recognizer_StopTimeoutMs: "stop-timeout",
      SpeechServiceResponse_TranslationRequestStablePartialResult: "stable-partial",
      SpeechServiceResponse_RecognitionLatencyMs: "recognition-latency",
    },
  };
  return { sdk, state };
}

function result(overrides = {}) {
  return {
    text: "Good morning",
    translations: new Map([["vi", "Chào buổi sáng"]]),
    properties: { getProperty: () => "24" },
    offset: 0,
    duration: 3_000_000,
    ...overrides,
  };
}

test("Azure fixed source keeps the direct recognizer fast path", async () => {
  const { sdk, state } = fakeSdk();
  const translator = new AzureSpeechTranslator({
    sourceLanguage: "en-US",
    targetLanguage: "vi",
    key: "test-key",
    region: "test-region",
    sdk,
  });
  await translator.start();
  assert.equal(state.recognizers[0].mode, "fixed");
  assert.equal(state.speechConfig.speechRecognitionLanguage, "en-US");
  await translator.stop();
});

test("Azure auto source uses at-start LID and withholds captions until detection", async () => {
  const { sdk, state } = fakeSdk();
  const captions = [];
  const detections = [];
  const terminalErrors = [];
  const translator = new AzureSpeechTranslator({
    sourceLanguage: "auto",
    sourceLanguageCandidates: ["en-US", "ja-JP", "ko-KR"],
    targetLanguage: "vi",
    key: "test-key",
    region: "test-region",
    sdk,
    onCaption: (caption) => captions.push(caption),
    onLanguageDetected: (detection) => detections.push(detection),
    onTerminal: (error) => terminalErrors.push(error),
  });
  await translator.start();
  assert.equal(state.recognizers[0].mode, "auto");
  assert.deepEqual(state.languageConfig.languages, ["en-US", "ja-JP", "ko-KR"]);
  assert.equal(state.languageConfig.mode, "AtStart");

  state.recognizers[0].recognizing(null, { result: result({ language: "" }) });
  assert.equal(captions.length, 0);

  state.recognizers[0].recognizing(null, {
    result: result({ language: "ja-JP", languageDetectionConfidence: "High" }),
  });
  assert.equal(captions.length, 1);
  assert.equal(captions[0].sourceLanguage, "ja-JP");
  assert.equal(captions[0].sourceLanguageMode, "auto");
  assert.equal(captions[0].languageDetectionConfidence, "High");
  assert.ok(Number.isFinite(captions[0].languageDetectionLatencyMs));
  assert.equal(detections.length, 1);
  assert.equal(detections[0].language, "ja-JP");

  state.recognizers[0].recognized(null, {
    result: result({ language: "", languageDetectionConfidence: "" }),
  });
  assert.equal(captions.length, 2);
  assert.equal(captions[1].languageDetectionConfidence, "High");
  assert.equal(
    captions[1].languageDetectionLatencyMs,
    captions[0].languageDetectionLatencyMs,
  );
  assert.equal(detections.length, 1);

  state.recognizers[0].recognized(null, {
    result: result({ language: "ko-KR", languageDetectionConfidence: "High" }),
  });
  assert.equal(terminalErrors.length, 1);
  assert.match(terminalErrors[0].message, /changed at-start language/);
  assert.equal(captions.length, 2);
  await translator.stop();
});

test("Azure auto source canonicalizes candidate comparisons and upgrades confidence", async () => {
  const { sdk, state } = fakeSdk();
  const captions = [];
  const detections = [];
  const statuses = [];
  const terminalErrors = [];
  const translator = new AzureSpeechTranslator({
    sourceLanguage: "auto",
    sourceLanguageCandidates: ["en-us", "ja-jp"],
    targetLanguage: "vi",
    key: "test-key",
    region: "test-region",
    sdk,
    onCaption: (caption) => captions.push(caption),
    onLanguageDetected: (detection) => detections.push(detection),
    onStatus: (status) => statuses.push(status),
    onTerminal: (error) => terminalErrors.push(error),
  });
  await translator.start();

  state.recognizers[0].recognizing(null, {
    result: result({ language: "en-US", languageDetectionConfidence: "" }),
  });
  assert.equal(captions[0].sourceLanguage, "en-us");
  assert.equal(detections[0].confidence, "Unknown");
  assert.ok(statuses.some((status) => status.level === "warning"));

  state.recognizers[0].recognized(null, {
    result: result({ language: "en-US", languageDetectionConfidence: "High" }),
  });
  assert.equal(detections.length, 2);
  assert.equal(detections[1].updated, true);
  assert.equal(captions[1].languageDetectionConfidence, "High");

  state.recognizers[0].recognized(null, {
    result: result({ language: "fr-FR", languageDetectionConfidence: "High" }),
  });
  assert.equal(terminalErrors.length, 1);
  assert.match(terminalErrors[0].message, /unexpected source language/);
  assert.equal(captions.length, 2);
  await translator.stop();
});

test("Azure auto source terminates after repeated finals without a detected language", async () => {
  const { sdk, state } = fakeSdk();
  const captions = [];
  const statuses = [];
  const terminalErrors = [];
  const translator = new AzureSpeechTranslator({
    sourceLanguage: "auto",
    sourceLanguageCandidates: ["en-US", "ja-JP"],
    targetLanguage: "vi",
    key: "test-key",
    region: "test-region",
    sdk,
    onCaption: (caption) => captions.push(caption),
    onStatus: (status) => statuses.push(status),
    onTerminal: (error) => terminalErrors.push(error),
  });
  await translator.start();

  for (let count = 0; count < 3; count += 1) {
    state.recognizers[0].recognized(null, { result: result({ language: "" }) });
  }
  assert.equal(captions.length, 0);
  assert.equal(
    statuses.filter((status) => status.message.includes("chưa xác định được ngôn ngữ")).length,
    1,
  );
  assert.equal(terminalErrors.length, 1);
  assert.match(terminalErrors[0].message, /three recognized utterances/);
  await translator.stop();
});
