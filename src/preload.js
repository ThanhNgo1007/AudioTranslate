const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("audioTranslate", {
  onCaption(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("overlay:caption", listener);
    return () => ipcRenderer.removeListener("overlay:caption", listener);
  },
  onStatus(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("overlay:status", listener);
    return () => ipcRenderer.removeListener("overlay:status", listener);
  },
  onInteraction(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("overlay:interaction", listener);
    return () => ipcRenderer.removeListener("overlay:interaction", listener);
  },
  onPreferences(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("overlay:preferences", listener);
    return () => ipcRenderer.removeListener("overlay:preferences", listener);
  },
  setLocked(locked) {
    return ipcRenderer.invoke("overlay:set-locked", { locked });
  },
  applyPreset(preset) {
    return ipcRenderer.invoke("overlay:apply-preset", { preset });
  },
  nudge(delta) {
    return ipcRenderer.invoke("overlay:nudge", delta);
  },
  openControlCenter() {
    return ipcRenderer.invoke("overlay:open-control-center");
  },
  reportRendered(metrics) {
    ipcRenderer.send("overlay:rendered", metrics);
  },
});
