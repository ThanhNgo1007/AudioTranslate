import type {
  CaptionPreview,
  ControlCenterAPI,
  ControlCenterClient,
  ControlCenterSnapshot,
  DiagnosticsReport,
  LanguageState,
  OverlaySettings,
  PrivacySettings,
  ProviderId,
  SourceSelection,
  TranslationSettings,
} from "./types";
import { finishFileSessionWithFreshSnapshot } from "./file-session-result.mjs";
import { stopOwnedFileStreamer } from "./file-streamer-lifecycle.mjs";
import { buildNativeOverlayPatch } from "./overlay-update.mjs";
import { normalizeOverlaySettings } from "./overlay-snapshot.mjs";
import { rendererOwnedSourceLabel } from "./source-display.mjs";
import { normalizeAudioTelemetry } from "./runtime-insights.mjs";
import { normalizeDiagnosticsReport } from "./diagnostics-display.mjs";
import { normalizeTranslationSettings } from "./translation-profile.mjs";

interface FileSourceMeta {
  displayName: string;
  fileBytes: number;
  mimeType: string;
  sampleRate: 16_000;
  channels: 1;
  encoding: "pcm_s16le";
  destination: "google-gemini";
  consentVersion: "gemini:file-audio:v1";
}

interface NativeControlCenterAPI {
  getSnapshot(): Promise<unknown>;
  updateSettings(patch: Record<string, unknown>): Promise<unknown>;
  saveSecret(provider: "gemini", key: string): Promise<unknown>;
  deleteSecret(provider: "gemini"): Promise<unknown>;
  testProvider(provider: "gemini"): Promise<unknown>;
  setProvider(provider: ProviderId): Promise<unknown>;
  copyPairingToken(): Promise<unknown>;
  startRuntime(): Promise<unknown>;
  stopRuntime(): Promise<unknown>;
  setRuntimePaused(paused: boolean): Promise<unknown>;
  runDiagnostics(): Promise<unknown>;
  hideControlCenter(): Promise<unknown>;
  toggleOverlay(): Promise<unknown>;
  requestQuit(confirmActive?: boolean): Promise<unknown>;
  setOverlayLocked(locked: boolean): Promise<unknown>;
  resetOverlay(): Promise<unknown>;
  startFileSource(meta: FileSourceMeta): Promise<unknown>;
  pushFileAudio(
    chunk: ArrayBuffer,
    metadata: { sequence: number; capturedAt: number },
  ): boolean;
  stopFileSource(): Promise<unknown>;
  onSnapshot(callback: (snapshot: unknown) => void): () => void;
  onRuntimeStatus(callback: (status: unknown) => void): () => void;
  onCaption(callback: (caption: CaptionPreview) => void): () => void;
  onFileSourceInvalidated(callback: (payload: { reason?: string }) => void): () => void;
}

declare global {
  interface Window {
    audioTranslateControl?: NativeControlCenterAPI;
  }
}

let selectedFile: File | null = null;
let tabSourceSelected = false;
let keySavedThisSession = false;
let providerTestedThisSession = false;
let activeFileStreamer: FileAudioStreamer | null = null;

function stopActiveFileStreamer() {
  return stopOwnedFileStreamer(
    () => activeFileStreamer,
    (next) => { activeFileStreamer = next; },
  );
}

