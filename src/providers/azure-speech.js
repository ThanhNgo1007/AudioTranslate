function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

const MAX_MISSING_LANGUAGE_FINALS = 3;
const CONFIDENCE_RANK = Object.freeze({ Unknown: 0, Low: 1, Medium: 2, High: 3 });

class AzureSpeechTranslator {
  constructor(options) {
    this.sourceLanguage = options.sourceLanguage;
    this.sourceLanguageCandidates = options.sourceLanguageCandidates || [];
    this.targetLanguage = options.targetLanguage;
    this.key = options.key;
    this.region = options.region;
    this.onCaption = options.onCaption;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
    this.onTerminal = options.onTerminal;
    this.onLanguageDetected = options.onLanguageDetected;
    this.sequence = 0;
    this.firstCapturedAt = null;
    this.totalSamples = 0;
    this.sdk = null;
    this.pushStream = null;
    this.recognizer = null;
    this.running = false;
    this.stopPromise = null;
    this.terminalSignaled = false;
    this.terminalError = null;
    this.detectedLanguage = null;
    this.languageDetectionConfidence = null;
    this.languageDetectionLatencyMs = null;
    this.sdkOverride = options.sdk;
    this.languageDetectionStartedAt = null;
    this.missingLanguageNotified = false;
    this.missingLanguageFinals = 0;
  }

