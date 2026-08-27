const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const { WebSocket, WebSocketServer } = require("ws");
const { AudioTelemetryAggregator } = require("./audio/audio-telemetry");
const { createProvider, getProviderCapabilities } = require("./provider-factory");
const { PROTOCOL_VERSION, decodeAudioFrame, safeParseControl } = require("./protocol");
const { RUNTIME_METRIC_FIELDS, USAGE_COUNTER_FIELDS } = require("./runtime-metrics");

const MAX_AUDIO_AGE_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15000;
const MAX_STARTS_PER_MINUTE = 10;
const AUTH_SCHEME = "hmac-sha256-v1";

function hmacProof(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function proofsMatch(expected, supplied) {
  if (typeof supplied !== "string") return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

function createServerAuthentication(secret) {
  const nonce = crypto.randomBytes(32).toString("base64url");
  return {
    scheme: AUTH_SCHEME,
    nonce,
    serverProof: hmacProof(secret, `ATR1|server|${nonce}`),
  };
}

function verifyClientAuthentication(secret, challenge, authentication) {
  if (!secret) return true;
  if (
    !challenge ||
    challenge.used ||
    authentication?.scheme !== AUTH_SCHEME ||
    typeof authentication.clientNonce !== "string" ||
    !/^[A-Za-z0-9_-]{24,128}$/.test(authentication.clientNonce)
  ) {
    return false;
  }
  const expected = hmacProof(
    secret,
    `ATR1|client|${challenge.nonce}|${authentication.clientNonce}`,
  );
  if (!proofsMatch(expected, authentication.clientProof)) return false;
  challenge.used = true;
  return true;
}

class ClientMessageError extends Error {
  constructor(message, code = "MESSAGE_ERROR", closeCode = 1008) {
    super(message);
    this.name = "ClientMessageError";
    this.code = code;
    this.closeCode = closeCode;
  }
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function extensionIdFromOrigin(origin) {
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin || "");
  return match?.[1] || null;
}

function isAllowedOrigin(origin, configOrAllowDevClients = false) {
  const config =
    typeof configOrAllowDevClients === "boolean"
      ? { allowDevClients: configOrAllowDevClients, allowedExtensionIds: [] }
      : configOrAllowDevClients;
  const extensionId = extensionIdFromOrigin(origin);
  if (extensionId) {
    const allowedIds = config.allowedExtensionIds || [];
    // An empty production allow-list must not silently trust every installed
    // extension. Development mode can opt into that legacy convenience.
    return allowedIds.includes(extensionId) || Boolean(config.allowDevClients && allowedIds.length === 0);
  }
  if (origin === "audiotranslate://control-center") {
    return typeof config.authToken === "string" && config.authToken.length >= 24;
  }
  return Boolean(
    config.allowDevClients &&
      (!origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)),
  );
}

function tokensMatch(expected, supplied) {
  if (!expected) return true;
  if (typeof supplied !== "string") return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

function validateLanguage(value, fallback, label) {
  const language = String(value || fallback);
  if (language.length > 35 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(language)) {
    throw new ClientMessageError(`Invalid ${label} language: ${language}`, "INVALID_LANGUAGE");
  }
  return language
    .split("-")
    .map((part, index) => {
      if (index === 0) return part.toLowerCase();
      if (part.length === 4) return `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`;
      if (part.length === 2 || /^\d{3}$/.test(part)) return part.toUpperCase();
      return part.toLowerCase();
    })
    .join("-");
}

function validateSourceSettings(config) {
  const requested = String(config.sourceLanguage || "en-US");
  if (requested !== "auto") {
    return {
      sourceLanguage: validateLanguage(requested, "en-US", "source"),
      sourceLanguageCandidates: [],
    };
  }

  const capabilities = getProviderCapabilities(config.provider).autoSourceLanguage;
  if (!capabilities?.supported) {
    throw new ClientMessageError(
      `Provider ${config.provider} does not support automatic source-language detection`,
      "UNSUPPORTED_SOURCE_MODE",
    );
  }

  const rawCandidates = Array.isArray(config.sourceLanguageCandidates)
    ? config.sourceLanguageCandidates
    : [];
  const sourceLanguageCandidates = (rawCandidates || []).map((candidate) =>
    validateLanguage(candidate, "", "source candidate"),
  );
  const minCandidates = Number.isInteger(capabilities.minCandidates)
    ? capabilities.minCandidates
    : 0;
  const maxCandidates = Number.isInteger(capabilities.maxCandidates)
    ? capabilities.maxCandidates
    : 8;
  if (sourceLanguageCandidates.length < minCandidates) {
    throw new ClientMessageError(
      `Auto language detection requires at least ${minCandidates} candidate locales`,
      "AUTO_CANDIDATES_REQUIRED",
    );
  }
  if (sourceLanguageCandidates.length > maxCandidates) {
    throw new ClientMessageError(
      `Auto language detection accepts at most ${maxCandidates} candidate locales`,
      "TOO_MANY_CANDIDATES",
    );
  }
  if (
    capabilities.requireFullLocales &&
    sourceLanguageCandidates.some((candidate) => !candidate.includes("-"))
  ) {
    throw new ClientMessageError(
      "Auto language candidates must be full locales such as en-US or vi-VN",
      "INVALID_SOURCE_CANDIDATES",
    );
  }
  const baseLanguages = sourceLanguageCandidates.map((candidate) =>
    candidate.split("-")[0].toLowerCase(),
  );
  if (
    capabilities.uniqueBaseLanguages &&
    new Set(baseLanguages).size !== baseLanguages.length
  ) {
    throw new ClientMessageError(
      "Auto language candidates must use one locale per base language",
      "DUPLICATE_BASE_LANGUAGE",
    );
  }
  return { sourceLanguage: "auto", sourceLanguageCandidates };
}

function sanitizeLanguageDetection(detection) {
  const language = String(detection?.language || "").trim();
  if (!language || language.length > 35 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(language)) {
    return null;
  }
  const rawConfidence = detection?.confidence;
  const confidence = ["Unknown", "Low", "Medium", "High"].includes(rawConfidence)
    ? rawConfidence
    : null;
  const rawLatency = Number(detection?.detectionLatencyMs);
  const detectionLatencyMs = Number.isFinite(rawLatency) && rawLatency >= 0
    ? Math.round(rawLatency)
    : null;
  return {
    language,
    confidence,
    detectionLatencyMs,
    ...(detection?.updated === true ? { updated: true } : {}),
  };
}

function numericAllowlist(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sanitized = {};
  for (const field of fields) {
    const number = value[field];
    if (
      typeof number === "number" &&
      Number.isFinite(number) &&
      number >= 0 &&
      number <= Number.MAX_SAFE_INTEGER
    ) {
      sanitized[field] = Math.round(number);
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

class RealtimeGateway extends EventEmitter {
  constructor(config, options = {}) {
    super();
    this.config = config;
    this.providerFactory = options.providerFactory || createProvider;
    this.server = null;
    this.activeSession = null;
    this.boundPort = null;
    this.nextSessionId = 1;
    this.startPromise = null;
    this.closePromise = null;
    this.lifecycle = Promise.resolve();
    this.heartbeatTimer = null;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.now = options.now || Date.now;
    this.telemetryIntervalMs = options.telemetryIntervalMs;
    this.paused = false;
    this.state = "stopped";
  }

  async start() {
    if (this.state === "running") return this.address();
    if (this.startPromise) return this.startPromise;
    if (this.state === "closing") throw new Error("Gateway is closing");

    this.startPromise = this.startServer();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startServer() {
    this.state = "starting";
    const server = new WebSocketServer({
      host: this.config.host,
      port: this.config.port,
      maxPayload: 512 * 1024,
      perMessageDeflate: false,
      verifyClient: ({ origin }) => isAllowedOrigin(origin, this.config),
    });
    this.server = server;
    server.on("connection", (socket, request) => this.handleConnection(socket, request));

    try {
      await new Promise((resolve, reject) => {
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        server.once("listening", onListening);
        server.once("error", onError);
      });
    } catch (error) {
      this.server = null;
      this.boundPort = null;
      this.state = "stopped";
      try {
        server.close();
      } catch {
        // A server that failed before listen may already be closed.
      }
      throw normalizeError(error);
    }

    server.on("error", (error) => this.emit("error", normalizeError(error)));
    this.boundPort = server.address().port;
    this.state = "running";
    this.startHeartbeat();
    const status = {
      type: "status",
      level: "idle",
      message: `Đang chờ audio từ Chrome/Edge tại ws://${this.config.host}:${this.boundPort}`,
    };
    this.emit("status", status);
    return this.address();
  }

  enqueueLifecycle(task) {
    const operation = this.lifecycle.then(task, task);
    this.lifecycle = operation.catch(() => {});
    return operation;
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.server) return;
      for (const client of this.server.clients) {
        if (client.isAlive === false) {
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  address() {
    return { host: this.config.host, port: this.boundPort ?? this.config.port };
  }

  handleConnection(socket, request) {
    if (this.server?.clients.size > 4) {
      socket.close(1013, "Too many local clients");
      return;
    }
    socket.isAlive = true;
    socket.authentication = this.config.authToken
      ? { ...createServerAuthentication(this.config.authToken), used: false }
      : null;
    socket.startTimestamps = [];
    socket.failed = false;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.on("message", (data, isBinary) => {
      this.handleMessage(socket, data, isBinary).catch((error) => {
        this.failClient(socket, normalizeError(error));
      });
    });
    socket.on("close", () => {
      if (this.activeSession?.socket === socket) {
        this.enqueueLifecycle(() => this.stopActiveSession("Browser capture disconnected")).catch(
          () => {},
        );
      }
    });
    socket.on("error", (error) => {
      this.emit("status", { type: "status", level: "error", message: error.message });
    });

    const publicAuthentication = socket.authentication
      ? {
          scheme: socket.authentication.scheme,
          nonce: socket.authentication.nonce,
          serverProof: socket.authentication.serverProof,
        }
      : null;
    this.send(socket, {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      provider: this.config.provider,
      providerCapabilities: getProviderCapabilities(this.config.provider),
      remote: request.socket.remoteAddress,
      authRequired: Boolean(this.config.authToken),
      authentication: publicAuthentication,
    });
  }

  failClient(socket, rawError) {
    if (socket.failed) return;
    socket.failed = true;
    const error = normalizeError(rawError);
    const code = error.code || "MESSAGE_ERROR";
    this.send(socket, { type: "error", code, message: error.message, fatal: true });
    this.emit("status", { type: "status", level: "error", message: error.message });
    const closeCode = Number.isInteger(error.closeCode) ? error.closeCode : 1008;
    setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) socket.close(closeCode, String(code).slice(0, 123));
    }, 10).unref?.();
  }

  async handleMessage(socket, data, isBinary) {
    if (isBinary) {
      const session = this.activeSession;
      if (!session || session.socket !== socket || !session.ready) {
        throw new ClientMessageError(
          "Send audio only after the gateway acknowledges `started`",
          "AUDIO_BEFORE_READY",
        );
      }
      let frame;
      try {
        frame = decodeAudioFrame(data);
      } catch (error) {
        throw new ClientMessageError(normalizeError(error).message, "INVALID_AUDIO_FRAME");
      }
      if (frame.sequence <= session.lastSequence) return;
      session.lastSequence = frame.sequence;
      const now = this.now();
      const ageMs = now - frame.capturedAt;
      if (session.paused) {
        const telemetry = session.telemetry.record(null, {
          sequence: frame.sequence,
          droppedFrames: session.droppedFrames,
          queueMs: ageMs,
        });
        frame.pcm.fill(0);
        if (telemetry) this.emitTelemetry(session, telemetry);
        return;
      }
      if (Number.isFinite(ageMs) && ageMs > MAX_AUDIO_AGE_MS) {
        session.droppedFrames += 1;
        const telemetry = session.telemetry.record(null, {
          sequence: frame.sequence,
          droppedFrames: session.droppedFrames,
          queueMs: ageMs,
        });
        frame.pcm.fill(0);
        if (telemetry) this.emitTelemetry(session, telemetry);
        if (now - session.lastDropNoticeAt > 1000) {
          session.lastDropNoticeAt = now;
          this.send(socket, {
            type: "status",
            level: "warning",
            message: `Đã bỏ ${session.droppedFrames} audio frame cũ để giữ phụ đề realtime`,
          });
        }
        return;
      }
      const telemetry = session.telemetry.record(frame.pcm, {
        sequence: frame.sequence,
        droppedFrames: session.droppedFrames,
        queueMs: ageMs,
      });
      if (telemetry) {
        session.provider.setAudioActivity?.({
          rms: telemetry.rms,
          peak: telemetry.peak,
          speech: telemetry.speech === true,
          silenceMs: telemetry.silenceMs,
          packetGapCount: telemetry.packetGapCount,
          droppedFrames: telemetry.droppedFrames,
          queueMs: telemetry.queueMs,
          updatedAt: telemetry.updatedAt,
        });
        this.emitTelemetry(session, telemetry);
      }
      const accepted = session.provider.write(frame.pcm, frame) !== false;
      if (accepted && session.firstAudioCapturedAt === null && Number.isFinite(frame.capturedAt)) {
        session.firstAudioCapturedAt = frame.capturedAt;
      }
      if (accepted && Number.isFinite(ageMs)) {
        this.emitRuntimeMetrics(session, { localQueueMs: Math.max(0, ageMs) });
      }
      return;
    }

    let message;
    try {
      message = safeParseControl(data);
    } catch (error) {
      throw new ClientMessageError(normalizeError(error).message, "INVALID_CONTROL_MESSAGE");
    }
    if (message.type === "ping") {
      this.send(socket, { type: "pong", now: Date.now() });
      return;
    }
    if (message.type === "stop") {
      await this.enqueueLifecycle(async () => {
        if (this.activeSession?.socket === socket) await this.stopActiveSession("Capture stopped");
      });
      this.send(socket, { type: "stopped" });
      return;
    }
    if (message.type !== "start") {
      throw new ClientMessageError(`Unknown control message: ${message.type}`, "UNKNOWN_MESSAGE");
    }

    if (message.protocolVersion !== PROTOCOL_VERSION) {
      throw new ClientMessageError(
        `Protocol mismatch: extension=${message.protocolVersion}, gateway=${PROTOCOL_VERSION}`,
        "PROTOCOL_MISMATCH",
      );
    }
    if (
      !verifyClientAuthentication(
        this.config.authToken,
        socket.authentication,
        message.authentication,
      )
    ) {
      throw new ClientMessageError(
        "Xác thực pairing HMAC không hợp lệ. Hãy ghép nối lại extension với local app.",
        "UNAUTHORIZED",
      );
    }
    const now = Date.now();
    socket.startTimestamps = socket.startTimestamps.filter((timestamp) => now - timestamp < 60000);
    if (socket.startTimestamps.length >= MAX_STARTS_PER_MINUTE) {
      throw new ClientMessageError("Too many session starts; wait one minute", "RATE_LIMITED", 1013);
    }
    socket.startTimestamps.push(now);
    await this.enqueueLifecycle(() => this.startSession(socket));
  }

  async startSession(socket) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const { sourceLanguage, sourceLanguageCandidates } = validateSourceSettings(this.config);
    const targetLanguage = validateLanguage(
      this.config.targetLanguage,
      "vi",
      "target",
    );
    const showSource = this.config.showSource !== false;

    const previousSocket = this.activeSession?.socket;
    await this.stopActiveSession("Replaced by a new capture session");
    if (previousSocket && previousSocket !== socket && previousSocket.readyState === WebSocket.OPEN) {
      this.send(previousSocket, {
        type: "error",
        code: "SESSION_REPLACED",
        message: "Phiên dịch đã được thay thế bởi một tab khác",
        fatal: true,
      });
      previousSocket.close(4002, "Session replaced");
    }
    const session = {
      id: `session-${this.nextSessionId++}`,
      socket,
      sourceLanguage,
      sourceLanguageCandidates,
      targetLanguage,
      showSource,
      provider: null,
      lastSequence: -1,
      lastDropNoticeAt: 0,
      droppedFrames: 0,
      ready: false,
      cloudTimer: null,
      paused: this.paused,
      telemetry: new AudioTelemetryAggregator({
        now: this.now,
        intervalMs: this.telemetryIntervalMs,
      }),
      firstAudioCapturedAt: null,
      firstReadableRecorded: false,
    };
    const callbacks = {
      onCaption: (caption) => {
        if (this.activeSession !== session || session.paused) return;
        const metrics = {};
        const liveEdgeToPartialMs = Number.isFinite(caption?.liveEdgeToPartialMs)
          ? caption.liveEdgeToPartialMs
          : caption?.latencyMs;
        if (Number.isFinite(liveEdgeToPartialMs)) {
          metrics.liveEdgeToPartialMs = liveEdgeToPartialMs;
        }
        if (Number.isFinite(caption?.partialToFinalMs)) {
          metrics.partialToFinalMs = caption.partialToFinalMs;
        }
        if (
          !session.firstReadableRecorded &&
          Number.isFinite(session.firstAudioCapturedAt) &&
          String(caption?.translation || "").trim()
        ) {
          const emittedAt = Number(caption?.emittedAt);
          const readableAt = Number.isFinite(emittedAt) ? emittedAt : Number(this.now());
          if (Number.isFinite(readableAt)) {
            metrics.firstReadableMs = Math.max(0, readableAt - session.firstAudioCapturedAt);
            session.firstReadableRecorded = true;
          }
        }
        this.emitRuntimeMetrics(session, metrics);
        const payload = {
          ...caption,
          type: "caption",
          sessionId: session.id,
          showSource,
        };
        this.emit("caption", payload);
        this.send(socket, payload);
      },
      onStatus: (status) => {
        if (this.activeSession !== session) return;
        const payload = { ...status, type: "status" };
        this.emit("status", payload);
        this.send(socket, payload);
      },
      onError: (error) => {
        if (this.activeSession !== session) return;
        const payload = { type: "status", level: "error", message: error.message };
        this.emit("status", payload);
        this.send(socket, { type: "error", code: "PROVIDER_ERROR", message: error.message });
      },
      onTerminal: (error) => {
        if (this.activeSession !== session) return;
        this.enqueueLifecycle(() => this.failSession(session, normalizeError(error))).catch(() => {});
      },
      onLanguageDetected: (detection) => {
        if (this.activeSession !== session) return;
        const sanitized = sanitizeLanguageDetection(detection);
        if (!sanitized) return;
        const payload = {
          type: "language-detected",
          sessionId: session.id,
          ...sanitized,
        };
        this.emit("language", payload);
        this.send(socket, payload);
      },
      onUsage: (usage) => {
        if (this.activeSession !== session) return;
        this.emitRuntimeUsage(session, usage);
      },
    };

    session.provider = this.providerFactory(
      this.config,
      { sourceLanguage, sourceLanguageCandidates, targetLanguage },
      callbacks,
    );
    this.activeSession = session;
    const providerPrepareStartedAt = Number(this.now());
    try {
      await session.provider.start();
    } catch (error) {
      if (this.activeSession === session) this.activeSession = null;
      await session.provider.stop().catch(() => {});
      const failure = new ClientMessageError(
        normalizeError(error).message,
        "PROVIDER_START_FAILED",
        1011,
      );
      throw failure;
    }
    const providerPreparedAt = Number(this.now());
    session.providerPrepareMs =
      Number.isFinite(providerPrepareStartedAt) && Number.isFinite(providerPreparedAt)
        ? Math.max(0, Math.round(providerPreparedAt - providerPrepareStartedAt))
        : null;
    if (this.activeSession !== session || socket.readyState !== WebSocket.OPEN) {
      if (this.activeSession === session) this.activeSession = null;
      await session.provider.stop().catch(() => {});
      return;
    }
    session.ready = true;
    if (session.paused) session.provider.setPaused?.(true);
    if (this.config.provider !== "demo" && this.config.maxCloudMinutes > 0) {
      session.cloudTimer = this.setTimer(() => {
        const error = new Error(
          `Cloud session reached the configured ${this.config.maxCloudMinutes}-minute guardrail`,
        );
        error.code = "CLOUD_DURATION_LIMIT";
        this.enqueueLifecycle(() => this.failSession(session, error)).catch(() => {});
      }, this.config.maxCloudMinutes * 60_000);
      session.cloudTimer.unref?.();
    }

    const status = {
      type: "status",
      level: "listening",
      message:
        sourceLanguage === "auto"
          ? sourceLanguageCandidates.length > 0
            ? `Đang tự động nhận diện, gợi ý ${sourceLanguageCandidates.join(", ")} → ${targetLanguage}`
            : `Đang tự động nhận diện → ${targetLanguage}`
          : `Đang nghe ${sourceLanguage} → ${targetLanguage}`,
      sessionId: session.id,
    };
    this.emit("status", status);
    if (session.providerPrepareMs !== null) {
      this.emitRuntimeMetrics(session, { providerPrepareMs: session.providerPrepareMs });
    }
    this.send(socket, {
      type: "started",
      sourceLanguage,
      sourceLanguageCandidates,
      targetLanguage,
      provider: this.config.provider,
      sessionId: session.id,
      maxCloudMinutes: this.config.maxCloudMinutes || 0,
      providerPrepareMs: session.providerPrepareMs,
    });
  }

  clearCloudTimer(session) {
    if (!session?.cloudTimer) return;
    this.clearTimer(session.cloudTimer);
    session.cloudTimer = null;
  }

  setPaused(paused, expectedSessionId) {
    const session = this.activeSession;
    if (!session) {
      if (expectedSessionId !== undefined) {
        return { changed: false, paused: this.paused, sessionId: null };
      }
      const nextPaused = paused === true;
      const changed = this.paused !== nextPaused;
      this.paused = nextPaused;
      return { changed, paused: this.paused, sessionId: null };
    }
    if (expectedSessionId !== undefined && expectedSessionId !== session.id) {
      return { changed: false, paused: session.paused, sessionId: session.id };
    }
    const nextPaused = paused === true;
    if (session.paused === nextPaused) {
      return { changed: false, paused: session.paused, sessionId: session.id };
    }
    this.paused = nextPaused;
    session.paused = nextPaused;
    session.provider.setPaused?.(nextPaused);
    if (nextPaused) this.emitTelemetryReset(session);
    const status = {
      type: "status",
      level: nextPaused ? "paused" : "listening",
      message: nextPaused
        ? "Phiên dịch đang tạm dừng; audio mới bị loại bỏ cục bộ"
        : "Phiên dịch đã tiếp tục trên kết nối hiện tại",
      sessionId: session.id,
      paused: nextPaused,
    };
    this.emit("status", status);
    this.send(session.socket, status);
    return { changed: true, paused: nextPaused, sessionId: session.id };
  }

  emitTelemetry(session, telemetry) {
    if (this.activeSession !== session) return;
    const payload = { type: "audio-telemetry", sessionId: session.id, ...telemetry };
    this.emit("telemetry", payload);
    this.send(session.socket, payload);
  }

  emitRuntimeMetrics(session, value) {
    if (this.activeSession !== session) return false;
    const metrics = numericAllowlist(value, RUNTIME_METRIC_FIELDS);
    if (!metrics) return false;
    this.emit("metrics", {
      type: "runtime-metrics",
      sessionId: session.id,
      ...metrics,
    });
    return true;
  }

  emitRuntimeUsage(session, value) {
    if (this.activeSession !== session) return false;
    const usage = numericAllowlist(value, USAGE_COUNTER_FIELDS);
    if (!usage) return false;
    this.emit("usage", {
      type: "runtime-usage",
      sessionId: session.id,
      mode: "session-total",
      usage,
    });
    return true;
  }

  emitTelemetryReset(session) {
    const payload = {
      type: "audio-telemetry",
      sessionId: session.id,
      ...session.telemetry.reset(),
    };
    this.emit("telemetry", payload);
    this.send(session.socket, payload);
  }

  async failSession(session, error) {
    if (this.activeSession !== session) return;
    this.activeSession = null;
    this.paused = false;
    this.clearCloudTimer(session);
    this.emitTelemetryReset(session);
    await session.provider.stop().catch(() => {});
    const payload = { type: "status", level: "error", message: error.message, terminal: true };
    this.emit("status", payload);
    this.send(session.socket, {
      type: "error",
      code: "PROVIDER_TERMINATED",
      message: error.message,
      fatal: true,
    });
    if (session.socket.readyState === WebSocket.OPEN) {
      setTimeout(() => session.socket.close(1011, "Provider terminated"), 10).unref?.();
    }
  }

  async stopActiveSession(reason = "Session stopped") {
    const session = this.activeSession;
    if (!session) return;
    this.activeSession = null;
    this.paused = false;
    session.ready = false;
    this.clearCloudTimer(session);
    this.emitTelemetryReset(session);
    await session.provider.stop().catch((error) => {
      this.emit("status", { type: "status", level: "error", message: error.message });
    });
    this.emit("status", { type: "status", level: "idle", message: reason });
  }

  send(socket, payload) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeGateway();
    try {
      await this.closePromise;
    } finally {
      this.closePromise = null;
    }
  }

  async closeGateway() {
    if (this.startPromise) await this.startPromise.catch(() => {});
    this.state = "closing";
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    await this.enqueueLifecycle(() => this.stopActiveSession("Gateway stopped"));
    this.paused = false;
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    if (server) {
      const clients = [...server.clients];
      for (const client of clients) {
        try {
          client.close(4001, "Local app stopped capture");
        } catch {
          client.terminate();
        }
      }
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(forceTimer);
          clearTimeout(timeout);
          resolve();
        };
        const forceTimer = setTimeout(() => {
          for (const client of clients) {
            if (client.readyState !== WebSocket.CLOSED) client.terminate();
          }
        }, 250);
        const timeout = setTimeout(() => {
          for (const client of clients) {
            if (client.readyState !== WebSocket.CLOSED) client.terminate();
          }
          finish();
        }, 2000);
        server.close(() => {
          finish();
        });
      });
    }
    this.state = "stopped";
  }
}

module.exports = {
  AUTH_SCHEME,
  ClientMessageError,
  RealtimeGateway,
  createServerAuthentication,
  extensionIdFromOrigin,
  isAllowedOrigin,
  tokensMatch,
  verifyClientAuthentication,
  validateSourceSettings,
};
