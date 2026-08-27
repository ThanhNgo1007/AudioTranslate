const { sanitizeRuntimeMetricsSnapshot } = require("./runtime-metrics");

function nonNegativeInteger(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

function metric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function validSessionId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validLanguage(value) {
  const language = String(value || "").trim();
  return language.length <= 35 && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(language)
    ? language
    : null;
}

function sanitizedTelemetry(value) {
  return {
    rms: metric(value?.rms),
    peak: metric(value?.peak),
    speech: value?.speech === true,
    silenceMs: nonNegativeInteger(value?.silenceMs, 0),
    packetGapCount: nonNegativeInteger(value?.packetGapCount, 0),
    droppedFrames: nonNegativeInteger(value?.droppedFrames, 0),
    queueMs: nonNegativeInteger(value?.queueMs),
    updatedAt: nonNegativeInteger(value?.updatedAt),
  };
}

class DesktopRuntimeSignals {
  constructor() {
    this.generation = 0;
    this.sessionId = null;
    this.resetSignals();
  }

  attachGateway() {
    this.generation += 1;
    this.sessionId = null;
    this.resetSignals();
    return this.generation;
  }

  beginSession(generation, sessionId) {
    if (generation !== this.generation || !validSessionId(sessionId)) return false;
    if (this.sessionId !== sessionId) {
      const paused = this.paused;
      this.resetSignals();
      this.paused = paused;
      this.sessionId = sessionId;
    }
    return true;
  }

  applyTelemetry(generation, event) {
    if (!this.accepts(generation, event?.sessionId)) return false;
    this.telemetry = event?.reset === true ? null : sanitizedTelemetry(event);
    return true;
  }

  applyLanguage(generation, event) {
    if (!this.accepts(generation, event?.sessionId)) return false;
    const language = validLanguage(event?.language);
    if (!language) return false;
    this.detectedLanguage = language;
    this.languageDetectionMs = nonNegativeInteger(event?.detectionLatencyMs);
    return true;
  }

  applyCaption(generation, caption) {
    if (!this.accepts(generation, caption?.sessionId) || caption?.synthetic === true) return false;
    const latencyMs = nonNegativeInteger(caption?.latencyMs);
    if (latencyMs === null) return false;
    this.latencyMs = latencyMs;
    return true;
  }

  setPaused(paused) {
    this.paused = paused === true;
  }

  endGateway(generation) {
    if (generation !== this.generation) return false;
    this.sessionId = null;
    this.resetSignals();
    return true;
  }

  details(runtimeDiagnostics = null) {
    return {
      paused: this.paused,
      latencyMs: this.latencyMs,
      detectedLanguage: this.detectedLanguage,
      languageDetectionMs: this.languageDetectionMs,
      telemetry: this.telemetry ? { ...this.telemetry } : null,
      diagnostics: sanitizeRuntimeMetricsSnapshot(runtimeDiagnostics),
    };
  }

  acceptsEvent(generation, event) {
    if (!this.accepts(generation, event?.sessionId)) return false;
    const eventGeneration = Number(event?.generation);
    return !Number.isFinite(eventGeneration) || eventGeneration === generation;
  }

  accepts(generation, sessionId) {
    return generation === this.generation && this.sessionId !== null && sessionId === this.sessionId;
  }

  resetSignals() {
    this.paused = false;
    this.latencyMs = null;
    this.detectedLanguage = null;
    this.languageDetectionMs = null;
    this.telemetry = null;
  }
}

module.exports = { DesktopRuntimeSignals, sanitizedTelemetry };
