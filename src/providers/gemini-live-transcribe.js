const DEFAULT_MODEL = "gemini-3.5-transcribe-live";
const INPUT_MIME_TYPE = "audio/pcm;rate=16000";
const AUDIO_CHUNK_BYTES = 3_200;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_ROTATION_MS = 570_000;
const DEFAULT_HYBRID_SILENCE_MS = 320;
const DEFAULT_MAX_BUFFERED_AUDIO_BYTES = 64 * 1_024;
const MAX_SECRET_LENGTH = 16 * 1_024;
const MAX_TRANSCRIPT_CHARS = 64 * 1_024;
const USAGE_COUNTER_FIELDS = Object.freeze([
  "promptTokenCount",
  "responseTokenCount",
  "totalTokenCount",
  "cachedContentTokenCount",
  "thoughtsTokenCount",
  "toolUsePromptTokenCount",
]);

const secrets = new WeakMap();

function positiveInteger(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return number;
}

function normalizeApiKey(value) {
  const apiKey = String(value || "");
  if (!apiKey) throw new Error("Gemini API key is required");
  if (apiKey.length > MAX_SECRET_LENGTH || /[\u0000\r\n]/.test(apiKey)) {
    throw new Error("Invalid Gemini API key");
  }
  return apiKey;
}

function normalizeModel(value) {
  const model = String(value || DEFAULT_MODEL).trim();
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new Error("Invalid Gemini Live Transcribe model");
  }
  return model;
}

function normalizeLanguage(value, label, { allowAuto = false } = {}) {
  const language = String(value || "").trim();
  if (allowAuto && language.toLowerCase() === "auto") return "auto";
  if (!language || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) {
    throw new Error(`Invalid Gemini ${label} language`);
  }
  return language;
}

