const test = require("node:test");
const assert = require("node:assert/strict");
const {
  GeminiLiveTranslateTranslator,
  AUDIO_CHUNK_BYTES,
  DEFAULT_MODEL,
} = require("../src/providers/gemini-live-translate");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label = "condition", timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function fakeTimerHarness() {
  const timers = [];
  return {
    timers,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    runLatest() {
      const timer = [...timers].reverse().find((candidate) => !candidate.cleared);
      if (!timer) throw new Error("No active timer");
      timer.cleared = true;
      timer.callback();
    },
  };
}

function createHarness(overrides = {}) {
  const connects = [];
  const sessions = [];
  const captions = [];
  const statuses = [];
  const errors = [];
  const terminals = [];
  const detections = [];
  const usages = [];
  const factoryKeys = [];
  let connectImpl = overrides.connectImpl;

  const client = {
    live: {
      async connect(params) {
        connects.push(params);
        if (connectImpl) return connectImpl(params, connects.length - 1);
        const session = {
          sent: [],
          closeCalls: 0,
          sendRealtimeInput(message) {
            this.sent.push(message);
          },
          close() {
            this.closeCalls += 1;
          },
        };
        sessions.push(session);
        return session;
      },
    },
  };

  const provider = new GeminiLiveTranslateTranslator({
    apiKey: "gemini-test-secret",
    sourceLanguage: "auto",
    targetLanguage: "vi",
    startupTimeoutMs: 100,
    finalDebounceMs: 25,
    clientFactory: async ({ apiKey }) => {
      factoryKeys.push(apiKey);
      return { client, modalityAudio: "AUDIO" };
    },
    onCaption: (caption) => captions.push(caption),
    onStatus: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
    onTerminal: (error) => terminals.push(error),
    onLanguageDetected: (detection) => detections.push(detection),
    onUsage: (usage) => usages.push(usage),
    ...overrides,
  });

  return {
    provider,
    client,
    connects,
    sessions,
    captions,
    statuses,
    errors,
    terminals,
    detections,
    usages,
    factoryKeys,
    setConnectImpl(implementation) {
      connectImpl = implementation;
    },
  };
}

test("connects to Gemini in output-only low-latency mode by default", async () => {
  const harness = createHarness();
  assert.doesNotMatch(JSON.stringify(harness.provider), /gemini-test-secret/);

  await harness.provider.start();
  assert.deepEqual(harness.factoryKeys, ["gemini-test-secret"]);
  assert.equal(harness.connects.length, 1);
  const request = harness.connects[0];
  assert.equal(request.model, DEFAULT_MODEL);
  assert.deepEqual(request.config.responseModalities, ["AUDIO"]);
  assert.equal("inputAudioTranscription" in request.config, false);
  assert.deepEqual(request.config.outputAudioTranscription, {});
  assert.deepEqual(request.config.translationConfig, {
    targetLanguageCode: "vi",
    echoTargetLanguage: false,
  });
  assert.deepEqual(request.config.contextWindowCompression, { slidingWindow: {} });
  assert.deepEqual(request.config.sessionResumption, {});
  assert.ok(request.config.abortSignal instanceof AbortSignal);
  assert.equal(typeof request.callbacks.onmessage, "function");
  assert.doesNotMatch(JSON.stringify(harness.provider), /gemini-test-secret/);
  assert.ok(harness.statuses.some((status) => status.level === "ok"));
  await harness.provider.stop();
});

test("privacy mode rotates into a fresh session without retaining resumable state", async () => {
  const harness = createHarness({ enableSessionResumption: false });
  await harness.provider.start();
  assert.equal("sessionResumption" in harness.connects[0].config, false);

  const callbacks = harness.connects[0].callbacks;
  callbacks.onmessage({
    sessionResumptionUpdate: { resumable: true, newHandle: "must-be-ignored" },
    goAway: { timeLeft: "5s" },
  });
  await harness.provider.reconnectPromise;
  assert.equal(harness.provider.state, "running");
  assert.equal(harness.connects.length, 2);
  assert.equal("sessionResumption" in harness.connects[1].config, false);
  assert.ok(harness.statuses.some((status) => status.level === "warning"));
  assert.equal(harness.terminals.length, 0);
  assert.doesNotMatch(JSON.stringify(harness.provider), /must-be-ignored/);
  await harness.provider.stop();
});

