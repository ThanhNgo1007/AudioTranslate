const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { sanitizeRuntimeMetricsSnapshot } = require("./runtime-metrics");

const REPORT_SCHEMA = "audiotranslate.runtime-observations";
const REPORT_SCHEMA_VERSION = 1;
const MAX_REPORT_BYTES = 1024 * 1024;
const PROVIDERS = new Set(["demo", "gemini"]);
const SOURCE_KINDS = new Set(["tab", "file"]);
const SESSION_STATES = new Set(["idle", "connecting", "listening", "paused", "stopping", "error"]);
const SUPPORTED_MODELS = new Set(["gemini-3.5-live-translate-preview"]);
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

function knownValue(value, allowed, fallback = "unknown") {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function safeModel(value) {
  return typeof value === "string" && SUPPORTED_MODELS.has(value) ? value : null;
}

function safeLanguage(value, { allowAuto = false } = {}) {
  if (allowAuto && value === "auto") return value;
  return typeof value === "string" && LANGUAGE_PATTERN.test(value) ? value : null;
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(Math.min(Number.MAX_SAFE_INTEGER, value))
    : null;
}

function normalizedGeneratedAt(value) {
  if (typeof value !== "string") throw new TypeError("generatedAt must be an ISO timestamp");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("generatedAt must be an ISO timestamp");
  return date.toISOString();
}

function buildRuntimeReport(options = {}) {
  const runtime = options.runtime && typeof options.runtime === "object" && !Array.isArray(options.runtime)
    ? options.runtime
    : {};
  const provider = knownValue(runtime.provider, PROVIDERS);
  const diagnostics = sanitizeRuntimeMetricsSnapshot(options.diagnostics) ||
    sanitizeRuntimeMetricsSnapshot({ metrics: {}, usage: {} });

  return {
    schema: REPORT_SCHEMA,
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: normalizedGeneratedAt(options.generatedAt),
    runtime: {
      provider,
      model: provider === "demo" ? "demo" : provider === "gemini" ? safeModel(runtime.model) : null,
      sourceKind: knownValue(runtime.sourceKind, SOURCE_KINDS),
      sourceLanguage: safeLanguage(runtime.sourceLanguage, { allowAuto: true }),
      targetLanguage: safeLanguage(runtime.targetLanguage),
      detectedLanguage: safeLanguage(runtime.detectedLanguage),
      languageDetectionMs: nonNegativeNumber(runtime.languageDetectionMs),
      state: knownValue(runtime.state, SESSION_STATES),
      active: runtime.active === true,
      paused: runtime.paused === true,
      armed: runtime.armed === true,
      cloudConsent: runtime.cloudConsent === true,
    },
    metrics: diagnostics.metrics,
    usage: diagnostics.usage,
  };
}

function serializeRuntimeReport(report) {
  const safeReport = buildRuntimeReport({
    generatedAt: report?.generatedAt,
    runtime: report?.runtime,
    diagnostics: {
      metrics: report?.metrics,
      usage: report?.usage,
    },
  });
  const contents = `${JSON.stringify(safeReport, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_REPORT_BYTES) {
    throw new RangeError("Runtime report exceeds the safe size limit");
  }
  return contents;
}

function writeRuntimeReportAtomic(destination, contents, options = {}) {
  if (typeof destination !== "string" || !path.isAbsolute(destination) || destination.includes("\0")) {
    throw new TypeError("Runtime report destination must be an absolute path");
  }
  if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > MAX_REPORT_BYTES) {
    throw new TypeError("Runtime report contents are invalid");
  }

  const fsImpl = options.fsImpl || fs;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const nonce = Buffer.from(randomBytes(12)).toString("hex");
  if (nonce.length !== 24) throw new TypeError("Runtime report nonce is invalid");
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${nonce}.tmp`,
  );
  let descriptor = null;
  let renamed = false;

  try {
    descriptor = fsImpl.openSync(temporary, "wx", 0o600);
    fsImpl.writeFileSync(descriptor, contents, { encoding: "utf8" });
    if (typeof fsImpl.fsyncSync === "function") fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = null;
    fsImpl.renameSync(temporary, destination);
    renamed = true;
    try {
      fsImpl.chmodSync(destination, 0o600);
    } catch {
      // Windows and some network filesystems do not expose POSIX modes.
    }
  } catch (error) {
    if (descriptor !== null) {
      try {
        fsImpl.closeSync(descriptor);
      } catch {
        // Best effort before removing the private temp file.
      }
    }
    if (!renamed) {
      try {
        fsImpl.unlinkSync(temporary);
      } catch {
        // The temp file may not have been created.
      }
    }
    throw error;
  }
}

module.exports = {
  REPORT_SCHEMA,
  REPORT_SCHEMA_VERSION,
  buildRuntimeReport,
  serializeRuntimeReport,
  writeRuntimeReportAtomic,
};