function normalizeLanguageCandidates(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Gemini source language candidates must be an array");
  if (value.length > 8) throw new Error("Gemini accepts at most 8 source language hints");
  const seen = new Set();
  return value
    .map((language) => normalizeLanguage(language, "source language hint"))
    .filter((language) => {
      const key = language.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeVocabulary(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Gemini custom vocabulary must be an array");
  const seen = new Set();
  const result = [];
  for (const candidate of value) {
    const term = String(candidate || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    if (!term) continue;
    const key = term.toLocaleLowerCase("und");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(term);
    if (result.length === 100) break;
  }
  return result;
}

function normalizeTranscriptionMode(value) {
  const mode = String(value || "VERBATIM").trim().toUpperCase();
  if (mode !== "VERBATIM" && mode !== "SMART") {
    throw new Error("Gemini transcription mode must be VERBATIM or SMART");
  }
  return mode;
}

function replaceAll(value, search, replacement) {
  return search ? value.split(search).join(replacement) : value;
}

function redact(value, sensitiveValues) {
  let result = String(value ?? "");
  const variants = (Array.isArray(sensitiveValues) ? sensitiveValues : [sensitiveValues])
    .filter(Boolean)
    .flatMap((secret) => [secret, encodeURIComponent(secret), `key=${secret}`])
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const variant of variants) result = replaceAll(result, variant, "[REDACTED]");
  return result;
}

function errorFromEvent(value, fallbackMessage) {
  if (value?.error instanceof Error) return value.error;
  if (value instanceof Error) return value;
  return new Error(String(value?.message || value?.reason || value || fallbackMessage));
}

function isQuotaExhausted(error) {
  const nested = error?.error instanceof Error ? error.error : null;
  const code = nested?.code ?? error?.code ?? nested?.status ?? error?.status;
  const detail = [nested?.message, error?.message, nested?.name, error?.name, code]
    .filter((item) => item !== undefined && item !== null)
    .join(" ");
  return Number(code) === 429 || /RESOURCE_EXHAUSTED|GEMINI_FREE_TIER_QUOTA|\b429\b/i.test(detail);
}

function publicGeminiError(error, sensitiveValues) {
  if (isQuotaExhausted(error)) {
    const quota = new Error(
      "Gemini Free Tier đã hết hạn mức hoặc đang giới hạn tốc độ. Hãy chờ rồi thử lại hoặc kiểm tra quota trong Google AI Studio; AudioTranslate đã dừng an toàn và không tự chuyển sang dịch vụ trả phí.",
    );
    quota.name = "GeminiQuotaError";
    quota.code = "GEMINI_FREE_TIER_QUOTA";
    return quota;
  }
  const source = errorFromEvent(error, "Gemini Live Transcribe error");
  const clean = new Error(redact(source.message || "Gemini Live Transcribe error", sensitiveValues));
  clean.name = redact(source.name || "Error", sensitiveValues);
  if (source.code !== undefined) clean.code = redact(source.code, sensitiveValues);
  return clean;
}

function normalizeUsageMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const field of USAGE_COUNTER_FIELDS) {
    const number = value[field];
    if (
      typeof number === "number" &&
      Number.isFinite(number) &&
      number >= 0 &&
      number <= Number.MAX_SAFE_INTEGER
    ) {
      result[field] = Math.round(number);
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function audioBufferFrom(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new TypeError("Gemini audio must be a Buffer, ArrayBuffer, or typed array");
}

function boundedTranscript(value) {
  const text = String(value || "").trim();
  return text.length <= MAX_TRANSCRIPT_CHARS
    ? text
    : text.slice(text.length - MAX_TRANSCRIPT_CHARS);
}

function closeSession(session) {
  if (!session || typeof session.close !== "function") return Promise.resolve();
  try {
    return Promise.resolve(session.close());
  } catch (error) {
    return Promise.reject(error);
  }
}

function withTimeout(promise, timeoutMs, label, setTimer, clearTimer, onTimeout) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimer(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer?.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimer(timer));
}

async function defaultClientFactory({ apiKey }) {
  let sdk;
  try {
    sdk = await import("@google/genai");
  } catch {
    throw new Error(
      "Gemini SDK is unavailable. Install @google/genai before using Gemini Live Transcribe.",
    );
  }
  const GoogleGenAI = sdk.GoogleGenAI || sdk.default?.GoogleGenAI;
  if (typeof GoogleGenAI !== "function") {
    throw new Error("Installed @google/genai package does not export GoogleGenAI");
  }
  return {
    client: new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1beta" } }),
    modalityText: sdk.Modality?.TEXT || "TEXT",
  };
}

class GeminiLiveTranscriber {
  constructor(options = {}) {
    const apiKey = normalizeApiKey(options.apiKey ?? options.key);
    secrets.set(this, { apiKey });

    this.model = normalizeModel(options.model);
    this.sourceLanguage = normalizeLanguage(options.sourceLanguage || "auto", "source", {
      allowAuto: true,
    });
    this.sourceLanguageCandidates = normalizeLanguageCandidates(
      options.sourceLanguageCandidates,
    );
    this.customVocabulary = normalizeVocabulary(options.customVocabulary);
    this.transcriptionMode = normalizeTranscriptionMode(options.transcriptionMode);
    this.clientFactory = options.clientFactory || defaultClientFactory;
    if (typeof this.clientFactory !== "function") {
      throw new Error("Gemini clientFactory must be a function");
    }

    this.onTranscript = options.onTranscript;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
    this.onTerminal = options.onTerminal;
    this.onLanguageDetected = options.onLanguageDetected;
    this.onUsage = options.onUsage;
    this.startupTimeoutMs = positiveInteger(
      options.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
      "Gemini Live Transcribe startup timeout",
      120_000,
    );
    this.rotationMs = positiveInteger(
      options.rotationMs,
      DEFAULT_ROTATION_MS,
      "Gemini Live Transcribe rotation interval",
      599_000,
    );
    this.hybridSilenceMs = positiveInteger(
      options.hybridSilenceMs,
      DEFAULT_HYBRID_SILENCE_MS,
      "Gemini hybrid silence threshold",
      5_000,
    );
    this.maxBufferedAudioBytes = positiveInteger(
      options.maxBufferedAudioBytes,
      DEFAULT_MAX_BUFFERED_AUDIO_BYTES,
      "Gemini buffered-audio limit",
      16 * 1_024 * 1_024,
    );
    if (this.maxBufferedAudioBytes < AUDIO_CHUNK_BYTES) {
      throw new Error(`Gemini buffered-audio limit must be at least ${AUDIO_CHUNK_BYTES} bytes`);
    }

    this.now = options.now || Date.now;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;

    Object.defineProperties(this, {
      client: { value: null, writable: true, enumerable: false },
      session: { value: null, writable: true, enumerable: false },
      pendingAudio: { value: Buffer.alloc(0), writable: true, enumerable: false },
      connectAbortController: { value: null, writable: true, enumerable: false },
      rotationPromise: { value: null, writable: true, enumerable: false },
      lastInterim: { value: "", writable: true, enumerable: false },
    });

    this.modalityText = "TEXT";
    this.state = "idle";
    this.startPromise = null;
    this.stopPromise = null;
    this.rotationTimer = null;
    this.nextEpoch = 0;
    this.connectionEpoch = 0;
    this.intentionalClose = false;
    this.terminalSignaled = false;
    this.paused = false;
    this.lastAudioCapturedAt = null;
    this.languageDetectionStartedAt = null;
    this.detectedLanguage = null;
    this.hadSpeech = false;
    this.boundarySent = false;
    this.audioBackpressureActive = false;
  }

  buildConfig() {
    const languageCodes =
      this.sourceLanguage === "auto"
        ? this.sourceLanguageCandidates
        : [this.sourceLanguage];
    return {
      responseModalities: [this.modalityText],
      inputAudioTranscription: {
        languageCodes,
        ...(this.customVocabulary.length > 0
          ? { customVocabulary: [...this.customVocabulary] }
          : {}),
        mode: this.transcriptionMode,
      },
    };
  }

  start() {
    if (this.state === "running") return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.state !== "idle") {
      return Promise.reject(
        new Error(`Gemini Live Transcribe cannot start from state ${this.state}`),
      );
    }
    this.state = "starting";
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  async startInternal() {
    const { apiKey } = secrets.get(this);
    this.onStatus?.({ level: "connecting", message: "Đang kết nối Gemini Live Transcribe…" });
    try {
      const factoryResult = await this.clientFactory({ apiKey });
      const client = factoryResult?.client || factoryResult;
      if (!client?.live || typeof client.live.connect !== "function") {
        throw new Error("Gemini clientFactory returned an invalid Live API client");
      }
      if (this.state !== "starting") {
        throw new Error("Gemini Live Transcribe was stopped during startup");
      }
      this.client = client;
      this.modalityText = factoryResult?.modalityText || "TEXT";
      const candidate = await this.openCandidate();
      if (this.state !== "starting") {
        await closeSession(candidate.session).catch(() => {});
        throw new Error("Gemini Live Transcribe was stopped during startup");
      }
      this.activateCandidate(candidate);
      this.state = "running";
      this.scheduleRotation();
      this.onStatus?.({
        level: "ok",
        message: "Gemini Live Transcribe đã sẵn sàng",
      });
    } catch (error) {
      const clean = publicGeminiError(error, apiKey);
      if (this.state !== "stopping" && this.state !== "stopped") this.state = "stopped";
      if (this.state === "stopped") {
        this.clearSensitiveAudio();
        this.client = null;
        secrets.get(this).apiKey = "";
      }
      throw clean;
    }
  }

  async openCandidate() {
    if (!this.client) throw new Error("Gemini Live client is not initialized");
    const epoch = ++this.nextEpoch;
    const abortController = new AbortController();
    this.connectAbortController = abortController;
    const connecting = Promise.resolve(
      this.client.live.connect({
        model: this.model,
        config: {
          ...this.buildConfig(),
          abortSignal: abortController.signal,
        },
        callbacks: {
          onopen: () => {
            if (this.isStopping()) return;
            this.onStatus?.({ level: "connecting", message: "Gemini Transcribe WebSocket đã mở" });
          },
          onmessage: (message) => this.handleMessage(message, epoch),
          onerror: (event) => this.handleTransportError(event, epoch),
          onclose: (event) => this.handleTransportClose(event, epoch),
        },
      }),
    );
    let session;
    try {
      session = await withTimeout(
        connecting,
        this.startupTimeoutMs,
        "Gemini Live Transcribe startup",
        this.setTimer,
        this.clearTimer,
        () => abortController.abort(),
      );
    } finally {
      if (this.connectAbortController === abortController) this.connectAbortController = null;
    }
    if (!session || typeof session.sendRealtimeInput !== "function") {
      await closeSession(session).catch(() => {});
      throw new Error("Gemini Live API returned an invalid transcription session");
    }
    if (this.isStopping()) {
      await closeSession(session).catch(() => {});
      throw new Error("Gemini Live Transcribe connection became stale during startup");
    }
    return { epoch, session };
  }

  activateCandidate(candidate) {
    this.session = candidate.session;
    this.connectionEpoch = candidate.epoch;
    this.lastInterim = "";
    this.hadSpeech = false;
    this.boundarySent = false;
  }

  scheduleRotation() {
    this.clearRotationTimer();
    if (this.state !== "running") return;
    this.rotationTimer = this.setTimer(() => {
      this.rotationTimer = null;
      this.rotationPromise = this.rotateSession();
    }, this.rotationMs);
    this.rotationTimer?.unref?.();
  }

  clearRotationTimer() {
    if (!this.rotationTimer) return;
    this.clearTimer(this.rotationTimer);
    this.rotationTimer = null;
  }

  async rotateSession() {
    if (this.state !== "running" || this.isStopping()) return;
    const previous = this.session;
    try {
      const candidate = await this.openCandidate();
      if (this.state !== "running" || this.isStopping()) {
        await closeSession(candidate.session).catch(() => {});
        return;
      }
      this.activateCandidate(candidate);
      await closeSession(previous).catch((error) => this.onError?.(this.cleanError(error)));
      this.scheduleRotation();
      this.onStatus?.({
        level: "ok",
        message: "Gemini Live Transcribe đã xoay phiên an toàn",
      });
    } catch (error) {
      if (this.isStopping()) return;
      this.onError?.(this.cleanError(error));
      this.scheduleRotation();
    }
  }

  write(pcm, timing = {}) {
    if (this.state !== "running" || this.terminalSignaled || this.paused || !this.session) {
      return false;
    }
    const audio = audioBufferFrom(pcm);
    if (audio.byteLength === 0) return true;
    if (audio.byteLength % 2 !== 0) {
      audio.fill(0);
      throw new Error("Gemini PCM16 audio must contain an even number of bytes");
    }
    if (this.pendingAudio.byteLength + audio.byteLength > this.maxBufferedAudioBytes) {
      audio.fill(0);
      if (!this.audioBackpressureActive) {
        this.audioBackpressureActive = true;
        this.onStatus?.({
          level: "warning",
          message: "Bộ đệm Gemini Transcribe đã đầy; tạm bỏ audio mới",
        });
      }
      return false;
    }
    const capturedAt = Number(timing.capturedAt);
    if (Number.isFinite(capturedAt)) {
      this.lastAudioCapturedAt = capturedAt;
      if (this.languageDetectionStartedAt === null && this.sourceLanguage === "auto") {
        this.languageDetectionStartedAt = capturedAt;
      }
    }
    const previous = this.pendingAudio;
    this.pendingAudio = Buffer.concat([previous, audio]);
    previous.fill(0);
    audio.fill(0);
    return this.drainAudio();
  }

  drainAudio() {
    while (this.state === "running" && this.session && this.pendingAudio.length >= AUDIO_CHUNK_BYTES) {
      const previous = this.pendingAudio;
      const chunk = Buffer.from(previous.subarray(0, AUDIO_CHUNK_BYTES));
      this.pendingAudio = Buffer.from(previous.subarray(AUDIO_CHUNK_BYTES));
      previous.fill(0);
      try {
        this.session.sendRealtimeInput({
          audio: { data: chunk.toString("base64"), mimeType: INPUT_MIME_TYPE },
        });
      } catch (error) {
        chunk.fill(0);
        this.signalTerminal(this.cleanError(error));
        return false;
      }
      chunk.fill(0);
    }
    if (this.audioBackpressureActive && this.pendingAudio.length < AUDIO_CHUNK_BYTES) {
      this.audioBackpressureActive = false;
      this.onStatus?.({ level: "ok", message: "Bộ đệm Gemini Transcribe đã phục hồi" });
    }
    return true;
  }

  setAudioActivity(value = {}) {
    if (this.state !== "running" || this.paused || !this.session) return false;
    if (value.speech === true) {
      this.hadSpeech = true;
      this.boundarySent = false;
      return true;
    }
    const silenceMs = Number(value.silenceMs);
    if (
      this.hadSpeech &&
      !this.boundarySent &&
      Number.isFinite(silenceMs) &&
      silenceMs >= this.hybridSilenceMs
    ) {
      try {
        this.session.sendRealtimeInput({ audioStreamEnd: true });
      } catch (error) {
        this.signalTerminal(this.cleanError(error));
        return false;
      }
      this.boundarySent = true;
      this.hadSpeech = false;
      return true;
    }
    return false;
  }

  handleMessage(message, epoch) {
    if (epoch !== this.connectionEpoch || this.isStopping() || this.paused) return;
    const usage = normalizeUsageMetadata(message?.usageMetadata);
    if (usage) this.onUsage?.(usage);
    const content = message?.serverContent;
    if (!content || typeof content !== "object") return;

    const interim = content.interimInputTranscription;
    if (interim && typeof interim === "object") {
      this.recordDetectedLanguage(interim.languageCode);
      const text = boundedTranscript(interim.text);
      if (text && text !== this.lastInterim) {
        this.lastInterim = text;
        this.emitTranscript(text, false, interim.languageCode);
      }
    }
    const final = content.inputTranscription;
    if (final && typeof final === "object") {
      this.recordDetectedLanguage(final.languageCode);
      const text = boundedTranscript(final.text);
      if (text) {
        this.lastInterim = "";
        this.emitTranscript(text, true, final.languageCode);
      }
    }
  }

  emitTranscript(text, isFinal, rawLanguage) {
    const sourceLanguage =
      String(rawLanguage || "").trim() ||
      this.detectedLanguage ||
      this.sourceLanguage;
    this.onTranscript?.({
      text,
      isFinal,
      sourceLanguage,
      capturedAt: this.lastAudioCapturedAt,
      emittedAt: this.now(),
      provider: "gemini-live-transcribe",
    });
  }

  recordDetectedLanguage(rawLanguage) {
    if (this.sourceLanguage !== "auto") return;
    const language = String(rawLanguage || "").trim();
    if (!language || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) return;
    if (language.toLowerCase() === this.detectedLanguage?.toLowerCase()) return;
    const updated = Boolean(this.detectedLanguage);
    this.detectedLanguage = language;
    const detectionLatencyMs = Number.isFinite(this.languageDetectionStartedAt)
      ? Math.max(0, Math.round(this.now() - this.languageDetectionStartedAt))
      : null;
    this.onLanguageDetected?.({
      language,
      confidence: null,
      detectionLatencyMs,
      provider: "gemini-live-transcribe",
      ...(updated ? { updated: true } : {}),
    });
  }

  handleTransportError(event, epoch) {
    if (epoch !== this.connectionEpoch || this.isStopping()) return;
    this.signalTerminal(this.cleanError(event));
  }

  handleTransportClose(event, epoch) {
    if (epoch !== this.connectionEpoch || this.isStopping() || this.intentionalClose) return;
    this.signalTerminal(this.cleanError(event || "Gemini Live Transcribe connection closed"));
  }

  cleanError(error) {
    return publicGeminiError(error, secrets.get(this)?.apiKey || "");
  }

  signalTerminal(error) {
    if (this.terminalSignaled || this.isStopping()) return;
    this.terminalSignaled = true;
    this.state = "failed";
    this.clearRotationTimer();
    this.clearSensitiveAudio();
    this.onTerminal?.(this.cleanError(error));
  }

  isStopping() {
    return this.state === "stopping" || this.state === "stopped";
  }

  clearSensitiveAudio() {
    this.pendingAudio.fill(0);
    this.pendingAudio = Buffer.alloc(0);
    this.lastInterim = "";
    this.lastAudioCapturedAt = null;
    this.hadSpeech = false;
    this.boundarySent = false;
    this.audioBackpressureActive = false;
  }

  setPaused(paused) {
    const next = paused === true;
    if (this.paused === next) return false;
    this.paused = next;
    if (next) this.clearSensitiveAudio();
    return true;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  async stopInternal() {
    if (this.state === "stopped") return;
    this.state = "stopping";
    this.intentionalClose = true;
    this.clearRotationTimer();
    this.connectAbortController?.abort();
    this.clearSensitiveAudio();
    const session = this.session;
    this.session = null;
    await closeSession(session).catch((error) => this.onError?.(this.cleanError(error)));
    await this.rotationPromise?.catch(() => {});
    this.client = null;
    secrets.get(this).apiKey = "";
    this.state = "stopped";
    this.paused = false;
    this.onStatus?.({ level: "idle", message: "Gemini Live Transcribe đã dừng" });
  }
}

module.exports = {
  AUDIO_CHUNK_BYTES,
  DEFAULT_MODEL,
  DEFAULT_ROTATION_MS,
  GeminiLiveTranscriber,
};
