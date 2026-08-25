const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const net = require("node:net");
const { WebSocket } = require("ws");
const {
  AUTH_SCHEME,
  RealtimeGateway,
  createServerAuthentication,
  isAllowedOrigin,
  tokensMatch,
  verifyClientAuthentication,
  validateSourceSettings,
} = require("../src/gateway");
const { AUDIO_HEADER_BYTES, PROTOCOL_VERSION, encodeAudioFrame } = require("../src/protocol");

function startControl(overrides = {}) {
  return Buffer.from(
    JSON.stringify({
      type: "start",
      protocolVersion: PROTOCOL_VERSION,
      ...overrides,
    }),
  );
}

function fakeSocket() {
  return {
    readyState: WebSocket.OPEN,
    startTimestamps: [],
    sent: [],
    send(value) {
      this.sent.push(JSON.parse(value));
    },
    close() {
      this.readyState = WebSocket.CLOSED;
    },
  };
}

function baseConfig(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    provider: "demo",
    sourceLanguage: "en-US",
    sourceLanguageCandidates: ["en-US", "ja-JP", "ko-KR"],
    targetLanguage: "vi",
    showSource: true,
    allowDevClients: true,
    allowedExtensionIds: [],
    authToken: "",
    ...overrides,
  };
}

test("origin and pairing-token checks fail closed when configured", () => {
  const extensionId = "a".repeat(32);
  assert.equal(
    isAllowedOrigin(`chrome-extension://${extensionId}`, {
      allowDevClients: false,
      allowedExtensionIds: [extensionId],
    }),
    true,
  );
  assert.equal(
    isAllowedOrigin(`chrome-extension://${"b".repeat(32)}`, {
      allowDevClients: false,
      allowedExtensionIds: [extensionId],
    }),
    false,
  );
  assert.equal(
    isAllowedOrigin(`chrome-extension://${extensionId}`, {
      allowDevClients: false,
      allowedExtensionIds: [],
    }),
    false,
  );
  assert.equal(
    isAllowedOrigin(`chrome-extension://${extensionId}`, {
      allowDevClients: true,
      allowedExtensionIds: [],
    }),
    true,
  );
  assert.equal(tokensMatch("secret-token-123", "secret-token-123"), true);
  assert.equal(tokensMatch("secret-token-123", "wrong-token"), false);
});

test("mutual HMAC authentication proves the gateway without transmitting the token", () => {
  const secret = "pairing-secret-that-never-crosses-websocket";
  const challenge = { ...createServerAuthentication(secret), used: false };
  const clientNonce = crypto.randomBytes(24).toString("base64url");
  const clientProof = crypto
    .createHmac("sha256", secret)
    .update(`ATR1|client|${challenge.nonce}|${clientNonce}`)
    .digest("base64url");
  assert.equal(
    verifyClientAuthentication(secret, challenge, {
      scheme: AUTH_SCHEME,
      clientNonce,
      clientProof,
    }),
    true,
  );
  assert.equal(challenge.used, true);
  assert.equal(
    verifyClientAuthentication(secret, challenge, {
      scheme: AUTH_SCHEME,
      clientNonce,
      clientProof,
    }),
    false,
  );
  assert.doesNotMatch(JSON.stringify(challenge), new RegExp(secret));
});

