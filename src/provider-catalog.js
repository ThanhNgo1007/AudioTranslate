const CHECKED_AT = "2026-08-24";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const PROVIDERS = deepFreeze({
  demo: {
    id: "demo",
    label: "Demo / xem thử",
    status: "runnable",
    runnable: true,
    realTranslation: false,
    category: "local-demo",
    checkedAt: CHECKED_AT,
    cost: {
      kind: "no-api-charge",
      summary: "Không dùng API và không phát sinh phí provider.",
    },
    privacy: {
      dataLeavesDevice: false,
      destinations: [],
      summary: "Audio không rời thiết bị; caption là nội dung mô phỏng, không phải bản dịch thật.",
    },
    remediation:
      "Dùng `audiotranslate preview` để xem overlay; chọn Gemini hoặc Azure nếu cần dịch audio thật.",
  },
  azure: {
    id: "azure",
    label: "Azure Speech Translation",
    status: "runnable",
    runnable: true,
    realTranslation: true,
    category: "cloud-direct",
    checkedAt: CHECKED_AT,
    cost: {
      kind: "free-quota-or-paid",
      summary:
        "Tier F0 hiện có 5 giờ audio/tháng và 1 request đồng thời; hết quota F0 có thể bị chặn, còn chuyển sang S0 là trả phí.",
    },
    privacy: {
      dataLeavesDevice: true,
      destinations: ["Microsoft Azure Speech"],
      summary: "PCM audio được gửi tới Azure Speech để nhận dạng và dịch trực tiếp.",
    },
    remediation:
      "Tạo Azure Speech resource đúng tier, rồi cấu hình AZURE_SPEECH_KEY và AZURE_SPEECH_REGION.",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini API",
    status: "runnable",
    runnable: true,
    realTranslation: true,
    category: "cloud-direct",
    checkedAt: CHECKED_AT,
    cost: {
      kind: "provider-free-tier-or-paid",
      summary:
        "Gemini Live Translate hiện có Free Tier theo quota; Paid Tier niêm yết xấp xỉ 0,0368 USD/phút audio. Free Tier có thể dùng dữ liệu để cải thiện sản phẩm; Paid Tier thì không.",
    },
    privacy: {
      dataLeavesDevice: true,
      destinations: ["Google Gemini API"],
      summary:
        "Chỉ audio từ tab hoặc file mà người dùng chủ động bắt đầu mới được gửi tới Google; API key chỉ ở main process và không đi vào extension/renderer.",
    },
    remediation:
      "Mở Control Center, lưu Gemini API key vào kho mã hóa, xác nhận đường dữ liệu cloud và kiểm tra kết nối trước khi dịch.",
  },
  openai: {
    id: "openai",
    label: "OpenAI API",
    status: "in-development",
    runnable: false,
    realTranslation: false,
    category: "cloud-planned",
    checkedAt: CHECKED_AT,
    cost: {
      kind: "paid-api",
      summary:
        "gpt-realtime-translate hiện niêm yết 0,034 USD/phút (~2,04 USD/giờ), không có free tier; gói ChatGPT không bao gồm API usage.",
    },
    privacy: {
      dataLeavesDevice: true,
      destinations: ["OpenAI API"],
      summary:
        "Nếu được tích hợp, audio hoặc transcript sẽ rời thiết bị tới OpenAI; text-MT module hiện chưa phải adapter audio realtime.",
    },
    remediation:
      "Cần nối và benchmark adapter Realtime Translation hoặc một ASR streaming + OpenAI text MT, rồi thêm consent, config, factory và doctor.",
  },
  together: {
    id: "together",
    label: "Together Realtime ASR + text MT",
    status: "in-development",
    runnable: false,
    realTranslation: false,
    category: "cloud-cascade",
    checkedAt: CHECKED_AT,
    cost: {
      kind: "paid-api",
      summary:
        "Together không có free trial, là prepaid tối thiểu 5 USD; Streaming Whisper khoảng 0,0035 USD/phút (~0,21 USD/giờ), còn MT tính riêng.",
    },
    privacy: {
      dataLeavesDevice: true,
      destinations: ["Together AI", "Configured text MT provider"],
      summary:
        "Khi bật, audio sẽ tới Together và transcript có thể tới một MT endpoint thứ hai; runtime hiện vẫn khóa module này.",
    },
    remediation:
      "Chốt Together model và MT endpoint, xin consent cho cả hai đích dữ liệu, nối config/factory/doctor và chạy E2E bằng key thật.",
  },
  local: {
    id: "local",
    label: "Local / offline",
    status: "in-development",
    runnable: false,
    realTranslation: false,
    category: "local-planned",
    checkedAt: CHECKED_AT,
    cost: {
      kind: "local-compute",
      summary:
        "Không có phí API, nhưng cần tài nguyên CPU/GPU, RAM, dung lượng model và điện năng trên máy người dùng.",
    },
    privacy: {
      dataLeavesDevice: false,
      destinations: [],
      summary: "Mục tiêu là xử lý hoàn toàn trên máy; engine local chưa được đóng gói trong bản hiện tại.",
    },
    remediation:
      "Đóng gói ASR streaming local và MT local, kiểm tra license/model, rồi benchmark latency và accuracy đa nền tảng.",
  },
});

function getProvider(id) {
  const normalized = String(id || "").trim().toLowerCase();
  const provider = PROVIDERS[normalized];
  if (!provider) throw new Error(`Unsupported provider catalog entry: ${normalized || id}`);
  return provider;
}

function listProviders(options = {}) {
  const providers = Object.values(PROVIDERS);
  if (options.runnableOnly === true) return providers.filter((provider) => provider.runnable);
  if (options.status) return providers.filter((provider) => provider.status === options.status);
  return [...providers];
}

function renderProviderCatalog(options = {}) {
  const providers = listProviders(options);
  if (options.json === true || options.format === "json") {
    return `${JSON.stringify(providers, null, 2)}\n`;
  }

  const lines = [
    `AudioTranslate providers (kiểm tra ${CHECKED_AT})`,
    "Chỉ RUNNABLE mới có thể dùng với lệnh start. BYOK không đồng nghĩa miễn phí.",
    "",
  ];
  for (const provider of providers) {
    const status = provider.runnable ? "RUNNABLE" : "IN DEVELOPMENT — DISABLED";
    lines.push(`${provider.id} — ${provider.label} [${status}]`);
    lines.push(`  Chi phí: ${provider.cost.summary}`);
    lines.push(`  Riêng tư: ${provider.privacy.summary}`);
    lines.push(`  Tiếp theo: ${provider.remediation}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

module.exports = {
  PROVIDERS,
  getProvider,
  listProviders,
  renderProviderCatalog,
};
