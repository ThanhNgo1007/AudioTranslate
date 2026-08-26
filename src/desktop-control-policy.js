const crypto = require("node:crypto");

const PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{24,512}$/;

function validPairingToken(candidate) {
  const value = String(candidate || "").trim();
  return PAIRING_TOKEN_PATTERN.test(value) ? value : "";
}

function desktopConfigFromArgs(argv, getConfig) {
  if (typeof getConfig !== "function") throw new TypeError("getConfig is required");
  const preview = Array.isArray(argv) && argv.some((value) => value === "--preview" || value === "--preview=true");
  const config = getConfig([], {}, { preview });
  return {
    ...config,
    host: "127.0.0.1",
    provider: "demo",
    sourceLanguage: "auto",
    sourceLanguageCandidates: [],
    targetLanguage: "vi",
    authToken: "",
    cloudConsent: "",
    geminiApiKey: "",
    preview,
    allowDevClients: false,
  };
}

function configFromDesktopSettings(cliConfig = {}, settings = {}, secrets = {}) {
  const source = settings?.source || {};
  const cloud = settings?.cloud || {};
  const captions = settings?.captions || {};
  const overlay = settings?.overlay || {};
  return {
    ...cliConfig,
    provider: settings?.provider || cliConfig.provider,
    sourceLanguage: source.language || "auto",
    sourceLanguageCandidates: Array.isArray(source.languageHints) ? source.languageHints : [],
    targetLanguage: source.targetLanguage || "vi",
    showSource: captions.mode === "bilingual" && overlay.showSource !== false,
    cloudConsent: cloud.consent || "",
    maxCloudMinutes: cloud.maxMinutes,
    authToken: String(secrets.authToken || ""),
    geminiApiKey: String(secrets.geminiApiKey || ""),
    geminiInputTranscription: captions.mode === "bilingual",
    geminiEchoTargetLanguage: captions.echoTargetLanguage === true,
    geminiFinalDebounceMs: captions.finalDebounceMs,
    captionResetGapMs: captions.resetGapMs,
  };
}

function controlWindowChromeOptions(platform = process.platform) {
  return {
    frame: false,
    autoHideMenuBar: platform !== "darwin",
  };
}

function desktopEditMenuTemplate() {
  return {
    label: "Sửa",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };
}

function desktopSettingsMigrationPatch(settings = {}, options = {}) {
  const supported = settings?.provider === "demo" || settings?.provider === "gemini";
  const mustUseDemo = options.preview === true || !supported;
  if (!mustUseDemo || settings?.provider === "demo") return null;
  const cloud = settings?.cloud && typeof settings.cloud === "object" ? settings.cloud : {};
  return {
    provider: "demo",
    cloud: { ...cloud, consent: "" },
  };
}

function assertGenericDesktopPatch(patch = {}) {
  if (patch && typeof patch === "object" && Object.hasOwn(patch, "provider")) {
    throw new Error("Provider changes must use control:set-provider");
  }
  return patch;
}

function finalizeOverlayLockChange(overlayWindow, locked, publishSnapshot) {
  if (!locked) {
    overlayWindow?.show();
    overlayWindow?.focus();
  } else {
    overlayWindow?.showInactive();
  }
  publishSnapshot();
}

function ensurePairingToken(secretStore, environmentCandidate = "", randomBytes = crypto.randomBytes) {
  const environmentToken = validPairingToken(environmentCandidate);
  if (environmentToken) return environmentToken;
  const stored = validPairingToken(secretStore?.get("pairing"));
  if (stored) return stored;
  const generated = randomBytes(32).toString("base64url");
  if (!validPairingToken(generated)) throw new Error("Không thể tạo pairing token an toàn");
  secretStore.set("pairing", generated);
  return generated;
}

function publicPairingStatus(secretStore, environmentCandidate = "") {
  if (validPairingToken(environmentCandidate)) {
    return { configured: true, storage: "environment", backend: "environment" };
  }
  let status;
  try {
    status = secretStore?.status("pairing");
  } catch {
    status = null;
  }
  return {
    configured: status?.configured === true,
    storage: String(status?.storage || "unavailable"),
    backend: String(status?.backend || "unavailable"),
  };
}

function normalizeDesktopProvider(candidate) {
  const provider = String(candidate || "").trim().toLowerCase();
  if (provider === "demo" || provider === "gemini") return provider;
  throw new Error(`Nhà cung cấp ${provider || "này"} chưa khả dụng trong Control Center`);
}

function quitDecision(runtimeActive, confirmed) {
  if (runtimeActive && confirmed !== true) {
    return { needsConfirmation: true, shouldQuit: false };
  }
  return { needsConfirmation: false, shouldQuit: true };
}

function beforeQuitAction(state = {}) {
  if (state.shutdownComplete === true) return "allow";
  if (state.shutdownStarted === true || state.confirmationPending === true) return "block";
  if (state.runtimeActive === true && state.quitApproved !== true) return "confirm";
  return "shutdown";
}