test("auto source validation is provider-aware and rejects ambiguous candidate sets", () => {
  assert.deepEqual(
    validateSourceSettings(
      baseConfig({
        provider: "azure",
        sourceLanguage: "auto",
        sourceLanguageCandidates: ["en-US", "ja-JP", "ko-KR"],
      }),
    ),
    {
      sourceLanguage: "auto",
      sourceLanguageCandidates: ["en-US", "ja-JP", "ko-KR"],
    },
  );
  assert.deepEqual(
    validateSourceSettings(
      baseConfig({
        provider: "azure",
        sourceLanguage: "auto",
        sourceLanguageCandidates: ["en-us", "ja-jp"],
      }),
    ),
    { sourceLanguage: "auto", sourceLanguageCandidates: ["en-US", "ja-JP"] },
  );
  assert.throws(
    () =>
      validateSourceSettings(
        baseConfig({
          provider: "azure",
          sourceLanguage: "auto",
          sourceLanguageCandidates: ["en-US"],
        }),
      ),
    (error) => error.code === "AUTO_CANDIDATES_REQUIRED",
  );
  assert.throws(
    () =>
      validateSourceSettings(
        baseConfig({
          provider: "azure",
          sourceLanguage: "auto",
          sourceLanguageCandidates: ["en-US", "en-GB"],
        }),
      ),
    (error) => error.code === "DUPLICATE_BASE_LANGUAGE",
  );
  assert.throws(
    () =>
      validateSourceSettings(
        baseConfig({
          provider: "azure",
          sourceLanguage: "auto",
          sourceLanguageCandidates: ["en-US", "ja-JP", "ko-KR", "zh-CN", "fr-FR"],
        }),
      ),
    (error) => error.code === "TOO_MANY_CANDIDATES",
  );
  assert.throws(
    () =>
      validateSourceSettings(
        baseConfig({
          provider: "demo",
          sourceLanguage: "auto",
          sourceLanguageCandidates: ["en-US", "ja-JP"],
        }),
      ),
    (error) => error.code === "UNSUPPORTED_SOURCE_MODE",
  );
});

test("Gemini auto source accepts no hints and continuous language hints", () => {
  assert.deepEqual(
    validateSourceSettings(
      baseConfig({ provider: "gemini", sourceLanguage: "auto", sourceLanguageCandidates: [] }),
    ),
    { sourceLanguage: "auto", sourceLanguageCandidates: [] },
  );
  assert.deepEqual(
    validateSourceSettings(
      baseConfig({
        provider: "gemini",
        sourceLanguage: "auto",
        sourceLanguageCandidates: ["en", "vi-VN"],
      }),
    ),
    { sourceLanguage: "auto", sourceLanguageCandidates: ["en", "vi-VN"] },
  );
});

test("gateway configuration owns language and transcript settings", async () => {
  let sessionOptions;
  let callbacks;
  const gateway = new RealtimeGateway(
    baseConfig({
      provider: "gemini",
      sourceLanguage: "auto",
      sourceLanguageCandidates: ["en-US", "ja-JP"],
      targetLanguage: "ja",
      showSource: false,
    }),
    {
      providerFactory: (_config, session, providerCallbacks) => {
        sessionOptions = session;
        callbacks = providerCallbacks;
        return { async start() {}, async stop() {}, write() {} };
      },
    },
  );
  const socket = fakeSocket();

  await gateway.handleMessage(
    socket,
    startControl({
      sourceLanguage: "ko-KR",
      sourceLanguageCandidates: ["ko-KR"],
      targetLanguage: "de",
      showSource: true,
    }),
    false,
  );
  callbacks.onCaption({ transcript: "Hello", translation: "こんにちは", sequence: 1 });

  assert.deepEqual(sessionOptions, {
    sourceLanguage: "auto",
    sourceLanguageCandidates: ["en-US", "ja-JP"],
    targetLanguage: "ja",
  });
  assert.deepEqual(
    socket.sent.find((message) => message.type === "started"),
    {
      type: "started",
      sourceLanguage: "auto",
      sourceLanguageCandidates: ["en-US", "ja-JP"],
      targetLanguage: "ja",
      provider: "gemini",
      sessionId: "session-1",
      maxCloudMinutes: 0,
    },
  );
  assert.equal(socket.sent.find((message) => message.type === "caption").showSource, false);
  await gateway.close();
});

test("client cannot hide a source transcript enabled by gateway configuration", async () => {
  let callbacks;
  const gateway = new RealtimeGateway(baseConfig({ showSource: true }), {
    providerFactory: (_config, _session, providerCallbacks) => {
      callbacks = providerCallbacks;
      return { async start() {}, async stop() {}, write() {} };
    },
  });
  const socket = fakeSocket();

  await gateway.handleMessage(socket, startControl({ showSource: false }), false);
  callbacks.onCaption({ transcript: "Hello", translation: "Xin chào", sequence: 1 });

  assert.equal(socket.sent.find((message) => message.type === "caption").showSource, true);
  await gateway.close();
});