test("bilingual fixed-source mode adds one transcription hint without disabling translation", async () => {
  const harness = createHarness({
    sourceLanguage: "en-US",
    enableInputTranscription: true,
    echoTargetLanguage: false,
  });
  await harness.provider.start();
  assert.deepEqual(harness.connects[0].config.inputAudioTranscription, {
    languageCodes: ["en-US"],
  });
  assert.equal(harness.connects[0].config.translationConfig.echoTargetLanguage, false);
  await harness.provider.stop();
});

test("auto source forwards only the optional language hints selected by the user", async () => {
  const harness = createHarness({
    sourceLanguage: "auto",
    sourceLanguageCandidates: ["en-US", "ja-JP", "en-us"],
    enableInputTranscription: true,
  });
  await harness.provider.start();
  assert.deepEqual(harness.connects[0].config.inputAudioTranscription, {
    languageCodes: ["en-US", "ja-JP"],
  });
  await harness.provider.stop();
});

test("fastest mode omits input transcription even when language hints exist", async () => {
  const harness = createHarness({
    sourceLanguage: "auto",
    sourceLanguageCandidates: ["en-US", "ja-JP"],
    enableInputTranscription: false,
  });
  await harness.provider.start();
  assert.equal("inputAudioTranscription" in harness.connects[0].config, false);
  assert.deepEqual(harness.connects[0].config.outputAudioTranscription, {});
  await harness.provider.stop();
});

test("combines five 20 ms PCM16 frames into one 100 ms Gemini audio message", async () => {
  const harness = createHarness({ sourceLanguage: "en-US" });
  await harness.provider.start();
  const session = harness.sessions[0];
  const frame = Buffer.alloc(640, 0x2a);

  for (let index = 0; index < 4; index += 1) {
    assert.equal(harness.provider.write(frame, { capturedAt: 1000 + index * 20 }), true);
  }
  assert.equal(session.sent.length, 0);
  assert.equal(harness.provider.write(frame, { capturedAt: 1080 }), true);
  assert.equal(session.sent.length, 1);
  assert.deepEqual(Object.keys(session.sent[0]), ["audio"]);
  assert.equal(session.sent[0].audio.mimeType, "audio/pcm;rate=16000");
  const decoded = Buffer.from(session.sent[0].audio.data, "base64");
  assert.equal(decoded.byteLength, AUDIO_CHUNK_BYTES);
  assert.deepEqual(decoded, Buffer.alloc(AUDIO_CHUNK_BYTES, 0x2a));
  assert.deepEqual(frame, Buffer.alloc(640, 0x2a), "caller-owned audio is not mutated");

  assert.throws(() => harness.provider.write(Buffer.alloc(3)), /even number of bytes/);
  assert.throws(() => harness.provider.write("not audio"), /Buffer, ArrayBuffer, or typed array/);
  await harness.provider.stop();
});

test("pause wipes buffered audio and suppresses stale captions without reconnecting", async () => {
  const harness = createHarness({ finalDebounceMs: 0 });
  await harness.provider.start();
  const providerSession = harness.sessions[0];
  const callbacks = harness.connects[0].callbacks;
  harness.provider.write(Buffer.alloc(640, 7), { capturedAt: 100 });
  const bufferedBeforePause = harness.provider.pendingAudio;
  assert.equal(bufferedBeforePause.byteLength, 640);

  harness.provider.setPaused(true);
  callbacks.onmessage({
    serverContent: {
      inputTranscription: { text: "stale source", languageCode: "en-US", finished: true },
      outputTranscription: { text: "stale translation", finished: true },
    },
  });

  assert.equal(harness.provider.pendingAudio.byteLength, 0);
  assert.deepEqual(bufferedBeforePause, Buffer.alloc(640));
  assert.equal(harness.captions.length, 0);
  assert.equal(harness.detections.length, 0);
  assert.equal(harness.connects.length, 1);

  harness.provider.setPaused(false);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(harness.provider.write(Buffer.alloc(640, 3), { capturedAt: 200 + index }), true);
  }
  assert.equal(providerSession.sent.length, 1);
  assert.equal(harness.connects.length, 1);
  await harness.provider.stop();
});

