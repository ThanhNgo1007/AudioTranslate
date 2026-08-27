const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  Tray,
} = require("electron");
const { getConfig, GEMINI_CLOUD_CONSENT } = require("./config");
const { FileSourceSessionManager, GEMINI_FILE_CONSENT } = require("./audio/file-source-session");
const { FileGatewayClient } = require("./file-gateway-client");
const { RealtimeGateway } = require("./gateway");
const { collectDesktopDiagnostics } = require("./desktop-diagnostics");
const { DesktopRuntimeSignals } = require("./desktop-runtime-signals");
const { RollingRuntimeMetrics, RUNTIME_METRIC_FIELDS } = require("./runtime-metrics");
const { listDisplayOptions, resolveOverlayDisplay } = require("./overlay-display");
const { createProvider } = require("./provider-factory");
const { SecretStore, resolveSecret, resolveSecretStatus } = require("./secret-store");
const { SettingsStore } = require("./settings-store");
const { DEMO_LINES } = require("./providers/demo");
const {
  assertGenericDesktopPatch,
  beforeQuitAction,
  configFromDesktopSettings,
  configureDesktopIdentity,
  controlWindowChromeOptions,
  desktopConfigFromArgs,
  desktopEditMenuTemplate,
  desktopSettingsMigrationPatch,
  ensurePairingToken,
  finalizeOverlayLockChange,
  normalizeDesktopProvider,
  providerStartMode,
  publicPairingStatus,
  quitDecision,
  runIsolatedProviderProbe,
  runtimeStateForStatus,
  shouldOpenDesktopGateway,
  settingsPatchRequiresRuntimeStop,
} = require("./desktop-control-policy");

configureDesktopIdentity(app, path);

const appArgOffset = app.isPackaged ? 1 : 2;
const cliConfig = desktopConfigFromArgs(process.argv.slice(appArgOffset), getConfig);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let overlayWindow = null;
let controlWindow = null;
let tray = null;
let gateway = null;
let fileGatewayClient = null;
let fileSourceManager = null;
let settingsStore = null;
let secretStore = null;
let pairingToken = "";
let settings = null;
let runtimeConfig = { ...cliConfig };
let providerVerified = false;
let runtimeArmed = false;
let selectedFileReady = false;
let runtimeState = { state: "idle", active: false, message: "Sẵn sàng thiết lập", latencyMs: null };
const runtimeSignals = new DesktopRuntimeSignals();
const runtimeMetrics = new RollingRuntimeMetrics({ maxSamples: 120 });
let runtimeGeneration = 0;
let lastStatus = { type: "status", level: "idle", message: "Đang khởi động AudioTranslate…" };
let previewTimer = null;
let boundsSaveTimer = null;
let runtimeLifecycle = Promise.resolve();
let quitting = false;
let quitApproved = false;
let quitConfirmationPending = false;
let shutdownStarted = false;
let shutdownComplete = false;
let ipcRegistered = false;

function controlCenterFile() {
  return path.join(__dirname, "control-center", "dist", "index.html");
}

function controlCenterUrl() {
  return pathToFileURL(controlCenterFile()).href;
}

function sendToWindow(window, channel, payload) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
  window.webContents.send(channel, payload);
  return true;
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function publicErrorMessage(error, fallback = "Thao tác runtime không thành công") {
  const message = typeof error?.message === "string" ? error.message : fallback;
  return message.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").slice(0, 500) || fallback;
}

function invalidateFileSource(reason = "runtime-reset") {
  selectedFileReady = false;
  sendToWindow(controlWindow, "control:file-source-invalidated", { reason });
}

async function stopFileRoute(reason = "runtime-reset") {
  fileSourceManager?.shutdown();
  const client = fileGatewayClient;
  fileGatewayClient = null;
  await client?.stop().catch(() => {});
  invalidateFileSource(reason);
}

function releaseFileRouteForSender(senderId, reason) {
  const stopped = fileSourceManager?.stopBySender(senderId, reason) === true;
  if (!stopped && !selectedFileReady) return;
  invalidateFileSource(reason);
  void enqueueRuntime(async () => {
    const client = fileGatewayClient;
    fileGatewayClient = null;
    await client?.stop().catch(() => {});
    publishSnapshot();
  });
}

function currentDisplay() {
  let fallback;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    fallback = screen.getDisplayMatching(overlayWindow.getBounds());
  } else {
    fallback = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }
  return resolveOverlayDisplay(screen.getAllDisplays(), settings?.overlay?.displayId, fallback);
}

function defaultOverlayBounds(preset = "bottom") {
  const area = currentDisplay().workArea;
  const width = Math.min(1160, Math.max(640, Math.round(area.width * 0.82)));
  const height = Math.min(320, Math.max(220, Math.round(area.height * 0.22)));
  const x = Math.round(area.x + (area.width - width) / 2);
  let y = Math.round(area.y + area.height - height - 34);
  if (preset === "top") y = Math.round(area.y + 34);
  if (preset === "floating") y = Math.round(area.y + (area.height - height) / 2);
  return { x, y, width, height };
}

function boundsFromNormalized(normalized, display = currentDisplay()) {
  if (!normalized) return defaultOverlayBounds(settings?.overlay?.preset);
  const area = display.workArea;
  const width = Math.max(420, Math.min(area.width, Math.round(area.width * normalized.width)));
  const height = Math.max(160, Math.min(area.height, Math.round(area.height * normalized.height)));
  return {
    width,
    height,
    x: Math.round(area.x + Math.min(1 - width / area.width, normalized.x) * area.width),
    y: Math.round(area.y + Math.min(1 - height / area.height, normalized.y) * area.height),
  };
}