test("provider-aware auto candidate validation uses gateway configuration", async () => {
  const gateway = new RealtimeGateway(
    baseConfig({
      provider: "azure",
      sourceLanguage: "auto",
      sourceLanguageCandidates: ["en-US", "en-GB"],
    }),
    {
      providerFactory: () => ({ async start() {}, async stop() {}, write() {} }),
    },
  );
  const socket = fakeSocket();

  await assert.rejects(
    gateway.handleMessage(
      socket,
      startControl({
        sourceLanguage: "auto",
        sourceLanguageCandidates: ["en-US", "ja-JP"],
      }),
      false,
    ),
    (error) => error.code === "DUPLICATE_BASE_LANGUAGE",
  );
  assert.equal(gateway.activeSession, null);
  await gateway.close();
});

test("closing the desktop gateway tells the extension to stop capture instead of reconnecting", async () => {
  const client = {
    closeCode: null,
    closeReason: null,
    terminated: false,
    close(code, reason) {
      this.closeCode = code;
      this.closeReason = reason;
    },
    terminate() {
      this.terminated = true;
    },
  };
  const gateway = new RealtimeGateway(baseConfig());
  gateway.state = "running";
  gateway.server = {
    clients: new Set([client]),
    close(callback) {
      callback();
    },
  };

  await gateway.close();

  assert.equal(client.closeCode, 4001);
  assert.match(client.closeReason, /stopped/i);
  assert.equal(client.terminated, false);
});

test("auto language detection is scoped to the active session and sent as a structured event", async () => {
  let callbacks;
  const candidates = ["en-US", "ja-JP", "ko-KR"];
  const gateway = new RealtimeGateway(baseConfig({
    provider: "azure",
    sourceLanguage: "auto",
    sourceLanguageCandidates: candidates,
  }), {
    providerFactory: (_config, _session, providerCallbacks) => {
      callbacks = providerCallbacks;
      return { async start() {}, async stop() {}, write() {} };
    },
  });
  const detections = [];
  gateway.on("language", (detection) => detections.push(detection));
  const socket = fakeSocket();

  await gateway.handleMessage(socket, startControl(), false);
  callbacks.onLanguageDetected({
    type: "caption",
    sessionId: "provider-controlled",
    language: "ja-JP",
    confidence: "High",
    detectionLatencyMs: 840,
    transcript: "private provider transcript",
    apiKey: "provider-secret-must-not-cross",
  });

  const started = socket.sent.find((message) => message.type === "started");
  const event = socket.sent.find((message) => message.type === "language-detected");
  assert.deepEqual(started.sourceLanguageCandidates, candidates);
  assert.deepEqual(event, {
    type: "language-detected",
    sessionId: started.sessionId,
    language: "ja-JP",
    confidence: "High",
    detectionLatencyMs: 840,
  });
  assert.deepEqual(detections, [event]);
  assert.doesNotMatch(JSON.stringify(event), /private provider transcript|provider-secret/);
  await gateway.close();
});

test("provider callbacks cannot override gateway event types or session identity", async () => {
  let callbacks;
  const gateway = new RealtimeGateway(baseConfig(), {
    providerFactory: (_config, _session, providerCallbacks) => {
      callbacks = providerCallbacks;
      return { async start() {}, async stop() {}, write() {} };
    },
  });
  const socket = fakeSocket();
  await gateway.handleMessage(socket, startControl(), false);
  const sessionId = gateway.activeSession.id;

  callbacks.onCaption({
    type: "error",
    sessionId: "provider-controlled",
    transcript: "hello",
    translation: "xin chào",
    sequence: 1,
  });
  callbacks.onStatus({ type: "error", level: "ok", message: "ready" });

  const caption = socket.sent.find((message) => message.transcript === "hello");
  const status = socket.sent.find((message) => message.message === "ready");
  assert.equal(caption.type, "caption");
  assert.equal(caption.sessionId, sessionId);
  assert.equal(status.type, "status");
  await gateway.close();
});

