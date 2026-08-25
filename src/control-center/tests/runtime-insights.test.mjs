import assert from "node:assert/strict";
import test from "node:test";

import {
  describeDetectedLanguage,
  describeLatency,
  meterSegments,
  normalizeAudioTelemetry,
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