test("merges transcript fragments, detects input language, and debounces one final caption", async () => {
  let now = 1000;
  const timers = fakeTimerHarness();
  const harness = createHarness({
    now: () => now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    finalDebounceMs: 50,
  });
  await harness.provider.start();
  harness.provider.write(Buffer.alloc(640), { capturedAt: 900 });
  const callbacks = harness.connects[0].callbacks;

  callbacks.onmessage({
    serverContent: { inputTranscription: { text: "Good ", languageCode: "en-US" } },
  });
  callbacks.onmessage({
    serverContent: { inputTranscription: { text: "morning", languageCode: "en-US" } },
  });
  callbacks.onmessage({
    serverContent: {
      outputTranscription: { text: "Chào " },
      modelTurn: { parts: [{ inlineData: { data: "translated-audio-must-be-ignored" } }] },
    },
  });
  callbacks.onmessage({
    serverContent: { outputTranscription: { text: "buổi sáng" } },
  });

  assert.equal(harness.detections.length, 1);
  assert.deepEqual(harness.detections[0], {
    language: "en-US",
    confidence: null,
    detectionLatencyMs: 100,
    provider: "gemini-live-translate",
  });
  assert.equal(harness.captions.length, 2);
  assert.equal(harness.captions[0].translation, "Chào");
  assert.equal(harness.captions[1].transcript, "Good morning");
  assert.equal(harness.captions[1].translation, "Chào buổi sáng");
  assert.equal(harness.captions[1].isFinal, false);
  assert.equal(harness.captions[1].sourceLanguage, "en-US");
  assert.equal(harness.captions[1].sourceLanguageMode, "auto");
  assert.equal(harness.captions[1].provider, "gemini-live-translate");
  assert.equal(harness.captions[1].latencyMs, 100);
  assert.equal(harness.captions[1].liveEdgeToPartialMs, 100);
  assert.equal(
    timers.timers.length,
    0,
    "output fragments must remain one mutable utterance until Gemini reports a boundary",
  );

  callbacks.onmessage({
    serverContent: { inputTranscription: { finished: true } },
  });
  assert.equal(timers.timers.at(-1).delay, 50);
  assert.doesNotMatch(JSON.stringify(harness.provider), /Good morning|Chào buổi sáng/);

  now = 1050;
  timers.runLatest();
  assert.equal(harness.captions.length, 3);
  assert.equal(harness.captions[2].isFinal, true);
  assert.equal(harness.captions[2].translation, "Chào buổi sáng");
  assert.equal(harness.captions[2].partialToFinalMs, 50);
  assert.equal(harness.sessions[0].sent.length, 0, "partial audio below 100 ms is not uploaded");
  await harness.provider.stop();
});

test("keeps output fragments in one utterance and extends the grace window for late text", async () => {
  const timers = fakeTimerHarness();
  const harness = createHarness({
    finalDebounceMs: 300,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await harness.provider.start();
  const callbacks = harness.connects[0].callbacks;

  callbacks.onmessage({
    serverContent: { inputTranscription: { text: "We should leave", languageCode: "en" } },
  });
  callbacks.onmessage({ serverContent: { outputTranscription: { text: "Chúng ta" } } });
  callbacks.onmessage({
    serverContent: { outputTranscription: { text: "Chúng ta nên đi" } },
  });

  assert.equal(timers.timers.length, 0);
  assert.deepEqual(
    harness.captions.map(({ translation, isFinal }) => ({ translation, isFinal })),
    [
      { translation: "Chúng ta", isFinal: false },
      { translation: "Chúng ta nên đi", isFinal: false },
    ],
  );

  callbacks.onmessage({
    serverContent: { inputTranscription: { finished: true } },
  });
  const firstBoundaryTimer = timers.timers.at(-1);
  assert.equal(firstBoundaryTimer.delay, 300);

  callbacks.onmessage({ serverContent: { outputTranscription: { text: " ngay" } } });
  assert.equal(firstBoundaryTimer.cleared, true, "late output must extend the final grace window");
  assert.equal(timers.timers.at(-1).cleared, false);
  assert.equal(harness.captions.at(-1).translation, "Chúng ta nên đi ngay");
  assert.equal(harness.captions.at(-1).isFinal, false);

  timers.runLatest();
  const finals = harness.captions.filter((caption) => caption.isFinal);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].transcript, "We should leave");
  assert.equal(finals[0].translation, "Chúng ta nên đi ngay");
  await harness.provider.stop();
});

