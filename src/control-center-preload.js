const { contextBridge, ipcRenderer } = require("electron");

let fileSessionId = null;

ipcRenderer.on("control:file-source-invalidated", () => {
  fileSessionId = null;
});

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("audioTranslateControl", {
  getSnapshot: () => ipcRenderer.invoke("control:get-snapshot"),
  updateSettings: (patch) => ipcRenderer.invoke("control:update-settings", patch),
  saveSecret: (provider, candidate) =>
    ipcRenderer.invoke("control:save-secret", { provider, candidate }),
  deleteSecret: (provider) => ipcRenderer.invoke("control:delete-secret", { provider }),
  testProvider: (provider) => ipcRenderer.invoke("control:test-provider", { provider }),
  setProvider: (provider) => ipcRenderer.invoke("control:set-provider", { provider }),
  async copyPairingToken() {
    const result = await ipcRenderer.invoke("control:copy-pairing-token");
    return { copied: result?.copied === true };
  },
  startRuntime: () => ipcRenderer.invoke("control:start-runtime"),
  stopRuntime: () => ipcRenderer.invoke("control:stop-runtime"),
  setRuntimePaused: (paused) =>
    ipcRenderer.invoke("control:set-runtime-paused", { paused: paused === true }),
  runDiagnostics: () => ipcRenderer.invoke("control:run-diagnostics"),
  async exportRuntimeReport() {
    const result = await ipcRenderer.invoke("control:export-runtime-report");
    const outcome = ["saved", "cancelled", "failed"].includes(result?.outcome)
      ? result.outcome
      : "failed";
    return { outcome };
  },
  hideControlCenter: () => ipcRenderer.invoke("control:hide"),
  toggleOverlay: () => ipcRenderer.invoke("control:toggle-overlay"),
  requestQuit: (confirmActive = false) =>
    ipcRenderer.invoke("control:request-quit", { confirmActive: confirmActive === true }),
  setOverlayLocked: (locked) =>
    ipcRenderer.invoke("control:set-overlay-locked", { locked }),
  resetOverlay: () => ipcRenderer.invoke("control:reset-overlay"),
  async startFileSource(metadata) {
    if (fileSessionId) throw new Error("A file audio session is already active");
    const result = await ipcRenderer.invoke("control:start-file-source", metadata);
    if (typeof result?.sessionId !== "string" || !result.sessionId) {
      throw new Error("Main process did not create a file audio session");
    }
    fileSessionId = result.sessionId;
    return result?.snapshot || result;
  },
  pushFileAudio(pcm, timing) {
    if (!(pcm instanceof ArrayBuffer) || pcm.byteLength === 0 || pcm.byteLength > 6_400) {
      return false;
    }
    if (!fileSessionId) return false;
    if (!Number.isSafeInteger(timing?.sequence) || timing.sequence < 0) return false;
    ipcRenderer.send("control:file-audio", {
      sessionId: fileSessionId,
      sequence: timing?.sequence,
      pcm,
    });
    return true;
  },
  async stopFileSource() {
    const sessionId = fileSessionId;
    fileSessionId = null;
    if (!sessionId) return ipcRenderer.invoke("control:get-snapshot");
    const result = await ipcRenderer.invoke("control:stop-file-source", { sessionId });
    return result?.snapshot || result;
  },
  onSnapshot: (callback) => subscribe("control:snapshot", callback),
  onRuntimeStatus: (callback) => subscribe("control:runtime-status", callback),
  onCaption: (callback) => subscribe("control:caption", callback),
  onTelemetry: (callback) => subscribe("control:telemetry", callback),
  onLanguageDetected: (callback) => subscribe("control:language-detected", callback),
  onFileSourceInvalidated: (callback) => subscribe("control:file-source-invalidated", callback),
});