test("invalid client language overrides cannot reject a valid configured replacement", async () => {
  let stopCount = 0;
  const gateway = new RealtimeGateway(baseConfig({ provider: "azure" }), {
    providerFactory: () => ({
      async start() {},
      async stop() {
        stopCount += 1;
      },
      write() {},
    }),
  });
  const activeSocket = fakeSocket();
  const replacementSocket = fakeSocket();
  await gateway.handleMessage(activeSocket, startControl(), false);
  const activeSession = gateway.activeSession;

  await gateway.handleMessage(
    replacementSocket,
    startControl({
      sourceLanguage: "auto",
      sourceLanguageCandidates: ["en-US", "en-GB"],
      targetLanguage: "not a language!",
    }),
    false,
  );
  assert.notEqual(gateway.activeSession, activeSession);
  assert.equal(gateway.activeSession.sourceLanguage, "en-US");
  assert.equal(gateway.activeSession.targetLanguage, "vi");
  assert.equal(stopCount, 1);
  await gateway.close();
});

test("language callbacks from a replaced provider cannot leak into the new session", async () => {
  const callbackSets = [];
  const gateway = new RealtimeGateway(baseConfig(), {
    providerFactory: (_config, _session, callbacks) => {
      callbackSets.push(callbacks);
      return { async start() {}, async stop() {}, write() {} };
    },
  });
  const socket = fakeSocket();
  await gateway.handleMessage(socket, startControl(), false);
  await gateway.handleMessage(socket, startControl({ sourceLanguage: "ja-JP" }), false);
  const before = socket.sent.length;

  callbackSets[0].onLanguageDetected({
    language: "en-US",
    confidence: "High",
    detectionLatencyMs: 500,
  });
  assert.equal(socket.sent.length, before);

  callbackSets[1].onLanguageDetected({
    language: "ja-JP",
    confidence: "High",
    detectionLatencyMs: 600,
  });
  assert.equal(socket.sent.at(-1).sessionId, gateway.activeSession.id);
  await gateway.close();
});

test("audio telemetry aggregates PCM without exposing it and throttles session updates", async () => {
  const origin = Date.now();
  let now = origin;
  const writes = [];
  const gateway = new RealtimeGateway(baseConfig(), {
    now: () => now,
    telemetryIntervalMs: 250,
    providerFactory: () => ({
      async start() {},
      async stop() {},
      write(pcm) {
        writes.push(Buffer.from(pcm));
        return true;
      },
    }),
  });
  const socket = fakeSocket();
  const telemetry = [];
  gateway.on("telemetry", (event) => telemetry.push(event));
  await gateway.handleMessage(socket, startControl(), false);

  const samples = Buffer.alloc(8);
  [0, 16_384, -16_384, 32_767].forEach((sample, index) => {
    samples.writeInt16LE(sample, index * 2);
  });
  await gateway.handleMessage(
    socket,
    encodeAudioFrame(samples, { sequence: 10, capturedAt: origin - 10 }),
    true,
  );
  now = origin + 100;
  await gateway.handleMessage(
    socket,
    encodeAudioFrame(samples, { sequence: 12, capturedAt: origin + 60 }),
    true,
  );
  assert.equal(telemetry.length, 0, "telemetry is not emitted faster than the throttle");

  now = origin + 250;
  await gateway.handleMessage(
    socket,
    encodeAudioFrame(samples, { sequence: 13, capturedAt: origin + 225 }),
    true,
  );

  assert.equal(writes.length, 3);
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].type, "audio-telemetry");
  assert.equal(telemetry[0].sessionId, gateway.activeSession.id);
  assert.ok(Math.abs(telemetry[0].rms - 0.61236) < 0.00001);
  assert.ok(Math.abs(telemetry[0].peak - 0.99997) < 0.00001);
  assert.equal(telemetry[0].speech, true);
  assert.equal(telemetry[0].silenceMs, 0);
  assert.equal(telemetry[0].packetGapCount, 1);
  assert.equal(telemetry[0].droppedFrames, 0);
  assert.equal(telemetry[0].queueMs, 40);
  assert.equal(telemetry[0].updatedAt, origin + 250);
  assert.equal(Object.hasOwn(telemetry[0], "pcm"), false);
  assert.doesNotMatch(JSON.stringify(telemetry[0]), /transcript|translation|secret/i);
  await gateway.close();
});

