const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  beforeQuitAction,
  configureDesktopIdentity,
  controlWindowChromeOptions,
  configFromDesktopSettings,
  desktopEditMenuTemplate,
  desktopSettingsMigrationPatch,
  assertGenericDesktopPatch,
  desktopConfigFromArgs,
  ensurePairingToken,
  finalizeOverlayLockChange,
  normalizeDesktopProvider,
  publicPairingStatus,
  providerStartMode,
  quitDecision,
  runIsolatedProviderProbe,
  runtimeStateForStatus,
  shouldOpenDesktopGateway,
  settingsPatchRequiresRuntimeStop,
} = require("../src/desktop-control-policy");

test("desktop settings produce explicit Gemini low-latency provider options", () => {
  const config = configFromDesktopSettings(
    { host: "127.0.0.1", geminiModel: "gemini-test" },
    {
      provider: "gemini",
      source: { language: "auto", languageHints: ["en-US"], targetLanguage: "vi" },
      cloud: { consent: "gemini:audio:v1", maxMinutes: 15 },
      captions: {
        mode: "fastest",
        echoTargetLanguage: false,
        resetGapMs: 1100,
        finalDebounceMs: 120,
      },
      translation: {
        mode: "balanced",
        transcriptionModel: "gemini-transcribe-test",
        textModel: "gemini-flash-lite-test",
        contextTurns: 5,
        partialThrottleMs: 600,
        glossary: "council = hội đồng",
        characterContext: "Alex: older sister of Sam.",
        unknown: "must-not-cross",
      },
      overlay: { showSource: false },
    },
    { authToken: "local-pairing", geminiApiKey: "cloud-secret" },
  );

  assert.equal(config.provider, "gemini");
  assert.equal(config.sourceLanguage, "auto");
  assert.deepEqual(config.sourceLanguageCandidates, ["en-US"]);
  assert.equal(config.targetLanguage, "vi");
  assert.equal(config.geminiInputTranscription, false);
  assert.equal(config.geminiEchoTargetLanguage, false);
  assert.equal(config.geminiFinalDebounceMs, 120);
  assert.equal(config.captionResetGapMs, 1100);
  assert.equal(config.showSource, false);
  assert.equal(config.authToken, "local-pairing");
  assert.equal(config.geminiApiKey, "cloud-secret");
  assert.equal(config.geminiTranslationMode, "balanced");
  assert.equal(config.geminiTranscriptionModel, "gemini-transcribe-test");
  assert.equal(config.geminiTextModel, "gemini-flash-lite-test");
  assert.equal(config.geminiContextTurns, 5);
  assert.equal(config.geminiPartialThrottleMs, 600);
  assert.equal(config.geminiGlossary, "council = hội đồng");
  assert.equal(config.geminiCharacterContext, "Alex: older sister of Sam.");
  assert.equal(Object.hasOwn(config, "unknown"), false);
});

test("desktop pairing reuses an environment token without persisting or exposing it", () => {
  const environmentToken = "environment-pairing-token-123456789";
  const calls = [];
  const store = {
    get: () => "",
    set: (...args) => calls.push(args),
    status: () => ({ provider: "pairing", configured: false, storage: "encrypted", backend: "platform" }),
  };

  assert.equal(ensurePairingToken(store, environmentToken), environmentToken);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(JSON.stringify(publicPairingStatus(store, environmentToken)), new RegExp(environmentToken));
});

test("desktop config ignores stale cloud/env-style arguments and accepts only preview mode", () => {
  const fakeGetConfig = (_argv, env, parsed) => ({
    provider: env.AUDIOTRANSLATE_PROVIDER || parsed.provider || "demo",
    sourceLanguage: parsed.source || "en-US",
    sourceLanguageCandidates: ["ja-JP"],
    targetLanguage: parsed.target || "vi",
    authToken: env.AUDIOTRANSLATE_TOKEN || "",
    cloudConsent: env.AUDIOTRANSLATE_CLOUD_CONSENT || "",
    geminiApiKey: env.GEMINI_API_KEY || "",
    preview: parsed.preview === true,
    allowedExtensionIds: ["docfjemeacdakckkamiiopljhmgjgfgl"],
  });
  const config = desktopConfigFromArgs(
    ["--preview", "--provider", "gemini", "--source", "ja-JP", "--target", "en"],
    fakeGetConfig,
  );

  assert.equal(config.preview, true);
  assert.equal(config.provider, "demo");
  assert.equal(config.sourceLanguage, "auto");
  assert.deepEqual(config.sourceLanguageCandidates, []);
  assert.equal(config.targetLanguage, "vi");
  assert.equal(config.authToken, "");
  assert.equal(config.cloudConsent, "");
  assert.equal(config.geminiApiKey, "");
});

