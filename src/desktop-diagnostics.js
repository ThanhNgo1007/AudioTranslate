const { collectChecks } = require("./doctor");

const REPORT_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 2_000;

const DOCTOR_RULES = [
  {
    matches: (name) => name === "Node.js >=22.12",
    id: "runtime.node",
    category: "runtime",
    label: "Node.js runtime",
    remediation: "Cài Node.js 24 LTS rồi khởi động lại AudioTranslate.",
    actionId: "install-node",
  },
  {
    matches: (name) => name === "Google Gen AI SDK",
    id: "dependency.gemini",
    category: "dependency",
    label: "Gemini SDK",
    remediation: "Cài lại các dependency của AudioTranslate rồi thử lại.",
    actionId: "install-dependencies",
  },
  {
    matches: (name) => name === "Electron dependency",
    id: "dependency.electron",
    category: "dependency",
    label: "Electron",
    remediation: "Cài lại các dependency của AudioTranslate rồi thử lại.",
    actionId: "install-dependencies",
  },
  {
    matches: (name) => name === "WebSocket dependency",
    id: "dependency.websocket",
    category: "dependency",
    label: "WebSocket",
    remediation: "Cài lại các dependency của AudioTranslate rồi thử lại.",
    actionId: "install-dependencies",
  },
  {
    matches: (name) => name === "Azure Speech SDK",
    id: "dependency.azure",
    category: "dependency",
    label: "Azure Speech SDK",
    remediation: "Cài lại các dependency của AudioTranslate rồi thử lại.",
    actionId: "install-dependencies",
  },
  {
    matches: (name) => name === "Chromium extension",
    id: "extension.package",
    category: "extension",
    label: "Gói extension Chrome/Edge",
    remediation: "Cài hoặc tải lại extension AudioTranslate.",
    actionId: "open-extension-setup",
  },
  {
    matches: (name) => name === "Azure credentials" || name === "Gemini credentials",
    id: "provider.credentials",
    category: "provider",
    label: "Thông tin xác thực provider",
    remediation: "Lưu API key trong phần Provider rồi kiểm tra kết nối.",
    actionId: "open-provider-settings",
  },
  {
    matches: (name) => name === "Cloud consent",
    id: "provider.consent",
    category: "provider",
    label: "Quyền gửi audio tới cloud",
    remediation: "Xem lại luồng dữ liệu và xác nhận quyền riêng tư.",
    actionId: "open-privacy-settings",
  },
  {
    matches: (name) => name.endsWith(" cloud usage"),
    id: "provider.cloud-usage",
    category: "provider",
    label: "Sử dụng provider cloud",
    remediation: "Xem lại quyền riêng tư và giới hạn sử dụng provider.",
    actionId: "open-privacy-settings",
  },
  {
    matches: (name) => name === "Pairing token",
    id: "pairing.token",
    category: "pairing",
    label: "Ghép nối extension",
    remediation: "Mở hướng dẫn extension và ghép nối lại.",
    actionId: "open-extension-setup",
  },
  {
    matches: (name) => name.startsWith("Loopback port "),
    id: "port.loopback",
    category: "port",
    label: "Cổng kết nối nội bộ",
    remediation: "Đóng ứng dụng đang chiếm cổng AudioTranslate rồi kiểm tra lại.",
    actionId: "retry-diagnostics",
  },
];

function outcome(ok, required = true) {
  if (ok) return { status: "pass", severity: "info" };
  return required
    ? { status: "fail", severity: "error" }
    : { status: "warning", severity: "warning" };
}

function mapDoctorCheck(check, index, context = {}) {
  const name = typeof check?.name === "string" ? check.name : "";
  const rule = DOCTOR_RULES.find((candidate) => candidate.matches(name));
  if (rule?.id === "port.loopback" && context?.runtime?.gatewayRunning === true) {
    return {
      id: rule.id,
      category: rule.category,
      label: rule.label,
      status: "pass",
      severity: "info",
      detail: "Cổng đang được AudioTranslate sử dụng an toàn.",
      remediation: null,
      actionId: null,
    };
  }
  const result = outcome(check?.ok === true, check?.required === true);
  if (!rule) {
    return {
      id: `runtime.additional-${index + 1}`,
      category: "runtime",
      label: "Điều kiện hệ thống bổ sung",
      ...result,
      detail: result.status === "pass" ? "Điều kiện đã đáp ứng." : "Điều kiện chưa đáp ứng.",
      remediation: result.status === "pass" ? null : "Kiểm tra lại cài đặt AudioTranslate.",
      actionId: result.status === "pass" ? null : "retry-diagnostics",
    };
  }
  return {
    id: rule.id,
    category: rule.category,
    label: rule.label,
    ...result,
    detail: result.status === "pass" ? "Sẵn sàng." : "Chưa sẵn sàng.",
    remediation: result.status === "pass" ? null : rule.remediation,
    actionId: result.status === "pass" ? null : rule.actionId,
  };
}

