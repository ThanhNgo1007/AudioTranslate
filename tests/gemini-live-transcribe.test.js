const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUDIO_CHUNK_BYTES,
  DEFAULT_MODEL,
  DEFAULT_ROTATION_MS,
  GeminiLiveTranscriber,
} = require("../src/providers/gemini-live-transcribe");

async function waitFor(predicate, label = "condition", timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function timerHarness() {
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
    run(delay) {
      const timer = timers.find((candidate) => !candidate.cleared && candidate.delay === delay);
      if (!timer) throw new Error(`No active ${delay} ms timer`);
      timer.cleared = true;
      timer.callback();
    },
  };
}

function createHarness(overrides = {}) {
  const connects = [];
  const sessions = [];
  const transcripts = [];
  const statuses = [];
  const errors = [];
  const terminals = [];
  const detections = [];
  const usages = [];
  const factoryKeys = [];
  const timers = timerHarness();
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

  const provider = new GeminiLiveTranscriber({
    apiKey: "gemini-transcribe-test-secret",
    sourceLanguage: "auto",
    sourceLanguageCandidates: [],
    customVocabulary: ["Alex", "Stormhold", "Alex"],
    startupTimeoutMs: 100,
    clientFactory: async ({ apiKey }) => {
      factoryKeys.push(apiKey);
      return { client, modalityText: "TEXT" };
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onTranscript: (event) => transcripts.push(event),
    onStatus: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
    onTerminal: (error) => terminals.push(error),
    onLanguageDetected: (event) => detections.push(event),
    onUsage: (usage) => usages.push(usage),
    ...overrides,
  });

  return {
    provider,
    client,
    connects,
    sessions,
    transcripts,
    statuses,
    errors,
    terminals,
    detections,
    usages,
    factoryKeys,
    timers,
  };
}

test("connects to dedicated Live Transcribe with bounded recognition context", async () => {
  const vocabulary = Array.from({ length: 120 }, (_, index) => `Character-${index}`);
  const harness = createHarness({
    sourceLanguageCandidates: ["en-US", "ja-JP", "en-us"],
    customVocabulary: [...vocabulary, "Character-0"],
  });

  assert.doesNotMatch(JSON.stringify(harness.provider), /gemini-transcribe-test-secret/);
  await harness.provider.start();

  assert.deepEqual(harness.factoryKeys, ["gemini-transcribe-test-secret"]);
  assert.equal(harness.connects[0].model, DEFAULT_MODEL);
  assert.deepEqual(harness.connects[0].config.responseModalities, ["TEXT"]);
  assert.deepEqual(harness.connects[0].config.inputAudioTranscription.languageCodes, [
    "en-US",
    "ja-JP",
  ]);
  assert.deepEqual(
    harness.connects[0].config.inputAudioTranscription.customVocabulary,
    vocabulary.slice(0, 100),
  );
  assert.equal(harness.connects[0].config.inputAudioTranscription.mode, "VERBATIM");
  assert.ok(harness.connects[0].config.abortSignal instanceof AbortSignal);
  assert.equal(harness.timers.timers.some((timer) => timer.delay === DEFAULT_ROTATION_MS), true);
  assert.doesNotMatch(JSON.stringify(harness.provider), /gemini-transcribe-test-secret/);
  await harness.provider.stop();
});

test("batches PCM into 100 ms and emits replaceable interim plus authoritative final", async () => {
  let now = 1_500;
  const harness = createHarness({ now: () => now });
  await harness.provider.start();
  const session = harness.sessions[0];
  const frame = Buffer.alloc(640, 0x2a);

  for (let index = 0; index < 5; index += 1) {
    assert.equal(
      harness.provider.write(frame, { capturedAt: 1_000 + index * 20 }),
      true,
    );
  }
  assert.equal(session.sent.length, 1);
  assert.equal(session.sent[0].audio.mimeType, "audio/pcm;rate=16000");
  assert.equal(Buffer.from(session.sent[0].audio.data, "base64").byteLength, AUDIO_CHUNK_BYTES);

  const callbacks = harness.connects[0].callbacks;
  callbacks.onmessage({
    serverContent: {
      interimInputTranscription: { text: "She said", languageCode: "en-US" },
    },
  });
  callbacks.onmessage({
    serverContent: {
      interimInputTranscription: { text: "She said we should go", languageCode: "en-US" },
    },
  });
  now = 1_800;
  callbacks.onmessage({
    serverContent: {
      inputTranscription: {
        text: "She said we should go.",
        languageCode: "en-US",
      },
    },
    usageMetadata: { promptTokenCount: 10, secretText: "must-not-pass" },
  });

  assert.deepEqual(
    harness.transcripts.map(({ text, isFinal, sourceLanguage }) => ({
      text,
      isFinal,
      sourceLanguage,
    })),
    [
      { text: "She said", isFinal: false, sourceLanguage: "en-US" },
      { text: "She said we should go", isFinal: false, sourceLanguage: "en-US" },
      { text: "She said we should go.", isFinal: true, sourceLanguage: "en-US" },
    ],
  );
  assert.equal(harness.transcripts[0].capturedAt, 1_080);
  assert.deepEqual(harness.detections[0], {
    language: "en-US",
    confidence: null,
    detectionLatencyMs: 500,
    provider: "gemini-live-transcribe",
  });
  assert.deepEqual(harness.usages, [{ promptTokenCount: 10 }]);
  await harness.provider.stop();
});

test("hybrid activity finalizes one utterance immediately after local silence", async () => {
  const harness = createHarness({ hybridSilenceMs: 320 });
  await harness.provider.start();
  const session = harness.sessions[0];

  assert.equal(harness.provider.setAudioActivity({ speech: true, silenceMs: 0 }), true);
  assert.equal(harness.provider.setAudioActivity({ speech: false, silenceMs: 200 }), false);
  assert.equal(harness.provider.setAudioActivity({ speech: false, silenceMs: 340 }), true);
  assert.deepEqual(session.sent.at(-1), { audioStreamEnd: true });
  assert.equal(harness.provider.setAudioActivity({ speech: false, silenceMs: 900 }), false);

  assert.equal(harness.provider.setAudioActivity({ speech: true, silenceMs: 0 }), true);
  assert.equal(harness.provider.setAudioActivity({ speech: false, silenceMs: 400 }), true);
  assert.equal(
    session.sent.filter((message) => message.audioStreamEnd === true).length,
    2,
  );
  await harness.provider.stop();
});

test("rotates the ten-minute-limited session without accepting stale callbacks", async () => {
  const harness = createHarness();
  await harness.provider.start();
  const oldSession = harness.sessions[0];
  const oldCallbacks = harness.connects[0].callbacks;

  harness.timers.run(DEFAULT_ROTATION_MS);
  await waitFor(() => harness.connects.length === 2, "replacement Live Transcribe session");
  await harness.provider.rotationPromise;

  assert.equal(oldSession.closeCalls, 1);
  assert.equal(harness.sessions.length, 2);
  oldCallbacks.onmessage({
    serverContent: { inputTranscription: { text: "stale text", languageCode: "en-US" } },
  });
  assert.equal(harness.transcripts.length, 0);

  for (let index = 0; index < 5; index += 1) {
    harness.provider.write(Buffer.alloc(640), { capturedAt: 2_000 + index * 20 });
  }
  assert.equal(harness.sessions[1].sent.length, 1);
  await harness.provider.stop();
});

test("pause clears mutable audio and stop is concurrent-safe without leaking credentials", async () => {
  const harness = createHarness();
  await harness.provider.start();
  harness.provider.write(Buffer.alloc(640), { capturedAt: 2_000 });

  assert.equal(harness.provider.setPaused(true), true);
  assert.equal(harness.provider.write(Buffer.alloc(640), { capturedAt: 2_020 }), false);
  harness.connects[0].callbacks.onmessage({
    serverContent: { interimInputTranscription: { text: "must be ignored" } },
  });
  assert.equal(harness.transcripts.length, 0);
  assert.equal(harness.provider.setPaused(false), true);

  const first = harness.provider.stop();
  const second = harness.provider.stop();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(harness.sessions[0].closeCalls, 1);
  assert.equal(harness.provider.state, "stopped");
  assert.doesNotMatch(JSON.stringify(harness.provider), /gemini-transcribe-test-secret/);
});

test("startup and quota failures are actionable and redact the API key", async () => {
  const startup = createHarness({
    clientFactory: async ({ apiKey }) => {
      throw new Error(`cannot connect with ${apiKey}`);
    },
  });
  await assert.rejects(startup.provider.start(), (error) => {
    assert.doesNotMatch(error.message, /gemini-transcribe-test-secret/);
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });

  const quota = createHarness();
  await quota.provider.start();
  quota.connects[0].callbacks.onerror({
    error: Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { code: 429 }),
  });
  assert.equal(quota.terminals.length, 1);
  assert.equal(quota.terminals[0].code, "GEMINI_FREE_TIER_QUOTA");
  assert.match(quota.terminals[0].message, /Free Tier/);
  await quota.provider.stop();
});

test("constructor rejects malformed languages, secrets, and undersized buffers", () => {
  assert.throws(
    () => new GeminiLiveTranscriber({ apiKey: "", targetLanguage: "vi" }),
    /API key is required/,
  );
  assert.throws(
    () =>
      new GeminiLiveTranscriber({
        apiKey: "key",
        sourceLanguage: "not a locale!",
      }),
    /source language/,
  );
  assert.throws(
    () =>
      new GeminiLiveTranscriber({
        apiKey: "key",
        sourceLanguage: "auto",
        maxBufferedAudioBytes: 100,
      }),
    /at least 3200 bytes/,
  );
});