test("pause drops and wipes PCM before provider writes while resume keeps the same session", async () => {
  let callbacks;
  const writes = [];
  const pauseCalls = [];
  const telemetry = [];
  const gateway = new RealtimeGateway(baseConfig(), {
    providerFactory: (_config, _session, providerCallbacks) => {
      callbacks = providerCallbacks;
      return {
        async start() {},
        async stop() {},
        setPaused(paused) {
          pauseCalls.push(paused);
        },
        write(pcm) {
          writes.push(Buffer.from(pcm));
          return true;
        },
      };
    },
  });
  const socket = fakeSocket();
  gateway.on("telemetry", (event) => telemetry.push(event));
  await gateway.handleMessage(socket, startControl(), false);
  const session = gateway.activeSession;
  await gateway.handleMessage(
    socket,
    encodeAudioFrame(Buffer.alloc(640, 1), { sequence: 0 }),
    true,
  );

  assert.deepEqual(gateway.setPaused(true, "wrong-session"), {
    changed: false,
    paused: false,
    sessionId: session.id,
  });
  assert.equal(gateway.activeSession, session);
  assert.deepEqual(gateway.setPaused(true, session.id), {
    changed: true,
    paused: true,
    sessionId: session.id,
  });
  assert.equal(telemetry.at(-1).reset, true);
  assert.equal(telemetry.at(-1).rms, 0);
  const pausedFrame = encodeAudioFrame(Buffer.alloc(640, 9), { sequence: 1 });
  await gateway.handleMessage(socket, pausedFrame, true);
  callbacks.onCaption({ transcript: "must not leak", translation: "không", sequence: 1 });

  assert.equal(writes.length, 1);
  assert.deepEqual(
    pausedFrame.subarray(AUDIO_HEADER_BYTES),
    Buffer.alloc(640),
    "gateway-owned paused PCM is wiped in place",
  );
  assert.equal(socket.sent.some((message) => message.transcript === "must not leak"), false);
  assert.equal(gateway.activeSession, session);

  assert.deepEqual(gateway.setPaused(false, session.id), {
    changed: true,
    paused: false,
    sessionId: session.id,
  });
  await gateway.handleMessage(
    socket,
    encodeAudioFrame(Buffer.alloc(640, 2), { sequence: 2 }),
    true,
  );
  assert.equal(writes.length, 2);
  assert.equal(gateway.activeSession, session);
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.deepEqual(pauseCalls, [true, false]);
  await gateway.close();
});

test("intentional pause does not report discarded audio as transport loss", async () => {
  const origin = Date.now();
  let now = origin;
  const telemetry = [];
  const gateway = new RealtimeGateway(baseConfig(), {
    now: () => now,
    telemetryIntervalMs: 250,
    providerFactory: () => ({
      async start() {},
      async stop() {},
      setPaused() {},
      write() {
        return true;
      },
    }),
  });
  const socket = fakeSocket();
  gateway.on("telemetry", (event) => telemetry.push(event));
  await gateway.handleMessage(socket, startControl(), false);
  const sessionId = gateway.activeSession.id;

  gateway.setPaused(true, sessionId);
  now = origin + 250;
  const pausedFrame = encodeAudioFrame(Buffer.alloc(640, 9), {
    sequence: 0,
    capturedAt: now,
  });
  await gateway.handleMessage(socket, pausedFrame, true);

  assert.equal(telemetry.at(-1).reset, undefined);
  assert.equal(telemetry.at(-1).droppedFrames, 0);
  assert.equal(telemetry.at(-1).packetGapCount, 0);
  assert.deepEqual(pausedFrame.subarray(AUDIO_HEADER_BYTES), Buffer.alloc(640));
  await gateway.close();
});