function selectLocalMediaFile() {
  return new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,video/*,.mkv,.m4a,.mp3,.mp4,.ogg,.opus,.wav,.webm";
    input.multiple = false;
    input.addEventListener("change", () => resolve(input.files?.item(0) ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

function mediaMimeType(file: File) {
  if (/^(audio|video)\/[a-z0-9][a-z0-9.+-]{0,126}$/i.test(file.type)) return file.type;
  const extension = file.name.toLowerCase().split(".").pop();
  const inferred: Record<string, string> = {
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    mkv: "video/x-matroska",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    wav: "audio/wav",
    webm: "video/webm",
  };
  return inferred[extension || ""] || "audio/x-unknown";
}

function fileMetadata(file: File): FileSourceMeta {
  return {
    displayName: file.name,
    fileBytes: file.size,
    mimeType: mediaMimeType(file),
    sampleRate: 16_000,
    channels: 1,
    encoding: "pcm_s16le",
    destination: "google-gemini",
    consentVersion: "gemini:file-audio:v1",
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeSnapshot(rawValue: unknown): ControlCenterSnapshot {
  const raw = recordOf(rawValue);
  const settings = recordOf(raw.settings || raw);
  const sourceSettings = recordOf(settings.source);
  const rawSource = recordOf(raw.source);
  const secrets = recordOf(raw.secrets);
  const geminiSecret = recordOf(secrets.gemini);
  const rawPairing = recordOf(raw.pairing);
  const providerState = typeof raw.provider === "object" ? recordOf(raw.provider) : recordOf(raw.providerState);
  const runtime = recordOf(raw.runtime || raw.session);
  const overlay = recordOf(settings.overlay || raw.overlay);
  const translation = normalizeTranslationSettings(settings.translation || raw.translation);
  const nativeKind = String(rawSource.kind || sourceSettings.kind || "tab");
  const sourceKind = nativeKind === "file" ? "file" : "browser-tab";
  const fileSelected = sourceKind === "file" && selectedFile !== null;
  const sourceConnected = sourceKind === "file"
    ? fileSelected && rawSource.connected === true
    : tabSourceSelected;
  const sessionState = String(runtime.state || "idle");
  const activeProvider = settings.provider === "gemini" || providerState.active === "gemini"
    ? "gemini"
    : "demo";
  const normalizedSessionState = new Set(["idle", "connecting", "listening", "paused", "stopping", "error"]).has(sessionState)
    ? sessionState as ControlCenterSnapshot["session"]["state"]
    : sessionState === "running" || sessionState === "ready"
      ? "listening"
      : "idle";

  return {
    provider: {
      active: activeProvider,
      keyConfigured: Boolean(
        providerState.keyConfigured ?? geminiSecret.configured ?? raw.geminiKeyConfigured ?? keySavedThisSession,
      ),
      maskedKeyHint: typeof providerState.maskedKeyHint === "string"
        ? providerState.maskedKeyHint
        : keySavedThisSession ? "••••••••••••••••" : undefined,
      connected: Boolean(
        providerState.connected ?? raw.providerConnected ?? providerTestedThisSession,
      ),
      model: typeof providerState.model === "string"
        ? providerState.model
        : "gemini-3.5-live-translate-preview",
      storage: ["encrypted", "session-only", "environment"].includes(String(providerState.storage || geminiSecret.storage))
        ? String(providerState.storage || geminiSecret.storage) as ControlCenterSnapshot["provider"]["storage"]
        : "unavailable",
      storageBackend: typeof providerState.storageBackend === "string"
        ? providerState.storageBackend
        : typeof geminiSecret.backend === "string" ? geminiSecret.backend : undefined,
    },
    pairing: {
      configured: rawPairing.configured === true,
      storage: ["encrypted", "session-only", "environment"].includes(String(rawPairing.storage))
        ? String(rawPairing.storage) as ControlCenterSnapshot["pairing"]["storage"]
        : "unavailable",
      backend: typeof rawPairing.backend === "string" ? rawPairing.backend : undefined,
    },
    source: {
      kind: sourceKind,
      connected: sourceConnected,
      label: rendererOwnedSourceLabel({
        sourceKind,
        selectedFileName: fileSelected ? selectedFile!.name : "",
        tabSourceSelected,
        mainLabel: typeof rawSource.label === "string" ? rawSource.label : "",
      }),
    },
    languages: {
      source: String(recordOf(raw.languages).source || sourceSettings.language || "auto"),
      target: String(recordOf(raw.languages).target || sourceSettings.targetLanguage || "vi"),
      detected: typeof runtime.detectedLanguage === "string" ? runtime.detectedLanguage : null,
      detectionMs: typeof runtime.languageDetectionMs === "number" ? runtime.languageDetectionMs : null,
    },
    translation,
    privacy: {
      cloudConsent: recordOf(raw.privacy).cloudConsent === true || recordOf(settings.cloud).consent === "gemini:audio:v1",
      maxCloudMinutes: Math.round(numberOr(recordOf(raw.privacy).maxCloudMinutes, numberOr(recordOf(settings.cloud).maxMinutes, 30))),
    },
    overlay: normalizeOverlaySettings(overlay),
    displays: Array.isArray(raw.displays)
      ? raw.displays.flatMap((item) => {
        const display = recordOf(item);
        if (typeof display.id !== "string" || typeof display.label !== "string") return [];
        return [{ id: display.id, label: display.label, primary: display.primary === true }];
      })
      : [],
    audio: normalizeAudioTelemetry(runtime.telemetry),
    app: {
      overlayVisible: recordOf(raw.app).overlayVisible !== false,
      controlVisible: recordOf(raw.app).controlVisible !== false,
    },
    session: {
      state: normalizedSessionState,
      active: runtime.active === true || normalizedSessionState === "listening" || normalizedSessionState === "paused" || normalizedSessionState === "connecting",
      message: typeof runtime.message === "string" ? runtime.message : "Sẵn sàng thiết lập",
      latencyMs: typeof runtime.latencyMs === "number" ? runtime.latencyMs : null,
      paused: runtime.paused === true,
      armed: runtime.armed === true,
      canPause: runtime.canPause === true,
      canResume: runtime.canResume === true,
      canStop: runtime.canStop === true,
    },
  };
}

class FileAudioStreamer {
  private media: HTMLAudioElement | null = null;
  private context: AudioContext | null = null;
  private objectUrl: string | null = null;
  private sequence = 0;
  private stopped = false;
  private sendQueue = Promise.resolve();
  private onEnded: () => Promise<void>;

  constructor(
    private readonly nativeClient: NativeControlCenterAPI,
    onEnded: () => Promise<void>,
  ) {
    this.onEnded = onEnded;
  }

  private enqueuePcm(buffer: ArrayBuffer) {
    if (buffer.byteLength !== 3_200) {
      new Uint8Array(buffer).fill(0);
      return;
    }
    const sequence = this.sequence;
    this.sequence += 1;
    this.sendQueue = this.sendQueue.then(() => {
      if (this.stopped) {
        new Uint8Array(buffer).fill(0);
        return;
      }
      const accepted = this.nativeClient.pushFileAudio(buffer, { sequence, capturedAt: Date.now() });
      new Uint8Array(buffer).fill(0);
      if (!accepted) void this.stop();
    });
  }

  private connectScriptProcessor(
    context: AudioContext,
    source: MediaElementAudioSourceNode,
    destination: AudioNode,
  ) {
    const processor = context.createScriptProcessor(4_096, 2, 2);
    const resampler = new MonoPcm16Resampler(context.sampleRate, (buffer) => this.enqueuePcm(buffer));
    processor.onaudioprocess = (event) => {
      const inputs = Array.from(
        { length: event.inputBuffer.numberOfChannels },
        (_, index) => event.inputBuffer.getChannelData(index),
      );
      const outputs = Array.from(
        { length: event.outputBuffer.numberOfChannels },
        (_, index) => event.outputBuffer.getChannelData(index),
      );
      for (let channel = 0; channel < outputs.length; channel += 1) {
        outputs[channel].set(inputs[Math.min(channel, inputs.length - 1)] || new Float32Array(outputs[channel].length));
      }
      resampler.push(inputs);
    };
    this.media!.addEventListener("ended", () => resampler.flush(), { once: true });
    source.connect(processor).connect(destination);
  }

  async start(file: File) {
    this.stopped = false;
    this.sequence = 0;
    this.objectUrl = URL.createObjectURL(file);
    const media = new Audio();
    media.preload = "auto";
    media.src = this.objectUrl;
    this.media = media;
    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
    const source = context.createMediaElementSource(media);
    const outputGain = context.createGain();
    outputGain.gain.value = 1;
    outputGain.connect(context.destination);
    let workletHandlesEnd = false;

    if (context.audioWorklet) {
      workletHandlesEnd = true;
      const moduleUrl = new URL("./file-audio-worklet.js", document.baseURI).href;
      await context.audioWorklet.addModule(moduleUrl);
      const worklet = new AudioWorkletNode(context, "audiotranslate-file-pcm16", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      worklet.port.onmessage = (event: MessageEvent<{ type: string; pcm?: ArrayBuffer }>) => {
        if (event.data?.type === "pcm16" && event.data.pcm) this.enqueuePcm(event.data.pcm);
        if (event.data?.type === "flushed") {
          void this.sendQueue.finally(() => this.onEnded());
        }
      };
      media.addEventListener("ended", () => worklet.port.postMessage({ type: "flush" }), { once: true });
      source.connect(worklet).connect(outputGain);
    } else {
      this.connectScriptProcessor(context, source, outputGain);
    }

    if (!workletHandlesEnd) {
      media.addEventListener("ended", () => {
        void this.sendQueue.finally(() => this.onEnded());
      }, { once: true });
    }
    media.addEventListener("error", () => {
      void this.stop().finally(() => this.onEnded());
    }, { once: true });
    await context.resume();
    await media.play();
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.media?.pause();
    if (this.media) {
      this.media.removeAttribute("src");
      this.media.load();
    }
    if (this.context && this.context.state !== "closed") await this.context.close().catch(() => undefined);
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.media = null;
    this.context = null;
    this.objectUrl = null;
    await this.sendQueue.catch(() => undefined);
  }
}

class MonoPcm16Resampler {
  private readonly ratio: number;
  private nextInputFrame = 0;
  private totalInputFrames = 0;
  private previousSample = 0;
  private frame = new Int16Array(1_600);
  private frameOffset = 0;

  constructor(
    sourceSampleRate: number,
    private readonly emit: (buffer: ArrayBuffer) => void,
  ) {
    this.ratio = sourceSampleRate / 16_000;
  }

  private write(sample: number) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.frame[this.frameOffset] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.frameOffset += 1;
    if (this.frameOffset === this.frame.length) {
      const complete = this.frame;
      this.frame = new Int16Array(1_600);
      this.frameOffset = 0;
      this.emit(complete.buffer);
    }
  }

  push(channels: Float32Array[]) {
    if (channels.length === 0 || channels[0].length === 0) return;
    const frameCount = channels[0].length;
    const blockStart = this.totalInputFrames;
    const blockEnd = blockStart + frameCount;
    const monoAt = (index: number) => {
      let sum = 0;
      for (const channel of channels) sum += channel[index] || 0;
      return sum / channels.length;
    };

    while (this.nextInputFrame < blockEnd) {
      const local = this.nextInputFrame - blockStart;
      let sample: number;
      if (local < 0) {
        const fraction = local + 1;
        sample = this.previousSample + (monoAt(0) - this.previousSample) * fraction;
      } else {
        const lower = Math.floor(local);
        if (lower + 1 >= frameCount) break;
        const fraction = local - lower;
        const left = monoAt(lower);
        sample = left + (monoAt(lower + 1) - left) * fraction;
      }
      this.write(sample);
      this.nextInputFrame += this.ratio;
    }
    this.previousSample = monoAt(frameCount - 1);
    this.totalInputFrames = blockEnd;
  }

  flush() {
    if (this.frameOffset === 0) return;
    this.frame.fill(0, this.frameOffset);
    const finalFrame = this.frame;
    this.frame = new Int16Array(1_600);
    this.frameOffset = 0;
    this.emit(finalFrame.buffer);
  }
}

function createNativeClient(nativeClient: NativeControlCenterAPI): ControlCenterClient {
  const readSnapshot = async () => normalizeSnapshot(await nativeClient.getSnapshot());
  const withLatestSnapshot = async (operation: () => Promise<unknown>) => {
    await operation();
    return readSnapshot();
  };
  nativeClient.onFileSourceInvalidated(() => {
    void stopActiveFileStreamer();
  });

  return {
    available: true,
    mode: "native",
    getSnapshot: readSnapshot,
    async saveGeminiKey({ apiKey }) {
      await nativeClient.saveSecret("gemini", apiKey);
      keySavedThisSession = true;
      providerTestedThisSession = false;
      return readSnapshot();
    },
    async clearGeminiKey() {
      await nativeClient.deleteSecret("gemini");
      keySavedThisSession = false;
      providerTestedThisSession = false;
      return readSnapshot();
    },
    async testGeminiConnection() {
      await nativeClient.testProvider("gemini");
      providerTestedThisSession = true;
      return readSnapshot();
    },
    selectProvider: ({ provider }) => withLatestSnapshot(async () => {
      await stopActiveFileStreamer();
      await nativeClient.stopFileSource().catch(() => undefined);
      await nativeClient.setProvider(provider);
    }),
    async copyPairingToken() {
      const result = recordOf(await nativeClient.copyPairingToken());
      return { copied: result.copied === true };
    },
    async selectSource({ kind }) {
      await stopActiveFileStreamer();
      tabSourceSelected = false;
      if (kind === "browser-tab") selectedFile = null;
      await nativeClient.updateSettings({
        source: {
          kind: kind === "browser-tab" ? "tab" : "file",
          fileSelected: false,
        },
      });
      return readSnapshot();
    },
    async connectBrowserTab() {
      await stopActiveFileStreamer();
      selectedFile = null;
      await nativeClient.updateSettings({ source: { kind: "tab" } });
      tabSourceSelected = true;
      return readSnapshot();
    },
    async pickAudioFile() {
      const file = await selectLocalMediaFile();
      if (!file) return readSnapshot();
      await stopActiveFileStreamer();
      await nativeClient.updateSettings({ source: { kind: "file", fileSelected: true } });
      selectedFile = file;
      tabSourceSelected = false;
      return readSnapshot();
    },
    updateLanguages: async (languages) => {
      await stopActiveFileStreamer();
      return withLatestSnapshot(() => nativeClient.updateSettings({
        source: { language: languages.source, targetLanguage: languages.target },
      }));
    },
    updateTranslation: async (translation) => {
      await stopActiveFileStreamer();
      return withLatestSnapshot(() => nativeClient.updateSettings({ translation }));
    },
    updatePrivacy: async (privacy) => {
      await stopActiveFileStreamer();
      return withLatestSnapshot(() => nativeClient.updateSettings({
        cloud: {
          ...(privacy.cloudConsent !== undefined
            ? { consent: privacy.cloudConsent ? "gemini:audio:v1" : "" }
            : {}),
          ...(privacy.maxCloudMinutes !== undefined
            ? { maxMinutes: privacy.maxCloudMinutes }
            : {}),
        },
      }));
    },
    async updateOverlay(overlay) {
      if (typeof overlay.clickThrough === "boolean") {
        await nativeClient.setOverlayLocked(overlay.clickThrough);
      }
      const current = await readSnapshot();
      const nativeOverlay = buildNativeOverlayPatch(current.overlay, overlay);
      return withLatestSnapshot(() => nativeClient.updateSettings({ overlay: nativeOverlay }));
    },
    async startSession() {
      const current = await readSnapshot();
      if (current.provider.active === "gemini" && current.source.kind === "file" && !selectedFile) {
        throw new Error("Tệp đã chọn không còn khả dụng; vui lòng chọn lại.");
      }
      const runtimeSnapshot = await withLatestSnapshot(() => nativeClient.startRuntime());
      if (current.provider.active === "gemini" && current.source.kind === "file") {
        try {
          await nativeClient.startFileSource(fileMetadata(selectedFile!));
          const streamer = new FileAudioStreamer(nativeClient, async () => {
            await stopActiveFileStreamer();
            selectedFile = null;
            await nativeClient.stopFileSource().catch(() => undefined);
            await nativeClient.stopRuntime().catch(() => undefined);
          });
          activeFileStreamer = streamer;
          return await finishFileSessionWithFreshSnapshot(
            () => streamer.start(selectedFile!),
            readSnapshot,
          );
        } catch (error) {
          await stopActiveFileStreamer();
          await nativeClient.stopFileSource().catch(() => undefined);
          await nativeClient.stopRuntime().catch(() => undefined);
          throw error;
        }
      }
      return runtimeSnapshot;
    },
    async stopSession() {
      const current = await readSnapshot();
      await stopActiveFileStreamer();
      if (current.source.kind === "file") await nativeClient.stopFileSource();
      return withLatestSnapshot(() => nativeClient.stopRuntime());
    },
    pauseSession: () => withLatestSnapshot(() => nativeClient.setRuntimePaused(true)),
    resumeSession: () => withLatestSnapshot(() => nativeClient.setRuntimePaused(false)),
    async runDiagnostics() {
      return normalizeDiagnosticsReport(await nativeClient.runDiagnostics());
    },
    resetOverlay: () => withLatestSnapshot(() => nativeClient.resetOverlay()),
    async hideControlCenter() {
      await nativeClient.hideControlCenter();
    },
    toggleOverlay: () => withLatestSnapshot(() => nativeClient.toggleOverlay()),
    async requestQuit(confirmActive = false) {
      const result = recordOf(await nativeClient.requestQuit(confirmActive));
      return {
        needsConfirmation: result.needsConfirmation === true,
        shouldQuit: result.shouldQuit === true,
      };
    },
    onSnapshot: (callback) => nativeClient.onSnapshot((snapshot) => callback(normalizeSnapshot(snapshot))),
    onCaption: (callback) => nativeClient.onCaption(callback),
  };
}

const defaultSnapshot: ControlCenterSnapshot = {
  provider: {
    active: "gemini",
    keyConfigured: false,
    connected: false,
    model: "gemini-3.5-live-translate-preview",
    storage: "unavailable",
  },
  pairing: { configured: true, storage: "encrypted", backend: "platform" },
  source: {
    kind: "browser-tab",
    connected: false,
    label: "Chưa kết nối tab",
  },
  languages: {
    source: "auto",
    target: "vi",
    detected: null,
    detectionMs: null,
  },
  translation: normalizeTranslationSettings(),
  privacy: { cloudConsent: false, maxCloudMinutes: 30 },
  overlay: {
    preset: "cinema",
    fontSize: 34,
    backgroundOpacity: 72,
    maxWidth: 78,
    position: "bottom",
    showSource: true,
    clickThrough: true,
    highContrast: true,
    sourceFontSize: 17,
    fontWeight: 700,
    lineHeight: 1.24,
    maxLines: 2,
    hideAfterMs: 8_000,
    displayId: null,
  },
  displays: [],
  audio: { rms: 0, peak: 0, speech: false, silenceMs: 0, packetGapCount: 0, droppedFrames: 0, queueMs: null, updatedAt: 0 },
  app: { overlayVisible: true, controlVisible: true },
  session: {
    state: "idle",
    message: "Sẵn sàng thiết lập",
    latencyMs: null,
  },
};

function cloneSnapshot(snapshot: ControlCenterSnapshot) {
  return structuredClone(snapshot);
}

function createMockClient(): ControlCenterClient {
  let snapshot = cloneSnapshot(defaultSnapshot);
  const snapshotListeners = new Set<(next: ControlCenterSnapshot) => void>();
  const captionListeners = new Set<(caption: CaptionPreview) => void>();
  let captionTimer: number | null = null;

  const publish = () => {
    const next = cloneSnapshot(snapshot);
    snapshotListeners.forEach((listener) => listener(next));
    return next;
  };
  const wait = () => new Promise<void>((resolve) => window.setTimeout(resolve, 320));

  const stopCaptionTimer = () => {
    if (captionTimer !== null) window.clearInterval(captionTimer);
    captionTimer = null;
  };

  return {
    available: true,
    mode: "mock",
    async getSnapshot() {
      return cloneSnapshot(snapshot);
    },
    async saveGeminiKey({ apiKey }: { apiKey: string }) {
      await wait();
      snapshot.provider.keyConfigured = apiKey.trim().length >= 20;
      snapshot.provider.maskedKeyHint = snapshot.provider.keyConfigured ? "••••••••••••••7xQ" : undefined;
      snapshot.provider.connected = false;
      snapshot.session.message = snapshot.provider.keyConfigured
        ? "Khoá đã được lưu trong kho bảo mật (mô phỏng)"
        : "Khoá API chưa hợp lệ";
      return publish();
    },
    async selectProvider({ provider }: { provider: ProviderId }) {
      stopCaptionTimer();
      snapshot.provider.active = provider;
      snapshot.session = { state: "idle", message: provider === "demo" ? "Demo cục bộ đã sẵn sàng" : "Đã chọn Google Gemini", latencyMs: null };
      return publish();
    },
    async copyPairingToken() {
      await wait();
      snapshot.session.message = "Đã sao chép mã ghép nối (mô phỏng)";
      publish();
      return { copied: true };
    },
    async clearGeminiKey() {
      snapshot.provider = {
        ...snapshot.provider,
        keyConfigured: false,
        connected: false,
        maskedKeyHint: undefined,
      };
      snapshot.session.message = "Đã xoá khoá Gemini";
      return publish();
    },
    async testGeminiConnection() {
      snapshot.session = { state: "connecting", message: "Đang kiểm tra Gemini…", latencyMs: null };
      publish();
      await wait();
      snapshot.provider.connected = snapshot.provider.keyConfigured;
      snapshot.session = snapshot.provider.connected
        ? { state: "idle", message: "Gemini đã sẵn sàng", latencyMs: 286 }
        : { state: "error", message: "Hãy lưu khoá API trước", latencyMs: null };
      return publish();
    },
    async selectSource({ kind }: SourceSelection) {
      snapshot.source = {
        kind,
        connected: false,
        label: kind === "browser-tab" ? "Chưa kết nối tab" : "Chưa chọn tệp",
      };
      return publish();
    },
    async connectBrowserTab() {
      await wait();
      snapshot.source = {
        kind: "browser-tab",
        connected: true,
        label: "Tab Chrome / Edge đã ghép nối",
      };
      snapshot.session.message = "Đang nhận âm thanh tab qua kết nối nội bộ";
      return publish();
    },
    async pickAudioFile() {
      await wait();
      snapshot.source = {
        kind: "file",
        connected: true,
        label: "sample-dialogue.wav",
      };
      snapshot.session.message = "Tệp chỉ được đọc khi phiên dịch chạy";
      return publish();
    },
    async updateLanguages(languages: LanguageState) {
      snapshot.languages = languages;
      return publish();
    },
    async updateTranslation(translation: Partial<TranslationSettings>) {
      snapshot.translation = normalizeTranslationSettings({
        ...snapshot.translation,
        ...translation,
      });
      return publish();
    },
    async updatePrivacy(privacy: Partial<PrivacySettings>) {
      snapshot.privacy = { ...snapshot.privacy, ...privacy };
      return publish();
    },
    async updateOverlay(overlay: Partial<OverlaySettings>) {
      snapshot.overlay = { ...snapshot.overlay, ...overlay };
      return publish();
    },
    async startSession() {
      const providerReady = snapshot.provider.active === "demo" || snapshot.provider.connected;
      const sourceReady = snapshot.provider.active === "demo" || snapshot.source.connected;
      const consentReady = snapshot.provider.active === "demo" || snapshot.privacy.cloudConsent;
      if (!providerReady || !sourceReady || !consentReady) {
        snapshot.session = {
          state: "error",
          message: "Cần kết nối Gemini và một nguồn âm thanh",
          latencyMs: null,
        };
        return publish();
      }
      snapshot.session = { state: "connecting", active: true, armed: true, canStop: true, message: "Đang mở phiên dịch bảo mật…", latencyMs: null };
      publish();
      await wait();
      snapshot.session = { state: "listening", active: true, armed: true, canStop: true, canPause: true, paused: false, message: "Đang nghe và dịch trực tiếp", latencyMs: 624 };
      snapshot.languages = { ...snapshot.languages, detected: "en-US", detectionMs: 438 };
      snapshot.audio = { ...snapshot.audio, rms: 0.42, peak: 0.71, speech: true, silenceMs: 0, updatedAt: Date.now() };
      publish();
      const lines: CaptionPreview[] = [
        {
          transcript: "We should leave before the storm reaches the coast.",
          translation: "Chúng ta nên đi trước khi cơn bão tràn tới bờ biển.",
          isFinal: true,
        },
        {
          transcript: "I already packed everything we need.",
          translation: "Tôi đã chuẩn bị mọi thứ chúng ta cần rồi.",
          isFinal: true,
        },
      ];
      let index = 0;
      captionListeners.forEach((listener) => listener(lines[index]));
      stopCaptionTimer();
      captionTimer = window.setInterval(() => {
        index = (index + 1) % lines.length;
        captionListeners.forEach((listener) => listener(lines[index]));
      }, 3800);
      return cloneSnapshot(snapshot);
    },
    async stopSession() {
      stopCaptionTimer();
      snapshot.session = { state: "idle", active: false, armed: false, canStop: false, canPause: false, canResume: false, paused: false, message: "Đã dừng phiên dịch", latencyMs: null };
      snapshot.audio = cloneSnapshot(defaultSnapshot).audio;
      return publish();
    },
    async pauseSession() {
      snapshot.session.paused = true;
      snapshot.session.canPause = false;
      snapshot.session.canResume = true;
      snapshot.session.message = "Đã tạm dừng gửi audio mới";
      snapshot.audio = { ...snapshot.audio, rms: 0, peak: 0, speech: false };
      return publish();
    },
    async resumeSession() {
      snapshot.session.paused = false;
      snapshot.session.canPause = true;
      snapshot.session.canResume = false;
      snapshot.session.message = "Đã tiếp tục dịch audio mới";
      return publish();
    },
    async runDiagnostics(): Promise<DiagnosticsReport> {
      await wait();
      return normalizeDiagnosticsReport({
        version: 1,
        checkedAt: new Date().toISOString(),
        overall: "attention",
        ok: true,
        summary: { passed: 4, warnings: 1, failed: 0 },
        checks: [
          { id: "runtime.node", category: "runtime", label: "Node.js runtime", status: "pass", severity: "info", detail: "Sẵn sàng.", remediation: null, actionId: null },
          { id: "extension.connection", category: "extension", label: "Kết nối tab Chrome/Edge", status: "warning", severity: "warning", detail: "Chưa có tab nào kết nối.", remediation: "Mở extension trên tab cần dịch.", actionId: "open-extension-setup" },
        ],
      });
    },
    async hideControlCenter() {
      snapshot.app.controlVisible = false;
      publish();
    },
    async toggleOverlay() {
      snapshot.app.overlayVisible = !snapshot.app.overlayVisible;
      return publish();
    },
    async requestQuit(confirmActive = false) {
      const active = snapshot.session.state === "listening" || snapshot.session.state === "connecting";
      if (active && !confirmActive) return { needsConfirmation: true, shouldQuit: false };
      return { needsConfirmation: false, shouldQuit: true };
    },
    async resetOverlay() {
      snapshot.overlay = cloneSnapshot(defaultSnapshot).overlay;
      snapshot.session.message = "Đã đặt lại giao diện phụ đề";
      return publish();
    },
    onSnapshot(callback) {
      snapshotListeners.add(callback);
      return () => snapshotListeners.delete(callback);
    },
    onCaption(callback) {
      captionListeners.add(callback);
      return () => captionListeners.delete(callback);
    },
  };
}

function createUnavailableClient(): ControlCenterClient {
  const errorSnapshot: ControlCenterSnapshot = {
    ...cloneSnapshot(defaultSnapshot),
    session: {
      state: "error",
      message: "Control Center chưa được nối với tiến trình Electron",
      latencyMs: null,
    },
  };
  const reject = async () => {
    throw new Error(errorSnapshot.session.message);
  };
  return {
    available: false,
    mode: "unavailable",
    getSnapshot: async () => cloneSnapshot(errorSnapshot),
    saveGeminiKey: reject,
    clearGeminiKey: reject,
    testGeminiConnection: reject,
    selectProvider: reject,
    copyPairingToken: reject,
    selectSource: reject,
    connectBrowserTab: reject,
    pickAudioFile: reject,
    updateLanguages: reject,
    updateTranslation: reject,
    updatePrivacy: reject,
    updateOverlay: reject,
    startSession: reject,
    stopSession: reject,
    pauseSession: reject,
    resumeSession: reject,
    runDiagnostics: reject,
    resetOverlay: reject,
    hideControlCenter: reject,
    toggleOverlay: reject,
    requestQuit: reject,
    onSnapshot: () => () => undefined,
    onCaption: () => () => undefined,
  };
}

export function getControlCenterClient(): ControlCenterClient {
  const nativeClient = window.audioTranslateControl;
  if (nativeClient) return createNativeClient(nativeClient);
  return import.meta.env.DEV ? createMockClient() : createUnavailableClient();
}
