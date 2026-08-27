const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "main-app.js"), "utf8");

function functionBody(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

test("inactive desktop replacement closes transport before any new gateway can listen", () => {
  const body = functionBody("replaceGateway", "startRuntime");
  const closedBranch = body.indexOf("shouldOpenDesktopGateway(activate)");
  const constructor = body.indexOf("new RealtimeGateway");
  const previewStop = body.indexOf("stopPreview()");
  assert.ok(closedBranch >= 0, "replaceGateway must explicitly gate listening on activation");
  assert.ok(previewStop >= 0 && previewStop < closedBranch, "closed replacement must stop synthetic preview too");
  assert.ok(constructor > closedBranch, "the closed branch must run before gateway construction");
});

test("main Gemini test uses the isolated probe lifecycle", () => {
  const body = functionBody("testGeminiProvider", "normalizeControlPatch");
  assert.match(body, /runIsolatedProviderProbe\(runtimeIsActive\(\)/);
  assert.doesNotMatch(body, /onStatus:\s*\(status\)\s*=>\s*sendStatus/);
});

test("OS before-quit routes active sessions through native confirmation", () => {
  const start = source.indexOf('app.on("before-quit"');
  assert.notEqual(start, -1);
  const body = source.slice(start);
  assert.match(body, /beforeQuitAction/);
  assert.match(body, /requestQuitWithNativeConfirmation/);
});

test("terminal provider status disarms and closes the desktop gateway", () => {
  const body = functionBody("replaceGateway", "startRuntime");
  assert.match(body, /status\.terminal\s*===\s*true/);
  assert.match(body, /runtimeArmed\s*=\s*false/);
  assert.match(body, /nextGateway\.close/);
});

test("desktop pause and diagnostics IPC stay behind the exact Control Center sender guard", () => {
  const start = source.indexOf("function registerIpc");
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf("function startPreview", start));
  assert.match(
    body,
    /ipcMain\.handle\("control:set-runtime-paused",[\s\S]*?assertControlSender\(event\)[\s\S]*?setRuntimePaused\(payload\?\.paused\)/,
  );
  assert.match(
    body,
    /ipcMain\.handle\("control:run-diagnostics",[\s\S]*?assertControlSender\(event\)[\s\S]*?collectDesktopDiagnostics\(desktopDiagnosticsContext\(\)\)/,
  );
});

test("saved multi-display selection is exposed safely and triggers real overlay repositioning", () => {
  assert.match(source, /listDisplayOptions\(screen\.getAllDisplays\(\), screen\.getPrimaryDisplay\(\)\.id\)/);
  assert.match(source, /resolveOverlayDisplay\(screen\.getAllDisplays\(\), settings\?\.overlay\?\.displayId, fallback\)/);
  assert.match(source, /Object\.hasOwn\(patch\.overlay, "displayId"\)/);
});

test("desktop wiring delegates caption config and ignores removed contextual patches", () => {
  const configBody = functionBody("configFromSettings", "enqueueRuntime");
  assert.match(configBody, /configFromDesktopSettings/);

  const patchBody = functionBody("normalizeControlPatch", "assertControlSender");
  assert.match(patchBody, /isPlainRecord\(patch\.captions\)/);
  assert.match(patchBody, /next\.captions\s*=\s*patch\.captions/);
  assert.doesNotMatch(patchBody, /patch\.translation/);
});

test("desktop startup reports direct Gemini Live Translate only", () => {
  const body = functionBody("startRuntime", "stopRuntime");
  assert.match(body, /Live Translate/);
  assert.doesNotMatch(body, /settings\.translation|Live Transcribe|Flash-Lite/);
});

test("provider snapshot reports only the direct Live Translate model", () => {
  const body = functionBody("controlSnapshot", "publishSnapshot");
  assert.match(body, /geminiModel/);
  assert.doesNotMatch(body, /translationMode|transcriptionModel|textModel|Flash-Lite/);
});

test("desktop aggregates gateway, usage and renderer timing without caption payloads", () => {
  assert.match(source, /new RollingRuntimeMetrics\(\{ maxSamples: 120 \}\)/);
  const gatewayBody = functionBody("replaceGateway", "startRuntime");
  assert.match(gatewayBody, /nextGateway\.on\("metrics"/);
  assert.match(gatewayBody, /nextGateway\.on\("usage"/);
  assert.match(gatewayBody, /runtimeMetrics\.recordUsage/);

  const startBody = functionBody("startRuntime", "stopRuntime");
  assert.match(startBody, /runtimeMetrics\.reset\(\)/);

  const ipcStart = source.indexOf("function registerIpc");
  const ipcBody = source.slice(ipcStart, source.indexOf("function startPreview", ipcStart));
  assert.match(
    ipcBody,
    /ipcMain\.on\("overlay:rendered",[\s\S]*?runtimeMetrics\.record\("resultToRafMs"/,
  );
  assert.doesNotMatch(ipcBody, /runtimeMetrics\.record\([^,]+,\s*metrics\.(?:text|caption|transcript|audio|data|bytes)/i);
});
