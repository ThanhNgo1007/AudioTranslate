const DEFAULT_BASE_URL = "wss://api.together.ai/v1/realtime";
const DEFAULT_MODEL = "openai/whisper-large-v3";
const INPUT_AUDIO_FORMAT = "pcm_s16le_16000";
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1500;
const DEFAULT_MAX_BUFFERED_AMOUNT_BYTES = 512 * 1024;
const DEFAULT_MAX_AUDIO_CHUNK_BYTES = 64 * 1024;

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

const TRANSCRIPT_DELTA = "conversation.item.input_audio_transcription.delta";
const TRANSCRIPT_COMPLETED = "conversation.item.input_audio_transcription.completed";
const TRANSCRIPT_FAILED = "conversation.item.input_audio_transcription.failed";

const clientSecrets = new WeakMap();

function positiveInteger(value, fallback, label) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return result;
}

function normalizeApiKey(value) {
  const apiKey = String(value || "");
  if (!apiKey) throw new Error("Together API key is required");
  if (apiKey.length > 16384 || /[\u0000\r\n]/.test(apiKey)) {
    throw new Error("Invalid Together API key");
  }
  return apiKey;
}

function normalizeModel(value) {
  const model = String(value || DEFAULT_MODEL).trim();
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new Error("Invalid Together ASR model");
  }
  return model;
}

function normalizeSourceLanguage(value) {
  const language = String(value || "").trim();
  if (!language) throw new Error("Together ASR requires a fixed source-language hint");
  if (language.toLowerCase() === "auto") {
    throw new Error("Together realtime ASR auto language detection is not enabled by this client");
  }
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) {
    throw new Error("Invalid Together source-language hint");
  }
  return language;
}

function buildEndpoint(baseUrl, model, sourceLanguage) {
  let url;
  try {
    url = new URL(String(baseUrl || DEFAULT_BASE_URL));
  } catch {
    throw new Error("Together realtime base URL must be an absolute URL");
  }
  if (url.protocol !== "wss:") {
    throw new Error("Together realtime base URL must use wss:");
  }
  if (url.username || url.password) {
    throw new Error("Together realtime base URL must not contain credentials");
  }
  for (const secretParameter of ["api_key", "apikey", "authorization", "token"]) {
    if (url.searchParams.has(secretParameter)) {
      throw new Error("Together realtime base URL must not contain credentials");
    }
  }
  url.hash = "";
  url.searchParams.set("intent", "transcription");
  url.searchParams.set("model", model);
  url.searchParams.set("input_audio_format", INPUT_AUDIO_FORMAT);
  url.searchParams.set("language", sourceLanguage);
  return url.toString();
}

function replaceAll(value, search, replacement) {
  if (!search) return value;
  return value.split(search).join(replacement);
}

function redact(value, apiKey) {
  let result = String(value ?? "");
  const variants = [apiKey, encodeURIComponent(apiKey), `Bearer ${apiKey}`]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const variant of variants) result = replaceAll(result, variant, "[REDACTED]");
  return result;
}

function sanitizedError(error, apiKey, fallbackMessage = "Together realtime ASR error") {
  const source = error instanceof Error ? error : new Error(String(error || fallbackMessage));
  const clean = new Error(redact(source.message || fallbackMessage, apiKey));
  clean.name = source.name || "Error";
  if (source.code !== undefined) clean.code = redact(source.code, apiKey);
  return clean;
}

function audioBufferFrom(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("Together ASR audio must be a Buffer, ArrayBuffer, or typed array");
}

function messageText(value) {
  const data = value && typeof value === "object" && "data" in value ? value.data : value;
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return String(data);
}

function closeReasonText(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  }
  return String(value || "");
}

class TogetherRealtimeAsr {
  constructor(options = {}) {
    const apiKey = normalizeApiKey(options.apiKey);
    this.model = normalizeModel(options.model);
    this.sourceLanguage = normalizeSourceLanguage(options.sourceLanguage);
    this.baseUrl = buildEndpoint(options.baseUrl, this.model, this.sourceLanguage);
    this.WebSocketImpl = options.WebSocketImpl || require("ws");
    if (typeof this.WebSocketImpl !== "function") {
      throw new Error("Together ASR WebSocket implementation must be a constructor");
    }

    this.onTranscript = options.onTranscript;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
    this.onTerminal = options.onTerminal;
    this.startupTimeoutMs = positiveInteger(
      options.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
      "Together ASR startup timeout",
    );
    this.closeTimeoutMs = positiveInteger(
      options.closeTimeoutMs,
      DEFAULT_CLOSE_TIMEOUT_MS,
      "Together ASR close timeout",
    );
    this.maxBufferedAmountBytes = positiveInteger(
      options.maxBufferedAmountBytes,
      DEFAULT_MAX_BUFFERED_AMOUNT_BYTES,
      "Together ASR buffered-amount limit",
    );
    this.maxAudioChunkBytes = positiveInteger(
      options.maxAudioChunkBytes,
      DEFAULT_MAX_AUDIO_CHUNK_BYTES,
      "Together ASR audio-chunk limit",
    );

    clientSecrets.set(this, { apiKey });
    Object.defineProperty(this, "socket", {
      value: null,
      writable: true,
      enumerable: false,
    });

    this.state = "idle";
    this.sequence = 0;
    this.sessionId = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.startResolve = null;
    this.startReject = null;
    this.startupTimer = null;
    this.intentionalClose = false;
    this.terminalSignaled = false;
    this.backpressureActive = false;
    this.droppedAudioBytes = 0;
  }