test("desktop pairing creates a CSPRNG token in SecretStore when no token exists", () => {
  let stored = "";
  const store = {
    get: () => stored,
    set(provider, value) {
      assert.equal(provider, "pairing");
      stored = value;
      return { provider, configured: true, storage: "encrypted", backend: "platform" };
    },
    status: () => ({ provider: "pairing", configured: Boolean(stored), storage: "encrypted", backend: "platform" }),
  };
  const token = ensurePairingToken(store, "", () => Buffer.alloc(32, 9));

  assert.equal(token, Buffer.alloc(32, 9).toString("base64url"));
  assert.equal(stored, token);
  assert.deepEqual(publicPairingStatus(store, ""), {
    configured: true,
    storage: "encrypted",
    backend: "platform",
  });
});

test("desktop provider policy enables only implemented Control Center providers", () => {
  assert.equal(normalizeDesktopProvider("demo"), "demo");
  assert.equal(normalizeDesktopProvider("gemini"), "gemini");
  assert.throws(() => normalizeDesktopProvider("openai"), /chưa khả dụng/i);
  assert.throws(() => normalizeDesktopProvider("local"), /chưa khả dụng/i);
});

test("quit policy requires one confirmation only while audio runtime is active", () => {
  assert.deepEqual(quitDecision(false, false), { needsConfirmation: false, shouldQuit: true });
  assert.deepEqual(quitDecision(true, false), { needsConfirmation: true, shouldQuit: false });
  assert.deepEqual(quitDecision(true, true), { needsConfirmation: false, shouldQuit: true });
});

test("provider start policy runs Demo as a synthetic preview and gates Gemini cloud", () => {
  assert.equal(providerStartMode("demo", {}), "synthetic-preview");
  assert.throws(
    () => providerStartMode("gemini", { keyConfigured: false, verified: false, consent: "" }),
    /API key/i,
  );
  assert.throws(
    () => providerStartMode("gemini", { keyConfigured: true, verified: false, consent: "gemini:audio:v1" }),
    /kiểm tra kết nối/i,
  );
  assert.throws(
    () => providerStartMode("gemini", { keyConfigured: true, verified: true, consent: "" }),
    /cho phép gửi audio/i,
  );
  assert.equal(
    providerStartMode("gemini", {
      keyConfigured: true,
      verified: true,
      consent: "gemini:audio:v1",
    }),
    "realtime-gateway",
  );
});

test("active runtime stops before source, language, or consent changes become visible", () => {
  assert.equal(settingsPatchRequiresRuntimeStop(false, { source: { language: "ja-JP" } }, {}), false);
  assert.equal(settingsPatchRequiresRuntimeStop(true, { overlay: { showSource: false } }, {}), true);
  assert.equal(settingsPatchRequiresRuntimeStop(true, { source: { language: "ja-JP" } }, {}), true);
  assert.equal(settingsPatchRequiresRuntimeStop(true, { source: { kind: "file" } }, {}), true);
  assert.equal(
    settingsPatchRequiresRuntimeStop(
      true,
      { translation: { mode: "accurate" } },
      { translation: { mode: "balanced" } },
    ),
    true,
  );
  assert.equal(
    settingsPatchRequiresRuntimeStop(
      true,
      { captions: { mode: "bilingual" } },
      { captions: { mode: "fastest" } },
    ),
    true,
  );
  assert.equal(
    settingsPatchRequiresRuntimeStop(
      true,
      { captions: { echoTargetLanguage: true } },
      { captions: { echoTargetLanguage: false } },
    ),
    true,
  );
  assert.equal(
    settingsPatchRequiresRuntimeStop(
      true,
      { cloud: { consent: "" } },
      { cloud: { consent: "gemini:audio:v1" } },
    ),
    true,
  );
});

