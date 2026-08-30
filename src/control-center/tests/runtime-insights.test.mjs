import assert from "node:assert/strict";
import test from "node:test";

import {
  describeDetectedLanguage,
  describeLatency,
  describeRuntimeMetrics,
  describeRuntimeUsage,
  meterSegments,
  normalizeAudioTelemetry,
  normalizeRuntimeDiagnostics,
} from "../src/runtime-insights.mjs";

test("audio telemetry is finite, clamped and preserves truthful loss counters", () => {
  assert.deepEqual(
    normalizeAudioTelemetry({
      rms: 1.4,
      peak: -2,
      speech: true,
      silenceMs: -20,
      packetGapCount: 3.8,
      droppedFrames: 2,
      queueMs: Number.POSITIVE_INFINITY,
      updatedAt: 1234,
    }),
    {
      rms: 1,
      peak: 0,
      speech: true,
      silenceMs: 0,
      packetGapCount: 3,
      droppedFrames: 2,
      queueMs: 0,
      updatedAt: 1234,
    },
  );
});

test("meter segments come from measured RMS and never animate a silent or missing signal", () => {
  assert.equal(meterSegments(null, 28), 0);
  assert.equal(meterSegments(0, 28), 0);
  assert.equal(meterSegments(0.01, 28), 1);
  assert.ok(meterSegments(0.25, 28) > meterSegments(0.05, 28));
  assert.equal(meterSegments(1, 28), 28);
});

test("detected language copy distinguishes auto detection, fixed input and time to lock", () => {
  assert.deepEqual(describeDetectedLanguage("en-US", "auto", 482), {
    label: "Tiếng Anh (Mỹ)",
    detail: "Tự nhận diện sau 482 ms",
    detected: true,
  });
  assert.deepEqual(describeDetectedLanguage(null, "auto", null), {
    label: "Đang nhận diện…",
    detail: "Cần một đoạn lời nói rõ",
    detected: false,
  });
  assert.deepEqual(describeDetectedLanguage(null, "ja-JP", null), {
    label: "Tiếng Nhật",
    detail: "Ngôn ngữ nguồn đã chọn",
    detected: false,
  });
});

test("latency status is honest about missing samples and warns past realtime target", () => {
  assert.deepEqual(describeLatency(null), { label: "—", tone: "idle", detail: "Chưa có caption" });
  assert.deepEqual(describeLatency(812), { label: "812 ms", tone: "good", detail: "Trong mục tiêu realtime" });
  assert.deepEqual(describeLatency(1450), { label: "1,45 s", tone: "warning", detail: "Chậm hơn mục tiêu 1 giây" });
});

test("runtime diagnostics normalize only bounded numeric latency summaries and usage", () => {
  const diagnostics = normalizeRuntimeDiagnostics({
    metrics: {
      providerPrepareMs: { latest: 440, p50: 410, p95: 520, count: 9 },
      firstReadableMs: { latest: 780, p50: 720, p95: 980, count: 6 },
      transcript: { latest: 1, p50: 1, p95: 1, count: 1 },
    },
    usage: {
      promptTokenCount: 120,
      responseTokenCount: 30,
      totalTokenCount: 150,
      audio: "private",
      text: "private",
    },
  });

  assert.deepEqual(diagnostics.metrics.providerPrepareMs, {
    latest: 440,
    p50: 410,
    p95: 520,
    count: 9,
  });
  assert.deepEqual(diagnostics.metrics.firstReadableMs, {
    latest: 780,
    p50: 720,
    p95: 980,
    count: 6,
  });
  assert.deepEqual(diagnostics.usage, {
    promptTokenCount: 120,
    responseTokenCount: 30,
    totalTokenCount: 150,
  });
  assert.doesNotMatch(JSON.stringify(diagnostics), /private|transcript|audio|text/i);
});

test("runtime metric rows distinguish missing, warming and observed session samples", () => {
  const rows = describeRuntimeMetrics({
    metrics: {
      liveEdgeToPartialMs: { latest: 812, p50: 760, p95: 1_040, count: 1 },
      firstReadableMs: { latest: 690, p50: 720, p95: 980, count: 6 },
    },
  });

  assert.deepEqual(rows.map((row) => row.key), [
    "providerPrepareMs",
    "localQueueMs",
    "liveEdgeToPartialMs",
    "partialToFinalMs",
    "resultToRafMs",
    "firstReadableMs",
  ]);
  assert.deepEqual(rows[0], {
    key: "providerPrepareMs",
    label: "Chuẩn bị nhà cung cấp",
    detail: "Từ lúc bắt đầu đến khi nhà cung cấp sẵn sàng",
    latest: "—",
    p50: "—",
    p95: "—",
    count: 0,
    sampleLabel: "Chưa có mẫu",
    state: "empty",
  });
  assert.deepEqual(rows[2], {
    key: "liveEdgeToPartialMs",
    label: "Audio đến phụ đề tạm",
    detail: "Từ biên audio mới nhất đến bản dịch tạm đầu tiên",
    latest: "812 ms",
    p50: "760 ms",
    p95: "1,04 s",
    count: 1,
    sampleLabel: "1 mẫu · chưa đủ để đánh giá phân vị",
    state: "warming",
  });
  assert.equal(rows[5].sampleLabel, "6 mẫu");
  assert.equal(rows[5].state, "observed");
});

test("runtime usage rows expose only named numeric token counters", () => {
  const rows = describeRuntimeUsage({
    usage: {
      promptTokenCount: 1_200,
      responseTokenCount: 300,
      totalTokenCount: 1_500,
      transcript: "must-not-cross",
      apiKey: "must-not-cross",
    },
  });

  assert.deepEqual(rows, [
    { key: "promptTokenCount", label: "Token đầu vào", value: 1_200, displayValue: "1.200" },
    { key: "responseTokenCount", label: "Token đầu ra", value: 300, displayValue: "300" },
    { key: "totalTokenCount", label: "Tổng token", value: 1_500, displayValue: "1.500" },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /must-not-cross|transcript|apiKey/i);
});