  start() {
    if (this.state === "running") return Promise.resolve();
    if (this.state === "starting" && this.startPromise) return this.startPromise;
    if (this.state !== "idle") {
      return Promise.reject(new Error("Together realtime ASR client cannot be restarted"));
    }

    this.state = "starting";
    const { apiKey } = clientSecrets.get(this);
    this.startPromise = new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      this.startupTimer = setTimeout(() => {
        const error = new Error(
          `Together realtime ASR startup timed out after ${this.startupTimeoutMs} ms`,
        );
        this.fail(error, true);
      }, this.startupTimeoutMs);
      this.startupTimer.unref?.();

      try {
        this.socket = new this.WebSocketImpl(this.baseUrl, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "OpenAI-Beta": "realtime=v1",
          },
          handshakeTimeout: this.startupTimeoutMs,
          maxPayload: 1024 * 1024,
          perMessageDeflate: false,
        });
        this.attachSocket(this.socket);
      } catch (error) {
        this.fail(error, false);
      }
    });
    return this.startPromise;
  }

  attachSocket(socket) {
    socket.on("open", () => {
      if (socket !== this.socket || this.state !== "starting") return;
      this.onStatus?.({
        level: "connecting",
        message: "Together WebSocket connected; waiting for session.created",
      });
    });
    socket.on("message", (data) => {
      if (socket !== this.socket || this.state === "stopping" || this.state === "stopped") {
        return;
      }
      this.handleMessage(data);
    });
    socket.on("error", (error) => {
      if (socket !== this.socket || this.intentionalClose) return;
      const clean = this.cleanError(error);
      this.onError?.(clean);
      if (this.state === "starting") this.fail(clean, true);
    });
    socket.on("close", (code, reason) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.clearStartupTimer();
      if (this.intentionalClose) {
        this.state = "stopped";
        return;
      }

      const detail = redact(closeReasonText(reason), clientSecrets.get(this).apiKey);
      const suffix = detail ? `: ${detail}` : "";
      const error = new Error(
        `Together realtime ASR connection closed unexpectedly (code ${Number(code) || 0})${suffix}`,
      );
      if (this.state === "starting") this.rejectStart(error);
      this.state = "failed";
      this.signalTerminal(error);
    });
  }

  handleMessage(data) {
    let event;
    try {
      event = JSON.parse(messageText(data));
    } catch {
      this.fail(new Error("Together realtime ASR returned malformed JSON"), true);
      return;
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      this.fail(new Error("Together realtime ASR returned an invalid event"), true);
      return;
    }

    if (event.type === "session.created") {
      if (this.state !== "starting") return;
      this.sessionId = String(event.session?.id || "") || null;
      this.state = "running";
      this.clearStartupTimer();
      this.resolveStart();
      this.onStatus?.({
        level: "ok",
        message: "Together realtime ASR session ready",
        sessionId: this.sessionId,
      });
      return;
    }

    if (event.type === TRANSCRIPT_DELTA) {
      if (this.state !== "running" || typeof event.delta !== "string") return;
      this.emitTranscript(event.delta, false, event);
      return;
    }
    if (event.type === TRANSCRIPT_COMPLETED) {
      if (this.state !== "running" || typeof event.transcript !== "string") return;
      this.emitTranscript(event.transcript, true, event);
      return;
    }
    if (event.type === TRANSCRIPT_FAILED) {
      const detail = event.error?.message || event.error?.code || "unknown utterance error";
      this.onError?.(this.cleanError(new Error(`Together transcription failed: ${detail}`)));
      return;
    }
    if (event.type === "error") {
      const detail = event.error?.message || event.message || "unknown server error";
      this.fail(new Error(`Together realtime ASR server error: ${detail}`), true);
    }
  }

  emitTranscript(text, isFinal, raw) {
    this.onTranscript?.({
      text,
      isFinal,
      sequence: this.sequence++,
      sourceLanguage: this.sourceLanguage,
      provider: "together",
      emittedAt: Date.now(),
      raw,
    });
  }

  write(pcm, _metadata = {}) {
    const audio = audioBufferFrom(pcm);
    if (audio.byteLength === 0) return true;
    if (audio.byteLength % 2 !== 0) {
      throw new Error("Together ASR PCM16 audio chunks must contain an even number of bytes");
    }
    if (audio.byteLength > this.maxAudioChunkBytes) {
      throw new Error(
        `Together ASR audio chunk exceeds ${this.maxAudioChunkBytes} byte limit`,
      );
    }
    const payload = JSON.stringify({
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
    return this.sendPayload(payload, audio.byteLength);
  }

  commit() {
    return this.sendPayload(JSON.stringify({ type: "input_audio_buffer.commit" }), 0);
  }

  sendPayload(payload, audioBytes) {
    const socket = this.socket;
    if (this.state !== "running" || !socket || socket.readyState !== WS_OPEN) return false;

    const queued = Number(socket.bufferedAmount);
    const bufferedAmount = Number.isFinite(queued) && queued >= 0 ? queued : Infinity;
    const payloadBytes = Buffer.byteLength(payload);
    if (bufferedAmount + payloadBytes > this.maxBufferedAmountBytes) {
      this.droppedAudioBytes += audioBytes;
      if (!this.backpressureActive) {
        this.backpressureActive = true;
        this.onStatus?.({
          level: "warning",
          message: "Together network queue is full; dropping live audio instead of growing memory",
          bufferedAmount,
          droppedAudioBytes: this.droppedAudioBytes,
        });
      }
      return false;
    }

    if (this.backpressureActive) {
      this.backpressureActive = false;
      this.onStatus?.({
        level: "ok",
        message: "Together network queue recovered",
        droppedAudioBytes: this.droppedAudioBytes,
      });
    }
    try {
      socket.send(payload, (error) => {
        if (!error || this.intentionalClose) return;
        this.onError?.(this.cleanError(error));
      });
      return true;
    } catch (error) {
      this.onError?.(this.cleanError(error));
      return false;
    }
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.intentionalClose = true;
    this.clearStartupTimer();
    if (this.state === "starting") {
      this.rejectStart(new Error("Together realtime ASR stopped before startup completed"));
    }
    this.state = "stopping";
    this.stopPromise = this.closeSocket().finally(() => {
      this.socket = null;
      this.state = "stopped";
    });
    return this.stopPromise;
  }

  async closeSocket() {
    const socket = this.socket;
    if (!socket || socket.readyState === WS_CLOSED) return;

    await new Promise((resolve) => {
      let settled = false;
      let timer;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off?.("close", done);
        socket.removeEventListener?.("close", done);
        resolve();
      };
      socket.once?.("close", done);
      if (!socket.once && socket.addEventListener) socket.addEventListener("close", done, { once: true });
      timer = setTimeout(() => {
        try {
          socket.terminate?.();
        } catch {
          // Best effort after the graceful-close deadline.
        }
        done();
      }, this.closeTimeoutMs);
      timer.unref?.();

      try {
        if (socket.readyState === WS_CONNECTING && typeof socket.terminate === "function") {
          socket.terminate();
        } else {
          socket.close(1000, "client shutdown");
        }
      } catch {
        try {
          socket.terminate?.();
        } catch {
          // Best effort during shutdown.
        }
        done();
      }
    });
  }

  fail(error, closeSocket) {
    if (this.state === "failed" || this.state === "stopped") return;
    const clean = this.cleanError(error);
    this.clearStartupTimer();
    if (this.state === "starting") this.rejectStart(clean);
    this.state = "failed";
    this.signalTerminal(clean);
    if (closeSocket) {
      try {
        if (this.socket?.readyState === WS_CONNECTING) this.socket.terminate?.();
        else this.socket?.close?.(1002, "protocol error");
      } catch {
        try {
          this.socket?.terminate?.();
        } catch {
          // Best effort after a terminal protocol failure.
        }
      }
    }
  }

  resolveStart() {
    const resolve = this.startResolve;
    this.startResolve = null;
    this.startReject = null;
    resolve?.();
  }

  rejectStart(error) {
    const reject = this.startReject;
    this.startResolve = null;
    this.startReject = null;
    reject?.(this.cleanError(error));
  }

  clearStartupTimer() {
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  cleanError(error) {
    return sanitizedError(error, clientSecrets.get(this).apiKey);
  }

  signalTerminal(error) {
    if (this.terminalSignaled) return;
    this.terminalSignaled = true;
    this.onTerminal?.(this.cleanError(error));
  }

  toJSON() {
    return {
      provider: "together",
      model: this.model,
      sourceLanguage: this.sourceLanguage,
      baseUrl: this.baseUrl,
      state: this.state,
      sessionId: this.sessionId,
    };
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  INPUT_AUDIO_FORMAT,
  TogetherRealtimeAsr,
};
