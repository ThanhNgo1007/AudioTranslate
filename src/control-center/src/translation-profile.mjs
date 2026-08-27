const profiles = Object.freeze({
  fastest: Object.freeze({
    id: "fastest",
    label: "Độ trễ thấp nhất",
    badge: "Nhanh nhất",
    summary: "Live Translate dịch trực tiếp audio → phụ đề, không thêm bước dịch văn bản.",
    contextual: false,
    partialTranslation: true,
  }),
  balanced: Object.freeze({
    id: "balanced",
    label: "Cân bằng",
    badge: "Khuyên dùng",
    summary: "Live Transcribe + Flash-Lite thêm một bước dịch văn bản để hiểu ngữ cảnh tốt hơn.",
    contextual: true,
    partialTranslation: true,
  }),
  accurate: Object.freeze({
    id: "accurate",
    label: "Ưu tiên chính xác",
    badge: "Câu hoàn chỉnh",
    summary: "Chờ câu hoàn chỉnh rồi mới dịch để ưu tiên văn phong, giới tính và ngữ cảnh.",
    contextual: true,
    partialTranslation: false,
  }),
});

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function boundedText(value, maximum = 4_000) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, maximum);
}

function boundedModel(value, fallback) {
  const model = boundedText(value, 200).trim();
  return model || fallback;
}

export function describeTranslationProfile(value) {
  const key = String(value || "").trim().toLowerCase();
  return profiles[key] || profiles.balanced;
}

export function normalizeTranslationSettings(value = {}) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    mode: describeTranslationProfile(candidate.mode).id,
    transcriptionModel: boundedModel(
      candidate.transcriptionModel,
      "gemini-3.5-transcribe-live",
    ),
    textModel: boundedModel(candidate.textModel, "gemini-3.5-flash-lite"),
    contextTurns: boundedInteger(candidate.contextTurns, 4, 0, 6),
    partialThrottleMs: boundedInteger(candidate.partialThrottleMs, 450, 250, 2_000),
    glossary: boundedText(candidate.glossary),
    characterContext: boundedText(candidate.characterContext),
  };
}
