import assert from "node:assert/strict";
import test from "node:test";

import {
  diagnosticActionTarget,
  describeDiagnosticsOverall,
  normalizeDiagnosticsReport,
} from "../src/diagnostics-display.mjs";

test("diagnostic reports are allowlisted before reaching React state", () => {
  const normalized = normalizeDiagnosticsReport({
    version: 1,
    checkedAt: "2026-08-24T01:02:03.000Z",
    overall: "blocked",
    ok: false,
    summary: { passed: 2, warnings: 1, failed: 1 },
    apiKey: "must-not-survive",
    checks: [{
      id: "provider.gemini",
      category: "provider",
      label: "Gemini Live Translate",
      status: "fail",
      severity: "error",
      detail: "Provider chưa sẵn sàng.",
      remediation: "Lưu API key.",
      actionId: "open-provider-settings",
      secret: "must-not-survive",
    }],
  });

  assert.deepEqual(normalized, {
    version: 1,
    checkedAt: "2026-08-24T01:02:03.000Z",
    overall: "blocked",
    ok: false,
    summary: { passed: 2, warnings: 1, failed: 1 },
    checks: [{
      id: "provider.gemini",
      category: "provider",
      label: "Gemini Live Translate",
      status: "fail",
      severity: "error",
      detail: "Provider chưa sẵn sàng.",
      remediation: "Lưu API key.",
      actionId: "open-provider-settings",
    }],
  });
  assert.doesNotMatch(JSON.stringify(normalized), /must-not-survive/);
});

test("diagnostics copy and actions remain deterministic", () => {
  assert.deepEqual(describeDiagnosticsOverall("healthy"), {
    label: "Hệ thống sẵn sàng",
    tone: "good",
  });
  assert.deepEqual(describeDiagnosticsOverall("attention"), {
    label: "Cần chú ý",
    tone: "warning",
  });
  assert.equal(diagnosticActionTarget("open-provider-settings"), "providers");
  assert.equal(diagnosticActionTarget("open-privacy-settings"), "privacy");
  assert.equal(diagnosticActionTarget("open-extension-setup"), "translate");
  assert.equal(diagnosticActionTarget("install-dependencies"), null);
});
