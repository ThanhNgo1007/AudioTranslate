const assert = require("node:assert/strict");
const test = require("node:test");

const { DesktopRuntimeSignals } = require("../src/desktop-runtime-signals");

test("desktop runtime signals reject stale generations and wrong-session events", () => {
  const signals = new DesktopRuntimeSignals();
  const firstGeneration = signals.attachGateway();
  assert.equal(signals.beginSession(firstGeneration, "session-1"), true);
  assert.equal(signals.applyCaption(firstGeneration, {
    sessionId: "session-1",
    latencyMs: 480,
    transcript: "must not be retained",
  }), true);

  const secondGeneration = signals.attachGateway();
  assert.equal(signals.beginSession(secondGeneration, "session-2"), true);
  assert.equal(signals.applyLanguage(firstGeneration, {
    sessionId: "session-1",
    language: "en-US",
    detectionLatencyMs: 500,
  }), false);
  assert.equal(signals.applyTelemetry(secondGeneration, {
    sessionId: "wrong-session",
    rms: 0.9,
  }), false);
  assert.equal(signals.applyLanguage(secondGeneration, {
    sessionId: "session-2",
    language: "ja-JP",
    detectionLatencyMs: 840,
    transcript: "private transcript",
    apiKey: "secret-key",
  }), true);
  assert.equal(signals.applyTelemetry(secondGeneration, {
    sessionId: "session-2",
    rms: 0.2,
    peak: 0.7,
    speech: true,
    silenceMs: 0,
    packetGapCount: 2,
    droppedFrames: 3,
    queueMs: 45,
    updatedAt: 2_000,
    pcm: Buffer.alloc(640, 7),
  }), true);
  assert.equal(signals.applyCaption(secondGeneration, {
    sessionId: "session-2",
    latencyMs: 320,
    transcript: "another private transcript",
  }), true);
  signals.setPaused(true);

  const details = signals.details();
  assert.deepEqual(details, {
    paused: true,
    latencyMs: 320,
    detectedLanguage: "ja-JP",
    languageDetectionMs: 840,
    telemetry: {
      rms: 0.2,
      peak: 0.7,
      speech: true,
      silenceMs: 0,
      packetGapCount: 2,
      droppedFrames: 3,
      queueMs: 45,
      updatedAt: 2_000,
    },
  });
  assert.doesNotMatch(JSON.stringify(details), /private transcript|secret-key|pcm/);

  assert.equal(signals.endGateway(firstGeneration), false);
  assert.equal(signals.endGateway(secondGeneration), true);
  assert.deepEqual(signals.details(), {
    paused: false,
    latencyMs: null,
    detectedLanguage: null,
    languageDetectionMs: null,
    telemetry: null,
  });
});

test("telemetry reset clears meters without accepting transcript-shaped fields", () => {
  const signals = new DesktopRuntimeSignals();
  const generation = signals.attachGateway();
  signals.beginSession(generation, "session-3");
  signals.applyTelemetry(generation, {
    sessionId: "session-3",
    rms: 0.3,
    peak: 0.8,
    speech: true,
    updatedAt: 3_000,
  });

  assert.equal(signals.applyTelemetry(generation, {
    sessionId: "session-3",
    reset: true,
    transcript: "do not retain",
  }), true);
  assert.equal(signals.details().telemetry, null);
});