test("supports cumulative fragments and definitive finished boundaries without duplicate finals", async () => {
  const timers = fakeTimerHarness();
  const harness = createHarness({
    finalDebounceMs: 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await harness.provider.start();
  const callbacks = harness.connects[0].callbacks;

  callbacks.onmessage({
    serverContent: { inputTranscription: { text: "How are you?", languageCode: "en" } },
  });
  callbacks.onmessage({ serverContent: { outputTranscription: { text: "Bạn" } } });
  callbacks.onmessage({
    serverContent: { outputTranscription: { text: "Bạn khỏe không?", finished: true } },
  });
  callbacks.onmessage({ serverContent: { turnComplete: true } });
  assert.equal(timers.timers.at(-1).cleared, true);

  assert.deepEqual(
    harness.captions.map(({ translation, isFinal }) => ({ translation, isFinal })),
    [
      { translation: "Bạn", isFinal: false },
      { translation: "Bạn khỏe không?", isFinal: false },
      { translation: "Bạn khỏe không?", isFinal: true },
    ],
  );

  callbacks.onmessage({
    serverContent: { inputTranscription: { text: "Next", languageCode: "ja" } },
  });
  callbacks.onmessage({
    serverContent: { outputTranscription: { text: "Tiếp theo", finished: true } },
  });
  timers.runLatest();
  assert.equal(harness.captions.at(-1).transcript, "Next");
  assert.equal(harness.captions.at(-1).translation, "Tiếp theo");
  assert.equal(harness.captions.at(-1).latencyMs, null);
  assert.equal(harness.detections.at(-1).language, "ja");
  assert.equal(harness.detections.at(-1).updated, true);
  await harness.provider.stop();
});

test("usage metadata is forwarded through a numeric allowlist only", async () => {
  const harness = createHarness();
  await harness.provider.start();

  harness.connects[0].callbacks.onmessage({
    usageMetadata: {
      promptTokenCount: 100,
      responseTokenCount: 25,
      totalTokenCount: 125,
      cachedContentTokenCount: 5,
      thoughtsTokenCount: 3,
      toolUsePromptTokenCount: 2,
      promptTokensDetails: [{ modality: "AUDIO", tokenCount: 100 }],
      transcript: "must-not-leak",
      audio: "must-not-leak",
    },
  });

  assert.deepEqual(harness.usages, [{
    promptTokenCount: 100,
    responseTokenCount: 25,
    totalTokenCount: 125,
    cachedContentTokenCount: 5,
    thoughtsTokenCount: 3,
    toolUsePromptTokenCount: 2,
  }]);
  assert.doesNotMatch(JSON.stringify(harness.usages), /must-not-leak|transcript|audio/i);
  await harness.provider.stop();
});

test("Free Tier quota exhaustion becomes terminal without reconnecting or fallback", async () => {
  const harness = createHarness();
  await harness.provider.start();
  const error = Object.assign(new Error("RESOURCE_EXHAUSTED: quota exceeded"), { code: 429 });

  harness.connects[0].callbacks.onerror({ error });

  assert.equal(harness.errors.length, 1);
  assert.equal(harness.terminals.length, 1);
  assert.equal(harness.provider.state, "failed");
  assert.equal(harness.connects.length, 1);
  assert.equal(harness.terminals[0].code, "GEMINI_FREE_TIER_QUOTA");
  assert.match(harness.terminals[0].message, /Free Tier|AI Studio/i);
  assert.match(harness.terminals[0].message, /không tự động chuyển/i);
  await harness.provider.stop();
});

test("does not finalize before output transcription that arrives after generationComplete", async () => {
  const timers = fakeTimerHarness();
  const harness = createHarness({
    finalDebounceMs: 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await harness.provider.start();
  const callbacks = harness.connects[0].callbacks;

  callbacks.onmessage({
    serverContent: {
      inputTranscription: { text: "See you soon", languageCode: "en" },
      generationComplete: true,
    },
  });
  assert.equal(harness.captions.length, 0);

  callbacks.onmessage({
    serverContent: {
      outputTranscription: { text: "Hẹn sớm gặp lại" },
    },
  });
  assert.equal(harness.captions.at(-1).isFinal, false);
  timers.runLatest();
  assert.equal(harness.captions.at(-1).isFinal, true);
  assert.equal(harness.captions.at(-1).transcript, "See you soon");
  assert.equal(harness.captions.at(-1).translation, "Hẹn sớm gặp lại");
  await harness.provider.stop();
});

test("waits briefly for input transcription that arrives after finished output", async () => {
  const timers = fakeTimerHarness();
  const harness = createHarness({
    finalDebounceMs: 250,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await harness.provider.start();
  const callbacks = harness.connects[0].callbacks;

  callbacks.onmessage({
    serverContent: {
      outputTranscription: { text: "Cảm ơn", finished: true },
    },
  });
  callbacks.onmessage({
    serverContent: {
      inputTranscription: { text: "Thank you", languageCode: "en", finished: true },
    },
  });

  assert.equal(harness.captions.at(-1).isFinal, false);
  assert.equal(timers.timers.at(-1).delay, 250);
  timers.runLatest();
  assert.equal(harness.captions.at(-1).isFinal, true);
  assert.equal(harness.captions.at(-1).transcript, "Thank you");
  assert.equal(harness.captions.at(-1).translation, "Cảm ơn");
  await harness.provider.stop();
});

test("bounds cloud transcript fragments in memory while retaining recent subtitle text", async () => {
  const harness = createHarness({ finalDebounceMs: 0 });
  await harness.provider.start();
  const callbacks = harness.connects[0].callbacks;
  const oversized = `${"x".repeat(70 * 1024)}THE-END`;

  callbacks.onmessage({
    serverContent: {
      inputTranscription: { text: oversized, languageCode: "en" },
      outputTranscription: { text: oversized, finished: true },
    },
  });

  const final = harness.captions.at(-1);
  assert.equal(final.isFinal, true);
  assert.ok(final.transcript.length <= 64 * 1024);
  assert.ok(final.translation.length <= 64 * 1024);
  assert.match(final.transcript, /THE-END$/);
  assert.match(final.translation, /THE-END$/);
  await harness.provider.stop();
});

test("uses a private resumption handle on GoAway and buffers audio until reconnect", async () => {
  const secondConnect = deferred();
  const sessions = [];
  const harness = createHarness({
    connectImpl(_params, index) {
      const session = {
        sent: [],
        closeCalls: 0,
        sendRealtimeInput(message) {
          this.sent.push(message);
        },
        close() {
          this.closeCalls += 1;
        },
      };
      sessions.push(session);
      return index === 0 ? session : secondConnect.promise;
    },
  });
  await harness.provider.start();
  const firstCallbacks = harness.connects[0].callbacks;
  firstCallbacks.onmessage({
    sessionResumptionUpdate: { resumable: true, newHandle: "private-resume-handle" },
    goAway: { timeLeft: "5s" },
  });
  const reconnecting = harness.provider.reconnectPromise;
  assert.ok(reconnecting instanceof Promise);
  await waitFor(() => harness.connects.length === 2, "resumed Gemini connection");
  assert.equal(harness.provider.state, "reconnecting");
  assert.deepEqual(harness.connects[1].config.sessionResumption, {
    handle: "private-resume-handle",
  });
  assert.doesNotMatch(JSON.stringify(harness.provider), /private-resume-handle/);

  for (let index = 0; index < 5; index += 1) {
    assert.equal(harness.provider.write(Buffer.alloc(640, 7), { capturedAt: index * 20 }), true);
  }
  assert.equal(sessions[0].sent.length, 0);
  secondConnect.resolve(sessions[1]);
  await reconnecting;
  assert.equal(harness.provider.state, "running");
  assert.equal(sessions[0].closeCalls, 1);
  assert.equal(sessions[1].sent.length, 1);
  assert.equal(Buffer.from(sessions[1].sent[0].audio.data, "base64").byteLength, 3200);
  assert.equal(harness.terminals.length, 0);
  await harness.provider.stop();
});

test("stop during a planned reconnect does not open a replacement cloud connection", async () => {
  const harness = createHarness();
  await harness.provider.start();
  harness.connects[0].callbacks.onmessage({
    sessionResumptionUpdate: { resumable: true, newHandle: "private-resume-handle" },
    goAway: { timeLeft: "5s" },
  });

  await harness.provider.stop();
  assert.equal(harness.connects.length, 1);
  assert.equal(harness.provider.state, "stopped");
  assert.equal(harness.terminals.length, 0);
  assert.doesNotMatch(JSON.stringify(harness.provider), /private-resume-handle/);
});

test("reconnect failures redact both the API key and private resumption handle", async () => {
  const harness = createHarness({
    connectImpl(_params, index) {
      if (index === 0) {
        return {
          sendRealtimeInput() {},
          close() {},
        };
      }
      throw new Error(
        "resume private-resume-handle rejected for key=gemini-test-secret",
      );
    },
  });
  await harness.provider.start();
  harness.connects[0].callbacks.onmessage({
    sessionResumptionUpdate: { resumable: true, newHandle: "private-resume-handle" },
    goAway: { timeLeft: "5s" },
  });
  await harness.provider.reconnectPromise;

  assert.equal(harness.terminals.length, 1);
  assert.match(harness.terminals[0].message, /\[REDACTED\]/);
  assert.doesNotMatch(
    harness.terminals[0].message,
    /private-resume-handle|gemini-test-secret/,
  );
  await harness.provider.stop();
});

test("fails closed when a connection cannot be resumed and redacts credentials", async () => {
  const harness = createHarness();
  await harness.provider.start();
  const callbacks = harness.connects[0].callbacks;
  callbacks.onerror(new Error("request key=gemini-test-secret was rejected"));
  callbacks.onerror(new Error("duplicate gemini-test-secret"));
  callbacks.onclose({ code: 4401, reason: "bad gemini-test-secret" });

  assert.equal(harness.errors.length, 1);
  assert.match(harness.errors[0].message, /\[REDACTED\]/);
  assert.doesNotMatch(harness.errors[0].message, /gemini-test-secret/);
  assert.equal(harness.terminals.length, 1);
  assert.doesNotMatch(harness.terminals[0].message, /gemini-test-secret/);
  assert.equal(harness.provider.state, "failed");
  assert.equal(harness.provider.write(Buffer.alloc(640)), false);
  assert.doesNotMatch(JSON.stringify(harness.provider), /gemini-test-secret/);
  await harness.provider.stop();
});

test("stop is concurrent-safe, idempotent, and never turns an intentional close terminal", async () => {
  const harness = createHarness();
  await harness.provider.start();
  const session = harness.sessions[0];
  const first = harness.provider.stop();
  const second = harness.provider.stop();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(session.closeCalls, 1);
  assert.equal(harness.terminals.length, 0);
  assert.equal(harness.provider.state, "stopped");
  assert.equal(harness.provider.write(Buffer.alloc(640)), false);
  await harness.provider.stop();
  assert.equal(session.closeCalls, 1);
});

test("startup failures are actionable and cannot echo the API key", async () => {
  const provider = new GeminiLiveTranslateTranslator({
    apiKey: "startup-private-key",
    sourceLanguage: "auto",
    targetLanguage: "vi",
    startupTimeoutMs: 100,
    clientFactory: async () => ({
      client: {
        live: {
          connect() {
            throw new Error("authentication startup-private-key failed");
          },
        },
      },
    }),
  });
  await assert.rejects(
    provider.start(),
    (error) => /\[REDACTED\]/.test(error.message) && !/startup-private-key/.test(error.message),
  );
  assert.equal(provider.client, null);
  assert.doesNotMatch(JSON.stringify(provider), /startup-private-key/);
  await provider.stop();
});

test("a late startup failure remains redacted after a concurrent stop wipes secrets", async () => {
  const startup = deferred();
  const provider = new GeminiLiveTranslateTranslator({
    apiKey: "concurrent-private-key",
    sourceLanguage: "auto",
    targetLanguage: "vi",
    startupTimeoutMs: 100,
    clientFactory: () => startup.promise,
  });

  const starting = provider.start();
  await provider.stop();
  startup.reject(new Error("late failure for concurrent-private-key"));
  await assert.rejects(
    starting,
    (error) => /\[REDACTED\]/.test(error.message) && !/concurrent-private-key/.test(error.message),
  );
  assert.equal(provider.client, null);
});

test("constructor rejects invalid secrets, languages, and undersized bounded buffers", () => {
  assert.throws(
    () =>
      new GeminiLiveTranslateTranslator({
        apiKey: "secret\r\nInjected: yes",
        sourceLanguage: "auto",
        targetLanguage: "vi",
      }),
    /Invalid Gemini API key/,
  );
  assert.throws(
    () =>
      new GeminiLiveTranslateTranslator({
        apiKey: "secret",
        sourceLanguage: "not a locale!",
        targetLanguage: "vi",
      }),
    /Invalid Gemini source language/,
  );
  assert.throws(
    () =>
      new GeminiLiveTranslateTranslator({
        apiKey: "secret",
        sourceLanguage: "auto",
        targetLanguage: "vi",
        maxBufferedAudioBytes: 1000,
      }),
    /at least 3200 bytes/,
  );
});
