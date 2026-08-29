const { performance } = require("node:perf_hooks");

const DEFAULT_MODEL = "gemini-3.5-live-translate-preview";
const INPUT_MIME_TYPE = "audio/pcm;rate=16000";
const AUDIO_CHUNK_BYTES = 3200;
const DEFAULT_FINAL_DEBOUNCE_MS = 120;
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BUFFERED_AUDIO_BYTES = 64 * 1024;
const DEFAULT_MAX_RECONNECT_AUDIO_AGE_MS = 1000;
const MAX_SECRET_LENGTH = 16 * 1024;
const MAX_RESUMPTION_HANDLE_LENGTH = 64 * 1024;
const MAX_TRANSCRIPT_CHARS = 64 * 1024;
const MAX_FRAGMENT_OVERLAP_CHARS = 1024;
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

function nonNegativeInteger(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    throw new Error(`${label} must be an integer between 0 and ${maximum}`);
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
  const normalized = value.map((language) =>
    normalizeLanguage(language, "source language hint"),
  );
  const seen = new Set();
  return normalized.filter((language) => {
    const key = language.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeModel(value) {
  const model = String(value || DEFAULT_MODEL).trim();
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new Error("Invalid Gemini Live Translate model");
  }
  return model;
}

function replaceAll(value, search, replacement) {
  if (!search) return value;
  return value.split(search).join(replacement);
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
  const message = value?.message || value?.reason || value || fallbackMessage;
  return new Error(String(message));
}

function sanitizedError(error, sensitiveValues, fallbackMessage = "Gemini Live Translate error") {
  const source = errorFromEvent(error, fallbackMessage);
  const clean = new Error(redact(source.message || fallbackMessage, sensitiveValues));
  clean.name = redact(source.name || "Error", sensitiveValues);
  if (source.code !== undefined) clean.code = redact(source.code, sensitiveValues);
  return clean;
}

function isQuotaExhausted(error) {
  const nested = error?.error instanceof Error ? error.error : null;
  const code = nested?.code ?? error?.code ?? nested?.status ?? error?.status;
  const detail = [nested?.message, error?.message, nested?.name, error?.name, code]
    .filter((value) => value !== undefined && value !== null)
    .join(" ");
  return Number(code) === 429 || /RESOURCE_EXHAUSTED|GEMINI_FREE_TIER_QUOTA|\b429\b/i.test(detail);
}

function publicGeminiError(error, sensitiveValues) {
  const clean = sanitizedError(error, sensitiveValues);
  if (!isQuotaExhausted(error) && !isQuotaExhausted(clean)) return clean;
  const quota = new Error(
    "Gemini Free Tier đã hết hạn mức hoặc đang giới hạn tốc độ. Hãy chờ rồi thử lại hoặc kiểm tra quota trong Google AI Studio; AudioTranslate đã dừng an toàn và không tự động chuyển sang dịch vụ trả phí.",
  );
  quota.name = "GeminiQuotaError";
  quota.code = "GEMINI_FREE_TIER_QUOTA";
  return quota;
}

function normalizeUsageMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = {};
  for (const field of USAGE_COUNTER_FIELDS) {
    const candidate = value[field];
    if (
      typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= 0 &&
      candidate <= Number.MAX_SAFE_INTEGER
    ) {
      normalized[field] = Math.round(candidate);
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
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
  const text = String(value || "");
  return text.length <= MAX_TRANSCRIPT_CHARS
    ? text
    : text.slice(text.length - MAX_TRANSCRIPT_CHARS);
}

function appendFragment(currentValue, nextValue) {
  const current = boundedTranscript(currentValue);
  const next = boundedTranscript(nextValue);
  if (!next) return current;
  if (!current) return next;
  if (next === current || current.endsWith(next)) return current;
  if (next.startsWith(current)) return next;

  const maximumOverlap = Math.min(
    current.length,
    next.length,
    MAX_FRAGMENT_OVERLAP_CHARS,
  );
  for (let overlap = maximumOverlap; overlap > 0; overlap -= 1) {
    if (current.slice(-overlap) === next.slice(0, overlap)) {
      return boundedTranscript(current + next.slice(overlap));
    }
  }
  return boundedTranscript(current + next);
}

function closeSession(session) {
  if (!session || typeof session.close !== "function") return Promise.resolve();
  try {
    return Promise.resolve(session.close());
  } catch (error) {
    return Promise.reject(error);
  }
}

function withTimeout(promise, timeoutMs, label, onTimeout) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function defaultClientFactory({ apiKey }) {
  let sdk;
  try {
    // Keep preview, CLI help and unit tests usable without eagerly loading the SDK.
    sdk = await import("@google/genai");
  } catch {
    throw new Error(
      "Gemini SDK is unavailable. Install @google/genai before using Gemini Live Translate.",
    );
  }
  const GoogleGenAI = sdk.GoogleGenAI || sdk.default?.GoogleGenAI;
  if (typeof GoogleGenAI !== "function") {
    throw new Error("Installed @google/genai package does not export GoogleGenAI");
  }
  return {
    client: new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1beta" } }),
    modalityAudio: sdk.Modality?.AUDIO || "AUDIO",
  };
}

class GeminiLiveTranslateTranslator {
  constructor(options = {}) {
    const apiKey = normalizeApiKey(options.apiKey ?? options.key);
    secrets.set(this, { apiKey, resumptionHandle: null });

    this.model = normalizeModel(options.model);
    this.sourceLanguage = normalizeLanguage(options.sourceLanguage || "auto", "source", {
      allowAuto: true,
    });
    this.sourceLanguageCandidates = normalizeLanguageCandidates(
      options.sourceLanguageCandidates,
    );
    this.targetLanguage = normalizeLanguage(options.targetLanguage, "target");
    this.enableInputTranscription = options.enableInputTranscription === true;
    this.echoTargetLanguage = options.echoTargetLanguage === true;
    this.enableSessionResumption = options.enableSessionResumption !== false;
    this.clientFactory = options.clientFactory || defaultClientFactory;
    if (typeof this.clientFactory !== "function") {
      throw new Error("Gemini clientFactory must be a function");
    }

    this.onCaption = options.onCaption;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
    this.onTerminal = options.onTerminal;
    this.onLanguageDetected = options.onLanguageDetected;
    this.onUsage = options.onUsage;

    this.startupTimeoutMs = positiveInteger(
      options.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
      "Gemini startup timeout",
      120000,
    );
    this.finalDebounceMs = nonNegativeInteger(
      options.finalDebounceMs,
      DEFAULT_FINAL_DEBOUNCE_MS,
      "Gemini final debounce",
      5000,
    );
    this.maxBufferedAudioBytes = positiveInteger(
      options.maxBufferedAudioBytes,
      DEFAULT_MAX_BUFFERED_AUDIO_BYTES,
      "Gemini buffered-audio limit",
      16 * 1024 * 1024,
    );
    if (this.maxBufferedAudioBytes < AUDIO_CHUNK_BYTES) {
      throw new Error(`Gemini buffered-audio limit must be at least ${AUDIO_CHUNK_BYTES} bytes`);
    }
    this.maxReconnectAudioAgeMs = positiveInteger(
      options.maxReconnectAudioAgeMs,
      DEFAULT_MAX_RECONNECT_AUDIO_AGE_MS,
      "Gemini reconnect audio age limit",
      10000,
    );

    this.now = options.now || Date.now;
    this.monotonicNow =
      options.monotonicNow || (options.now ? options.now : () => performance.now());
    if (typeof this.monotonicNow !== "function") {
      throw new Error("Gemini monotonic clock must be a function");
    }
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;

    Object.defineProperties(this, {
      client: { value: null, writable: true, enumerable: false },
      session: { value: null, writable: true, enumerable: false },
      connectAbortController: { value: null, writable: true, enumerable: false },
      pendingAudio: { value: Buffer.alloc(0), writable: true, enumerable: false },
      pendingAudioSegments: { value: [], writable: true, enumerable: false },
      turn: {
        value: this.createEmptyTurn(),
        writable: true,
        enumerable: false,
      },
      lastCaptionSignature: { value: null, writable: true, enumerable: false },
    });

    this.modalityAudio = "AUDIO";
    this.state = "idle";
    this.sequence = 0;
    this.connectionEpoch = 0;
    this.startPromise = null;
    this.stopPromise = null;
    this.reconnectPromise = null;
    this.finalTimer = null;
    this.terminalSignaled = false;
    this.terminalError = null;
    this.detectedLanguage = null;
    this.languageDetectionLatencyMs = null;
    this.languageDetectionStartedAt = null;
    this.lastAudioCapturedAt = null;
    this.audioBackpressureActive = false;
    this.reconnectDiscardedAudioBytes = 0;
    this.paused = false;
  }

  createEmptyTurn() {
    return {
      input: "",
      interimInput: "",
      output: "",
      inputFinished: false,
      outputFinished: false,
      serverBoundaryObserved: false,
      lastCapturedAt: null,
      firstPartialEmittedAt: null,
    };
  }

  start() {
    if (this.state === "running") return Promise.resolve();
    if (this.state === "starting" && this.startPromise) return this.startPromise;
    if (this.state !== "idle") {
      return Promise.reject(new Error(`Gemini Live Translate cannot start from state ${this.state}`));
    }
    this.state = "starting";
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  async startInternal() {
    const { apiKey } = secrets.get(this);
    this.onStatus?.({ level: "connecting", message: "Đang kết nối Gemini Live Translate…" });
    try {
      const factoryResult = await this.clientFactory({ apiKey });
      const client = factoryResult?.client || factoryResult;
      if (!client?.live || typeof client.live.connect !== "function") {
        throw new Error("Gemini clientFactory returned an invalid Live API client");
      }
      if (this.state !== "starting") {
        throw new Error("Gemini Live Translate was stopped during startup");
      }
      this.client = client;
      this.modalityAudio = factoryResult?.modalityAudio || "AUDIO";
      await this.openSession(null);
      if (this.terminalError) throw this.terminalError;
      if (this.state !== "starting") {
        throw new Error("Gemini Live Translate was stopped during startup");
      }
      this.state = "running";
      this.onStatus?.({
        level: "ok",
        message: `Gemini Live Translate đã sẵn sàng → ${this.targetLanguage}`,
      });
    } catch (error) {
      // Keep a local reference until startup settles so a concurrent stop can
      // wipe the WeakMap without making a late startup error leak the key.
      const clean = publicGeminiError(error, [apiKey, secrets.get(this).resumptionHandle]);
      if (this.state !== "stopping" && this.state !== "stopped") this.state = "stopped";
      if (this.state === "stopped") {
        this.client = null;
        this.clearSensitiveAudio();
        const secret = secrets.get(this);
        secret.resumptionHandle = null;
        secret.apiKey = "";
      }
      throw clean;
    }
  }

  buildConfig(handle) {
    const languageCodes =
      this.sourceLanguage === "auto"
        ? this.sourceLanguageCandidates
        : [this.sourceLanguage];
    const config = {
      responseModalities: [this.modalityAudio],
      ...(this.enableInputTranscription
        ? {
            inputAudioTranscription:
              languageCodes.length > 0 ? { languageCodes } : {},
          }
        : {}),
      outputAudioTranscription: {},
      translationConfig: {
        targetLanguageCode: this.targetLanguage,
        echoTargetLanguage: this.echoTargetLanguage,
      },
      contextWindowCompression: { slidingWindow: {} },
    };
    // `transparent` is an Enterprise Agent Platform-only field. The Gemini
    // Developer API (API-key mode) rejects it before opening the WebSocket.
    // An empty object starts a resumable session and a later connection passes
    // only the latest handle, matching the public Live API contract.
    if (this.enableSessionResumption) {
      config.sessionResumption = handle ? { handle } : {};
    }
    return config;
  }

  async openSession(handle) {
    if (!this.client) throw new Error("Gemini Live API client is not initialized");
    const epoch = ++this.connectionEpoch;
    const abortController = new AbortController();
    this.connectAbortController = abortController;
    const connecting = Promise.resolve(
      this.client.live.connect({
        model: this.model,
        config: {
          ...this.buildConfig(handle),
          abortSignal: abortController.signal,
        },
        callbacks: {
          onopen: () => {
            if (epoch !== this.connectionEpoch || this.isStopping()) return;
            this.onStatus?.({ level: "connecting", message: "Gemini Live WebSocket đã mở" });
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
        "Gemini Live Translate startup",
        () => abortController.abort(),
      );
    } finally {
      if (this.connectAbortController === abortController) this.connectAbortController = null;
    }
    if (!session || typeof session.sendRealtimeInput !== "function") {
      await closeSession(session).catch(() => {});
      throw new Error("Gemini Live API returned an invalid session");
    }
    if (epoch !== this.connectionEpoch || this.isStopping()) {
      await closeSession(session).catch(() => {});
      throw new Error("Gemini Live Translate connection became stale during startup");
    }
    this.session = session;
  }

  write(pcm, timing = {}) {
    if (
      (this.state !== "running" && this.state !== "reconnecting") ||
      this.terminalSignaled ||
      this.paused
    ) {
      return false;
    }

    const audio = audioBufferFrom(pcm);
    if (audio.byteLength === 0) return true;
    if (audio.byteLength % 2 !== 0) {
      audio.fill(0);
      throw new Error("Gemini PCM16 audio must contain an even number of bytes");
    }
    if (audio.byteLength > this.maxBufferedAudioBytes) {
      return this.rejectAudioForBackpressure(audio);
    }
    if (this.state === "reconnecting") {
      this.reconnectDiscardedAudioBytes += this.discardReconnectAudio(audio.byteLength);
    }
    if (this.pendingAudio.byteLength + audio.byteLength > this.maxBufferedAudioBytes) {
      return this.rejectAudioForBackpressure(audio);
    }

    const capturedAt = Number(timing.capturedAt);
    if (Number.isFinite(capturedAt)) {
      this.lastAudioCapturedAt = capturedAt;
      this.turn.lastCapturedAt = capturedAt;
      if (this.languageDetectionStartedAt === null && this.sourceLanguage === "auto") {
        this.languageDetectionStartedAt = capturedAt;
      }
    }
    const previous = this.pendingAudio;
    this.pendingAudio = Buffer.concat([previous, audio]);
    this.pendingAudioSegments.push({
      byteLength: audio.byteLength,
      bufferedAt: this.monotonicNow(),
    });
    previous.fill(0);
    audio.fill(0);

    if (this.state === "running") return this.drainAudio();
    return true;
  }

  rejectAudioForBackpressure(audio) {
    audio.fill(0);
    if (!this.audioBackpressureActive) {
      this.audioBackpressureActive = true;
      this.onStatus?.({
        level: "warning",
        message: "Bộ đệm Gemini đã đầy; tạm bỏ audio mới để giới hạn dữ liệu trong RAM",
      });
    }
    return false;
  }

  drainAudio() {
    while (
      this.state === "running" &&
      this.session &&
      this.pendingAudio.byteLength >= AUDIO_CHUNK_BYTES
    ) {
      const previous = this.pendingAudio;
      const chunk = Buffer.from(previous.subarray(0, AUDIO_CHUNK_BYTES));
      this.pendingAudio = Buffer.from(previous.subarray(AUDIO_CHUNK_BYTES));
      this.consumePendingAudioSegments(AUDIO_CHUNK_BYTES);
      previous.fill(0);
      if (!this.sendAudioChunk(chunk)) return false;
    }
    if (this.audioBackpressureActive && this.pendingAudio.byteLength < AUDIO_CHUNK_BYTES) {
      this.audioBackpressureActive = false;
      this.onStatus?.({ level: "ok", message: "Bộ đệm audio Gemini đã phục hồi" });
    }
    return true;
  }

  consumePendingAudioSegments(byteLength) {
    let remaining = byteLength;
    while (remaining > 0 && this.pendingAudioSegments.length > 0) {
      const segment = this.pendingAudioSegments[0];
      if (segment.byteLength <= remaining) {
        remaining -= segment.byteLength;
        this.pendingAudioSegments.shift();
      } else {
        segment.byteLength -= remaining;
        remaining = 0;
      }
    }
  }

  discardReconnectAudio(incomingBytes = 0) {
    const now = this.monotonicNow();
    let discardedBytes = 0;
    while (this.pendingAudioSegments.length > 0) {
      const segment = this.pendingAudioSegments[0];
      const remainingBytes = this.pendingAudio.byteLength - discardedBytes;
      const isStale = now - segment.bufferedAt > this.maxReconnectAudioAgeMs;
      const needsCapacity = remainingBytes + incomingBytes > this.maxBufferedAudioBytes;
      if (!isStale && !needsCapacity) break;
      discardedBytes += segment.byteLength;
      this.pendingAudioSegments.shift();
    }
    if (discardedBytes === 0) return 0;

    const previous = this.pendingAudio;
    this.pendingAudio = Buffer.from(previous.subarray(discardedBytes));
    previous.fill(0);
    return discardedBytes;
  }

  sendAudioChunk(chunk) {
    let encoded;
    try {
      encoded = chunk.toString("base64");
      this.session.sendRealtimeInput({
        audio: { data: encoded, mimeType: INPUT_MIME_TYPE },
      });
      return true;
    } catch (error) {
      const clean = this.cleanError(error);
      this.onError?.(clean);
      this.signalTerminal(clean);
      return false;
    } finally {
      chunk.fill(0);
      encoded = undefined;
    }
  }

  handleMessage(message, epoch) {
    if (epoch !== this.connectionEpoch || this.isStopping() || this.terminalSignaled) return;
    if (!message || typeof message !== "object") return;

    this.handleResumptionUpdate(message.sessionResumptionUpdate);
    const usage = normalizeUsageMetadata(message.usageMetadata);
    if (usage) this.onUsage?.(usage);
    const content = message.serverContent;
    if (content && typeof content === "object") this.handleServerContent(content);
    if (message.goAway) {
      this.beginReconnect("Gemini requested a planned connection rotation");
    }
  }

  handleResumptionUpdate(update) {
    if (!this.enableSessionResumption || !update || typeof update !== "object") return;
    const secret = secrets.get(this);
    if (update.resumable === false) {
      secret.resumptionHandle = null;
      return;
    }
    const handle = String(update.newHandle || "");
    if (
      update.resumable === true &&
      handle &&
      handle.length <= MAX_RESUMPTION_HANDLE_LENGTH &&
      !/[\u0000\r\n]/.test(handle)
    ) {
      secret.resumptionHandle = handle;
    } else if (update.resumable === true) {
      secret.resumptionHandle = null;
    }
  }

  handleServerContent(content) {
    if (this.paused) return;
    const hadOutputBeforeMessage = Boolean(String(this.turn.output || "").trim());
    const input = content.inputTranscription;
    const interimInput = content.interimInputTranscription;
    const output = content.outputTranscription;
    const serverBoundaryObserved =
      content.generationComplete === true || content.turnComplete === true;
    if (serverBoundaryObserved) this.turn.serverBoundaryObserved = true;

    if (interimInput && typeof interimInput === "object") {
      this.recordDetectedLanguage(interimInput.languageCode);
      if (interimInput.text) this.turn.interimInput = boundedTranscript(interimInput.text);
    }
    if (input && typeof input === "object") {
      this.recordDetectedLanguage(input.languageCode);
      this.turn.input = appendFragment(this.turn.input, input.text);
      this.turn.interimInput = "";
      if (input.finished === true) this.turn.inputFinished = true;
    }
    if (output && typeof output === "object") {
      this.turn.output = appendFragment(this.turn.output, output.text);
      if (output.finished === true) this.turn.outputFinished = true;
      if (String(output.text || "")) this.emitCaption(false);
    }

    // Plain output fragments are mutable hypotheses, not sentence boundaries.
    // Gemini may deliver the three authoritative boundary signals before or
    // after their matching transcription, so remember the boundary and extend
    // one short grace window whenever late input/output text still arrives.
    const relevantTurnActivity =
      Boolean(String(input?.text || "")) ||
      input?.finished === true ||
      Boolean(String(output?.text || "")) ||
      output?.finished === true ||
      serverBoundaryObserved;
    const hasAuthoritativeBoundary =
      this.turn.inputFinished ||
      this.turn.outputFinished ||
      this.turn.serverBoundaryObserved;
    if (
      relevantTurnActivity &&
      hasAuthoritativeBoundary &&
      String(this.turn.output || "").trim()
    ) {
      const boundaryCanFinalizeNow =
        serverBoundaryObserved &&
        (hadOutputBeforeMessage || Boolean(String(output?.text || "")) || output?.finished === true);
      if (boundaryCanFinalizeNow) this.finalizeTurn();
      else this.scheduleFinal();
    }
  }

  recordDetectedLanguage(rawLanguage) {
    if (this.sourceLanguage !== "auto") return;
    const language = String(rawLanguage || "").trim();
    if (!language || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) return;
    if (language.toLowerCase() === this.detectedLanguage?.toLowerCase()) return;

    const updated = Boolean(this.detectedLanguage);
    this.detectedLanguage = language;
    this.languageDetectionLatencyMs = Number.isFinite(this.languageDetectionStartedAt)
      ? Math.max(0, Math.round(this.now() - this.languageDetectionStartedAt))
      : null;
    this.onLanguageDetected?.({
      language,
      confidence: null,
      detectionLatencyMs: this.languageDetectionLatencyMs,
      provider: "gemini-live-translate",
      ...(updated ? { updated: true } : {}),
    });
    this.onStatus?.({ level: "ok", message: `Gemini đã nhận diện ngôn ngữ: ${language}` });
  }

  scheduleFinal() {
    this.clearFinalTimer();
    if (this.finalDebounceMs === 0) {
      this.finalizeTurn();
      return;
    }
    this.finalTimer = this.setTimer(() => {
      this.finalTimer = null;
      this.finalizeTurn();
    }, this.finalDebounceMs);
    this.finalTimer?.unref?.();
  }

  clearFinalTimer() {
    if (this.finalTimer === null) return;
    this.clearTimer(this.finalTimer);
    this.finalTimer = null;
  }

  finalizeTurn() {
    this.clearFinalTimer();
    if (String(this.turn.output || "").trim()) this.emitCaption(true);
    this.turn = this.createEmptyTurn();
    this.lastCaptionSignature = null;
  }

  emitCaption(isFinal) {
    const transcript = String(this.turn.input || this.turn.interimInput || "").trim();
    const translation = String(this.turn.output || "").trim();
    if (!translation) return;
    const signature = `${isFinal ? "1" : "0"}\u0000${transcript}\u0000${translation}`;
    if (signature === this.lastCaptionSignature) return;
    this.lastCaptionSignature = signature;

    const emittedAt = this.now();
    const rawCapturedAt = this.turn.lastCapturedAt ?? this.lastAudioCapturedAt;
    const capturedAt = rawCapturedAt === null ? Number.NaN : Number(rawCapturedAt);
    const latencyMs = Number.isFinite(capturedAt)
      ? Math.max(0, Math.round(emittedAt - capturedAt))
      : null;
    if (!isFinal && this.turn.firstPartialEmittedAt === null) {
      this.turn.firstPartialEmittedAt = emittedAt;
    }
    const partialToFinalMs =
      isFinal && Number.isFinite(this.turn.firstPartialEmittedAt)
        ? Math.max(0, Math.round(emittedAt - this.turn.firstPartialEmittedAt))
        : null;
    const autoDetected = this.sourceLanguage === "auto";
    this.onCaption?.({
      type: "caption",
      sequence: this.sequence++,
      transcript,
      translation,
      sourceLanguage: autoDetected ? this.detectedLanguage || "auto" : this.sourceLanguage,
      sourceLanguageMode: autoDetected ? "auto" : "fixed",
      languageDetectionConfidence: null,
      languageDetectionLatencyMs: autoDetected ? this.languageDetectionLatencyMs : null,
      targetLanguage: this.targetLanguage,
      isFinal,
      emittedAt,
      latencyMs,
      ...(!isFinal ? { liveEdgeToPartialMs: latencyMs } : { partialToFinalMs }),
      provider: "gemini-live-translate",
    });
  }

  handleTransportError(event, epoch) {
    if (epoch !== this.connectionEpoch || this.isStopping() || this.terminalSignaled) return;
    const clean = this.cleanError(event);
    this.onError?.(clean);
    if (clean.code === "GEMINI_FREE_TIER_QUOTA") {
      this.signalTerminal(clean);
      return;
    }
    if (this.state === "running") this.beginReconnect("Gemini Live transport error", clean);
  }

  handleTransportClose(event, epoch) {
    if (epoch !== this.connectionEpoch || this.isStopping() || this.terminalSignaled) return;
    const secret = secrets.get(this);
    const detail = event?.reason
      ? `: ${redact(event.reason, [secret.apiKey, secret.resumptionHandle])}`
      : "";
    const code = Number(event?.code) || 0;
    const error = new Error(`Gemini Live connection closed unexpectedly (code ${code})${detail}`);
    if (this.state === "starting") {
      this.signalTerminal(error);
      return;
    }
    this.beginReconnect("Gemini Live connection closed", error);
  }

  beginReconnect(reason, fallbackError) {
    if (this.isStopping() || this.terminalSignaled) return this.reconnectPromise;
    if (this.reconnectPromise) return this.reconnectPromise;
    const handle = this.enableSessionResumption
      ? secrets.get(this).resumptionHandle
      : null;
    if (this.enableSessionResumption && !handle) {
      this.signalTerminal(
        fallbackError ||
          new Error(`${reason}; no safe Gemini session-resumption handle was available`),
      );
      return null;
    }

    this.state = "reconnecting";
    this.reconnectDiscardedAudioBytes = 0;
    this.onStatus?.({
      level: "warning",
      message: this.enableSessionResumption
        ? "Gemini đang đổi kết nối an toàn; audio mới được giữ tạm trong RAM"
        : "Gemini đang mở phiên mới không khôi phục trạng thái; audio mới được giữ tạm trong RAM",
    });
    const staleSession = this.session;
    this.session = null;
    this.connectionEpoch += 1;
    this.reconnectPromise = (async () => {
      await closeSession(staleSession).catch((error) => this.onError?.(this.cleanError(error)));
      if (this.isStopping() || this.terminalSignaled) return;
      try {
        await this.openSession(handle);
        if (this.isStopping() || this.terminalSignaled) return;
        this.state = "running";
        const discardedBytes =
          this.reconnectDiscardedAudioBytes + this.discardReconnectAudio();
        this.reconnectDiscardedAudioBytes = 0;
        if (discardedBytes > 0) {
          const discardedMs = Math.round(discardedBytes / 32);
          this.onStatus?.({
            level: "warning",
            message: `Gemini đã khôi phục; bỏ ${discardedMs} ms audio cũ để không phát lại phụ đề trễ`,
          });
        } else {
          this.onStatus?.({ level: "ok", message: "Gemini đã khôi phục phiên dịch" });
        }
        this.drainAudio();
      } catch (error) {
        this.signalTerminal(this.cleanError(error));
      } finally {
        this.reconnectPromise = null;
      }
    })();
    return this.reconnectPromise;
  }

  cleanError(error) {
    const secret = secrets.get(this);
    return publicGeminiError(error, [secret.apiKey, secret.resumptionHandle]);
  }

  signalTerminal(error) {
    if (this.terminalSignaled || this.isStopping()) return;
    const clean = this.cleanError(error);
    this.terminalSignaled = true;
    this.terminalError = clean;
    this.state = "failed";
    this.clearFinalTimer();
    this.clearSensitiveAudio();
    this.connectAbortController?.abort();
    this.connectionEpoch += 1;
    const session = this.session;
    this.session = null;
    void closeSession(session).catch(() => {});
    this.onTerminal?.(clean);
  }

  isStopping() {
    return this.state === "stopping" || this.state === "stopped";
  }

  clearSensitiveAudio() {
    this.pendingAudio.fill(0);
    this.pendingAudio = Buffer.alloc(0);
    this.pendingAudioSegments = [];
    this.reconnectDiscardedAudioBytes = 0;
  }

  setPaused(paused) {
    const nextPaused = paused === true;
    if (this.paused === nextPaused) return false;
    this.paused = nextPaused;
    if (nextPaused) {
      this.clearFinalTimer();
      this.clearSensitiveAudio();
      this.turn = this.createEmptyTurn();
      this.lastCaptionSignature = null;
      this.audioBackpressureActive = false;
    }
    return true;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  async stopInternal() {
    this.paused = false;
    if (this.state === "stopped") {
      this.clearFinalTimer();
      this.clearSensitiveAudio();
      this.turn = this.createEmptyTurn();
      this.client = null;
      const secret = secrets.get(this);
      secret.resumptionHandle = null;
      secret.apiKey = "";
      return;
    }
    this.state = "stopping";
    this.clearFinalTimer();
    this.connectAbortController?.abort();
    this.connectionEpoch += 1;
    this.clearSensitiveAudio();
    this.turn = this.createEmptyTurn();
    const session = this.session;
    this.session = null;
    try {
      await closeSession(session);
    } catch (error) {
      this.onError?.(this.cleanError(error));
    }
    await this.reconnectPromise?.catch(() => {});
    this.client = null;
    const secret = secrets.get(this);
    secret.resumptionHandle = null;
    secret.apiKey = "";
    this.state = "stopped";
    this.onStatus?.({ level: "idle", message: "Gemini Live Translate đã dừng" });
  }
}

module.exports = {
  GeminiLiveTranslateTranslator,
  GeminiLiveTranslator: GeminiLiveTranslateTranslator,
  AUDIO_CHUNK_BYTES,
  DEFAULT_MODEL,
  DEFAULT_MAX_RECONNECT_AUDIO_AGE_MS,
};
