const crypto = require("node:crypto");

const GEMINI_FILE_CONSENT = "gemini:file-audio:v1";
const FILE_SOURCE_CHANNELS = Object.freeze({
  start: "audio-source:file:start",
  chunk: "audio-source:file:chunk",
  stop: "audio-source:file:stop",
});
const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 16 * 1024 * 1024 * 1024,
  maxChunkBytes: 6_400,
  maxQueueBytes: 32_000,
  maxQueueAgeMs: 1_000,
  maxChunksPerSecond: 80,
  maxBytesPerSecond: 96_000,
  maxSessionPcmBytes: 16_000 * 2 * 60 * 60 * 8,
});

class FileSourceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FileSourceError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new FileSourceError(message, code);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertOnlyKeys(value, allowed, code) {
  if (!isPlainObject(value)) fail("File source request is invalid", code);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail("File source request contains an unsupported field", code);
  }
}

function normalizeSenderId(value) {
  if (
    !((Number.isInteger(value) && value > 0) ||
      (typeof value === "string" && value.length > 0 && value.length <= 128))
  ) {
    fail("File source sender identity is invalid", "INVALID_SENDER");
  }
  return String(value);
}

function validateLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Invalid file source limit: ${key}`);
    }
  }
  if (limits.maxChunkBytes > limits.maxQueueBytes) {
    throw new TypeError("File source chunk limit cannot exceed queue limit");
  }
  if (limits.maxQueueAgeMs > 1_000) {
    throw new TypeError("File source queue cannot exceed the one-second realtime budget");
  }
  return Object.freeze(limits);
}

function validateStartRequest(input, limits = DEFAULT_LIMITS) {
  assertOnlyKeys(
    input,
    new Set([
      "displayName",
      "fileBytes",
      "mimeType",
      "sampleRate",
      "channels",
      "encoding",
      "destination",
      "consentVersion",
    ]),
    "INVALID_START",
  );
  const displayName = String(input.displayName || "");
  if (
    !displayName ||
    displayName.length > 200 ||
    /[\\/\u0000-\u001f\u007f]/.test(displayName)
  ) {
    fail("Selected file name is invalid", "INVALID_FILE_NAME");
  }
  if (!Number.isSafeInteger(input.fileBytes) || input.fileBytes <= 0) {
    fail("Selected file size is invalid", "INVALID_FILE_SIZE");
  }
  if (input.fileBytes > limits.maxFileBytes) {
    fail("Selected file exceeds the configured size limit", "FILE_TOO_LARGE");
  }
  const mimeType = String(input.mimeType || "").toLowerCase();
  if (!/^(?:audio|video)\/[a-z0-9][a-z0-9.+-]{0,126}$/.test(mimeType)) {
    fail("Selected file must be an audio or video media file", "INVALID_MEDIA_TYPE");
  }
  if (input.sampleRate !== 16_000 || input.channels !== 1 || input.encoding !== "pcm_s16le") {
    fail("File audio must be PCM16 mono at 16 kHz", "INVALID_AUDIO_FORMAT");
  }
  const destination = String(input.destination || "");
  if (!new Set(["local", "google-gemini"]).has(destination)) {
    fail("File audio destination must be selected explicitly", "INVALID_DESTINATION");
  }
  if (destination === "google-gemini" && input.consentVersion !== GEMINI_FILE_CONSENT) {
    fail("Gemini file-audio consent is required", "CLOUD_CONSENT_REQUIRED");
  }
  if (destination === "local" && input.consentVersion) {
    fail("Cloud consent is inconsistent with the local destination", "INVALID_CONSENT");
  }
  // displayName is deliberately validated and discarded. Status/telemetry never retain a path/name.
  return Object.freeze({ fileBytes: input.fileBytes, mimeType, destination });
}

function privacyLabel(destination) {
  if (destination === "google-gemini") {
    return "File được giải mã trên máy; PCM chỉ được stream tới Google Gemini khi phiên đang chạy. Chính sách dữ liệu của Google áp dụng.";
  }
  return "File được giải mã và xử lý cục bộ; PCM không được gửi tới dịch vụ AI cloud.";
}

function toPcmBuffer(value, maxChunkBytes) {
  const byteLength = value?.byteLength;
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > maxChunkBytes) {
    fail("PCM chunk size is invalid", "INVALID_CHUNK_SIZE");
  }
  if (byteLength % 2 !== 0) fail("PCM16 chunk must contain whole samples", "INVALID_PCM16");
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  const shared =
    typeof SharedArrayBuffer === "function" && value?.buffer instanceof SharedArrayBuffer;
  if (ArrayBuffer.isView(value) && !shared) {
    return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  fail("PCM chunk must be a private binary buffer", "INVALID_CHUNK_TYPE");
}

function wipe(buffer) {
  if (Buffer.isBuffer(buffer)) buffer.fill(0);
}

function senderIdFromEvent(event) {
  return normalizeSenderId(event?.sender?.id);
}

function createExactSenderAuthorizer({ webContentsId, url }) {
  const expectedId = normalizeSenderId(webContentsId);
  if (typeof url !== "string" || !url || url.length > 2_048) {
    throw new TypeError("Exact control-center URL is required");
  }
  return (event) => {
    const senderId = event?.sender?.id;
    const senderUrl = event?.senderFrame?.url;
    return String(senderId) === expectedId && senderUrl === url;
  };
}

class FileSourceSessionManager {
  constructor(options = {}) {
    if (typeof options.writePcm !== "function") {
      throw new TypeError("A main-process PCM writer is required");
    }
    this.writePcm = options.writePcm;
    this.authorizeDestination =
      typeof options.authorizeDestination === "function"
        ? options.authorizeDestination
        : (destination) => destination === "local";
    this.onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};
    this.now = options.now || Date.now;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.schedule = options.schedule || ((task) => queueMicrotask(task));
    this.limits = validateLimits(options.limits);
    this.activeSession = null;
  }

  start(senderId, request) {
    const ownerId = normalizeSenderId(senderId);
    if (this.activeSession) fail("A file source session is already active", "SESSION_ACTIVE");
    const metadata = validateStartRequest(request, this.limits);
    let destinationAuthorized = false;
    try {
      destinationAuthorized = this.authorizeDestination(metadata.destination) === true;
    } catch {
      destinationAuthorized = false;
    }
    if (!destinationAuthorized) {
      fail(
        "An authenticated main-process route is required for this destination",
        "DESTINATION_NOT_READY",
      );
    }
    const startedAt = this.now();
    const session = {
      id: this.randomBytes(24).toString("base64url"),
      ownerId,
      destination: metadata.destination,
      startedAt,
      active: true,
      paused: false,
      abortController: new AbortController(),
      queue: [],
      queuedBytes: 0,
      droppedFrames: 0,
      lastSequence: -1,
      totalPcmBytes: 0,
      rateWindowStartedAt: startedAt,
      rateChunks: 0,
      rateBytes: 0,
      pumpScheduled: false,
      pumping: false,
    };
    this.activeSession = session;
    const privacy = privacyLabel(session.destination);
    this.#emitStatus({
      type: "file-source-status",
      level: "ready",
      source: "file",
      destination: session.destination,
      privacy,
      message: "File audio source is ready",
    });
    return Object.freeze({
      sessionId: session.id,
      sampleRate: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
      maxChunkBytes: this.limits.maxChunkBytes,
      maxQueueAgeMs: this.limits.maxQueueAgeMs,
      privacy,
    });
  }

  push(senderId, request) {
    const session = this.#requireSession(senderId, request?.sessionId);
    let pcm = null;
    let queued = false;
    try {
      assertOnlyKeys(
        request,
        new Set(["sessionId", "sequence", "pcm"]),
        "INVALID_CHUNK",
      );
      if (!Number.isSafeInteger(request.sequence) || request.sequence < 0) {
        fail("PCM sequence is invalid", "INVALID_SEQUENCE");
      }
      if (request.sequence <= session.lastSequence) {
        return { accepted: false, reason: "out-of-order", droppedFrames: session.droppedFrames };
      }
      pcm = toPcmBuffer(request.pcm, this.limits.maxChunkBytes);
      const now = this.now();
      this.#recordRate(session, pcm.byteLength, now);
      if (session.paused) {
        session.lastSequence = request.sequence;
        session.droppedFrames += 1;
        wipe(pcm);
        return { accepted: false, reason: "paused", droppedFrames: session.droppedFrames };
      }
      if (session.totalPcmBytes + pcm.byteLength > this.limits.maxSessionPcmBytes) {
        wipe(pcm);
        fail("File source reached the session audio limit", "SESSION_AUDIO_LIMIT");
      }
      session.lastSequence = request.sequence;
      session.totalPcmBytes += pcm.byteLength;
      this.#pruneStale(session, now);
      session.queue.push({ sequence: request.sequence, pcm, queuedAt: now });
      queued = true;
      session.queuedBytes += pcm.byteLength;
      while (session.queuedBytes > this.limits.maxQueueBytes) this.#dropOldest(session);
      this.#schedulePump(session);
      return {
        accepted: true,
        queuedBytes: session.queuedBytes,
        droppedFrames: session.droppedFrames,
      };
    } catch (error) {
      if (pcm && !queued) wipe(pcm);
      if (this.activeSession === session) this.#terminate(session, "invalid-input");
      throw error;
    }
  }

  stop(senderId, request) {
    assertOnlyKeys(request, new Set(["sessionId"]), "INVALID_STOP");
    const session = this.#requireSession(senderId, request.sessionId);
    this.#terminate(session, "user-stop");
    return { stopped: true };
  }

  setPaused(paused, expectedSessionId) {
    const session = this.activeSession;
    if (!session || !session.active) {
      return { changed: false, paused: false, sessionId: null };
    }
    if (expectedSessionId !== undefined && expectedSessionId !== session.id) {
      return { changed: false, paused: session.paused, sessionId: session.id };
    }
    const nextPaused = paused === true;
    if (session.paused === nextPaused) {
      return { changed: false, paused: session.paused, sessionId: session.id };
    }
    session.paused = nextPaused;
    if (nextPaused) {
      while (session.queue.length > 0) this.#dropOldest(session);
    } else if (session.queue.length > 0) {
      this.#schedulePump(session);
    }
    return { changed: true, paused: nextPaused, sessionId: session.id };
  }

  stopBySender(senderId, reason = "renderer-destroyed") {
    const ownerId = normalizeSenderId(senderId);
    const session = this.activeSession;
    if (!session || session.ownerId !== ownerId) return false;
    this.#terminate(session, reason);
    return true;
  }

  shutdown() {
    if (this.activeSession) this.#terminate(this.activeSession, "shutdown");
  }

  #requireSession(senderId, sessionId) {
    const ownerId = normalizeSenderId(senderId);
    const session = this.activeSession;
    if (!session || !session.active) fail("No active file source session", "NO_SESSION");
    if (session.ownerId !== ownerId) fail("File source session belongs to another sender", "FORBIDDEN");
    if (typeof sessionId !== "string" || sessionId !== session.id) {
      fail("File source session is invalid", "INVALID_SESSION");
    }
    return session;
  }

  #recordRate(session, bytes, now) {
    if (now - session.rateWindowStartedAt >= 1_000) {
      session.rateWindowStartedAt = now;
      session.rateChunks = 0;
      session.rateBytes = 0;
    }
    session.rateChunks += 1;
    session.rateBytes += bytes;
    if (
      session.rateChunks > this.limits.maxChunksPerSecond ||
      session.rateBytes > this.limits.maxBytesPerSecond
    ) {
      fail("File source exceeded the realtime input rate", "RATE_LIMITED");
    }
  }

  #pruneStale(session, now) {
    while (
      session.queue.length > 0 &&
      now - session.queue[0].queuedAt > this.limits.maxQueueAgeMs
    ) {
      this.#dropOldest(session);
    }
  }

  #dropOldest(session) {
    const entry = session.queue.shift();
    if (!entry) return;
    session.queuedBytes -= entry.pcm.byteLength;
    session.droppedFrames += 1;
    wipe(entry.pcm);
  }

  #schedulePump(session) {
    if (session.pumpScheduled || session.pumping || !session.active || session.paused) return;
    session.pumpScheduled = true;
    this.schedule(async () => {
      session.pumpScheduled = false;
      try {
        await this.#pump(session);
      } catch (error) {
        if (this.activeSession === session) this.#terminate(session, "writer-failed");
        this.#emitStatus({
          type: "file-source-status",
          level: "error",
          source: "file",
          destination: session.destination,
          privacy: privacyLabel(session.destination),
          message: "File audio writer stopped unexpectedly",
          code: error?.code || "FILE_WRITER_FAILED",
        });
      }
    });
  }

  async #pump(session) {
    if (session.pumping || !session.active || session.paused || this.activeSession !== session) return;
    session.pumping = true;
    try {
      while (session.active && !session.paused && this.activeSession === session) {
        this.#pruneStale(session, this.now());
        const entry = session.queue.shift();
        if (!entry) break;
        session.queuedBytes -= entry.pcm.byteLength;
        try {
          await this.writePcm(entry.pcm, {
            sessionId: session.id,
            sequence: entry.sequence,
            capturedAt: entry.queuedAt,
            sampleRate: 16_000,
            channels: 1,
            encoding: "pcm_s16le",
            destination: session.destination,
            signal: session.abortController.signal,
          });
        } finally {
          wipe(entry.pcm);
        }
      }
    } finally {
      session.pumping = false;
      if (session.active && !session.paused && session.queue.length > 0) this.#schedulePump(session);
    }
  }

  #terminate(session, reason) {
    if (!session.active) return;
    session.active = false;
    session.abortController.abort(reason);
    for (const entry of session.queue) wipe(entry.pcm);
    session.queue = [];
    session.queuedBytes = 0;
    if (this.activeSession === session) this.activeSession = null;
    this.#emitStatus({
      type: "file-source-status",
      level: reason === "invalid-input" || reason === "writer-failed" ? "error" : "idle",
      source: "file",
      destination: session.destination,
      privacy: "Phiên file đã dừng; không còn PCM mới được chuyển tới provider.",
      message: "File audio source stopped",
      reason,
      droppedFrames: session.droppedFrames,
    });
  }

  #emitStatus(status) {
    try {
      this.onStatus(status);
    } catch {
      // UI/status delivery cannot weaken or interrupt the audio security boundary.
    }
  }
}

function registerFileSourceIpc({ ipcMain, manager, authorizeSender }) {
  if (!ipcMain || typeof ipcMain.handle !== "function" || typeof ipcMain.removeHandler !== "function") {
    throw new TypeError("Electron ipcMain-compatible object is required");
  }
  if (!(manager instanceof FileSourceSessionManager)) {
    throw new TypeError("FileSourceSessionManager is required");
  }
  if (typeof authorizeSender !== "function") {
    throw new TypeError("An exact renderer sender authorizer is required");
  }

  function guard(event) {
    if (!authorizeSender(event)) fail("File source IPC sender is not authorized", "FORBIDDEN");
    return senderIdFromEvent(event);
  }

  ipcMain.handle(FILE_SOURCE_CHANNELS.start, (event, request) => {
    const senderId = guard(event);
    const response = manager.start(senderId, request);
    event.sender.once?.("destroyed", () => manager.stopBySender(senderId));
    return response;
  });
  ipcMain.handle(FILE_SOURCE_CHANNELS.chunk, (event, request) =>
    manager.push(guard(event), request),
  );
  ipcMain.handle(FILE_SOURCE_CHANNELS.stop, (event, request) =>
    manager.stop(guard(event), request),
  );

  return () => {
    for (const channel of Object.values(FILE_SOURCE_CHANNELS)) ipcMain.removeHandler(channel);
    manager.shutdown();
  };
}

module.exports = {
  DEFAULT_LIMITS,
  FILE_SOURCE_CHANNELS,
  FileSourceError,
  FileSourceSessionManager,
  GEMINI_FILE_CONSENT,
  createExactSenderAuthorizer,
  privacyLabel,
  registerFileSourceIpc,
  validateStartRequest,
};
