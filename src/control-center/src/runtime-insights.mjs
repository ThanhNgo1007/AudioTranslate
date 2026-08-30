const LANGUAGE_LABELS = new Map([
  ["en", "Tiếng Anh"],
  ["en-US", "Tiếng Anh (Mỹ)"],
  ["en-GB", "Tiếng Anh (Anh)"],
  ["vi", "Tiếng Việt"],
  ["vi-VN", "Tiếng Việt"],
  ["ja", "Tiếng Nhật"],
  ["ja-JP", "Tiếng Nhật"],
  ["ko", "Tiếng Hàn"],
  ["ko-KR", "Tiếng Hàn"],
  ["zh", "Tiếng Trung"],
  ["zh-CN", "Tiếng Trung (Giản thể)"],
  ["zh-TW", "Tiếng Trung (Phồn thể)"],
  ["fr", "Tiếng Pháp"],
  ["de", "Tiếng Đức"],
  ["es", "Tiếng Tây Ban Nha"],
]);

function finiteNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function integerCounter(value) {
  return Math.floor(clamp(finiteNumber(value), 0, Number.MAX_SAFE_INTEGER));
}

const RUNTIME_METRIC_FIELDS = [
  "providerPrepareMs",
  "localQueueMs",
  "liveEdgeToPartialMs",
  "partialToFinalMs",
  "resultToRafMs",
  "firstReadableMs",
];

const USAGE_COUNTER_FIELDS = [
  "promptTokenCount",
  "responseTokenCount",
  "totalTokenCount",
  "cachedContentTokenCount",
  "thoughtsTokenCount",
  "toolUsePromptTokenCount",
];

const RUNTIME_METRIC_DEFINITIONS = [
  {
    key: "providerPrepareMs",
    label: "Chuẩn bị nhà cung cấp",
    detail: "Từ lúc bắt đầu đến khi nhà cung cấp sẵn sàng",
  },
  {
    key: "localQueueMs",
    label: "Hàng đợi audio cục bộ",
    detail: "Tuổi của audio khi đi qua gateway trên máy",
  },
  {
    key: "liveEdgeToPartialMs",
    label: "Audio đến phụ đề tạm",
    detail: "Từ biên audio mới nhất đến bản dịch tạm đầu tiên",
  },
  {
    key: "partialToFinalMs",
    label: "Phụ đề tạm đến bản chốt",
    detail: "Thời gian từ bản tạm đầu tiên đến câu hoàn chỉnh",
  },
  {
    key: "resultToRafMs",
    label: "Kết quả đến khi hiển thị",
    detail: "Từ kết quả renderer nhận được đến khung hình kế tiếp",
  },
  {
    key: "firstReadableMs",
    label: "Phụ đề đọc được đầu tiên",
    detail: "Từ lúc bắt đầu phiên đến phụ đề đầu tiên có thể đọc",
  },
];

const USAGE_COUNTER_DEFINITIONS = [
  { key: "promptTokenCount", label: "Token đầu vào" },
  { key: "responseTokenCount", label: "Token đầu ra" },
  { key: "totalTokenCount", label: "Tổng token" },
  { key: "cachedContentTokenCount", label: "Token cache" },
  { key: "thoughtsTokenCount", label: "Token suy luận" },
  { key: "toolUsePromptTokenCount", label: "Token công cụ" },
];

function recordOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalCounter(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(Math.min(Number.MAX_SAFE_INTEGER, value))
    : null;
}

function normalizeMetricSummary(value) {
  const summary = recordOf(value);
  const count = optionalCounter(summary.count) ?? 0;
  if (count === 0) return { latest: null, p50: null, p95: null, count: 0 };
  return {
    latest: optionalCounter(summary.latest),
    p50: optionalCounter(summary.p50),
    p95: optionalCounter(summary.p95),
    count,
  };
}

export function normalizeRuntimeDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = recordOf(value);
  const rawMetrics = recordOf(raw.metrics);
  const rawUsage = recordOf(raw.usage);
  const metrics = Object.fromEntries(
    RUNTIME_METRIC_FIELDS.map((field) => [field, normalizeMetricSummary(rawMetrics[field])]),
  );
  const usage = {};
  for (const field of USAGE_COUNTER_FIELDS) {
    const counter = optionalCounter(rawUsage[field]);
    if (counter !== null) usage[field] = counter;
  }
  return { metrics, usage };
}

function formatMilliseconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  const rounded = Math.round(value);
  if (rounded < 1_000) return `${rounded} ms`;
  return `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(rounded / 1_000)} s`;
}

export function describeRuntimeMetrics(value) {
  const diagnostics = normalizeRuntimeDiagnostics(value) || normalizeRuntimeDiagnostics({});
  return RUNTIME_METRIC_DEFINITIONS.map((definition) => {
    const summary = diagnostics.metrics[definition.key];
    const state = summary.count === 0 ? "empty" : summary.count < 5 ? "warming" : "observed";
    const sampleLabel = summary.count === 0
      ? "Chưa có mẫu"
      : summary.count < 5
        ? `${summary.count} mẫu · chưa đủ để đánh giá phân vị`
        : `${summary.count} mẫu`;
    return {
      ...definition,
      latest: formatMilliseconds(summary.latest),
      p50: formatMilliseconds(summary.p50),
      p95: formatMilliseconds(summary.p95),
      count: summary.count,
      sampleLabel,
      state,
    };
  });
}

export function describeRuntimeUsage(value) {
  const diagnostics = normalizeRuntimeDiagnostics(value);
  if (!diagnostics) return [];
  const numberFormatter = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
  return USAGE_COUNTER_DEFINITIONS.flatMap((definition) => {
    const value = diagnostics.usage[definition.key];
    if (typeof value !== "number") return [];
    return [{
      ...definition,
      value,
      displayValue: numberFormatter.format(value),
    }];
  });
}

export function normalizeAudioTelemetry(value = {}) {
  const record = value && typeof value === "object" ? value : {};
  return {
    rms: clamp(finiteNumber(record.rms), 0, 1),
    peak: clamp(finiteNumber(record.peak), 0, 1),
    speech: record.speech === true,
    silenceMs: integerCounter(record.silenceMs),
    packetGapCount: integerCounter(record.packetGapCount),
    droppedFrames: integerCounter(record.droppedFrames),
    queueMs: record.queueMs === null ? null : integerCounter(record.queueMs),
    updatedAt: integerCounter(record.updatedAt),
  };
}

export function meterSegments(rms, total = 28) {
  const safeTotal = Math.max(1, Math.floor(finiteNumber(total, 28)));
  if (typeof rms !== "number" || !Number.isFinite(rms) || rms <= 0) return 0;
  return Math.min(safeTotal, Math.max(1, Math.ceil(clamp(rms, 0, 1) * safeTotal)));
}

function languageLabel(code) {
  if (!code) return null;
  return LANGUAGE_LABELS.get(code) || LANGUAGE_LABELS.get(String(code).split("-")[0]) || String(code);
}

export function describeDetectedLanguage(detectedLanguage, configuredSource, languageDetectionMs) {
  if (detectedLanguage) {
    const elapsed = integerCounter(languageDetectionMs);
    return {
      label: languageLabel(detectedLanguage),
      detail: languageDetectionMs === null || languageDetectionMs === undefined
        ? "Nguồn được nhận diện tự động"
        : `Tự nhận diện sau ${elapsed} ms`,
      detected: true,
    };
  }
  if (!configuredSource || configuredSource === "auto") {
    return {
      label: "Đang nhận diện…",
      detail: "Cần một đoạn lời nói rõ",
      detected: false,
    };
  }
  return {
    label: languageLabel(configuredSource),
    detail: "Ngôn ngữ nguồn đã chọn",
    detected: false,
  };
}

export function describeLatency(latencyMs) {
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0) {
    return { label: "—", tone: "idle", detail: "Chưa có caption" };
  }
  const rounded = Math.round(latencyMs);
  if (rounded <= 1_000) {
    return { label: `${rounded} ms`, tone: "good", detail: "Trong mục tiêu realtime" };
  }
  return {
    label: `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(rounded / 1_000)} s`,
    tone: "warning",
    detail: "Chậm hơn mục tiêu 1 giây",
  };
}