function normalizedBounds(bounds, display) {
  const area = display.workArea;
  return {
    x: Math.max(0, Math.min(1, (bounds.x - area.x) / area.width)),
    y: Math.max(0, Math.min(1, (bounds.y - area.y) / area.height)),
    width: Math.max(0.2, Math.min(1, bounds.width / area.width)),
    height: Math.max(0.08, Math.min(0.6, bounds.height / area.height)),
  };
}

function applyOverlaySettings({ reposition = false } = {}) {
  if (!overlayWindow || overlayWindow.isDestroyed() || !settings) return;
  const locked = settings.overlay.locked;
  overlayWindow.setIgnoreMouseEvents(locked, { forward: true });
  overlayWindow.setFocusable(!locked);
  overlayWindow.setResizable(!locked);
  overlayWindow.setMovable(!locked);
  if (reposition) {
    const display = currentDisplay();
    const bounds = settings.overlay.normalizedBounds
      ? boundsFromNormalized(settings.overlay.normalizedBounds, display)
      : defaultOverlayBounds(settings.overlay.preset);
    overlayWindow.setBounds(bounds, true);
  }
  overlayWindow.webContents.send("overlay:interaction", { clickThrough: locked });
  overlayWindow.webContents.send("overlay:preferences", {
    ...settings.overlay,
    captionResetGapMs: settings.captions?.resetGapMs,
  });
  rebuildTrayMenu();
}

function scheduleBoundsSave() {
  if (!overlayWindow || overlayWindow.isDestroyed() || settings?.overlay?.locked) return;
  clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !settingsStore) return;
    const display = screen.getDisplayMatching(overlayWindow.getBounds());
    settings = settingsStore.update({
      overlay: {
        normalizedBounds: normalizedBounds(overlayWindow.getBounds(), display),
        displayId: String(display.id),
      },
    });
    publishSnapshot();
  }, 250);
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    ...boundsFromNormalized(settings?.overlay?.normalizedBounds),
    transparent: true,
    frame: false,
    resizable: settings?.overlay?.locked === false,
    movable: settings?.overlay?.locked === false,
    alwaysOnTop: true,
    focusable: settings?.overlay?.locked === false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    minWidth: 420,
    minHeight: 160,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  overlayWindow.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : undefined);
  if (process.platform === "darwin") {
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  overlayWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  overlayWindow.loadFile(path.join(__dirname, "overlay", "index.html"));
  overlayWindow.once("ready-to-show", () => {
    if (!overlayWindow) return;
    overlayWindow.showInactive();
    applyOverlaySettings();
    overlayWindow.webContents.send("overlay:status", lastStatus);
  });
  overlayWindow.on("move", scheduleBoundsSave);
  overlayWindow.on("resize", scheduleBoundsSave);
  overlayWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      overlayWindow?.hide();
    }
  });
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
}

function createControlWindow() {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.show();
    controlWindow.focus();
    return;
  }
  if (!fs.existsSync(controlCenterFile())) {
    sendStatus({
      type: "status",
      level: "error",
      message: "Control Center chưa được build. Chạy npm run build:control-center.",
    });
    return;
  }
  controlWindow = new BrowserWindow({
    ...controlWindowChromeOptions(process.platform),
    width: 1440,
    height: 960,
    minWidth: 1060,
    minHeight: 720,
    show: false,
    backgroundColor: "#0b0c0a",
    title: "AudioTranslate Control Center",
    webPreferences: {
      preload: path.join(__dirname, "control-center-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  controlWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  controlWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== controlCenterUrl()) event.preventDefault();
  });
  controlWindow.loadFile(controlCenterFile());
  const senderId = String(controlWindow.webContents.id);
  let initialNavigation = true;
  controlWindow.webContents.once("did-finish-load", () => {
    initialNavigation = false;
  });
  controlWindow.webContents.on(
    "did-start-navigation",
    (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame && !initialNavigation) {
        releaseFileRouteForSender(senderId, "control-center-reloaded");
      }
    },
  );
  controlWindow.webContents.on("render-process-gone", () => {
    releaseFileRouteForSender(senderId, "renderer-stopped");
  });
  controlWindow.once("ready-to-show", () => {
    controlWindow?.show();
    publishSnapshot();
  });
  controlWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      controlWindow?.hide();
      rebuildTrayMenu();
    }
  });
  controlWindow.on("closed", () => {
    releaseFileRouteForSender(senderId, "control-center-closed");
    controlWindow = null;
  });
}

function makeTrayImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="3" y="5" width="26" height="20" rx="6" fill="#fff"/><path d="M8 11h16v3H8zm0 6h10v3H8z" fill="#111827"/><circle cx="24" cy="22" r="5" fill="#22c55e" stroke="#111827" stroke-width="2"/></svg>`;
  const image = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  );
  image.setTemplateImage(process.platform === "darwin");
  return image.resize({ width: 18, height: 18 });
}

function toggleOverlay() {
  if (!overlayWindow) createOverlayWindow();
  else if (overlayWindow.isVisible()) overlayWindow.hide();
  else overlayWindow.showInactive();
  rebuildTrayMenu();
  publishSnapshot();
  return controlSnapshot();
}

function runtimeIsActive() {
  return runtimeArmed || previewTimer !== null || Boolean(gateway?.activeSession);
}

async function requestQuitWithNativeConfirmation() {
  if (quitConfirmationPending) {
    return { needsConfirmation: true, shouldQuit: false };
  }
  quitConfirmationPending = true;
  let decision;
  try {
    decision = quitDecision(runtimeIsActive(), false);
    if (decision.needsConfirmation) {
      const options = {
        type: "warning",
        title: "Thoát AudioTranslate?",
        message: "Phiên dịch đang chạy",
        detail: "Thoát sẽ dừng nguồn audio, phiên cloud và overlay phụ đề.",
        buttons: ["Hủy", "Dừng và thoát"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const result = controlWindow
        ? await dialog.showMessageBox(controlWindow, options)
        : await dialog.showMessageBox(options);
      decision = quitDecision(runtimeIsActive(), result.response === 1);
    }
    if (decision.shouldQuit) quitApproved = true;
  } finally {
    quitConfirmationPending = false;
  }
  if (!decision.shouldQuit) return decision;
  quitting = true;
  app.quit();
  return decision;
}

function setOverlayLocked(locked) {
  settings = settingsStore.update({ overlay: { locked: Boolean(locked) } });
  applyOverlaySettings();
  finalizeOverlayLockChange(overlayWindow, Boolean(locked), publishSnapshot);
  return controlSnapshot();
}

function applyOverlayPreset(preset) {
  if (!["bottom", "top", "floating"].includes(preset)) throw new Error("Preset không hợp lệ");
  settings = settingsStore.update({ overlay: { preset, normalizedBounds: null } });
  applyOverlaySettings({ reposition: true });
  publishSnapshot();
  return controlSnapshot();
}

function resetOverlay() {
  settings = settingsStore.update({ overlay: { normalizedBounds: null, preset: "bottom" } });
  applyOverlaySettings({ reposition: true });
  publishSnapshot();
  return controlSnapshot();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setToolTip("AudioTranslate Live");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Mở Control Center", click: createControlWindow },
      { label: overlayWindow?.isVisible() ? "Ẩn phụ đề" : "Hiện phụ đề", click: toggleOverlay },
      {
        label: "Dừng dịch",
        enabled: runtimeIsActive(),
        click: () => enqueueControlRuntime(stopRuntime).catch(() => {}),
      },
      {
        label: settings?.overlay?.locked ? "Điều chỉnh overlay" : "Khóa overlay",
        click: () => setOverlayLocked(!settings.overlay.locked),
      },
      { label: "Đưa phụ đề về vị trí mặc định", click: resetOverlay },
      {
        label: "Sao chép mã ghép nối extension",
        click: () => clipboard.writeText(configuredPairingToken()),
      },
      { type: "separator" },
      { label: lastStatus.message, enabled: false },
      { type: "separator" },
      {
        label: "Thoát",
        click: () => void requestQuitWithNativeConfirmation(),
      },
    ]),
  );
}

function installApplicationMenu() {
  const template = [
    {
      label: "AudioTranslate",
      submenu: [
        { label: "Mở Control Center", accelerator: "CommandOrControl+Shift+A", click: createControlWindow },
        { label: "Ẩn xuống khay", click: () => controlWindow?.hide() },
        { type: "separator" },
        { label: "Thoát AudioTranslate", accelerator: "CommandOrControl+Q", click: () => void requestQuitWithNativeConfirmation() },
      ],
    },
    desktopEditMenuTemplate(),
    {
      label: "Phiên",
      submenu: [
        { label: "Bắt đầu", click: () => enqueueControlRuntime(startRuntime).catch(() => {}) },
        { label: "Dừng", click: () => enqueueControlRuntime(stopRuntime).catch(() => {}) },
      ],
    },
    {
      label: "Overlay",
      submenu: [
        { label: "Ẩn / hiện", accelerator: "CommandOrControl+Alt+S", click: toggleOverlay },
        { label: "Khóa / mở chỉnh sửa", accelerator: "CommandOrControl+Alt+I", click: () => setOverlayLocked(!settings.overlay.locked) },
        { label: "Đặt lại vị trí", accelerator: "CommandOrControl+Alt+R", click: resetOverlay },
      ],
    },
  ];
  if (!app.isPackaged) {
    template.push({
      label: "Phát triển",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function runtimeStateFromStatus(status) {
  return runtimeStateForStatus(status, runtimeIsActive(), {
    ...runtimeSignals.details(runtimeMetrics.snapshot()),
    armed: runtimeArmed,
    pauseSupported: runtimeConfig.provider === "gemini",
  });
}

function publishRuntimeSignals() {
  runtimeState = runtimeStateFromStatus(lastStatus);
  sendToWindow(controlWindow, "control:runtime-status", runtimeState);
  publishSnapshot();
}

function sendStatus(status) {
  lastStatus = { type: "status", ...status };
  runtimeState = runtimeStateFromStatus(lastStatus);
  sendToWindow(overlayWindow, "overlay:status", lastStatus);
  sendToWindow(controlWindow, "control:runtime-status", runtimeState);
  rebuildTrayMenu();
  publishSnapshot();
}

function sendCaption(caption) {
  const payload = {
    ...caption,
    generation: Number.isFinite(caption?.generation)
      ? Number(caption.generation)
      : runtimeGeneration,
  };
  sendToWindow(overlayWindow, "overlay:caption", payload);
  sendToWindow(controlWindow, "control:caption", payload);
  if (runtimeSignals.applyCaption(runtimeGeneration, payload)) publishRuntimeSignals();
}

function providerSecretStatus() {
  return resolveSecretStatus(secretStore, "gemini", "");
}

function configuredGeminiApiKey() {
  return resolveSecret(secretStore, "gemini", "");
}

function configuredPairingToken() {
  return pairingToken;
}

function controlSnapshot() {
  const secretStatus = providerSecretStatus();
  const pairingStatus = publicPairingStatus(secretStore, "");
  const providerModel = runtimeConfig.geminiModel || "gemini-3.5-live-translate-preview";
  return {
    settings,
    secrets: { gemini: secretStatus },
    provider: {
      active: settings?.provider || "demo",
      keyConfigured: secretStatus.configured,
      connected: providerVerified,
      model: providerModel,
      storage: secretStatus.storage,
      storageBackend: secretStatus.backend,
    },
    pairing: pairingStatus,
    source: {
      kind: settings?.source?.kind || "tab",
      connected:
        settings?.source?.kind === "file"
          ? selectedFileReady
          : Boolean(configuredPairingToken() && gateway?.state === "running"),
      label:
        settings?.source?.kind === "file"
          ? selectedFileReady
            ? "Tệp đã chọn · chỉ giải mã trong bộ nhớ"
            : "Chưa chọn tệp"
          : gateway?.state === "running"
            ? "Gateway an toàn đang mở · dùng extension trên tab cần dịch"
            : "Gateway đang đóng an toàn · nhấn Bắt đầu để mở kết nối",
    },
    languages: {
      source: settings?.source?.language || "auto",
      target: settings?.source?.targetLanguage || "vi",
    },
    privacy: {
      cloudConsent: settings?.cloud?.consent === GEMINI_CLOUD_CONSENT,
      maxCloudMinutes: settings?.cloud?.maxMinutes || 30,
    },
    app: {
      overlayVisible: Boolean(overlayWindow?.isVisible()),
      controlVisible: Boolean(controlWindow?.isVisible()),
    },
    displays: listDisplayOptions(screen.getAllDisplays(), screen.getPrimaryDisplay().id),
    runtime: runtimeStateFromStatus(lastStatus),
  };
}

function publishSnapshot() {
  sendToWindow(controlWindow, "control:snapshot", controlSnapshot());
}

function configFromSettings() {
  return configFromDesktopSettings(cliConfig, settings, {
    authToken: configuredPairingToken(),
    geminiApiKey: configuredGeminiApiKey(),
  });
}

function enqueueRuntime(task) {
  const operation = runtimeLifecycle.then(task, task);
  runtimeLifecycle = operation.catch(() => {});
  return operation;
}

function enqueueControlRuntime(task) {
  return enqueueRuntime(async () => {
    try {
      return await task();
    } catch (error) {
      sendStatus({ level: "error", message: publicErrorMessage(error) });
      throw error;
    }
  });
}

async function replaceGateway({ activate = false } = {}) {
  if (runtimeGeneration > 0) runtimeSignals.endGateway(runtimeGeneration);
  runtimeGeneration = runtimeSignals.attachGateway();
  const generation = runtimeGeneration;
  runtimeArmed = false;
  if (!activate) stopPreview();
  await stopFileRoute("gateway-replaced");
  const previousGateway = gateway;
  gateway = null;
  await previousGateway?.close().catch(() => {});
  const configured = configFromSettings();
  runtimeConfig = configured;
  if (!shouldOpenDesktopGateway(activate)) return;
  const nextGateway = new RealtimeGateway(runtimeConfig);
  gateway = nextGateway;
  nextGateway.on("status", (status) => {
    if (gateway !== nextGateway) return;
    if (typeof status.sessionId === "string") {
      runtimeSignals.beginSession(generation, status.sessionId);
    }
    if (status.terminal === true) {
      runtimeArmed = false;
      runtimeSignals.endGateway(generation);
      sendStatus(status);
      void enqueueRuntime(async () => {
        if (gateway !== nextGateway) return;
        gateway = null;
        await stopFileRoute("provider-terminal");
        await nextGateway.close().catch(() => {});
      }).catch(() => {});
      return;
    }
    sendStatus(status);
  });
  nextGateway.on("caption", (caption) => {
    if (gateway === nextGateway) sendCaption(caption);
  });
  nextGateway.on("metrics", (metrics) => {
    if (gateway !== nextGateway || !runtimeSignals.acceptsEvent(generation, metrics)) return;
    let changed = false;
    for (const field of RUNTIME_METRIC_FIELDS) {
      if (runtimeMetrics.record(field, metrics?.[field])) changed = true;
    }
    if (changed) publishRuntimeSignals();
  });
  nextGateway.on("usage", (event) => {
    if (gateway !== nextGateway || !runtimeSignals.acceptsEvent(generation, event)) return;
    if (runtimeMetrics.recordUsage(event?.usage, { mode: event?.mode })) {
      publishRuntimeSignals();
    }
  });
  nextGateway.on("telemetry", (telemetry) => {
    if (gateway !== nextGateway || !runtimeSignals.applyTelemetry(generation, telemetry)) return;
    publishRuntimeSignals();
    sendToWindow(controlWindow, "control:telemetry", runtimeState.telemetry);
  });
  nextGateway.on("language", (detection) => {
    if (gateway !== nextGateway || !runtimeSignals.applyLanguage(generation, detection)) return;
    publishRuntimeSignals();
    sendToWindow(controlWindow, "control:language-detected", {
      language: runtimeState.detectedLanguage,
      detectionLatencyMs: runtimeState.languageDetectionMs,
    });
  });
  nextGateway.on("error", (error) => {
    if (gateway === nextGateway) sendStatus({ level: "error", message: error.message });
  });
  let address;
  try {
    address = await nextGateway.start();
  } catch (error) {
    if (gateway === nextGateway) gateway = null;
    await nextGateway.close().catch(() => {});
    throw error;
  }
  if (gateway !== nextGateway) {
    await nextGateway.close().catch(() => {});
    throw new Error("Gateway lifecycle was superseded");
  }
  runtimeConfig = { ...runtimeConfig, host: address.host, port: address.port };
  runtimeArmed = activate;
}

async function startRuntime() {
  runtimeMetrics.reset();
  runtimeSignals.setPaused(false);
  const provider = normalizeDesktopProvider(settings.provider);
  const mode = providerStartMode(provider, {
    keyConfigured: Boolean(configuredGeminiApiKey()),
    verified: providerVerified,
    consent: settings.cloud.consent,
  });
  await stopFileRoute("runtime-started");
  if (previewTimer) stopPreview();

  if (mode === "synthetic-preview") {
    await replaceGateway({ activate: false });
    runtimeArmed = true;
    startPreview();
    sendStatus({
      level: "listening",
      message: "Đang chạy Demo cục bộ · caption là nội dung mô phỏng, không dùng audio",
    });
    return controlSnapshot();
  }

  sendStatus({
    level: "connecting",
    message: "Đang chuẩn bị Gemini Live Translate…",
  });
  await replaceGateway({ activate: true });
  if (settings.source.kind === "tab") {
    sendStatus({
      level: "connecting",
      message: "Mở extension AudioTranslate trên tab Chrome/Edge rồi chọn Bắt đầu dịch",
    });
  }
  publishSnapshot();
  return controlSnapshot();
}

async function stopRuntime() {
  runtimeSignals.setPaused(false);
  stopPreview();
  await replaceGateway({ activate: false });
  sendStatus({ level: "idle", message: "Đã dừng phiên dịch; không còn audio mới được gửi" });
  return controlSnapshot();
}

async function setRuntimePaused(paused) {
  if (typeof paused !== "boolean") throw new Error("Trạng thái tạm dừng không hợp lệ");
  if (runtimeConfig.provider !== "gemini" || !runtimeIsActive()) {
    throw new Error("Chỉ phiên audio Gemini đang hoạt động mới có thể tạm dừng");
  }
  runtimeSignals.setPaused(paused);
  gateway?.setPaused(paused);
  fileSourceManager?.setPaused(paused);
  sendStatus({
    level: paused ? "paused" : "listening",
    message: paused
      ? "Đã tạm dừng; audio mới bị loại bỏ trong khi kết nối capture vẫn được giữ"
      : "Đã tiếp tục phiên dịch trên kết nối capture hiện tại",
  });
  return controlSnapshot();
}

function desktopDiagnosticsContext() {
  const secretStatus = providerSecretStatus();
  const pairingStatus = publicPairingStatus(secretStore, "");
  return {
    provider: {
      active: settings?.provider || "demo",
      keyConfigured: secretStatus.configured === true,
      connected: providerVerified === true,
    },
    storage: {
      storage: String(secretStatus.storage || "unavailable"),
      backend: String(secretStatus.backend || "unavailable"),
    },
    pairing: {
      configured: pairingStatus.configured === true,
      storage: String(pairingStatus.storage || "unavailable"),
      backend: String(pairingStatus.backend || "unavailable"),
    },
    privacy: { cloudConsent: settings?.cloud?.consent === GEMINI_CLOUD_CONSENT },
    extension: { connected: Boolean(gateway?.activeSession) },
    runtime: { gatewayRunning: gateway?.state === "running" },
    port: gateway?.address().port ?? runtimeConfig.port,
  };
}

async function setDesktopProvider(providerCandidate) {
  const provider = normalizeDesktopProvider(providerCandidate);
  if (settings.provider === provider) return controlSnapshot();
  if (runtimeIsActive()) await stopRuntime();
  settings = settingsStore.update({ provider });
  sendStatus({
    level: "idle",
    message:
      provider === "demo"
        ? "Đã chọn Demo cục bộ · không dùng API hoặc audio thật"
        : "Đã chọn Google Gemini · cần key, consent và kiểm tra kết nối",
  });
  return controlSnapshot();
}

async function testGeminiProvider() {
  const apiKey = configuredGeminiApiKey();
  await runIsolatedProviderProbe(runtimeIsActive(), (callbacks) => {
    if (!apiKey) throw new Error("Hãy lưu Gemini API key trước");
    providerVerified = false;
    sendStatus({ level: "connecting", message: "Đang kiểm tra kết nối Gemini…" });
    return createProvider(
      {
        ...configFromSettings(),
        provider: "gemini",
        cloudConsent: GEMINI_CLOUD_CONSENT,
        geminiApiKey: apiKey,
      },
      {
        sourceLanguage: "auto",
        sourceLanguageCandidates: [],
        targetLanguage: settings.source.targetLanguage,
      },
      callbacks,
    );
  });
  providerVerified = true;
  sendStatus({
    level: "ok",
    message: "Gemini API key hợp lệ và Live Translate đã sẵn sàng",
  });
  publishSnapshot();
  return controlSnapshot();
}

function normalizeControlPatch(patch) {
  if (!isPlainRecord(patch)) {
    throw new Error("Settings patch không hợp lệ");
  }
  assertGenericDesktopPatch(patch);
  const next = {};
  if (isPlainRecord(patch.cloud)) next.cloud = patch.cloud;
  if (isPlainRecord(patch.captions)) next.captions = patch.captions;
  if (isPlainRecord(patch.languages)) {
    next.source = {
      language: patch.languages.source,
      targetLanguage: patch.languages.target,
    };
  }
  if (isPlainRecord(patch.source)) {
    const kindWasProvided = patch.source.kind !== undefined;
    const kind = patch.source.kind === "browser-tab" ? "tab" : patch.source.kind;
    next.source = { ...(next.source || {}), ...patch.source };
    if (kindWasProvided) next.source.kind = kind;
    delete next.source.file;
    delete next.source.fileSelected;
    if (kindWasProvided || patch.source.fileSelected !== undefined || patch.source.file !== undefined) {
      const effectiveKind = kindWasProvided ? kind : settings?.source?.kind;
      selectedFileReady =
        effectiveKind === "file" && Boolean(patch.source.fileSelected ?? patch.source.file);
    }
  }
  if (isPlainRecord(patch.overlay)) {
    const overlay = { ...patch.overlay };
    if (Object.hasOwn(overlay, "showSource")) {
      next.captions = {
        ...(next.captions || {}),
        mode: overlay.showSource === true ? "bilingual" : "fastest",
      };
      delete overlay.showSource;
    }
    if (overlay.fontSize !== undefined) overlay.translationFontSize = overlay.fontSize;
    if (overlay.clickThrough !== undefined) overlay.locked = overlay.clickThrough;
    delete overlay.fontSize;
    delete overlay.clickThrough;
    next.overlay = overlay;
  }
  return next;
}

function assertControlSender(event) {
  let valid = false;
  try {
    const mainFrame = controlWindow?.webContents?.mainFrame;
    valid = Boolean(
      controlWindow &&
        !controlWindow.isDestroyed() &&
        !controlWindow.webContents.isDestroyed() &&
        event.sender === controlWindow.webContents &&
        event.senderFrame?.processId === mainFrame?.processId &&
        event.senderFrame?.routingId === mainFrame?.routingId &&
        event.senderFrame.url === controlCenterUrl(),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    const error = new Error("Control Center IPC sender không hợp lệ");
    error.code = "FORBIDDEN";
    throw error;
  }
  return String(event.sender.id);
}

async function ensureFileGateway() {
  if (
    !runtimeArmed ||
    gateway?.state !== "running" ||
    gateway?.config?.provider !== "gemini" ||
    runtimeConfig.provider !== "gemini" ||
    runtimeConfig.cloudConsent !== GEMINI_CLOUD_CONSENT ||
    !runtimeConfig.geminiApiKey
  ) {
    throw new Error("Gemini runtime và cloud consent phải sẵn sàng trước file audio");
  }
  if (!fileGatewayClient) {
    fileGatewayClient = new FileGatewayClient(runtimeConfig, { onStatus: sendStatus });
  }
  await fileGatewayClient.start();
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle("control:get-snapshot", (event) => {
    assertControlSender(event);
    return controlSnapshot();
  });
  ipcMain.handle("control:update-settings", (event, patch) => {
    assertControlSender(event);
    return enqueueControlRuntime(async () => {
      if (settingsPatchRequiresRuntimeStop(runtimeIsActive(), patch, settings)) {
        await stopRuntime();
      }
      settings = settingsStore.update(normalizeControlPatch(patch));
      applyOverlaySettings({
        reposition: Boolean(
          patch?.overlay?.normalizedBounds ||
          (isPlainRecord(patch?.overlay) && Object.hasOwn(patch.overlay, "displayId")),
        ),
      });
      publishSnapshot();
      return controlSnapshot();
    });
  });
  ipcMain.handle("control:save-secret", (event, payload) => {
    assertControlSender(event);
    if (payload?.provider !== "gemini") throw new Error("Provider secret không được hỗ trợ");
    return enqueueControlRuntime(async () => {
      if (runtimeArmed || gateway?.activeSession || fileGatewayClient) {
        await replaceGateway({ activate: false });
      }
      const status = secretStore.set("gemini", payload.candidate);
      providerVerified = false;
      publishSnapshot();
      return { ...controlSnapshot(), secrets: { gemini: status } };
    });
  });
  ipcMain.handle("control:delete-secret", (event, payload) => {
    assertControlSender(event);
    if (payload?.provider !== "gemini") throw new Error("Provider secret không được hỗ trợ");
    return enqueueControlRuntime(async () => {
      if (runtimeArmed || gateway?.activeSession || fileGatewayClient) {
        await replaceGateway({ activate: false });
      }
      secretStore.delete("gemini");
      providerVerified = false;
      publishSnapshot();
      return controlSnapshot();
    });
  });
  ipcMain.handle("control:test-provider", async (event, payload) => {
    assertControlSender(event);
    if (payload?.provider !== "gemini") throw new Error("Provider không được hỗ trợ");
    return enqueueControlRuntime(testGeminiProvider);
  });
  ipcMain.handle("control:set-provider", (event, payload) => {
    assertControlSender(event);
    return enqueueControlRuntime(() => setDesktopProvider(payload?.provider));
  });
  ipcMain.handle("control:copy-pairing-token", (event) => {
    assertControlSender(event);
    clipboard.writeText(configuredPairingToken());
    return { copied: true };
  });
  ipcMain.handle("control:start-runtime", (event) => {
    assertControlSender(event);
    return enqueueControlRuntime(startRuntime);
  });
  ipcMain.handle("control:stop-runtime", (event) => {
    assertControlSender(event);
    return enqueueControlRuntime(stopRuntime);
  });
  ipcMain.handle("control:set-runtime-paused", (event, payload) => {
    assertControlSender(event);
    return enqueueControlRuntime(() => setRuntimePaused(payload?.paused));
  });
  ipcMain.handle("control:run-diagnostics", (event) => {
    assertControlSender(event);
    return collectDesktopDiagnostics(desktopDiagnosticsContext());
  });
  ipcMain.handle("control:hide", (event) => {
    assertControlSender(event);
    controlWindow?.hide();
    rebuildTrayMenu();
    return { hidden: true };
  });
  ipcMain.handle("control:toggle-overlay", (event) => {
    assertControlSender(event);
    return toggleOverlay();
  });
  ipcMain.handle("control:request-quit", (event, payload) => {
    assertControlSender(event);
    const decision = quitDecision(runtimeIsActive(), payload?.confirmActive === true);
    if (decision.shouldQuit) {
      setImmediate(() => {
        quitApproved = true;
        quitting = true;
        app.quit();
      });
    }
    return decision;
  });
  ipcMain.handle("control:set-overlay-locked", (event, payload) => {
    assertControlSender(event);
    return setOverlayLocked(payload?.locked !== false);
  });
  ipcMain.handle("control:reset-overlay", (event) => {
    assertControlSender(event);
    return resetOverlay();
  });
  ipcMain.handle("control:start-file-source", (event, metadata) => {
    const senderId = assertControlSender(event);
    return enqueueControlRuntime(async () => {
      await ensureFileGateway();
      try {
        if (assertControlSender(event) !== senderId) throw new Error("FORBIDDEN");
      } catch (error) {
        const client = fileGatewayClient;
        fileGatewayClient = null;
        await client?.stop().catch(() => {});
        throw error;
      }
      const result = fileSourceManager.start(senderId, metadata);
      selectedFileReady = true;
      publishSnapshot();
      return { ...result, snapshot: controlSnapshot() };
    });
  });
  ipcMain.on("control:file-audio", (event, payload) => {
    let senderId;
    try {
      senderId = assertControlSender(event);
      fileSourceManager.push(senderId, payload);
    } catch (error) {
      sendStatus({ level: "error", message: error.message });
      if (!fileSourceManager?.activeSession) {
        invalidateFileSource("file-source-error");
        void enqueueRuntime(async () => {
          const client = fileGatewayClient;
          fileGatewayClient = null;
          await client?.stop().catch(() => {});
          publishSnapshot();
        });
      }
    }
  });
  ipcMain.handle("control:stop-file-source", (event, payload) => {
    const senderId = assertControlSender(event);
    return enqueueControlRuntime(async () => {
      let stopError = null;
      try {
        fileSourceManager.stop(senderId, payload);
      } catch (error) {
        stopError = error;
      }
      const client = fileGatewayClient;
      fileGatewayClient = null;
      await client?.stop().catch(() => {});
      invalidateFileSource("user-stop");
      publishSnapshot();
      if (stopError && !["NO_SESSION", "INVALID_SESSION"].includes(stopError.code)) {
        throw stopError;
      }
      return { snapshot: controlSnapshot() };
    });
  });

  ipcMain.handle("overlay:set-locked", (event, payload) => {
    if (event.sender !== overlayWindow?.webContents) throw new Error("FORBIDDEN");
    return setOverlayLocked(payload?.locked !== false);
  });
  ipcMain.handle("overlay:apply-preset", (event, payload) => {
    if (event.sender !== overlayWindow?.webContents) throw new Error("FORBIDDEN");
    return applyOverlayPreset(payload?.preset);
  });
  ipcMain.handle("overlay:nudge", (event, payload) => {
    if (event.sender !== overlayWindow?.webContents || settings.overlay.locked) {
      throw new Error("FORBIDDEN");
    }
    const bounds = overlayWindow.getBounds();
    const x = Number.isFinite(payload?.x) ? Math.max(-20, Math.min(20, payload.x)) : 0;
    const y = Number.isFinite(payload?.y) ? Math.max(-20, Math.min(20, payload.y)) : 0;
    overlayWindow.setPosition(bounds.x + x, bounds.y + y, false);
    return true;
  });
  ipcMain.handle("overlay:open-control-center", (event) => {
    if (event.sender !== overlayWindow?.webContents) throw new Error("FORBIDDEN");
    createControlWindow();
    return true;
  });
  ipcMain.on("overlay:rendered", (event, metrics) => {
    if (event.sender !== overlayWindow?.webContents) return;
    if (!runtimeSignals.acceptsEvent(runtimeGeneration, metrics)) return;
    const recorded = runtimeMetrics.record("resultToRafMs", metrics?.resultToRafMs);
    if (recorded) publishRuntimeSignals();
    if (process.env.AUDIOTRANSLATE_DEBUG === "true") {
      process.stderr.write(`${JSON.stringify({
        event: "overlay-rendered",
        sessionId: metrics.sessionId,
        generation: runtimeGeneration,
        sequence: Number.isFinite(metrics.sequence) ? metrics.sequence : null,
        isFinal: metrics.isFinal === true,
        rafAt: Number.isFinite(metrics.rafAt) ? metrics.rafAt : null,
        resultToRafMs: recorded ? Math.round(metrics.resultToRafMs) : null,
      })}\n`);
    }
  });
}

function startPreview() {
  stopPreview();
  let line = 0;
  let isFinal = false;
  const emitPreviewCaption = () => {
    const [transcript, translation] = DEMO_LINES[line % DEMO_LINES.length];
    sendCaption({
      type: "caption",
      sessionId: "preview",
      sequence: line * 2 + (isFinal ? 1 : 0),
      transcript: isFinal ? transcript : transcript.slice(0, Math.ceil(transcript.length * 0.68)),
      translation: isFinal ? translation : translation.slice(0, Math.ceil(translation.length * 0.68)),
      sourceLanguage: settings?.source?.language || "auto",
      targetLanguage: settings?.source?.targetLanguage || "vi",
      isFinal,
      showSource: settings.overlay.showSource,
      emittedAt: Date.now(),
      latencyMs: null,
      synthetic: true,
      provider: "demo",
    });
    if (isFinal) line += 1;
    isFinal = !isFinal;
  };
  emitPreviewCaption();
  previewTimer = setInterval(emitPreviewCaption, 1200);
  previewTimer.unref?.();
}

function stopPreview() {
  if (!previewTimer) return;
  clearInterval(previewTimer);
  previewTimer = null;
}

async function startApplication() {
  const userData = app.getPath("userData");
  settingsStore = new SettingsStore(path.join(userData, "settings.json"));
  const settingsFileExists = fs.existsSync(path.join(userData, "settings.json"));
  settings = settingsStore.load();
  if (!settingsFileExists) {
    settings = settingsStore.update({
      provider: cliConfig.provider,
      source: {
        language: cliConfig.provider === "gemini" ? "auto" : cliConfig.sourceLanguage,
        languageHints: cliConfig.provider === "gemini" ? [] : cliConfig.sourceLanguageCandidates,
        targetLanguage: cliConfig.targetLanguage,
      },
      cloud: {
        consent: cliConfig.cloudConsent,
        maxMinutes: cliConfig.maxCloudMinutes || 30,
      },
      overlay: { showSource: cliConfig.showSource, locked: cliConfig.clickThrough },
    });
  }
  const desktopMigration = desktopSettingsMigrationPatch(settings, { preview: cliConfig.preview });
  if (desktopMigration) settings = settingsStore.update(desktopMigration);
  secretStore = new SecretStore({
    safeStorage,
    directory: path.join(userData, "secrets"),
  });
  pairingToken = ensurePairingToken(secretStore, "");
  runtimeConfig = configFromSettings();
  fileSourceManager = new FileSourceSessionManager({
    authorizeDestination: (destination) =>
      destination === "google-gemini" &&
      runtimeArmed === true &&
      fileGatewayClient?.ready === true &&
      runtimeConfig.provider === "gemini" &&
      runtimeConfig.cloudConsent === GEMINI_CLOUD_CONSENT,
    writePcm: async (pcm, metadata) => {
      if (!fileGatewayClient?.write(pcm, metadata)) {
        const error = new Error("File audio route is not ready or is backpressured");
        error.code = "FILE_ROUTE_BACKPRESSURE";
        throw error;
      }
    },
    onStatus: sendStatus,
  });
  registerIpc();
  installApplicationMenu();
  createOverlayWindow();
  createControlWindow();
  tray = new Tray(makeTrayImage());
  tray.on("click", createControlWindow);
  rebuildTrayMenu();

  try {
    await enqueueRuntime(() => replaceGateway({ activate: false }));
  } catch (error) {
    sendStatus({ level: "error", message: error.message });
  }

  const shortcuts = [
    ["CommandOrControl+Alt+S", toggleOverlay],
    ["CommandOrControl+Alt+I", () => setOverlayLocked(!settings.overlay.locked)],
    ["CommandOrControl+Alt+R", resetOverlay],
  ];
  const failed = shortcuts
    .filter(([accelerator, callback]) => !globalShortcut.register(accelerator, callback))
    .map(([accelerator]) => accelerator);
  if (failed.length > 0) {
    sendStatus({
      level: "warning",
      message: `Không đăng ký được phím tắt: ${failed.join(", ")}; dùng menu tray thay thế`,
    });
  }
  if (cliConfig.preview) await enqueueControlRuntime(startRuntime);
}

if (hasSingleInstanceLock) {
  app.on("second-instance", createControlWindow);
  app.whenReady().then(startApplication);
}

app.on("activate", createControlWindow);
app.on("window-all-closed", () => {});
app.on("before-quit", (event) => {
  const action = beforeQuitAction({
    runtimeActive: runtimeIsActive(),
    quitApproved,
    confirmationPending: quitConfirmationPending,
    shutdownStarted,
    shutdownComplete,
  });
  if (action === "allow") return;
  event.preventDefault();
  if (action === "block") return;
  if (action === "confirm") {
    void requestQuitWithNativeConfirmation();
    return;
  }
  shutdownStarted = true;
  quitting = true;
  globalShortcut.unregisterAll();
  clearTimeout(boundsSaveTimer);
  if (previewTimer) clearInterval(previewTimer);
  void enqueueRuntime(async () => {
    runtimeArmed = false;
    await stopFileRoute("application-quit");
    await gateway?.close().catch(() => {});
  }).finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});

module.exports = { GEMINI_FILE_CONSENT };
