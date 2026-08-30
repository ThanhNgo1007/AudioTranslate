const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function loadPreload() {
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invocations = [];
  ipcRenderer.sent = [];
  ipcRenderer.invoke = async (channel, payload) => {
    ipcRenderer.invocations.push({ channel, payload });
    if (channel === "control:start-file-source") {
      return { sessionId: "main-only-session-id", snapshot: { ready: true } };
    }
    if (channel === "control:stop-file-source") return { snapshot: { ready: false } };
    if (channel === "control:copy-pairing-token") {
      return { copied: true, token: "pairing-secret-must-not-cross-preload" };
    }
    if (channel === "control:export-runtime-report") {
      return { outcome: "saved", filePath: "/private/runtime-report.json" };
    }
    return { ok: true };
  };
  ipcRenderer.send = (channel, payload) => ipcRenderer.sent.push({ channel, payload });
  ipcRenderer.removeListener = EventEmitter.prototype.removeListener.bind(ipcRenderer);
  const exposed = {};
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposed[name] = value;
      },
    },
    ipcRenderer,
  };

  const preloadPath = path.join(__dirname, "..", "src", "control-center-preload.js");
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron" && parent?.filename === preloadPath) return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(preloadPath)];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
  return { api: exposed.audioTranslateControl, ipcRenderer };
}

test("control preload keeps the file session id private and invalidates it on main reset", async () => {
  const { api, ipcRenderer } = loadPreload();
  const response = await api.startFileSource({ displayName: "movie.mp4" });
  assert.deepEqual(response, { ready: true });
  assert.doesNotMatch(JSON.stringify(response), /main-only-session-id/);

  const pcm = new ArrayBuffer(3_200);
  assert.equal(api.pushFileAudio(pcm, { sequence: 0, capturedAt: Date.now() }), true);
  assert.equal(ipcRenderer.sent[0].payload.sessionId, "main-only-session-id");
  ipcRenderer.emit("control:file-source-invalidated", {}, { reason: "runtime-reset" });
  assert.equal(api.pushFileAudio(new ArrayBuffer(3_200), { sequence: 1 }), false);
});

test("control preload notifies the renderer so invalidation stops file decode and playback", () => {
  const { api, ipcRenderer } = loadPreload();
  const reasons = [];
  const unsubscribe = api.onFileSourceInvalidated((payload) => reasons.push(payload.reason));

  ipcRenderer.emit("control:file-source-invalidated", {}, { reason: "consent-changed" });
  unsubscribe();
  ipcRenderer.emit("control:file-source-invalidated", {}, { reason: "after-unsubscribe" });

  assert.deepEqual(reasons, ["consent-changed"]);
});

test("control preload validates PCM bounds and sequence before crossing IPC", async () => {
  const { api, ipcRenderer } = loadPreload();
  await api.startFileSource({ displayName: "movie.mp4" });
  assert.equal(api.pushFileAudio(new ArrayBuffer(0), { sequence: 0 }), false);
  assert.equal(api.pushFileAudio(new ArrayBuffer(6_402), { sequence: 0 }), false);
  assert.equal(api.pushFileAudio(new ArrayBuffer(3_200), { sequence: -1 }), false);
  assert.equal(api.pushFileAudio(new ArrayBuffer(3_200), { sequence: 0.5 }), false);
  assert.equal(ipcRenderer.sent.length, 0);
});

test("control preload prevents overlapping file sessions and clears ownership before stop", async () => {
  const { api, ipcRenderer } = loadPreload();
  await api.startFileSource({ displayName: "movie.mp4" });
  await assert.rejects(
    api.startFileSource({ displayName: "other.mp4" }),
    /already active/,
  );
  const snapshot = await api.stopFileSource();
  assert.deepEqual(snapshot, { ready: false });
  assert.equal(api.pushFileAudio(new ArrayBuffer(3_200), { sequence: 0 }), false);
  const stop = ipcRenderer.invocations.find((entry) => entry.channel === "control:stop-file-source");
  assert.deepEqual(stop.payload, { sessionId: "main-only-session-id" });
});

test("control preload exposes explicit desktop lifecycle actions without returning pairing material", async () => {
  const { api, ipcRenderer } = loadPreload();

  await api.setProvider("demo");
  const copied = await api.copyPairingToken();
  await api.hideControlCenter();
  await api.toggleOverlay();
  await api.requestQuit(false);
  await api.requestQuit(true);

  assert.deepEqual(
    ipcRenderer.invocations.slice(-6),
    [
      { channel: "control:set-provider", payload: { provider: "demo" } },
      { channel: "control:copy-pairing-token", payload: undefined },
      { channel: "control:hide", payload: undefined },
      { channel: "control:toggle-overlay", payload: undefined },
      { channel: "control:request-quit", payload: { confirmActive: false } },
      { channel: "control:request-quit", payload: { confirmActive: true } },
    ],
  );
  assert.equal(JSON.stringify(ipcRenderer.invocations).includes("pairing-secret"), false);
  assert.deepEqual(copied, { copied: true });
  assert.doesNotMatch(JSON.stringify(copied), /pairing-secret/);
});

test("control preload exposes one boolean pause action and sanitized telemetry subscription", async () => {
  const { api, ipcRenderer } = loadPreload();
  const updates = [];
  const unsubscribe = api.onTelemetry((telemetry) => updates.push(telemetry));

  await api.setRuntimePaused(true);
  await api.setRuntimePaused(false);
  ipcRenderer.emit("control:telemetry", {}, {
    rms: 0.2,
    peak: 0.6,
    speech: true,
    silenceMs: 0,
    packetGapCount: 1,
    droppedFrames: 2,
    queueMs: 15,
    updatedAt: 1_000,
  });
  unsubscribe();
  ipcRenderer.emit("control:telemetry", {}, { rms: 0.9 });

  assert.deepEqual(ipcRenderer.invocations.slice(-2), [
    { channel: "control:set-runtime-paused", payload: { paused: true } },
    { channel: "control:set-runtime-paused", payload: { paused: false } },
  ]);
  assert.deepEqual(updates, [{
    rms: 0.2,
    peak: 0.6,
    speech: true,
    silenceMs: 0,
    packetGapCount: 1,
    droppedFrames: 2,
    queueMs: 15,
    updatedAt: 1_000,
  }]);
});

test("control preload requests diagnostics without renderer-supplied runtime or secret context", async () => {
  const { api, ipcRenderer } = loadPreload();
  await api.runDiagnostics();
  assert.deepEqual(ipcRenderer.invocations.at(-1), {
    channel: "control:run-diagnostics",
    payload: undefined,
  });
});

test("control preload exports a main-owned report without payload or returned path", async () => {
  const { api, ipcRenderer } = loadPreload();
  const result = await api.exportRuntimeReport();

  assert.deepEqual(ipcRenderer.invocations.at(-1), {
    channel: "control:export-runtime-report",
    payload: undefined,
  });
  assert.deepEqual(result, { outcome: "saved" });
  assert.doesNotMatch(JSON.stringify(result), /private|path|runtime-report\.json/i);
});

test("control preload surfaces provider language detection as a read-only event", () => {
  const { api, ipcRenderer } = loadPreload();
  const detections = [];
  const unsubscribe = api.onLanguageDetected((event) => detections.push(event));
  ipcRenderer.emit("control:language-detected", {}, {
    language: "ja-JP",
    detectionLatencyMs: 840,
  });
  unsubscribe();
  ipcRenderer.emit("control:language-detected", {}, { language: "en-US" });
  assert.deepEqual(detections, [{ language: "ja-JP", detectionLatencyMs: 840 }]);
});
