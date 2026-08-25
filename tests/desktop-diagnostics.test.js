const assert = require("node:assert/strict");
const test = require("node:test");

const { collectDesktopDiagnostics } = require("../src/desktop-diagnostics");

test("desktop diagnostics maps doctor failures to stable categories, severity, and actions", async () => {
  const report = await collectDesktopDiagnostics(
    {
      provider: { active: "gemini", keyConfigured: true, connected: true },
      storage: { storage: "encrypted" },
      pairing: { configured: true, storage: "encrypted" },
    },
    {
      now: () => new Date("2026-08-24T05:06:07.000Z"),
      collectChecks: async () => [
        { name: "Node.js >=22.12", ok: true, required: true },
        { name: "Google Gen AI SDK", ok: false, required: true },
        { name: "Loopback port 43765", ok: false, required: true },
      ],
    },
  );

  assert.equal(report.version, 1);
  assert.equal(report.checkedAt, "2026-08-24T05:06:07.000Z");
  assert.equal(report.overall, "blocked");
  assert.equal(report.ok, false);
  assert.deepEqual(report.summary, { passed: 4, warnings: 0, failed: 2 });
  assert.deepEqual(
    report.checks.map(({ id, category, status, severity, actionId }) => ({
      id,
      category,
      status,
      severity,
      actionId,
    })),
    [
      {
        id: "runtime.node",
        category: "runtime",
        status: "pass",
        severity: "info",
        actionId: null,
      },
      {
        id: "dependency.gemini",
        category: "dependency",
        status: "fail",
        severity: "error",
        actionId: "install-dependencies",
      },
      {
        id: "port.loopback",
        category: "port",
        status: "fail",
        severity: "error",
        actionId: "retry-diagnostics",
      },
      {
        id: "provider.gemini",
        category: "provider",
        status: "pass",
        severity: "info",
        actionId: null,
      },
      {
        id: "storage.secrets",
        category: "storage",
        status: "pass",
        severity: "info",
        actionId: null,
      },
      {
        id: "pairing.token",
        category: "pairing",
        status: "pass",
        severity: "info",
        actionId: null,
      },
    ],
  );
});

test("desktop diagnostics keeps doctor action mapping deterministic across all supported check groups", async () => {
  const report = await collectDesktopDiagnostics({}, {
    collectChecks: async () => [
      { name: "Electron dependency", ok: false, required: true },
      { name: "WebSocket dependency", ok: true, required: true },
      { name: "Azure Speech SDK", ok: false, required: false },
      { name: "Chromium extension", ok: false, required: true },
      { name: "Gemini credentials", ok: false, required: true },
      { name: "Cloud consent", ok: false, required: true },
      { name: "Gemini cloud usage", ok: false, required: false },
      { name: "Pairing token", ok: false, required: true },
    ],
  });

  assert.deepEqual(
    report.checks.map(({ id, category, status, actionId }) => ({ id, category, status, actionId })),
    [
      { id: "dependency.electron", category: "dependency", status: "fail", actionId: "install-dependencies" },
      { id: "dependency.websocket", category: "dependency", status: "pass", actionId: null },
      { id: "dependency.azure", category: "dependency", status: "warning", actionId: "install-dependencies" },
      { id: "extension.package", category: "extension", status: "fail", actionId: "open-extension-setup" },
      { id: "provider.credentials", category: "provider", status: "fail", actionId: "open-provider-settings" },
      { id: "provider.consent", category: "provider", status: "fail", actionId: "open-privacy-settings" },
      { id: "provider.cloud-usage", category: "provider", status: "warning", actionId: "open-privacy-settings" },
      { id: "pairing.token", category: "pairing", status: "fail", actionId: "open-extension-setup" },
    ],
  );
});

test("desktop diagnostics distinguishes usable session storage, provider verification, and extension presence", async () => {
  const report = await collectDesktopDiagnostics(
    {
      provider: { active: "gemini", keyConfigured: true, connected: false },
      storage: { storage: "session-only", backend: "basic_text" },
      pairing: { configured: true, storage: "session-only" },
      extension: { connected: false },
    },
    {
      collectChecks: async () => [{ name: "Node.js >=22.12", ok: true, required: true }],
    },
  );

  assert.deepEqual(
    report.checks.slice(1).map(({ id, status, actionId }) => ({ id, status, actionId })),
    [
      { id: "provider.gemini", status: "fail", actionId: "test-provider" },
      { id: "storage.secrets", status: "warning", actionId: "open-provider-settings" },
      { id: "pairing.token", status: "pass", actionId: null },
      { id: "extension.connection", status: "warning", actionId: "open-extension-setup" },
    ],
  );
  assert.equal(report.overall, "blocked");
});