  async start() {
    if (!this.key || !this.region) {
      throw new Error(
        "Azure Speech credentials are missing. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in .env.",
      );
    }

    // Lazy loading lets `doctor`, preview and unit tests run without cloud SDK startup work.
    this.sdk = this.sdkOverride || require("microsoft-cognitiveservices-speech-sdk");
    const sdk = this.sdk;
    const speechConfig = sdk.SpeechTranslationConfig.fromSubscription(this.key, this.region);
    const autoDetect = this.sourceLanguage === "auto";
    if (
      autoDetect &&
      (this.sourceLanguageCandidates.length < 2 || this.sourceLanguageCandidates.length > 4)
    ) {
      throw new Error("Azure at-start language detection requires 2-4 candidate locales");
    }
    // Azure still requires a placeholder locale when candidate LID is active.
    // The service ignores it and returns the detected language on each result.
    speechConfig.speechRecognitionLanguage = autoDetect
      ? this.sourceLanguageCandidates[0]
      : this.sourceLanguage;
    speechConfig.addTargetLanguage(this.targetLanguage);
    speechConfig.setProperty(sdk.PropertyId.Recognizer_StopTimeoutMs, "3000");
    speechConfig.setProperty(
      sdk.PropertyId.SpeechServiceResponse_TranslationRequestStablePartialResult,
      "true",
    );

    const format = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
    this.pushStream = sdk.AudioInputStream.createPushStream(format);
    const audioConfig = sdk.AudioConfig.fromStreamInput(this.pushStream);
    if (autoDetect) {
      const languageConfig = sdk.AutoDetectSourceLanguageConfig.fromLanguages(
        this.sourceLanguageCandidates,
      );
      languageConfig.mode = sdk.LanguageIdMode.AtStart;
      this.recognizer = sdk.TranslationRecognizer.FromConfig(
        speechConfig,
        languageConfig,
        audioConfig,
      );
    } else {
      this.recognizer = new sdk.TranslationRecognizer(speechConfig, audioConfig);
    }

    this.recognizer.recognizing = (_sender, event) => {
      this.emitResult(event.result, false);
    };
    this.recognizer.recognized = (_sender, event) => {
      this.emitResult(event.result, true);
    };
    this.recognizer.canceled = (_sender, event) => {
      const detail = event.errorDetails || String(event.reason || "Unknown Azure cancellation");
      this.signalTerminal(new Error(`Azure Speech canceled: ${detail}`));
    };
    this.recognizer.sessionStarted = () => {
      this.onStatus?.({ level: "ok", message: "Azure Speech session connected" });
    };
    this.recognizer.sessionStopped = () => {
      this.onStatus?.({ level: "idle", message: "Azure Speech session stopped" });
      if (this.running) this.signalTerminal(new Error("Azure Speech session stopped unexpectedly"));
    };

    try {
      if (autoDetect) {
        this.languageDetectionStartedAt = Date.now();
        this.onStatus?.({
          level: "connecting",
          message: `Đang nhận diện trong ${this.sourceLanguageCandidates.join(", ")}…`,
        });
      }
      await withTimeout(
        new Promise((resolve, reject) => {
          this.recognizer.startContinuousRecognitionAsync(resolve, (error) => {
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        }),
        15000,
        "Azure Speech startup",
      );
      if (this.terminalError) throw this.terminalError;
      this.running = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  write(pcm, timing = {}) {
    // The SDK push stream can buffer the first frames while the continuous
    // recognizer finishes connecting, avoiding a clipped first word.
    if (!this.pushStream) return;
    if (this.firstCapturedAt === null) {
      const frameDurationMs = (pcm.byteLength / 2 / 16000) * 1000;
      this.firstCapturedAt = Number.isFinite(timing.capturedAt)
        ? timing.capturedAt - frameDurationMs
        : Date.now() - frameDurationMs;
    }
    this.totalSamples += pcm.byteLength / 2;
    const arrayBuffer = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
    this.pushStream.write(arrayBuffer);
  }

  emitResult(result, isFinal) {
    if (!result) return;
    const transcript = String(result.text || "").trim();
    const translations = result.translations;
    let translation = "";
    if (translations && typeof translations.get === "function") {
      translation = String(translations.get(this.targetLanguage) || "").trim();
    } else if (translations && typeof translations === "object") {
      translation = String(translations[this.targetLanguage] || "").trim();
    }
    if (!transcript && !translation) return;

    const autoDetected = this.sourceLanguage === "auto";
    const reportedLanguage = autoDetected ? String(result.language || "").trim() : "";
    const matchedCandidate = reportedLanguage
      ? this.sourceLanguageCandidates.find(
          (candidate) => candidate.toLowerCase() === reportedLanguage.toLowerCase(),
        )
      : "";
    if (autoDetected && reportedLanguage && !matchedCandidate) {
      this.signalTerminal(
        new Error(`Azure returned unexpected source language: ${reportedLanguage}`),
      );
      return;
    }
    const detectedLanguage = autoDetected
      ? matchedCandidate || this.detectedLanguage
      : this.sourceLanguage;
    const reportedConfidence = autoDetected
      ? String(result.languageDetectionConfidence || "Unknown")
      : null;
    if (autoDetected && !detectedLanguage) {
      if (isFinal) {
        this.missingLanguageFinals += 1;
        if (!this.missingLanguageNotified) {
          this.missingLanguageNotified = true;
          this.onStatus?.({
            level: "warning",
            message: "Azure chưa xác định được ngôn ngữ; chưa hiển thị câu để tránh dịch sai",
          });
        }
        if (this.missingLanguageFinals >= MAX_MISSING_LANGUAGE_FINALS) {
          this.signalTerminal(
            new Error(
              "Azure could not identify the source language after three recognized utterances; choose a fixed source or a better candidate list",
            ),
          );
        }
      }
      return;
    }
    if (
      autoDetected &&
      this.detectedLanguage &&
      matchedCandidate !== "" &&
      matchedCandidate.toLowerCase() !== this.detectedLanguage.toLowerCase()
    ) {
      this.signalTerminal(
        new Error(
          `Azure changed at-start language from ${this.detectedLanguage} to ${matchedCandidate}`,
        ),
      );
      return;
    }
    if (autoDetected && !this.detectedLanguage) {
      this.detectedLanguage = detectedLanguage;
      this.missingLanguageFinals = 0;
      this.languageDetectionConfidence = reportedConfidence;
      this.languageDetectionLatencyMs = Math.max(
        0,
        Date.now() - Number(this.languageDetectionStartedAt || Date.now()),
      );
      this.onLanguageDetected?.({
        language: detectedLanguage,
        confidence: this.languageDetectionConfidence,
        detectionLatencyMs: this.languageDetectionLatencyMs,
      });
      this.onStatus?.({
        level: ["Unknown", "Low"].includes(this.languageDetectionConfidence)
          ? "warning"
          : "ok",
        message: `Đã nhận diện ngôn ngữ: ${detectedLanguage} (${this.languageDetectionConfidence})`,
      });
    } else if (
      autoDetected &&
      (CONFIDENCE_RANK[reportedConfidence] || 0) >
        (CONFIDENCE_RANK[this.languageDetectionConfidence] || 0)
    ) {
      this.languageDetectionConfidence = reportedConfidence;
      this.onLanguageDetected?.({
        language: this.detectedLanguage,
        confidence: this.languageDetectionConfidence,
        detectionLatencyMs: this.languageDetectionLatencyMs,
        updated: true,
      });
      this.onStatus?.({
        level: this.languageDetectionConfidence === "Low" ? "warning" : "ok",
        message: `Độ tin cậy nhận diện ${this.detectedLanguage}: ${this.languageDetectionConfidence}`,
      });
    }

    const now = Date.now();
    let latencyMs = null;
    const sdkLatencyRaw = result.properties?.getProperty?.(
      this.sdk.PropertyId.SpeechServiceResponse_RecognitionLatencyMs,
      "",
    );
    const sdkLatency = sdkLatencyRaw === "" || sdkLatencyRaw === undefined ? NaN : Number(sdkLatencyRaw);
    if (Number.isFinite(sdkLatency) && sdkLatency >= 0) latencyMs = Math.round(sdkLatency);
    const offsetTicks = Number(result.offset || 0);
    const durationTicks = Number(result.duration || 0);
    if (
      latencyMs === null &&
      this.firstCapturedAt !== null &&
      Number.isFinite(offsetTicks + durationTicks)
    ) {
      const audioSegmentEndAt = this.firstCapturedAt + (offsetTicks + durationTicks) / 10000;
      latencyMs = Math.max(0, Math.round(now - audioSegmentEndAt));
    }

    this.onCaption?.({
      type: "caption",
      sequence: this.sequence++,
      transcript,
      translation,
      sourceLanguage: detectedLanguage,
      sourceLanguageMode: autoDetected ? "auto" : "fixed",
      languageDetectionConfidence: autoDetected ? this.languageDetectionConfidence : null,
      languageDetectionLatencyMs: autoDetected ? this.languageDetectionLatencyMs : null,
      targetLanguage: this.targetLanguage,
      isFinal,
      emittedAt: now,
      latencyMs,
      provider: "azure",
    });
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  signalTerminal(error) {
    if (this.terminalSignaled) return;
    this.terminalSignaled = true;
    this.terminalError = error;
    this.onTerminal?.(error);
  }

  async stopInternal() {
    this.running = false;
    if (this.pushStream) {
      try {
        this.pushStream.close();
      } catch {
        // Best effort during shutdown.
      }
    }
    if (this.recognizer) {
      const recognizer = this.recognizer;
      try {
        await withTimeout(
          new Promise((resolve, reject) => {
            recognizer.stopContinuousRecognitionAsync(resolve, (error) =>
              reject(error instanceof Error ? error : new Error(String(error))),
            );
          }),
          4000,
          "Azure Speech stop",
        );
      } catch (error) {
        this.onError?.(error);
      }
      await withTimeout(
        new Promise((resolve) => recognizer.close(resolve, resolve)),
        2000,
        "Azure Speech close",
      ).catch(() => {});
    }
    this.recognizer = null;
    this.pushStream = null;
  }
}

module.exports = { AzureSpeechTranslator };