function shouldOpenDesktopGateway(activate = false) {
  return activate === true;
}

async function runIsolatedProviderProbe(runtimeActive, createCandidate) {
  if (runtimeActive) {
    throw new Error("Hãy dừng phiên dịch trước khi kiểm tra kết nối Gemini");
  }
  if (typeof createCandidate !== "function") throw new TypeError("createCandidate is required");
  const callbacks = {
    onStatus: () => {},
    onCaption: () => {},
    onError: () => {},
    onTerminal: () => {},
    onLanguageDetected: () => {},
  };
  const candidate = createCandidate(callbacks);
  if (!candidate || typeof candidate.start !== "function" || typeof candidate.stop !== "function") {
    throw new TypeError("Provider probe candidate is invalid");
  }
  try {
    await candidate.start();
  } finally {
    await candidate.stop().catch(() => {});
  }
}

function providerStartMode(providerCandidate, state = {}) {
  const provider = normalizeDesktopProvider(providerCandidate);
  if (provider === "demo") return "synthetic-preview";
  if (state.keyConfigured !== true) throw new Error("Hãy lưu Gemini API key trước khi bắt đầu");
  if (state.verified !== true) throw new Error("Hãy kiểm tra kết nối Gemini trước khi bắt đầu");
  if (state.consent !== "gemini:audio:v1") {
    throw new Error("Hãy cho phép gửi audio tới Google Gemini trước khi bắt đầu");
  }
  return "realtime-gateway";
}

function settingsPatchRequiresRuntimeStop(runtimeActive, patch = {}, currentSettings = {}) {
  if (!runtimeActive || !patch || typeof patch !== "object") return false;
  if (patch.source && typeof patch.source === "object") return true;
  if (patch.languages && typeof patch.languages === "object") return true;
  if (patch.captions && typeof patch.captions === "object") return true;
  if (
    patch.overlay &&
    typeof patch.overlay === "object" &&
    Object.hasOwn(patch.overlay, "showSource")
  ) return true;
  if (patch.cloud && typeof patch.cloud === "object") {
    const nextConsent = Object.hasOwn(patch.cloud, "consent")
      ? patch.cloud.consent
      : currentSettings?.cloud?.consent;
    return nextConsent !== currentSettings?.cloud?.consent || Object.hasOwn(patch.cloud, "maxMinutes");
  }
  return false;
}

function finiteNonNegative(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

function normalizeRuntimeTelemetry(value = {}) {
  const metric = (candidate) => {
    const number = Number(candidate);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
  };
  return {
    rms: metric(value?.rms),
    peak: metric(value?.peak),
    speech: value?.speech === true,
    silenceMs: finiteNonNegative(value?.silenceMs, 0),
    packetGapCount: finiteNonNegative(value?.packetGapCount, 0),
    droppedFrames: finiteNonNegative(value?.droppedFrames, 0),
    queueMs: finiteNonNegative(value?.queueMs),
    updatedAt: finiteNonNegative(value?.updatedAt),
  };
}

function normalizeDetectedLanguage(value) {
  const language = String(value || "").trim();
  return language.length <= 35 && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(language)
    ? language
    : null;
}

function runtimeStateForStatus(status = {}, runtimeActive = false, details = {}) {
  const level = String(status.level || "idle");
  const active = runtimeActive === true;
  const pauseSupported = details.pauseSupported !== false;
  const paused = active && pauseSupported && details.paused === true;
  const state = level === "error"
    ? "error"
    : paused || level === "paused"
      ? "paused"
    : level === "listening" || (["ok", "ready", "warning"].includes(level) && active)
      ? "listening"
      : level === "connecting"
        ? "connecting"
        : "idle";
  return {
    state,
    active,
    message: String(status.message || "Sẵn sàng"),
    latencyMs: finiteNonNegative(details.latencyMs ?? status.latencyMs),
    paused,
    armed: details.armed === true,
    canPause: active && pauseSupported && !paused,
    canResume: active && pauseSupported && paused,
    canStop: active,
    detectedLanguage: normalizeDetectedLanguage(details.detectedLanguage),
    languageDetectionMs: finiteNonNegative(details.languageDetectionMs),
    telemetry: normalizeRuntimeTelemetry(details.telemetry),
  };
}

function configureDesktopIdentity(app, pathModule, fsModule = require("node:fs")) {
  app.setName("AudioTranslate");
  if (app.isPackaged) return app.getPath("userData");
  const userData = pathModule.join(app.getPath("appData"), "AudioTranslate");
  fsModule.mkdirSync(userData, { recursive: true, mode: 0o700 });
  app.setPath("userData", userData);
  return userData;
}

module.exports = {
  assertGenericDesktopPatch,
  beforeQuitAction,
  configureDesktopIdentity,
  controlWindowChromeOptions,
  configFromDesktopSettings,
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
  validPairingToken,
};
