const DEFAULT_MAX_SAMPLES = 120;
const MAX_SAMPLE_LIMIT = 10_000;

const RUNTIME_METRIC_FIELDS = Object.freeze([
  "providerPrepareMs",
  "localQueueMs",
  "liveEdgeToPartialMs",
  "partialToFinalMs",
  "resultToRafMs",
  "firstReadableMs",
]);

const USAGE_COUNTER_FIELDS = Object.freeze([
  "promptTokenCount",
  "responseTokenCount",
  "totalTokenCount",
  "cachedContentTokenCount",
  "thoughtsTokenCount",
  "toolUsePromptTokenCount",
]);

const METRIC_FIELD_SET = new Set(RUNTIME_METRIC_FIELDS);

function positiveSampleLimit(value) {
  const number = value === undefined ? DEFAULT_MAX_SAMPLES : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > MAX_SAMPLE_LIMIT) {
    throw new TypeError(`maxSamples must be an integer between 1 and ${MAX_SAMPLE_LIMIT}`);
  }
  return number;
}

function nonNegativeNumber(value) {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER
    ? Math.round(number)
    : null;
}

function nonNegativeInteger(value) {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function nearestRank(sorted, percentile) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1];
}

function emptySummary() {
  return Object.freeze({ latest: null, p50: null, p95: null, count: 0 });
}

function summarize(samples) {
  if (!samples.length) return emptySummary();
  const sorted = [...samples].sort((left, right) => left - right);
  return Object.freeze({
    latest: samples.at(-1),
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    count: samples.length,
  });
}

function sanitizeSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptySummary();
  const count = nonNegativeInteger(value.count) ?? 0;
  if (count === 0) return emptySummary();
  return Object.freeze({
    latest: nonNegativeNumber(value.latest),
    p50: nonNegativeNumber(value.p50),
    p95: nonNegativeNumber(value.p95),
    count,
  });
}

function sanitizeRuntimeMetricsSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawMetrics =
    value.metrics && typeof value.metrics === "object" && !Array.isArray(value.metrics)
      ? value.metrics
      : {};
  const metrics = {};
  for (const field of RUNTIME_METRIC_FIELDS) {
    metrics[field] = sanitizeSummary(rawMetrics[field]);
  }

  const rawUsage =
    value.usage && typeof value.usage === "object" && !Array.isArray(value.usage)
      ? value.usage
      : {};
  const usage = {};
  for (const field of USAGE_COUNTER_FIELDS) {
    const counter = nonNegativeInteger(rawUsage[field]);
    if (counter !== null) usage[field] = counter;
  }
  return Object.freeze({
    metrics: Object.freeze(metrics),
    usage: Object.freeze(usage),
  });
}

class RollingRuntimeMetrics {
  constructor(options = {}) {
    this.maxSamples = positiveSampleLimit(options.maxSamples);
    this.resetState();
  }

  resetState() {
    this.series = new Map(
      RUNTIME_METRIC_FIELDS.map((field) => [field, []]),
    );
    this.usage = {};
  }

  record(field, value) {
    if (!METRIC_FIELD_SET.has(field)) return false;
    const measurement = nonNegativeNumber(value);
    if (measurement === null) return false;
    const samples = this.series.get(field);
    samples.push(measurement);
    if (samples.length > this.maxSamples) {
      samples.splice(0, samples.length - this.maxSamples);
    }
    return true;
  }

  recordUsage(value, options = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const mode = options.mode === "delta" ? "delta" : "session-total";
    let changed = false;
    for (const field of USAGE_COUNTER_FIELDS) {
      const counter = nonNegativeInteger(value[field]);
      if (counter === null) continue;
      const current = nonNegativeInteger(this.usage[field]);
      if (mode === "delta") {
        const next = Math.min(Number.MAX_SAFE_INTEGER, (current ?? 0) + counter);
        if (current !== next) changed = true;
        this.usage[field] = next;
        continue;
      }
      if (current === null || counter >= current) {
        if (current !== counter) changed = true;
        this.usage[field] = counter;
      }
    }
    return changed;
  }

  snapshot() {
    const metrics = {};
    for (const field of RUNTIME_METRIC_FIELDS) {
      metrics[field] = summarize(this.series.get(field));
    }
    return sanitizeRuntimeMetricsSnapshot({ metrics, usage: this.usage });
  }

  reset() {
    this.resetState();
    return this.snapshot();
  }
}

module.exports = {
  RollingRuntimeMetrics,
  RUNTIME_METRIC_FIELDS,
  USAGE_COUNTER_FIELDS,
  sanitizeRuntimeMetricsSnapshot,
};