test("successful credential test is idle while a successful active provider is listening", () => {
  assert.equal(runtimeStateForStatus({ level: "ok", message: "Key hợp lệ" }, false).state, "idle");
  assert.equal(runtimeStateForStatus({ level: "ok", message: "Provider ready" }, true).state, "listening");
  assert.equal(runtimeStateForStatus({ level: "ready", message: "File audio source is ready" }, true).state, "listening");
  assert.equal(runtimeStateForStatus({ level: "ready", message: "Provider ready" }, false).state, "idle");
  assert.equal(runtimeStateForStatus({ level: "warning", message: "Đang kết nối lại" }, true).state, "listening");
  assert.equal(runtimeStateForStatus({ level: "warning", message: "Chưa có phiên" }, false).state, "idle");
  assert.equal(runtimeStateForStatus({ level: "connecting" }, false).state, "connecting");
  assert.deepEqual(runtimeStateForStatus({ level: "error" }, true), {
    state: "error",
    active: true,
    message: "Sẵn sàng",
    latencyMs: null,
    paused: false,
    armed: false,
    canPause: true,
    canResume: false,
    canStop: true,
    detectedLanguage: null,
    languageDetectionMs: null,
    telemetry: {
      rms: 0,
      peak: 0,
      speech: false,
      silenceMs: 0,
      packetGapCount: 0,
      droppedFrames: 0,
      queueMs: null,
      updatedAt: null,
    },
    diagnostics: null,
  });
  assert.deepEqual(runtimeStateForStatus({ level: "error" }, false), {
    state: "error",
    active: false,
    message: "Sẵn sàng",
    latencyMs: null,
    paused: false,
    armed: false,
    canPause: false,
    canResume: false,
    canStop: false,
    detectedLanguage: null,
    languageDetectionMs: null,
    telemetry: {
      rms: 0,
      peak: 0,
      speech: false,
      silenceMs: 0,
      packetGapCount: 0,
      droppedFrames: 0,
      queueMs: null,
      updatedAt: null,
    },
    diagnostics: null,
  });
});

test("runtime snapshot keeps errors truthful while exposing independent pause and stop controls", () => {
  const telemetry = {
    rms: 0.25,
    peak: 0.75,
    speech: true,
    silenceMs: 0,
    packetGapCount: 2,
    droppedFrames: 3,
    queueMs: 41,
    updatedAt: 5_000,
    pcm: "must be discarded",
  };
  assert.deepEqual(
    runtimeStateForStatus(
      { level: "error", message: "Provider warning" },
      true,
      {
        armed: true,
        paused: false,
        latencyMs: 375,
        detectedLanguage: "ja-JP",
        languageDetectionMs: 840,
        telemetry,
      },
    ),
    {
      state: "error",
      active: true,
      message: "Provider warning",
      latencyMs: 375,
      paused: false,
      armed: true,
      canPause: true,
      canResume: false,
      canStop: true,
      detectedLanguage: "ja-JP",
      languageDetectionMs: 840,
      telemetry: {
        rms: 0.25,
        peak: 0.75,
        speech: true,
        silenceMs: 0,
        packetGapCount: 2,
        droppedFrames: 3,
        queueMs: 41,
        updatedAt: 5_000,
      },
      diagnostics: null,
    },
  );
  const paused = runtimeStateForStatus(
    { level: "paused", message: "Paused" },
    true,
    { armed: true, paused: true },
  );
  assert.equal(paused.state, "paused");
  assert.equal(paused.canPause, false);
  assert.equal(paused.canResume, true);
  assert.equal(paused.canStop, true);
});

test("synthetic preview stays active and stoppable without advertising audio pause", () => {
  const runtime = runtimeStateForStatus(
    { level: "listening", message: "Demo preview" },
    true,
    { armed: true, pauseSupported: false },
  );
  assert.equal(runtime.state, "listening");
  assert.equal(runtime.active, true);
  assert.equal(runtime.canPause, false);
  assert.equal(runtime.canResume, false);
  assert.equal(runtime.canStop, true);
});

test("Gemini credential probe is rejected while a runtime is active", async () => {
  let created = false;
  await assert.rejects(
    runIsolatedProviderProbe(true, () => {
      created = true;
      return { async start() {}, async stop() {} };
    }),
    /dừng phiên dịch/i,
  );
  assert.equal(created, false);
});

test("Gemini credential probe isolates provider start and stop statuses from session UI", async () => {
  const providerEvents = [];
  let stopped = false;
  await runIsolatedProviderProbe(false, (callbacks) => ({
    async start() {
      callbacks.onStatus({ level: "listening", message: "probe connected" });
      callbacks.onError(new Error("probe diagnostic"));
    },
    async stop() {
      stopped = true;
      callbacks.onStatus({ level: "idle", message: "probe stopped" });
      providerEvents.push("provider-stop-complete");
    },
  }));

  assert.equal(stopped, true);
  assert.deepEqual(providerEvents, ["provider-stop-complete"]);
});

