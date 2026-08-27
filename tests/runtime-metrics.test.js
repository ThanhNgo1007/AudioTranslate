const assert = require("node:assert/strict");
const test = require("node:test");

const { RollingRuntimeMetrics } = require("../src/runtime-metrics");

const EMPTY_SUMMARY = Object.freeze({ latest: null, p50: null, p95: null, count: 0 });

function forbiddenKeys(value, found = []) {
  if (!value || typeof value !== "object") return found;
  const banned = new Set(["text", "caption", "transcript", "audio", "data", "bytes"]);
  for (const [key, child] of Object.entries(value)) {
    if (banned.has(key.toLowerCase())) found.push(key);
    forbiddenKeys(child, found);
  }
  return found;
}

test("rolling metrics calculate nearest-rank p50/p95 and bound every series", () => {
  const metrics = new RollingRuntimeMetrics({ maxSamples: 120 });
  for (const value of [100, 200, 300, 400]) {
    assert.equal(metrics.record("providerPrepareMs", value), true);
  }
  for (let value = 1; value <= 125; value += 1) {
    metrics.record("localQueueMs", value);
  }
  metrics.record("liveEdgeToPartialMs", 480);
  metrics.record("partialToFinalMs", 125);
  metrics.record("resultToRafMs", 17);
  metrics.record("firstReadableMs", 690);

  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.metrics.providerPrepareMs, {
    latest: 400,
    p50: 200,
    p95: 400,
    count: 4,
  });
  assert.deepEqual(snapshot.metrics.localQueueMs, {
    latest: 125,
    p50: 65,
    p95: 119,
    count: 120,
  });
  assert.deepEqual(snapshot.metrics.liveEdgeToPartialMs, {
    latest: 480,
    p50: 480,
    p95: 480,
    count: 1,
  });
  assert.deepEqual(snapshot.metrics.partialToFinalMs, {
    latest: 125,
    p50: 125,
    p95: 125,
    count: 1,
  });
  assert.deepEqual(snapshot.metrics.resultToRafMs, {
    latest: 17,
    p50: 17,
    p95: 17,
    count: 1,
  });
  assert.deepEqual(snapshot.metrics.firstReadableMs, {
    latest: 690,
    p50: 690,
    p95: 690,
    count: 1,
  });
});

test("invalid, negative, non-finite and unknown measurements are ignored", () => {
  const metrics = new RollingRuntimeMetrics({ maxSamples: 3 });

  assert.equal(metrics.record("providerPrepareMs", -1), false);
  assert.equal(metrics.record("providerPrepareMs", Number.NaN), false);
  assert.equal(metrics.record("providerPrepareMs", Number.POSITIVE_INFINITY), false);
  assert.equal(metrics.record("unknownMetric", 20), false);
  assert.deepEqual(metrics.snapshot().metrics.providerPrepareMs, EMPTY_SUMMARY);
  assert.deepEqual(metrics.snapshot().usage, {});
});

test("usage replaces monotonic session totals and adds only explicit deltas", () => {
  const metrics = new RollingRuntimeMetrics();
  metrics.recordUsage({
    promptTokenCount: 100,
    responseTokenCount: 25,
    totalTokenCount: 125,
    transcript: "must not be retained",
    audio: "must not be retained",
  }, { mode: "session-total" });
  metrics.recordUsage({
    promptTokenCount: 120,
    responseTokenCount: 30,
    totalTokenCount: 150,
  }, { mode: "session-total" });
  metrics.recordUsage({
    promptTokenCount: 90,
    responseTokenCount: -2,
    totalTokenCount: 140,
  }, { mode: "session-total" });
  metrics.recordUsage({
    promptTokenCount: 5,
    responseTokenCount: 2,
    totalTokenCount: 7,
    arbitraryCounter: 999,
  }, { mode: "delta" });

  assert.deepEqual(metrics.snapshot().usage, {
    promptTokenCount: 125,
    responseTokenCount: 32,
    totalTokenCount: 157,
  });
  assert.deepEqual(forbiddenKeys(metrics.snapshot()), []);
});

test("reset clears metric samples and usage without changing the public schema", () => {
  const metrics = new RollingRuntimeMetrics();
  metrics.record("firstReadableMs", 740);
  metrics.recordUsage({ totalTokenCount: 80 }, { mode: "session-total" });

  const reset = metrics.reset();
  assert.deepEqual(reset.metrics.firstReadableMs, EMPTY_SUMMARY);
  assert.deepEqual(reset.usage, {});
  assert.deepEqual(forbiddenKeys(reset), []);
});