test("pausing an armed gateway before tab capture gates the next authenticated session", async () => {
  const writes = [];
  const pauseCalls = [];
  const gateway = new RealtimeGateway(baseConfig(), {
    providerFactory: () => ({
      async start() {},
      async stop() {},
      setPaused: (paused) => pauseCalls.push(paused),
      write: (pcm) => writes.push(Buffer.from(pcm)),
    }),
  });
  assert.deepEqual(gateway.setPaused(true), {
    changed: true,
    paused: true,
    sessionId: null,
  });

  const socket = fakeSocket();
  await gateway.handleMessage(socket, startControl(), false);
  const session = gateway.activeSession;
  const pausedFrame = encodeAudioFrame(Buffer.alloc(640, 8), { sequence: 0 });
  await gateway.handleMessage(socket, pausedFrame, true);

  assert.equal(session.paused, true);
  assert.deepEqual(pauseCalls, [true]);
  assert.deepEqual(writes, []);
  assert.deepEqual(pausedFrame.subarray(AUDIO_HEADER_BYTES), Buffer.alloc(640));
  assert.equal(socket.readyState, WebSocket.OPEN);
  await gateway.close();
});

test("terminal teardown emits one sanitized telemetry reset for the ended session", async () => {
  const origin = Date.now();
  let now = origin;
  let callbacks;
  const gateway = new RealtimeGateway(baseConfig(), {
    now: () => now,
    telemetryIntervalMs: 250,
    providerFactory: (_config, _session, providerCallbacks) => {
      callbacks = providerCallbacks;
      return { async start() {}, async stop() {}, write() { return true; } };
    },
  });
  const socket = fakeSocket();
  const telemetry = [];
  gateway.on("telemetry", (event) => telemetry.push(event));
  await gateway.handleMessage(socket, startControl(), false);
  const sessionId = gateway.activeSession.id;
  now = origin + 250;
  await gateway.handleMessage(
    socket,
    encodeAudioFrame(Buffer.alloc(640, 1), { sequence: 0, capturedAt: now }),
    true,
  );
  assert.equal(telemetry.at(-1).reset, undefined);

  callbacks.onTerminal(new Error("provider stopped"));
  await gateway.lifecycle;

  assert.equal(gateway.activeSession, null);
  assert.deepEqual(telemetry.at(-1), {
    type: "audio-telemetry",
    sessionId,
    rms: 0,
    peak: 0,
    speech: false,
    silenceMs: 0,
    packetGapCount: 0,
    droppedFrames: 0,
    queueMs: null,
    updatedAt: origin + 250,
    reset: true,
  });
  assert.doesNotMatch(JSON.stringify(telemetry.at(-1)), /provider stopped|pcm|transcript|secret/i);
  await gateway.close();
});

test("telemetry counts sequence gaps and stale-frame drops without forwarding stale PCM", async () => {
  const origin = Date.now();
  let now = origin;
  const writes = [];
  const telemetry = [];
  const gateway = new RealtimeGateway(baseConfig(), {
    now: () => now,
    telemetryIntervalMs: 250,
    providerFactory: () => ({
      async start() {},
      async stop() {},
      write(pcm) {
        writes.push(Buffer.from(pcm));
        return true;
      },
    }),
  });
  gateway.on("telemetry", (event) => telemetry.push(event));
  const socket = fakeSocket();
  await gateway.handleMessage(socket, startControl(), false);
  await gateway.handleMessage(
    socket,
    encodeAudioFrame(Buffer.alloc(640), { sequence: 0, capturedAt: origin }),
    true,
  );
  now = origin + 250;
  const staleFrame = encodeAudioFrame(
    Buffer.alloc(640, 7),
    { sequence: 2, capturedAt: origin - 2_000 },
  );
  await gateway.handleMessage(
    socket,
    staleFrame,
    true,
  );

  assert.equal(writes.length, 1);
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].packetGapCount, 1);
  assert.equal(telemetry[0].droppedFrames, 1);
  assert.equal(telemetry[0].queueMs, 2_250);
  assert.equal(telemetry[0].speech, false);
  assert.equal(telemetry[0].silenceMs, 250);
  assert.deepEqual(staleFrame.subarray(AUDIO_HEADER_BYTES), Buffer.alloc(640));
  await gateway.close();
});

