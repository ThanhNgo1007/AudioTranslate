const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildRuntimeReport,
  serializeRuntimeReport,
  writeRuntimeReportAtomic,
} = require("../src/runtime-report");

const EMPTY_SUMMARY = { latest: null, p50: null, p95: null, count: 0 };

test("runtime report is a strict main-owned projection with bounded metrics", () => {
  const report = buildRuntimeReport({
    generatedAt: "2026-08-30T04:05:06.000Z",
    runtime: {
      provider: "gemini",
      model: "gemini-3.5-live-translate-preview",
      sourceKind: "tab",
      sourceLanguage: "auto",
      targetLanguage: "vi",
      detectedLanguage: "en-US",
      languageDetectionMs: 438,
      state: "listening",
      active: true,
      paused: false,
      armed: true,
      cloudConsent: true,
      message: "hostile-message-token",
      sourceLabel: "/Users/private/movie.mp4",
      apiKey: "hostile-api-key",
      pairingToken: "hostile-pairing-token",
      url: "https://private.example",
    },
    diagnostics: {
      metrics: {
        providerPrepareMs: { latest: 440, p50: 410, p95: 520, count: 9 },
        liveEdgeToPartialMs: { latest: 780, p50: 720, p95: 980, count: 6 },
        transcript: { latest: 1, p50: 1, p95: 1, count: 1 },
      },
      usage: {
        totalTokenCount: 150,
        responseTokenCount: 30,
        audio: "hostile-audio",
        apiKey: "hostile-usage-key",
      },
      caption: "hostile-caption",
    },
  });

  assert.deepEqual(report, {
    schema: "audiotranslate.runtime-observations",
    schemaVersion: 1,
    generatedAt: "2026-08-30T04:05:06.000Z",
    runtime: {
      provider: "gemini",
      model: "gemini-3.5-live-translate-preview",
      sourceKind: "tab",
      sourceLanguage: "auto",
      targetLanguage: "vi",
      detectedLanguage: "en-US",
      languageDetectionMs: 438,
      state: "listening",
      active: true,
      paused: false,
      armed: true,
      cloudConsent: true,
    },
    metrics: {
      providerPrepareMs: { latest: 440, p50: 410, p95: 520, count: 9 },
      localQueueMs: EMPTY_SUMMARY,
      liveEdgeToPartialMs: { latest: 780, p50: 720, p95: 980, count: 6 },
      partialToFinalMs: EMPTY_SUMMARY,
      resultToRafMs: EMPTY_SUMMARY,
      firstReadableMs: EMPTY_SUMMARY,
    },
    usage: {
      responseTokenCount: 30,
      totalTokenCount: 150,
    },
  });

  const serialized = serializeRuntimeReport({
    ...report,
    runtime: { ...report.runtime, message: "hostile-serialized-message" },
    usage: { ...report.usage, audio: "hostile-serialized-audio" },
    caption: "hostile-serialized-caption",
    filePath: "/private/serialized-report.json",
  });
  assert.doesNotMatch(
    serialized,
    /hostile-|Users\/private|private\.example|private\/serialized|transcript|caption|sourceLabel|apiKey|pairingToken|filePath|\"audio\"/i,
  );
});

test("runtime report fails closed for invalid scalar context and metric values", () => {
  const report = buildRuntimeReport({
    generatedAt: "2026-08-30T04:05:06.000Z",
    runtime: {
      provider: "other",
      model: "model with spaces and /path",
      sourceKind: "microphone",
      sourceLanguage: "../../secret",
      targetLanguage: "",
      detectedLanguage: "<script>",
      languageDetectionMs: -1,
      state: "unknown-state",
      active: "yes",
      paused: 1,
      armed: null,
      cloudConsent: "true",
    },
    diagnostics: {
      metrics: {
        providerPrepareMs: { latest: -1, p50: Number.NaN, p95: Infinity, count: -5 },
      },
      usage: { totalTokenCount: -1 },
    },
  });

  assert.deepEqual(report.runtime, {
    provider: "unknown",
    model: null,
    sourceKind: "unknown",
    sourceLanguage: null,
    targetLanguage: null,
    detectedLanguage: null,
    languageDetectionMs: null,
    state: "unknown",
    active: false,
    paused: false,
    armed: false,
    cloudConsent: false,
  });
  assert.deepEqual(report.metrics.providerPrepareMs, EMPTY_SUMMARY);
  assert.deepEqual(report.usage, {});
});

test("runtime report never labels a local Demo session with a Gemini model", () => {
  const report = buildRuntimeReport({
    generatedAt: "2026-08-30T04:05:06.000Z",
    runtime: {
      provider: "demo",
      model: "gemini-3.5-live-translate-preview",
      sourceKind: "tab",
      sourceLanguage: "auto",
      targetLanguage: "vi",
      state: "idle",
    },
    diagnostics: {},
  });

  assert.equal(report.runtime.provider, "demo");
  assert.equal(report.runtime.model, "demo");
});

test("runtime report rejects secret-shaped strings in the model field", () => {
  const secretShapedModels = [
    "AIza-secret-that-must-never-cross",
    "pairingTokenLikeValue0123456789abcdef",
  ];

  for (const model of secretShapedModels) {
    const report = buildRuntimeReport({
      generatedAt: "2026-08-30T04:05:06.000Z",
      runtime: {
        provider: "gemini",
        model,
        sourceKind: "tab",
        sourceLanguage: "auto",
        targetLanguage: "vi",
        state: "listening",
      },
      diagnostics: {},
    });

    assert.equal(report.runtime.model, null);
    assert.doesNotMatch(
      serializeRuntimeReport({
        generatedAt: "2026-08-30T04:05:06.000Z",
        runtime: {
          provider: "gemini",
          model,
          sourceKind: "tab",
          sourceLanguage: "auto",
          targetLanguage: "vi",
          state: "listening",
        },
        metrics: {},
        usage: {},
      }),
      new RegExp(model),
    );
  }
});

test("runtime report writes through a same-directory mode-0600 atomic replacement", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-runtime-report-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "runtime-report.json");
  const contents = '{"schemaVersion":1}\n';

  writeRuntimeReportAtomic(destination, contents, {
    randomBytes: () => Buffer.alloc(12, 0xab),
  });

  assert.equal(fs.readFileSync(destination, "utf8"), contents);
  assert.deepEqual(fs.readdirSync(directory), ["runtime-report.json"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  }
});

test("runtime report preserves an existing destination and removes its temp file when rename fails", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-runtime-report-fail-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "runtime-report.json");
  fs.writeFileSync(destination, "original\n");
  const renameFailure = Object.assign(new Error("rename denied"), { code: "EACCES" });
  const failingFs = new Proxy(fs, {
    get(target, property, receiver) {
      if (property === "renameSync") return () => { throw renameFailure; };
      return Reflect.get(target, property, receiver);
    },
  });

  assert.throws(
    () => writeRuntimeReportAtomic(destination, "replacement\n", {
      fsImpl: failingFs,
      randomBytes: () => Buffer.alloc(12, 0xcd),
    }),
    (error) => error === renameFailure,
  );
  assert.equal(fs.readFileSync(destination, "utf8"), "original\n");
  assert.deepEqual(fs.readdirSync(directory), ["runtime-report.json"]);
});