test("desktop gateway listens only for an explicitly activated runtime", () => {
  assert.equal(shouldOpenDesktopGateway(false), false);
  assert.equal(shouldOpenDesktopGateway(), false);
  assert.equal(shouldOpenDesktopGateway(true), true);
});

test("before-quit asks once for active audio then performs one non-recursive shutdown", () => {
  assert.equal(beforeQuitAction({ runtimeActive: true }), "confirm");
  assert.equal(beforeQuitAction({ runtimeActive: true, confirmationPending: true }), "block");
  assert.equal(beforeQuitAction({ runtimeActive: true, quitApproved: true }), "shutdown");
  assert.equal(beforeQuitAction({ runtimeActive: false }), "shutdown");
  assert.equal(beforeQuitAction({ shutdownStarted: true }), "block");
  assert.equal(beforeQuitAction({ shutdownComplete: true }), "allow");
});

test("desktop Edit menu preserves native API-key text editing shortcuts", () => {
  const menu = desktopEditMenuTemplate();
  assert.equal(menu.label, "Sửa");
  assert.deepEqual(
    menu.submenu.map((item) => item.role || item.type),
    ["undo", "redo", "separator", "cut", "copy", "paste", "selectAll"],
  );
});

test("desktop identity uses a dedicated AudioTranslate user-data directory before locking", () => {
  const calls = [];
  const fs = { mkdirSync: (...args) => calls.push(["mkdir", ...args]) };
  const app = {
    isPackaged: false,
    setName: (name) => calls.push(["name", name]),
    getPath: (name) => {
      assert.equal(name, "appData");
      return "/Users/example/Library/Application Support";
    },
    setPath: (name, value) => calls.push([name, value]),
  };

  const configured = configureDesktopIdentity(app, path, fs);
  assert.equal(configured, "/Users/example/Library/Application Support/AudioTranslate");
  assert.deepEqual(calls, [
    ["name", "AudioTranslate"],
    ["mkdir", configured, { recursive: true, mode: 0o700 }],
    ["userData", configured],
  ]);
});

test("Control Center uses one frameless branded titlebar on every desktop platform", () => {
  assert.deepEqual(controlWindowChromeOptions("darwin"), {
    frame: false,
    autoHideMenuBar: false,
  });
  assert.deepEqual(controlWindowChromeOptions("win32"), {
    frame: false,
    autoHideMenuBar: true,
  });
});

test("desktop migrates a legacy Azure selection to safe local Demo state", () => {
  assert.deepEqual(
    desktopSettingsMigrationPatch({
      provider: "azure",
      cloud: { consent: "azure:tab-audio:v1", maxMinutes: 30 },
    }),
    { provider: "demo", cloud: { consent: "", maxMinutes: 30 } },
  );
  assert.equal(desktopSettingsMigrationPatch({ provider: "demo" }), null);
  assert.equal(desktopSettingsMigrationPatch({ provider: "gemini" }), null);
  assert.deepEqual(
    desktopSettingsMigrationPatch(
      { provider: "gemini", cloud: { consent: "gemini:audio:v1", maxMinutes: 30 } },
      { preview: true },
    ),
    { provider: "demo", cloud: { consent: "", maxMinutes: 30 } },
  );
});

test("generic settings IPC cannot bypass the validated provider action", () => {
  assert.throws(
    () => assertGenericDesktopPatch({ provider: "azure" }),
    /control:set-provider/,
  );
  assert.deepEqual(
    assertGenericDesktopPatch({ source: { language: "auto" } }),
    { source: { language: "auto" } },
  );
});

test("external overlay unlock makes the window visible before publishing its snapshot", () => {
  const calls = [];
  const overlayWindow = {
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
    showInactive: () => calls.push("showInactive"),
  };
  finalizeOverlayLockChange(overlayWindow, false, () => calls.push("publish"));
  assert.deepEqual(calls, ["show", "focus", "publish"]);

  calls.length = 0;
  finalizeOverlayLockChange(overlayWindow, true, () => calls.push("publish"));
  assert.deepEqual(calls, ["showInactive", "publish"]);
});