test("desktop diagnostics converts internal failures to a sanitized report", async () => {
  const apiKey = "AIza-secret-that-must-never-leave-main";
  const token = "pairing-token-that-must-never-leave-main";
  const privatePath = "/Users/example/private/AudioTranslate/.env";
  const report = await collectDesktopDiagnostics({}, {
    collectChecks: async () => {
      throw new Error(`${apiKey} ${token} ${privatePath}`);
    },
  });

  assert.equal(report.overall, "blocked");
  assert.deepEqual(report.summary, { passed: 0, warnings: 0, failed: 1 });
  assert.deepEqual(report.checks, [
    {
      id: "runtime.diagnostics-failed",
      category: "runtime",
      label: "Kiểm tra hệ thống",
      status: "fail",
      severity: "error",
      detail: "Không thể hoàn tất kiểm tra hệ thống.",
      remediation: "Thử kiểm tra lại. Nếu lỗi tiếp diễn, khởi động lại AudioTranslate.",
      actionId: "retry-diagnostics",
    },
  ]);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, new RegExp(apiKey));
  assert.doesNotMatch(serialized, new RegExp(token));
  assert.doesNotMatch(serialized, new RegExp(privatePath.replaceAll("/", "\\/")));
});

test("desktop diagnostics returns a bounded timeout report when a check stalls", async () => {
  const startedAt = Date.now();
  const report = await collectDesktopDiagnostics({}, {
    timeoutMs: 10,
    collectChecks: () => new Promise((resolve) => setTimeout(() => resolve([]), 150)),
  });

  assert.ok(Date.now() - startedAt < 100, "diagnostics must not wait for the stalled collector");
  assert.equal(report.overall, "blocked");
  assert.equal(report.checks[0].id, "runtime.diagnostics-timeout");
  assert.equal(report.checks[0].actionId, "retry-diagnostics");
});

test("desktop diagnostics honors AbortSignal without exposing the abort reason", async () => {
  const controller = new AbortController();
  const privateReason = "cancel because token=private-pairing-token";
  controller.abort(new Error(privateReason));
  const startedAt = Date.now();
  const report = await collectDesktopDiagnostics({}, {
    signal: controller.signal,
    timeoutMs: 500,
    collectChecks: () => new Promise((resolve) => setTimeout(() => resolve([]), 150)),
  });

  assert.ok(Date.now() - startedAt < 100, "an aborted request must return immediately");
  assert.equal(report.overall, "blocked");
  assert.equal(report.checks[0].id, "runtime.diagnostics-cancelled");
  assert.doesNotMatch(JSON.stringify(report), new RegExp(privateReason));
});

test("desktop diagnostics blocks an unsupported desktop provider instead of treating it as Demo", async () => {
  const report = await collectDesktopDiagnostics(
    { provider: { active: "openai", keyConfigured: true, connected: true } },
    { collectChecks: async () => [] },
  );

  assert.deepEqual(report.checks, [
    {
      id: "provider.unsupported",
      category: "provider",
      label: "Provider chưa được hỗ trợ",
      status: "fail",
      severity: "error",
      detail: "Provider đã chọn chưa thể chạy trong Control Center.",
      remediation: "Chọn Demo hoặc Gemini trong phần Provider.",
      actionId: "open-provider-settings",
    },
  ]);
  assert.equal(report.overall, "blocked");
});

test("desktop diagnostics treats an occupied loopback port as healthy when the desktop gateway owns it", async () => {
  const report = await collectDesktopDiagnostics(
    { runtime: { gatewayRunning: true } },
    {
      collectChecks: async () => [
        { name: "Loopback port 43765", ok: false, required: true },
      ],
    },
  );

  assert.deepEqual(report.checks[0], {
    id: "port.loopback",
    category: "port",
    label: "Cổng kết nối nội bộ",
    status: "pass",
    severity: "info",
    detail: "Cổng đang được AudioTranslate sử dụng an toàn.",
    remediation: null,
    actionId: null,
  });
  assert.equal(report.overall, "healthy");
});

test("desktop diagnostics reports missing Gemini cloud consent as a blocking provider action", async () => {
  const report = await collectDesktopDiagnostics(
    {
      provider: { active: "gemini", keyConfigured: true, connected: true },
      privacy: { cloudConsent: false },
    },
    { collectChecks: async () => [] },
  );

  assert.deepEqual(
    report.checks.map(({ id, status, actionId }) => ({ id, status, actionId })),
    [
      { id: "provider.gemini", status: "pass", actionId: null },
      { id: "provider.consent", status: "fail", actionId: "open-privacy-settings" },
    ],
  );
  assert.equal(report.overall, "blocked");
});

test("desktop runtime state replaces non-actionable desktop doctor placeholders without duplicates", async () => {
  const report = await collectDesktopDiagnostics(
    {
      provider: { active: "gemini", keyConfigured: false, connected: false },
      privacy: { cloudConsent: false },
      pairing: { configured: false, storage: "unavailable" },
    },
    {
      collectChecks: async () => [
        { name: "Gemini credentials", ok: true, required: false },
        { name: "Cloud consent", ok: true, required: false },
        { name: "Pairing token", ok: true, required: false },
      ],
    },
  );

  assert.deepEqual(
    report.checks.map(({ id, status }) => ({ id, status })),
    [
      { id: "provider.gemini", status: "fail" },
      { id: "provider.consent", status: "fail" },
      { id: "pairing.token", status: "fail" },
    ],
  );
});