function providerDiagnostic(provider = {}) {
  const id = String(provider.active || provider.id || "demo").toLowerCase();
  if (id !== "demo" && id !== "gemini") {
    return {
      id: "provider.unsupported",
      category: "provider",
      label: "Provider chưa được hỗ trợ",
      status: "fail",
      severity: "error",
      detail: "Provider đã chọn chưa thể chạy trong Control Center.",
      remediation: "Chọn Demo hoặc Gemini trong phần Provider.",
      actionId: "open-provider-settings",
    };
  }
  const ready = id === "demo" || (id === "gemini" && provider.keyConfigured === true && provider.connected === true);
  const result = outcome(ready, true);
  const actionId = ready ? null : provider.keyConfigured === true ? "test-provider" : "open-provider-settings";
  return {
    id: `provider.${id === "gemini" ? "gemini" : "demo"}`,
    category: "provider",
    label: id === "gemini" ? "Gemini Live Translate" : "Chế độ Demo",
    ...result,
    detail: ready ? "Provider sẵn sàng." : "Provider chưa được cấu hình và kiểm tra đầy đủ.",
    remediation: ready
      ? null
      : provider.keyConfigured === true
        ? "Kiểm tra kết nối provider trước khi bắt đầu dịch."
        : "Lưu API key và kiểm tra kết nối trong phần Provider.",
    actionId,
  };
}

function storageDiagnostic(storage = {}) {
  const encrypted = storage.storage === "encrypted";
  const sessionOnly = storage.storage === "session-only";
  const result = encrypted
    ? outcome(true, true)
    : sessionOnly
      ? outcome(false, false)
      : outcome(false, true);
  return {
    id: "storage.secrets",
    category: "storage",
    label: "Kho API key",
    ...result,
    detail: encrypted
      ? "API key được lưu bằng kho mã hóa của hệ điều hành."
      : sessionOnly
        ? "API key chỉ được giữ trong phiên hiện tại."
        : "Kho mã hóa chưa sẵn sàng.",
    remediation: encrypted ? null : "Kiểm tra kho thông tin xác thực của hệ điều hành.",
    actionId: encrypted ? null : "open-provider-settings",
  };
}

function extensionDiagnostic(extension = {}) {
  const connected = extension.connected === true;
  const result = connected ? outcome(true, false) : outcome(false, false);
  return {
    id: "extension.connection",
    category: "extension",
    label: "Kết nối tab Chrome/Edge",
    ...result,
    detail: connected ? "Extension đang kết nối." : "Chưa có tab nào kết nối.",
    remediation: connected ? null : "Mở extension trên tab cần dịch và ghép nối nếu được yêu cầu.",
    actionId: connected ? null : "open-extension-setup",
  };
}

function pairingDiagnostic(pairing = {}) {
  const configured = pairing.configured === true;
  const result = outcome(configured, true);
  return {
    id: "pairing.token",
    category: "pairing",
    label: "Ghép nối extension",
    ...result,
    detail: configured ? "Mã ghép nối an toàn đã sẵn sàng." : "Chưa có mã ghép nối hợp lệ.",
    remediation: configured ? null : "Mở hướng dẫn extension và ghép nối lại.",
    actionId: configured ? null : "open-extension-setup",
  };
}

function privacyDiagnostic(privacy = {}) {
  const consented = privacy.cloudConsent === true;
  const result = outcome(consented, true);
  return {
    id: "provider.consent",
    category: "provider",
    label: "Quyền gửi audio tới Gemini",
    ...result,
    detail: consented ? "Quyền gửi audio tới Gemini đã được xác nhận." : "Chưa xác nhận quyền gửi audio tới Gemini.",
    remediation: consented ? null : "Xem lại luồng dữ liệu và xác nhận quyền riêng tư.",
    actionId: consented ? null : "open-privacy-settings",
  };
}

