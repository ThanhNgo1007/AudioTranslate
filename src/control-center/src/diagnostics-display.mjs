const OVERALL = new Set(["healthy", "attention", "blocked"]);
const STATUS = new Set(["pass", "warning", "fail"]);
const SEVERITY = new Set(["info", "warning", "error"]);
const ACTIONS = new Set([
  "install-node",
  "install-dependencies",
  "open-extension-setup",
  "open-provider-settings",
  "open-privacy-settings",
  "retry-diagnostics",
  "test-provider",
]);

function text(value, fallback = "", maximum = 500) {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").slice(0, maximum) || fallback;
}

function counter(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

export function normalizeDiagnosticsReport(value = {}) {
  const report = value && typeof value === "object" ? value : {};
  const summary = report.summary && typeof report.summary === "object" ? report.summary : {};
  const overall = OVERALL.has(report.overall) ? report.overall : "blocked";
  return {
    version: counter(report.version) || 1,
    checkedAt: text(report.checkedAt, new Date(0).toISOString(), 40),
    overall,
    ok: report.ok === true && overall !== "blocked",
    summary: {
      passed: counter(summary.passed),
      warnings: counter(summary.warnings),
      failed: counter(summary.failed),
    },
    checks: Array.isArray(report.checks)
      ? report.checks.slice(0, 50).flatMap((candidate, index) => {
        if (!candidate || typeof candidate !== "object") return [];
        const status = STATUS.has(candidate.status) ? candidate.status : "fail";
        const severity = SEVERITY.has(candidate.severity) ? candidate.severity : "error";
        return [{
          id: text(candidate.id, `runtime.unknown-${index + 1}`, 100),
          category: text(candidate.category, "runtime", 40),
          label: text(candidate.label, "Kiểm tra hệ thống", 120),
          status,
          severity,
          detail: text(candidate.detail, "Không có chi tiết.", 500),
          remediation: candidate.remediation === null
            ? null
            : text(candidate.remediation, "Thử kiểm tra lại.", 500),
          actionId: ACTIONS.has(candidate.actionId) ? candidate.actionId : null,
        }];
      })
      : [],
  };
}

export function describeDiagnosticsOverall(overall) {
  if (overall === "healthy") return { label: "Hệ thống sẵn sàng", tone: "good" };
  if (overall === "attention") return { label: "Cần chú ý", tone: "warning" };
  return { label: "Cần xử lý", tone: "error" };
}

export function diagnosticActionTarget(actionId) {
  if (actionId === "open-provider-settings" || actionId === "test-provider") return "providers";
  if (actionId === "open-privacy-settings") return "privacy";
  if (actionId === "open-extension-setup") return "translate";
  return null;
}
