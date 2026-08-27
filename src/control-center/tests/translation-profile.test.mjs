import assert from "node:assert/strict";
import test from "node:test";

import {
  describeTranslationProfile,
  normalizeTranslationSettings,
} from "../src/translation-profile.mjs";

test("translation profiles explain their real latency and accuracy trade-offs", () => {
  assert.deepEqual(describeTranslationProfile("fastest"), {
    id: "fastest",
    label: "Độ trễ thấp nhất",
    badge: "Nhanh nhất",
    summary: "Live Translate dịch trực tiếp audio → phụ đề, không thêm bước dịch văn bản.",
    contextual: false,
    partialTranslation: true,
  });
  assert.deepEqual(describeTranslationProfile("balanced"), {
    id: "balanced",
    label: "Cân bằng",
    badge: "Khuyên dùng",
    summary: "Live Transcribe + Flash-Lite thêm một bước dịch văn bản để hiểu ngữ cảnh tốt hơn.",
    contextual: true,
    partialTranslation: true,
  });
  assert.deepEqual(describeTranslationProfile("accurate"), {
    id: "accurate",
    label: "Ưu tiên chính xác",
    badge: "Câu hoàn chỉnh",
    summary: "Chờ câu hoàn chỉnh rồi mới dịch để ưu tiên văn phong, giới tính và ngữ cảnh.",
    contextual: true,
    partialTranslation: false,
  });
});

test("unknown profiles fail safely to balanced and expose contextual controls only when relevant", () => {
  assert.equal(describeTranslationProfile("turbo").id, "balanced");
  assert.equal(describeTranslationProfile(null).contextual, true);
  assert.equal(describeTranslationProfile("fastest").contextual, false);
  assert.equal(describeTranslationProfile("accurate").contextual, true);
});

test("snapshot translation settings are normalized and bounded before entering the UI", () => {
  assert.deepEqual(normalizeTranslationSettings({
    mode: "accurate",
    transcriptionModel: "gemini-transcribe-custom",
    textModel: "gemini-flash-custom",
    contextTurns: 99,
    partialThrottleMs: 20,
    glossary: `hero = anh hùng\u0000${"g".repeat(5_000)}`,
    characterContext: "Alex: woman; older sister of Sam.",
  }), {
    mode: "accurate",
    transcriptionModel: "gemini-transcribe-custom",
    textModel: "gemini-flash-custom",
    contextTurns: 6,
    partialThrottleMs: 250,
    glossary: `hero = anh hùng${"g".repeat(3_985)}`,
    characterContext: "Alex: woman; older sister of Sam.",
  });

  assert.deepEqual(normalizeTranslationSettings({}), {
    mode: "balanced",
    transcriptionModel: "gemini-3.5-transcribe-live",
    textModel: "gemini-3.5-flash-lite",
    contextTurns: 4,
    partialThrottleMs: 450,
    glossary: "",
    characterContext: "",
  });
});
