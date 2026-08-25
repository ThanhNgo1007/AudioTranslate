const DEFAULT_TELEMETRY_INTERVAL_MS = 250;
const DEFAULT_SPEECH_RMS_THRESHOLD = 0.015;

function boundedMetric(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 100_000) / 100_000;
}

function normalizedQueueMs(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

class AudioTelemetryAggregator {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.intervalMs = Number.isInteger(options.intervalMs)
      ? Math.max(200, Math.min(250, options.intervalMs))
      : DEFAULT_TELEMETRY_INTERVAL_MS;
    this.speechRmsThreshold = Number.isFinite(options.speechRmsThreshold)
      ? Math.max(0, Math.min(1, options.speechRmsThreshold))
      : DEFAULT_SPEECH_RMS_THRESHOLD;
    const startedAt = this.now();
    this.lastEmittedAt = startedAt;
    this.silenceStartedAt = startedAt;
    this.lastSequence = null;
    this.packetGapCount = 0;
    this.squaredSum = 0;
    this.sampleCount = 0;
    this.peak = 0;
    this.queueMs = null;
  }

  record(pcm, details = {}) {
    this.#recordSequence(details.sequence);
    const queueMs = normalizedQueueMs(details.queueMs);
    if (queueMs !== null) this.queueMs = Math.max(this.queueMs ?? 0, queueMs);

    if (pcm) {
      const bytes = Buffer.isBuffer(pcm)
        ? pcm
        : Buffer.from(pcm.buffer || pcm, pcm.byteOffset || 0, pcm.byteLength);
      for (let offset = 0; offset + 1 < bytes.byteLength; offset += 2) {
        const normalized = bytes.readInt16LE(offset) / 32_768;
        this.squaredSum += normalized * normalized;
        this.sampleCount += 1;
        this.peak = Math.max(this.peak, Math.abs(normalized));
      }
    }

    const now = this.now();
    if (now - this.lastEmittedAt < this.intervalMs) return null;
    const rms = this.sampleCount > 0 ? Math.sqrt(this.squaredSum / this.sampleCount) : 0;
    const speech = rms >= this.speechRmsThreshold;
    if (speech) this.silenceStartedAt = null;
    else if (this.silenceStartedAt === null) this.silenceStartedAt = this.lastEmittedAt;
    const telemetry = Object.freeze({
      rms: boundedMetric(rms),
      peak: boundedMetric(this.peak),
      speech,
      silenceMs: speech ? 0 : Math.max(0, Math.round(now - this.silenceStartedAt)),
      packetGapCount: this.packetGapCount,
      droppedFrames: Number.isSafeInteger(details.droppedFrames)
        ? Math.max(0, details.droppedFrames)
        : 0,
      queueMs: this.queueMs,
      updatedAt: now,
    });
    this.lastEmittedAt = now;
    this.squaredSum = 0;
    this.sampleCount = 0;
    this.peak = 0;
    this.queueMs = null;
    return telemetry;
  }

  reset() {
    const now = this.now();
    this.lastEmittedAt = now;
    this.silenceStartedAt = now;
    this.lastSequence = null;
    this.packetGapCount = 0;
    this.squaredSum = 0;
    this.sampleCount = 0;
    this.peak = 0;
    this.queueMs = null;
    return Object.freeze({
      rms: 0,
      peak: 0,
      speech: false,
      silenceMs: 0,
      packetGapCount: 0,
      droppedFrames: 0,
      queueMs: null,
      updatedAt: now,
      reset: true,
    });
  }

  #recordSequence(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return;
    if (this.lastSequence !== null && sequence > this.lastSequence + 1) {
      this.packetGapCount += sequence - this.lastSequence - 1;
    }
    if (this.lastSequence === null || sequence > this.lastSequence) this.lastSequence = sequence;
  }
}

module.exports = {
  AudioTelemetryAggregator,
  DEFAULT_SPEECH_RMS_THRESHOLD,
  DEFAULT_TELEMETRY_INTERVAL_MS,
};
