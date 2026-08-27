export type SourceKind = "browser-tab" | "file";
export type ProviderId = "demo" | "gemini";
export type SessionState = "idle" | "connecting" | "listening" | "paused" | "stopping" | "error";
export type OverlayPreset = "cinema" | "accessible" | "compact";
export type OverlayPosition = "top" | "center" | "bottom";
export type TranslationMode = "fastest" | "balanced" | "accurate";

export interface GeminiState {
  active: ProviderId;
  keyConfigured: boolean;
  maskedKeyHint?: string;
  connected: boolean;
  model: string;
  storage: "encrypted" | "session-only" | "environment" | "unavailable";
  storageBackend?: string;
}

export interface PairingState {
  configured: boolean;
  storage: "encrypted" | "session-only" | "environment" | "unavailable";
  backend?: string;
}

export interface PrivacySettings {
  cloudConsent: boolean;
  maxCloudMinutes: number;
}

export interface DesktopState {
  overlayVisible: boolean;
  controlVisible: boolean;
}

export interface AudioSourceState {
  kind: SourceKind;
  connected: boolean;
  label: string;
}

export interface LanguageState {
  source: string;
  target: string;
  detected?: string | null;
  detectionMs?: number | null;
}

export interface TranslationSettings {
  mode: TranslationMode;
  transcriptionModel: string;
  textModel: string;
  contextTurns: number;
  partialThrottleMs: number;
  glossary: string;
  characterContext: string;
}

export interface OverlaySettings {
  preset: OverlayPreset;
  fontSize: number;
  backgroundOpacity: number;
  maxWidth: number;
  position: OverlayPosition;
  showSource: boolean;
  clickThrough: boolean;
  highContrast: boolean;
  sourceFontSize: number;
  fontWeight: number;
  lineHeight: number;
  maxLines: number;
  hideAfterMs: number;
  displayId: string | null;
}

export interface DisplayOption {
  id: string;
  label: string;
  primary: boolean;
}

export interface AudioTelemetry {
  rms: number;
  peak: number;
  speech: boolean;
  silenceMs: number;
  packetGapCount: number;
  droppedFrames: number;
  queueMs: number | null;
  updatedAt: number;
}

export type RuntimeMetricName =
  | "providerPrepareMs"
  | "localQueueMs"
  | "liveEdgeToPartialMs"
  | "partialToFinalMs"
  | "resultToRafMs"
  | "firstReadableMs";

export interface RuntimeMetricSummary {
  latest: number | null;
  p50: number | null;
  p95: number | null;
  count: number;
}

export interface RuntimeUsage {
  promptTokenCount?: number;
  responseTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
}

export interface RuntimeDiagnostics {
  metrics: Record<RuntimeMetricName, RuntimeMetricSummary>;
  usage: RuntimeUsage;
}

export interface SessionStatus {
  state: SessionState;
  active?: boolean;
  message: string;
  latencyMs: number | null;
  paused?: boolean;
  armed?: boolean;
  canPause?: boolean;
  canResume?: boolean;
  canStop?: boolean;
  diagnostics?: RuntimeDiagnostics | null;
}

export interface ControlCenterSnapshot {
  provider: GeminiState;
  pairing: PairingState;
  source: AudioSourceState;
  languages: LanguageState;
  translation: TranslationSettings;
  privacy: PrivacySettings;
  overlay: OverlaySettings;
  displays: DisplayOption[];
  audio: AudioTelemetry;
  app: DesktopState;
  session: SessionStatus;
}

export interface CaptionPreview {
  transcript: string;
  translation: string;
  isFinal: boolean;
}

export type DiagnosticOverall = "healthy" | "attention" | "blocked";
export type DiagnosticStatus = "pass" | "warning" | "fail";

export interface DiagnosticCheck {
  id: string;
  category: string;
  label: string;
  status: DiagnosticStatus;
  severity: "info" | "warning" | "error";
  detail: string;
  remediation: string | null;
  actionId: string | null;
}

export interface DiagnosticsReport {
  version: number;
  checkedAt: string;
  overall: DiagnosticOverall;
  ok: boolean;
  summary: { passed: number; warnings: number; failed: number };
  checks: DiagnosticCheck[];
}

export interface SourceSelection {
  kind: SourceKind;
}

export interface ControlCenterAPI {
  getSnapshot(): Promise<ControlCenterSnapshot>;
  saveGeminiKey(payload: { apiKey: string }): Promise<ControlCenterSnapshot>;
  clearGeminiKey(): Promise<ControlCenterSnapshot>;
  testGeminiConnection(): Promise<ControlCenterSnapshot>;
  selectProvider(payload: { provider: ProviderId }): Promise<ControlCenterSnapshot>;
  copyPairingToken(): Promise<{ copied: boolean }>;
  selectSource(payload: SourceSelection): Promise<ControlCenterSnapshot>;
  connectBrowserTab(): Promise<ControlCenterSnapshot>;
  pickAudioFile(): Promise<ControlCenterSnapshot>;
  updateLanguages(payload: LanguageState): Promise<ControlCenterSnapshot>;
  updateTranslation(payload: Partial<TranslationSettings>): Promise<ControlCenterSnapshot>;
  updatePrivacy(payload: Partial<PrivacySettings>): Promise<ControlCenterSnapshot>;
  updateOverlay(payload: Partial<OverlaySettings>): Promise<ControlCenterSnapshot>;
  startSession(): Promise<ControlCenterSnapshot>;
  stopSession(): Promise<ControlCenterSnapshot>;
  pauseSession(): Promise<ControlCenterSnapshot>;
  resumeSession(): Promise<ControlCenterSnapshot>;
  runDiagnostics(): Promise<DiagnosticsReport>;
  resetOverlay(): Promise<ControlCenterSnapshot>;
  hideControlCenter(): Promise<void>;
  toggleOverlay(): Promise<ControlCenterSnapshot>;
  requestQuit(confirmActive?: boolean): Promise<{ needsConfirmation: boolean; shouldQuit: boolean }>;
  onSnapshot(callback: (snapshot: ControlCenterSnapshot) => void): () => void;
  onCaption(callback: (caption: CaptionPreview) => void): () => void;
}

export interface ControlCenterClient extends ControlCenterAPI {
  available: boolean;
  mode: "native" | "mock" | "unavailable";
}