function summarize(checks) {
  const summary = { passed: 0, warnings: 0, failed: 0 };
  for (const check of checks) {
    if (check.status === "pass") summary.passed += 1;
    else if (check.status === "warning") summary.warnings += 1;
    else summary.failed += 1;
  }
  const overall = summary.failed > 0 ? "blocked" : summary.warnings > 0 ? "attention" : "healthy";
  return { summary, overall, ok: overall !== "blocked" };
}

function failedDiagnostic(kind = "failed") {
  if (kind === "timeout") {
    return {
      id: "runtime.diagnostics-timeout",
      category: "runtime",
      label: "Thời gian kiểm tra hệ thống",
      status: "fail",
      severity: "error",
      detail: "Kiểm tra hệ thống mất quá nhiều thời gian.",
      remediation: "Thử kiểm tra lại sau khi đóng ứng dụng có thể đang giữ tài nguyên.",
      actionId: "retry-diagnostics",
    };
  }
  if (kind === "cancelled") {
    return {
      id: "runtime.diagnostics-cancelled",
      category: "runtime",
      label: "Kiểm tra hệ thống",
      status: "fail",
      severity: "error",
      detail: "Kiểm tra hệ thống đã được hủy.",
      remediation: "Chạy kiểm tra lại khi sẵn sàng.",
      actionId: "retry-diagnostics",
    };
  }
  return {
    id: "runtime.diagnostics-failed",
    category: "runtime",
    label: "Kiểm tra hệ thống",
    status: "fail",
    severity: "error",
    detail: "Không thể hoàn tất kiểm tra hệ thống.",
    remediation: "Thử kiểm tra lại. Nếu lỗi tiếp diễn, khởi động lại AudioTranslate.",
    actionId: "retry-diagnostics",
  };
}

function collectWithDeadline(task, options = {}) {
  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(requestedTimeout, 30_000)
    : DEFAULT_TIMEOUT_MS;
  const signal = options.signal;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, { diagnosticFailure: "cancelled" });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    timer = setTimeout(
      () => finish(reject, { diagnosticFailure: "timeout" }),
      timeoutMs,
    );
    Promise.resolve()
      .then(task)
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
  });
}

function dynamicCheckReplacesDoctorPlaceholder(check, context) {
  const name = typeof check?.name === "string" ? check.name : "";
  if (context.provider && (name === "Azure credentials" || name === "Gemini credentials")) {
    return true;
  }
  if (context.privacy && name === "Cloud consent") return true;
  if (context.pairing && name === "Pairing token") return true;
  return false;
}

async function collectDesktopDiagnostics(context = {}, options = {}) {
  const doctorCollector = options.collectChecks || collectChecks;
  const config = {
    provider: context?.provider?.active === "gemini" ? "gemini" : "demo",
    headless: false,
    host: "127.0.0.1",
    port: Number.isInteger(context.port) ? context.port : 43765,
    authToken: "",
    azureSpeechKey: "",
    azureSpeechRegion: "",
    geminiApiKey: "",
    cloudConsent: "",
  };
  let checks;
  try {
    const rawChecks = await collectWithDeadline(
      () => doctorCollector(config, options.doctorOptions || {}),
      options,
    );
    if (!Array.isArray(rawChecks)) throw new TypeError("Invalid diagnostics result");
    checks = rawChecks
      .filter((check) => !dynamicCheckReplacesDoctorPlaceholder(check, context))
      .map((check, index) => mapDoctorCheck(check, index, context));
    if (context.provider) checks.push(providerDiagnostic(context.provider));
    if (
      context.privacy &&
      String(context?.provider?.active || context?.provider?.id || "demo").toLowerCase() === "gemini"
    ) {
      checks.push(privacyDiagnostic(context.privacy));
    }
    if (context.storage) checks.push(storageDiagnostic(context.storage));
    if (context.pairing) checks.push(pairingDiagnostic(context.pairing));
    if (context.extension) checks.push(extensionDiagnostic(context.extension));
  } catch (error) {
    checks = [failedDiagnostic(error?.diagnosticFailure)];
  }
  const result = summarize(checks);
  const now = options.now ? options.now() : new Date();
  return {
    version: REPORT_VERSION,
    checkedAt: now.toISOString(),
    overall: result.overall,
    ok: result.ok,
    summary: result.summary,
    checks,
  };
}

module.exports = { collectDesktopDiagnostics };