test("overlapping starts are serialized and cannot restore a stale provider", async () => {
  let providerNumber = 0;
  const stopped = [];
  const gateway = new RealtimeGateway(baseConfig(), {
    providerFactory: () => {
      const number = ++providerNumber;
      return {
        async start() {
          await new Promise((resolve) => setTimeout(resolve, number === 1 ? 20 : 1));
        },
        async stop() {
          stopped.push(number);
        },
        write() {},
      };
    },
  });
  const socket = fakeSocket();
  await Promise.all([
    gateway.handleMessage(socket, startControl(), false),
    gateway.handleMessage(socket, startControl(), false),
  ]);

  const started = socket.sent.filter((message) => message.type === "started");
  assert.deepEqual(
    started.map((message) => message.sessionId),
    ["session-1", "session-2"],
  );
  assert.equal(gateway.activeSession.id, "session-2");
  assert.deepEqual(stopped, [1]);
  await gateway.close();
});

test("a terminal provider callback tears down the active session", async () => {
  let callbacks;
  let stopCount = 0;
  const gateway = new RealtimeGateway(baseConfig(), {
    providerFactory: (_config, _session, providerCallbacks) => {
      callbacks = providerCallbacks;
      return {
        async start() {},
        async stop() {
          stopCount += 1;
        },
        write() {},
      };
    },
  });
  const socket = fakeSocket();
  const statuses = [];
  gateway.on("status", (status) => statuses.push(status));
  await gateway.handleMessage(socket, startControl(), false);
  callbacks.onTerminal(new Error("provider canceled"));
  await gateway.lifecycle;
  assert.equal(gateway.activeSession, null);
  assert.equal(stopCount, 1);
  assert.equal(statuses.at(-1).terminal, true);
  assert.equal(statuses.at(-1).level, "error");
  assert.ok(socket.sent.some((message) => message.code === "PROVIDER_TERMINATED"));
  await gateway.close();
});

test("cloud duration guardrail stops the provider and reports a terminal error", async () => {
  let scheduled;
  let stopCount = 0;
  const gateway = new RealtimeGateway(
    baseConfig({ provider: "azure", maxCloudMinutes: 30 }),
    {
      providerFactory: () => ({
        async start() {},
        async stop() {
          stopCount += 1;
        },
        write() {},
      }),
      setTimer(callback, milliseconds) {
        scheduled = { callback, milliseconds, unref() {} };
        return scheduled;
      },
      clearTimer(timer) {
        timer.cleared = true;
      },
    },
  );
  const socket = fakeSocket();
  await gateway.handleMessage(socket, startControl(), false);

  assert.equal(scheduled.milliseconds, 30 * 60_000);
  scheduled.callback();
  await gateway.lifecycle;
  assert.equal(gateway.activeSession, null);
  assert.equal(stopCount, 1);
  assert.ok(socket.sent.some((message) => message.code === "PROVIDER_TERMINATED"));
  assert.equal(scheduled.cleared, true);
  await gateway.close();
});

test("failed listen leaves the gateway reusable", async (context) => {
  const blocker = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error.code === "EPERM") {
      context.skip("sandbox does not permit loopback listeners");
      return;
    }
    throw error;
  }
  context.after(() => {
    if (blocker.listening) blocker.close();
  });
  const port = blocker.address().port;
  const gateway = new RealtimeGateway(baseConfig({ port }));
  context.after(() => gateway.close());

  await assert.rejects(gateway.start(), (error) => error.code === "EADDRINUSE");
  assert.equal(gateway.server, null);
  assert.equal(gateway.state, "stopped");

  await new Promise((resolve) => blocker.close(resolve));
  const address = await gateway.start();
  assert.equal(address.port, port);
});
