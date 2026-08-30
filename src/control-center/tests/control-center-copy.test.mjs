import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));

test("disabled Azure card does not redirect Control Center users back to CLI", () => {
  const source = fs.readFileSync(path.join(directory, "..", "src", "FidelityApp.tsx"), "utf8");
  const azureCard = source.match(/<button[^>]+provider-card-wide[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(azureCard, /Chưa tích hợp trong Control Center/);
  assert.doesNotMatch(azureCard, /CLI/i);
});

test("session status owns a visible grid row instead of being clipped below the footer", () => {
  const css = fs.readFileSync(path.join(directory, "..", "src", "styles.css"), "utf8");
  const appShell = css.match(/\.app-shell\s*\{\s*width:\s*100%;[\s\S]*?\}/)?.[0] || "";
  const sessionMessage = css.match(/\.session-message\s*\{[\s\S]*?\}/)?.[0] || "";

  assert.match(appShell, /grid-template-rows:\s*62px 42px 80px minmax\(0, 1fr\) 58px 18px/);
  assert.match(sessionMessage, /position:\s*static/);
  assert.doesNotMatch(sessionMessage, /bottom:/);
});

test("Gemini connection test is disabled for every active or pending runtime", () => {
  const source = fs.readFileSync(path.join(directory, "..", "src", "FidelityApp.tsx"), "utf8");
  const testButton = source.match(/<button[^>]+onClick=\{\(\) => void runAction\("test-key"[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(testButton, /canStopSession/);
});

test("Control Center exposes real runtime insights, pause and advanced overlay controls", () => {
  const source = fs.readFileSync(path.join(directory, "..", "src", "FidelityApp.tsx"), "utf8");
  const transport = fs.readFileSync(path.join(directory, "..", "src", "transport-controls.mjs"), "utf8");
  assert.match(source, /Ngôn ngữ phát hiện/);
  assert.match(transport, /Tạm dừng gửi audio/);
  assert.match(source, /Tùy chỉnh nâng cao/);
  assert.match(source, /Chẩn đoán hệ thống/);
  assert.match(source, /meterSegments\(snapshot\.audio\.rms/);
  assert.doesNotMatch(source, /index < 22/);
});

test("the native bridge preserves the paused runtime state", () => {
  const source = fs.readFileSync(path.join(directory, "..", "src", "bridge.ts"), "utf8");
  assert.match(source, /new Set\(\["idle", "connecting", "listening", "paused", "stopping", "error"\]\)/);
});

test("Control Center shows observed session percentiles and privacy-safe JSON export", () => {
  const source = fs.readFileSync(path.join(directory, "..", "src", "FidelityApp.tsx"), "utf8");
  const bridge = fs.readFileSync(path.join(directory, "..", "src", "bridge.ts"), "utf8");

  assert.match(source, /Hiệu năng phiên/);
  assert.match(source, /Mới nhất/);
  assert.match(source, /p50/);
  assert.match(source, /p95/);
  assert.match(source, /không phải cam kết SLA của Google/);
  assert.match(source, /Xuất báo cáo JSON/);
  assert.match(source, /client\.exportRuntimeReport\(\)/);
  assert.match(bridge, /diagnostics:\s*normalizeRuntimeDiagnostics\(runtime\.diagnostics\)/);
});

test("runtime metrics table keeps sample status readable without a squeezed fifth column", () => {
  const source = fs.readFileSync(path.join(directory, "..", "src", "FidelityApp.tsx"), "utf8");
  const css = fs.readFileSync(path.join(directory, "..", "src", "styles.css"), "utf8");
  const tableRule = css.match(/\.runtime-metrics-table\s*\{[\s\S]*?\}/)?.[0] || "";
  const detailRules = [...css.matchAll(/\.runtime-metrics-table tbody th small\s*\{[\s\S]*?\}/g)];
  const detailRule = detailRules.at(-1)?.[0] || "";

  assert.match(tableRule, /min-width:\s*0/);
  assert.doesNotMatch(tableRule, /min-width:\s*[1-9]\d*px/);
  assert.doesNotMatch(source, /<th scope="col">Mẫu<\/th>/);
  assert.match(source, /<th scope="row">[\s\S]*?runtime-sample-state[\s\S]*?<\/th>/);
  assert.match(tableRule, /font-size:\s*10px/);
  assert.match(detailRule, /color:\s*var\(--f-muted\)/);
  assert.match(detailRule, /font-size:\s*9px/);
});
