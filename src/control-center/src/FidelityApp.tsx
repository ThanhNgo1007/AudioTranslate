import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowClockwise,
  ArrowLeft,
  ArrowLineDown,
  ArrowLineUp,
  ArrowRight,
  ArrowUp,
  ArrowsOutCardinal,
  Browser,
  Check,
  CheckCircle,
  CircleNotch,
  Cloud,
  CornersOut,
  CurrencyCircleDollar,
  Eye,
  EyeSlash,
  FileAudio,
  HardDrives,
  House,
  Gauge,
  Key,
  Lifebuoy,
  LockKey,
  Minus,
  Monitor,
  Pause,
  Play,
  ShieldCheck,
  SidebarSimple,
  SpeakerHigh,
  Square,
  Stop,
  Stethoscope,
  Subtitles,
  Trash,
  PlugsConnected,
  Translate,
  WarningCircle,
  Waveform,
  X,
} from "@phosphor-icons/react";
import { getControlCenterClient } from "./bridge";
import { sourceLanguageOptions, targetLanguageOptions } from "./language-options.mjs";
import previewScene from "./assets/preview-scene.png";
import { describeSessionDisplay } from "./session-display.mjs";
import { describeDetectedLanguage, describeLatency, meterSegments } from "./runtime-insights.mjs";
import { describeTransportControls } from "./transport-controls.mjs";
import { diagnosticActionTarget, describeDiagnosticsOverall } from "./diagnostics-display.mjs";
import type {
  CaptionPreview,
  ControlCenterSnapshot,
  DiagnosticCheck,
  DiagnosticsReport,
  LanguageState,
  OverlayPreset,
  OverlaySettings,
  ProviderId,
  SourceKind,
} from "./types";

const client = getControlCenterClient();

const fallbackSnapshot: ControlCenterSnapshot = {
  provider: {
    active: "gemini",
    keyConfigured: false,
    connected: false,
    model: "gemini-3.5-live-translate-preview",
    storage: "unavailable",
  },
  pairing: { configured: false, storage: "unavailable" },
  source: { kind: "browser-tab", connected: false, label: "Chưa kết nối tab" },
  languages: { source: "auto", target: "vi", detected: null, detectionMs: null },
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
  session: { state: "idle", message: "Đang tải…", latencyMs: null },
};

const previewFallback: CaptionPreview = {
  transcript: "We're not meant to save the world. We're meant to leave it.",
  translation: "Chúng ta không tìm kiếm sự sống ngoài kia. Chúng ta tìm kiếm chính mình.",
  isFinal: true,
};

const presetSettings: Record<OverlayPreset, Partial<OverlaySettings>> = {
  cinema: { preset: "cinema", fontSize: 36, backgroundOpacity: 82, maxWidth: 88 },
  accessible: { preset: "accessible", fontSize: 44, backgroundOpacity: 92, maxWidth: 92 },
  compact: { preset: "compact", fontSize: 28, backgroundOpacity: 66, maxWidth: 66 },
};

type BusyAction =
  | "save-key"
  | "delete-key"
  | "test-key"
  | "provider"
  | "copy-pairing"
  | "source"
  | "session"
  | "pause"
  | "diagnostics"
  | "app"
  | "reset"
  | null;

type StepId = 1 | 2 | 3;

interface StepItemProps {
  id: StepId;
  active: boolean;
  complete: boolean;
  title: string;
  onClick: () => void;
}

function StepItem({ id, active, complete, title, onClick }: StepItemProps) {
  return (
    <button
      className="progress-step"
      type="button"
      data-active={active}
      data-complete={complete}
      aria-current={active ? "step" : undefined}
      onClick={onClick}
    >
      <span className="progress-number" aria-hidden="true">
        {complete ? <Check size={15} weight="bold" /> : id}
      </span>
      <span>{title}</span>
      {complete && <CheckCircle className="progress-check" size={17} weight="fill" aria-label="Hoàn tất" />}
    </button>
  );
}

function Toggle({
  checked,
  label,
  description,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  label: string;
  description?: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span className="toggle-copy">
        <span className="toggle-label">{label}</span>
        {description && <span className="toggle-description">{description}</span>}
      </span>
      <input
        className="toggle-input"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="toggle-control" aria-hidden="true"><span /></span>
    </label>
  );
}

function Slider({
  id,
  label,
  value,
  min,
  max,
  unit,
  step,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="slider-row" htmlFor={id}>
      <span className="slider-title">{label}</span>
      <span className="slider-glyph small" aria-hidden="true">A</span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <span className="slider-glyph large" aria-hidden="true">A</span>
      <output htmlFor={id}>{value}{unit}</output>
    </label>
  );
}

function ConfigHeading({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="config-heading">
      <span aria-hidden="true">{icon}</span>
      <h2>{children}</h2>
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<ControlCenterSnapshot>(fallbackSnapshot);
  const [caption, setCaption] = useState<CaptionPreview>(previewFallback);
  const [activeStep, setActiveStep] = useState<StepId>(1);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [uiError, setUiError] = useState<string | null>(null);
  const [pairingCopied, setPairingCopied] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);
  const [activeView, setActiveView] = useState<"translate" | "providers" | "overlay" | "privacy" | "diagnostics">("translate");
  const editingOverlay = snapshot.overlay.clickThrough === false;

  useEffect(() => {
    let mounted = true;
    client
      .getSnapshot()
      .then((next) => mounted && setSnapshot(next))
      .catch((error: unknown) => {
        if (mounted) setUiError(error instanceof Error ? error.message : "Không thể tải trạng thái");
      });
    const unsubscribeSnapshot = client.onSnapshot(setSnapshot);
    const unsubscribeCaption = client.onCaption(setCaption);
    return () => {
      mounted = false;
      unsubscribeSnapshot();
      unsubscribeCaption();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && editingOverlay) updateOverlay({ clickThrough: true });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingOverlay]);

  const completed = useMemo(
    () => ({
      1: snapshot.provider.active === "demo" || snapshot.provider.connected,
      2: snapshot.provider.active === "demo" || snapshot.source.connected,
      3: snapshot.session.state === "listening" || snapshot.session.state === "paused",
    }),
    [snapshot],
  );

  const providerReady = snapshot.provider.active === "demo" || snapshot.provider.connected;
  const sourceReady = snapshot.provider.active === "demo" || snapshot.source.connected;
  const consentReady = snapshot.provider.active === "demo" || snapshot.privacy.cloudConsent;
  const canStart = providerReady && sourceReady && consentReady;
  const isListening = snapshot.session.state === "listening";
  const isStopping = snapshot.session.state === "stopping";
  const sessionDisplay = describeSessionDisplay(
    snapshot.provider.active,
    snapshot.session.state,
    snapshot.session.active,
  );
  const canStopSession = snapshot.session.canStop ?? sessionDisplay.canStop;
  const transport = describeTransportControls({
    ...snapshot.session,
    canStop: canStopSession,
  });
  const languageInsight = describeDetectedLanguage(
    snapshot.languages.detected,
    snapshot.languages.source,
    snapshot.languages.detectionMs,
  );
  const latencyInsight = describeLatency(snapshot.session.latencyMs);
  const activeMeterSegments = snapshot.session.paused
    ? 0
    : meterSegments(snapshot.audio.rms, 28);
  const audioLossCount = snapshot.audio.packetGapCount + snapshot.audio.droppedFrames;
  const diagnosticsOverall = diagnostics ? describeDiagnosticsOverall(diagnostics.overall) : null;

  async function runAction(
    name: Exclude<BusyAction, null>,
    action: () => Promise<ControlCenterSnapshot>,
    nextStep?: StepId,
  ) {
    setBusy(name);
    setUiError(null);
    try {
      const next = await action();
      setSnapshot(next);
      if (nextStep) setActiveStep(nextStep);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Thao tác không thành công");
    } finally {
      setBusy(null);
    }
  }

  function goToStep(step: StepId) {
    setActiveStep(step);
    window.requestAnimationFrame(() => {
      document.getElementById(`config-step-${step}`)?.scrollIntoView({ block: "nearest" });
    });
  }

  function navigate(view: typeof activeView, step: StepId) {
    setActiveView(view);
    goToStep(step);
  }

  async function saveKey() {
    const normalizedKey = apiKey.trim();
    if (normalizedKey.length < 20) {
      setUiError("Khoá Gemini chưa đúng định dạng hoặc quá ngắn.");
      return;
    }
    await runAction("save-key", () => client.saveGeminiKey({ apiKey: normalizedKey }));
    setApiKey("");
    setShowKey(false);
  }

  function updateLanguages(next: Partial<LanguageState>) {
    const languages = { ...snapshot.languages, ...next };
    setSnapshot((current) => ({ ...current, languages }));
    void client.updateLanguages(languages).then(setSnapshot).catch((error: unknown) => {
      setUiError(error instanceof Error ? error.message : "Không thể đổi ngôn ngữ");
    });
  }

  function updateOverlay(next: Partial<OverlaySettings>) {
    setSnapshot((current) => ({ ...current, overlay: { ...current.overlay, ...next } }));
    void client.updateOverlay(next).then(setSnapshot).catch((error: unknown) => {
      setUiError(error instanceof Error ? error.message : "Không thể cập nhật overlay");
    });
  }

  function selectSource(kind: SourceKind) {
    void runAction("source", () => client.selectSource({ kind }));
  }

  async function selectProvider(provider: ProviderId) {
    if (provider === snapshot.provider.active) return;
    if (canStopSession && !window.confirm("Đổi nhà cung cấp sẽ dừng phiên dịch hiện tại. Tiếp tục?")) return;
    await runAction("provider", () => client.selectProvider({ provider }), 1);
  }

  async function copyPairingToken() {
    setBusy("copy-pairing");
    setUiError(null);
    try {
      const result = await client.copyPairingToken();
      setPairingCopied(result.copied);
      window.setTimeout(() => setPairingCopied(false), 2500);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Không thể sao chép mã ghép nối");
    } finally {
      setBusy(null);
    }
  }

  async function requestQuit() {
    setBusy("app");
    try {
      const decision = await client.requestQuit(false);
      if (decision.needsConfirmation) {
        const confirmed = window.confirm("Phiên dịch đang chạy. Thoát sẽ dừng audio và kết nối cloud. Bạn có chắc không?");
        if (confirmed) await client.requestQuit(true);
      }
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Không thể thoát ứng dụng");
    } finally {
      setBusy(null);
    }
  }

  async function runDiagnostics() {
    setBusy("diagnostics");
    setUiError(null);
    try {
      const report = await client.runDiagnostics();
      setDiagnostics(report);
      setActiveView("diagnostics");
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Không thể kiểm tra hệ thống");
    } finally {
      setBusy(null);
    }
  }

  function handleDiagnosticAction(check: DiagnosticCheck) {
    if (check.actionId === "retry-diagnostics") {
      void runDiagnostics();
      return;
    }
    const target = diagnosticActionTarget(check.actionId);
    if (target === "providers") navigate("providers", 1);
    if (target === "privacy") navigate("privacy", 3);
    if (target === "translate") navigate("translate", 2);
  }

  function toggleOverlayLock() {
    const nextLocked = editingOverlay;
    updateOverlay({ clickThrough: nextLocked });
  }

  const previewStyle = {
    "--caption-font-size": `${snapshot.overlay.fontSize}px`,
    "--caption-opacity": snapshot.overlay.backgroundOpacity / 100,
    "--caption-width": `${snapshot.overlay.maxWidth}%`,
    "--source-font-size": `${snapshot.overlay.sourceFontSize}px`,
    "--preview-line-height": snapshot.overlay.lineHeight,
    "--preview-font-weight": snapshot.overlay.fontWeight,
  } as CSSProperties;

  const statusTone = snapshot.session.state === "error"
    ? "error"
    : snapshot.session.paused ? "paused"
    : isListening ? "live" : "idle";

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><Waveform size={23} weight="bold" /></span>
          <span className="brand-name">AudioTranslate</span>
          {client.mode === "mock" && <span className="dev-badge">Bản xem thử</span>}
        </div>
        <div className="window-controls" aria-label="Điều khiển cửa sổ">
          <button type="button" title="Ẩn Control Center xuống khay hệ thống" onClick={() => void client.hideControlCenter()}><Minus size={18} /><span className="sr-only">Ẩn xuống khay</span></button>
          <button type="button" title={snapshot.app.overlayVisible ? "Ẩn overlay phụ đề" : "Hiện overlay phụ đề"} onClick={() => void runAction("app", () => client.toggleOverlay())}><Square size={15} /><span className="sr-only">Bật hoặc tắt overlay</span></button>
          <button type="button" title="Đóng cửa sổ và tiếp tục chạy dưới khay" onClick={() => void client.hideControlCenter()}><X size={18} /><span className="sr-only">Đóng xuống khay</span></button>
        </div>
      </header>

      <nav className="app-navigation" aria-label="Khu vực Control Center">
        <button type="button" data-active={activeView === "translate"} onClick={() => navigate("translate", 2)}><House size={17} /> Dịch ngay</button>
        <button type="button" data-active={activeView === "providers"} onClick={() => navigate("providers", 1)}><PlugsConnected size={17} /> Nhà cung cấp</button>
        <button type="button" data-active={activeView === "overlay"} onClick={() => navigate("overlay", 3)}><Subtitles size={17} /> Phụ đề & Overlay</button>
        <button type="button" data-active={activeView === "privacy"} onClick={() => navigate("privacy", 3)}><ShieldCheck size={17} /> Quyền riêng tư / Trợ giúp</button>
        <button type="button" data-active={activeView === "diagnostics"} onClick={() => {
          setActiveView("diagnostics");
          window.requestAnimationFrame(() => document.getElementById("diagnostics-panel")?.scrollIntoView({ block: "nearest" }));
        }}><Stethoscope size={17} /> Chẩn đoán hệ thống</button>
      </nav>

      <nav className="progress-bar" aria-label="Tiến trình thiết lập">
        <StepItem id={1} active={activeStep === 1} complete={completed[1]} title="Chọn nhà cung cấp" onClick={() => goToStep(1)} />
        <span className="progress-line" aria-hidden="true" />
        <StepItem id={2} active={activeStep === 2} complete={completed[2]} title="Chọn nguồn & ngôn ngữ" onClick={() => goToStep(2)} />
        <span className="progress-line" aria-hidden="true" />
        <StepItem id={3} active={activeStep === 3} complete={completed[3]} title="Bật phụ đề" onClick={() => goToStep(3)} />
      </nav>

      <main className="main-layout">
        <section className="cinema-panel" aria-label="Bản xem trước overlay phụ đề">
          <div className="scene-stage" style={previewStyle}>
            <img className="preview-scene" src={previewScene} alt="Cảnh không gian trung tính dùng để xem trước phụ đề" />
            <div className="scene-badge"><Waveform size={15} /> {sessionDisplay.sceneLabel}</div>
            <div className="runtime-insight-chips" aria-label="Thông tin phiên dịch trực tiếp">
              <span data-detected={languageInsight.detected}><Translate size={14} /> {languageInsight.label}</span>
              <span data-tone={latencyInsight.tone}><Gauge size={14} /> {latencyInsight.label}</span>
              {(snapshot.session.active || snapshot.session.armed) && <span data-tone={audioLossCount > 0 || (snapshot.audio.queueMs ?? 0) > 500 ? "warning" : "good"}><Waveform size={14} /> {audioLossCount > 0 ? `${audioLossCount} frame lỗi` : snapshot.audio.queueMs === null ? "Luồng trực tiếp" : `Queue ${snapshot.audio.queueMs} ms`}</span>}
              {snapshot.session.paused && <span data-tone="warning"><Pause size={14} /> Đang tạm dừng</span>}
            </div>
            <div className={`caption-selection position-${snapshot.overlay.position}`} data-editing={editingOverlay}>
              {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((position) => (
                <span key={position} className={`resize-handle handle-${position}`} aria-hidden="true" />
              ))}
              <div className="caption-surface" data-high-contrast={snapshot.overlay.highContrast}>
                <p className="translated-caption">{caption.translation}</p>
                {snapshot.overlay.showSource && <p className="source-caption">{caption.transcript}</p>}
              </div>
            </div>
          </div>

          <div className="preview-toolbar" aria-label="Công cụ chỉnh overlay">
            <button type="button" className="toolbar-control move-control" onClick={() => updateOverlay({ clickThrough: false })} aria-pressed={editingOverlay}>
              <ArrowsOutCardinal size={20} />
              <span>Di chuyển:</span>
              <span className="direction-icons" aria-hidden="true"><ArrowUp size={13} /><ArrowDown size={13} /><ArrowLeft size={13} /><ArrowRight size={13} /></span>
            </button>
            <button type="button" className="toolbar-control" onClick={() => updateOverlay({ position: "bottom" })}>
              <CornersOut size={19} /> <span>Snap:</span> <strong>Dưới</strong>
            </button>
            <span className="escape-hint">Thoát chỉnh sửa: <kbd>Esc</kbd></span>
          </div>
        </section>

        <aside className="config-panel" aria-label="Cấu hình AudioTranslate">
          <section id="config-step-1" className="config-section" data-active={activeStep === 1}>
            <ConfigHeading icon={<Key size={18} />}>Nhà cung cấp & API</ConfigHeading>
            <div className="provider-grid" aria-label="Chọn nhà cung cấp">
              <button type="button" className="provider-card" data-active={snapshot.provider.active === "demo"} disabled={busy !== null} onClick={() => void selectProvider("demo")}>
                <HardDrives size={20} /><span><strong>Demo cục bộ</strong><small>Caption mô phỏng · không API · không gửi audio</small></span>{snapshot.provider.active === "demo" && <CheckCircle size={18} weight="fill" />}
              </button>
              <button type="button" className="provider-card" data-active={snapshot.provider.active === "gemini"} disabled={busy !== null} onClick={() => void selectProvider("gemini")}>
                <Cloud size={20} /><span><strong>Google Gemini</strong><small>Dịch audio thật · dùng API key của bạn</small></span>{snapshot.provider.active === "gemini" && <CheckCircle size={18} weight="fill" />}
              </button>
              <button type="button" className="provider-card" disabled title="OpenAI realtime chưa được nối vào runtime"><Waveform size={20} /><span><strong>OpenAI</strong><small>Chưa khả dụng trong bản này</small></span></button>
              <button type="button" className="provider-card" disabled title="Engine offline chưa được đóng gói"><HardDrives size={20} /><span><strong>Local / offline</strong><small>Đang phát triển</small></span></button>
              <button type="button" className="provider-card provider-card-wide" disabled title="Azure Speech chưa được tích hợp trong Control Center"><SidebarSimple size={20} /><span><strong>Azure Speech</strong><small>Chưa tích hợp trong Control Center</small></span></button>
            </div>
            {snapshot.provider.active === "demo" && <p className="provider-mode-note"><Lifebuoy size={16} /> Demo tạo phụ đề mẫu để thử overlay; nó không nghe hoặc dịch audio thật.</p>}

            {snapshot.provider.active === "gemini" && <>
            <label className="field-label" htmlFor="gemini-key">Gemini API Key</label>
            <div className="key-row">
              <div className="secret-field">
                <input
                  id="gemini-key"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.currentTarget.value)}
                  placeholder={snapshot.provider.keyConfigured ? "••••••••••••••••••••" : "Dán khoá API tại đây"}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="key-security-note"
                />
                <button type="button" className="icon-button" onClick={() => setShowKey((visible) => !visible)} aria-label={showKey ? "Ẩn khoá API" : "Hiện khoá API"}>
                  {showKey ? <EyeSlash size={18} /> : <Eye size={18} />}
                </button>
              </div>
              <span className="saved-status" data-saved={snapshot.provider.keyConfigured}>
                {snapshot.provider.keyConfigured ? <CheckCircle size={17} weight="fill" /> : <WarningCircle size={17} weight="fill" />}
                {snapshot.provider.keyConfigured
                  ? snapshot.provider.storage === "session-only" ? "Chỉ lưu trong phiên" : snapshot.provider.storage === "environment" ? "Từ biến môi trường" : "Đã mã hoá an toàn"
                  : "Chưa có khoá"}
              </span>
            </div>

            <div className="provider-actions">
              <button type="button" className="button secondary" disabled={!snapshot.provider.keyConfigured || busy !== null || canStopSession} title={canStopSession ? "Dừng phiên hiện tại trước khi kiểm tra kết nối" : undefined} onClick={() => void runAction("test-key", () => client.testGeminiConnection(), 2)}>
                {busy === "test-key" ? <CircleNotch className="spinner" size={17} /> : <Waveform size={17} />} Kiểm tra kết nối
              </button>
              <button type="button" className="button primary small-button" disabled={apiKey.trim().length < 20 || busy !== null} onClick={() => void saveKey()}>
                {busy === "save-key" ? <CircleNotch className="spinner" size={16} /> : <LockKey size={16} />} Lưu khoá
              </button>
              {snapshot.provider.keyConfigured && (
                <button type="button" className="icon-text-button danger" disabled={busy !== null} onClick={() => void runAction("delete-key", () => client.clearGeminiKey())}>
                  {busy === "delete-key" ? <CircleNotch className="spinner" size={15} /> : <Trash size={15} />} Xoá
                </button>
              )}
            </div>

            <div className="cloud-note" id="key-security-note">
              <Cloud size={23} aria-hidden="true" />
              <p><strong>Xử lý trên Google Gemini.</strong> Không lưu nội dung trong AudioTranslate. Chi phí theo giá API Gemini.</p>
            </div>
            </>}
          </section>

          <section id="config-step-2" className="config-section" data-active={activeStep === 2}>
            <ConfigHeading icon={<Translate size={18} />}>Nguồn & ngôn ngữ</ConfigHeading>
            <div className="source-tabs" aria-label="Loại nguồn âm thanh">
              <button type="button" data-selected={snapshot.source.kind === "browser-tab"} onClick={() => selectSource("browser-tab")}>
                <Browser size={17} /> Tab Chrome / Edge
              </button>
              <button type="button" data-selected={snapshot.source.kind === "file"} onClick={() => selectSource("file")}>
                <FileAudio size={17} /> Tệp audio / video
              </button>
            </div>

            <div className="source-status" data-connected={snapshot.source.connected}>
              <span className="source-status-copy">
                {snapshot.source.kind === "browser-tab" ? <Browser size={18} /> : <FileAudio size={18} />}
                <span><strong>{snapshot.source.label}</strong><small>Chỉ xử lý khi phiên đang chạy</small></span>
              </span>
              <button className="button secondary compact" type="button" disabled={busy !== null} onClick={() => void runAction(
                "source",
                snapshot.source.kind === "browser-tab" ? () => client.connectBrowserTab() : () => client.pickAudioFile(),
                3,
              )}>
                {busy === "source" ? <CircleNotch className="spinner" size={15} /> : null}
                {snapshot.source.connected ? "Chọn lại" : snapshot.source.kind === "browser-tab" ? "Ghép nối" : "Chọn tệp"}
              </button>
            </div>

            <div className="pairing-panel">
              <span><LockKey size={18} /><span><strong>Mã ghép nối extension</strong><small>{snapshot.pairing.storage === "session-only" ? "Chỉ giữ trong phiên app này" : snapshot.pairing.storage === "environment" ? "Đang dùng biến môi trường" : "Lưu trong kho mã hoá của hệ điều hành"}</small></span></span>
              <button type="button" className="button secondary compact" disabled={!snapshot.pairing.configured || busy !== null} title={!snapshot.pairing.configured ? "Ứng dụng chưa tạo được mã ghép nối" : "Sao chép trực tiếp từ main process; UI không đọc mã"} onClick={() => void copyPairingToken()}>
                {busy === "copy-pairing" ? <CircleNotch className="spinner" size={15} /> : pairingCopied ? <Check size={15} /> : <Key size={15} />}
                {pairingCopied ? "Đã sao chép" : "Sao chép mã"}
              </button>
            </div>

            <div className="language-fields">
              <label><span>Nguồn (tự động)</span><select value={snapshot.languages.source} onChange={(event) => updateLanguages({ source: event.currentTarget.value })}>
                {sourceLanguageOptions.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
              </select></label>
              <label><span>Đích</span><select value={snapshot.languages.target} onChange={(event) => updateLanguages({ target: event.currentTarget.value })}>
                {targetLanguageOptions.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
              </select></label>
            </div>
            <div className="language-detection-card" data-detected={languageInsight.detected}>
              <span className="language-detection-icon"><Translate size={17} /></span>
              <span><strong>Ngôn ngữ phát hiện</strong><small>{languageInsight.detail}</small></span>
              <b>{languageInsight.label}</b>
            </div>
          </section>

          <section id="config-step-3" className="config-section overlay-config" data-active={activeStep === 3}>
            <ConfigHeading icon={<Subtitles size={18} />}>Kiểu hiển thị phụ đề</ConfigHeading>

            <div className="position-options" aria-label="Vị trí phụ đề">
              {(["bottom", "top", "center"] as const).map((position) => (
                <button type="button" key={position} data-selected={snapshot.overlay.position === position} onClick={() => updateOverlay({ position })}>
                  {position === "bottom" ? <ArrowLineDown size={18} /> : position === "top" ? <ArrowLineUp size={18} /> : <CornersOut size={18} />}
                  {position === "bottom" ? "Dưới màn hình" : position === "top" ? "Trên màn hình" : "Thả nổi"}
                </button>
              ))}
            </div>

            <div className="preset-options" aria-label="Mẫu phụ đề">
              {([ ["cinema", "Điện ảnh"], ["accessible", "Dễ đọc"], ["compact", "Gọn"] ] as const).map(([id, label]) => (
                <button type="button" key={id} data-selected={snapshot.overlay.preset === id} onClick={() => updateOverlay(presetSettings[id])}>{label}</button>
              ))}
            </div>

            <Slider id="font-size" label="Cỡ chữ" value={snapshot.overlay.fontSize} min={22} max={52} unit=" px" onChange={(fontSize) => updateOverlay({ fontSize })} />
            <Slider id="background-opacity" label="Độ tương phản" value={snapshot.overlay.backgroundOpacity} min={30} max={96} unit="%" onChange={(backgroundOpacity) => updateOverlay({ backgroundOpacity })} />
            <Slider id="caption-width" label="Độ rộng" value={snapshot.overlay.maxWidth} min={45} max={94} unit="%" onChange={(maxWidth) => updateOverlay({ maxWidth })} />

            <details className="advanced-overlay-controls">
              <summary><Monitor size={16} /> Tùy chỉnh nâng cao <small>Khả năng đọc, câu dài & màn hình</small></summary>
              <div className="advanced-overlay-body">
                <Slider id="source-font-size" label="Cỡ chữ câu gốc" value={snapshot.overlay.sourceFontSize} min={11} max={32} unit=" px" onChange={(sourceFontSize) => updateOverlay({ sourceFontSize })} />
                <Slider id="font-weight" label="Độ đậm" value={snapshot.overlay.fontWeight} min={400} max={800} step={50} unit="" onChange={(fontWeight) => updateOverlay({ fontWeight })} />
                <Slider id="line-height" label="Khoảng dòng" value={snapshot.overlay.lineHeight} min={1} max={1.8} step={0.05} unit="×" onChange={(lineHeight) => updateOverlay({ lineHeight })} />
                <Slider id="max-caption-lines" label="Số dòng tối đa" value={snapshot.overlay.maxLines} min={1} max={2} unit=" dòng" onChange={(maxLines) => updateOverlay({ maxLines })} />
                <Toggle checked={snapshot.overlay.highContrast} label="Tương phản cao" description="Bỏ hiệu ứng mờ, tăng viền và độ tách chữ" onChange={(highContrast) => updateOverlay({ highContrast })} />
                <label className="advanced-select-row">
                  <span><strong>Tự ẩn phụ đề</strong><small>Chỉ đếm thời gian sau khi giọng nói kết thúc</small></span>
                  <select value={snapshot.overlay.hideAfterMs} onChange={(event) => updateOverlay({ hideAfterMs: Number(event.currentTarget.value) })}>
                    <option value={0}>Không ẩn</option>
                    <option value={3_000}>3 giây</option>
                    <option value={5_000}>5 giây</option>
                    <option value={8_000}>8 giây</option>
                    <option value={12_000}>12 giây</option>
                    <option value={20_000}>20 giây</option>
                  </select>
                </label>
                <label className="advanced-select-row">
                  <span><strong>Màn hình overlay</strong><small>Chọn màn hình đích khi dùng nhiều màn hình</small></span>
                  <select value={snapshot.overlay.displayId ?? ""} disabled={snapshot.displays.length === 0} onChange={(event) => updateOverlay({ displayId: event.currentTarget.value || null })}>
                    <option value="">Màn hình hiện tại</option>
                    {snapshot.displays.map((display) => <option key={display.id} value={display.id}>{display.label}{display.primary ? " · Chính" : ""}</option>)}
                  </select>
                </label>
              </div>
            </details>

            <div className="toggle-stack">
              <Toggle checked={snapshot.overlay.showSource} label="Hiện câu gốc" description="Dòng nhỏ dưới bản dịch" onChange={(showSource) => updateOverlay({ showSource })} />
              <Toggle checked={snapshot.privacy.cloudConsent} disabled={snapshot.provider.active !== "gemini"} label="Cho phép gửi audio tới Google Gemini" description={snapshot.provider.active === "gemini" ? "Lưu trên máy; có thể thu hồi bất kỳ lúc nào" : "Không áp dụng cho Demo cục bộ"} onChange={(cloudConsent) => void client.updatePrivacy({ cloudConsent }).then(setSnapshot).catch((error: unknown) => setUiError(error instanceof Error ? error.message : "Không thể lưu consent"))} />
            </div>

            <label className="guardrail-field" htmlFor="cloud-minutes">
              <span><strong>Giới hạn thời lượng cloud</strong><small>Tự dừng để kiểm soát quota/chi phí (1–1440 phút)</small></span>
              <input id="cloud-minutes" type="number" min={1} max={1440} value={snapshot.privacy.maxCloudMinutes} disabled={snapshot.provider.active !== "gemini"} title={snapshot.provider.active !== "gemini" ? "Chỉ áp dụng cho provider cloud Gemini" : undefined} onChange={(event) => {
                const maxCloudMinutes = Math.max(1, Math.min(1440, Number(event.currentTarget.value) || 1));
                setSnapshot((current) => ({ ...current, privacy: { ...current.privacy, maxCloudMinutes } }));
                void client.updatePrivacy({ maxCloudMinutes }).then(setSnapshot).catch((error: unknown) => setUiError(error instanceof Error ? error.message : "Không thể lưu giới hạn cloud"));
              }} />
            </label>

            <div className="privacy-disclosures">
              <details><summary><ShieldCheck size={16} /> Dữ liệu được bảo vệ thế nào?</summary><p>Audio chỉ đi từ nguồn đã chọn tới Gemini qua TLS trong phiên đang chạy. AudioTranslate không lưu nội dung trong renderer. Theo chính sách hiện tại, dữ liệu Free Tier có thể được Google dùng để cải thiện sản phẩm; Paid Tier thì không.</p></details>
              <details><summary><CurrencyCircleDollar size={16} /> Chi phí Gemini API</summary><p>Free Tier miễn phí trong hạn mức. Paid Tier hiện khoảng 0,0368 USD/phút cho audio vào + ra; giá có thể thay đổi. AudioTranslate không thêm phụ phí.</p></details>
            </div>

            {transport.canTogglePause && <button className="pause-button" type="button" disabled={busy !== null} title={transport.pauseHint} onClick={() => void runAction("pause", transport.paused ? () => client.resumeSession() : () => client.pauseSession())}>
              {busy === "pause" ? <CircleNotch className="spinner" size={18} /> : transport.paused ? <Play size={18} weight="fill" /> : <Pause size={18} weight="fill" />}
              {transport.pauseLabel}
            </button>}
            <button className={canStopSession ? "start-button stop-session" : "start-button"} type="button" disabled={(!canStart && !canStopSession) || busy !== null || isStopping} onClick={() => void runAction("session", canStopSession ? () => client.stopSession() : () => client.startSession())}>
              {busy === "session" || isStopping ? <CircleNotch className="spinner" size={20} /> : canStopSession ? <Stop size={20} weight="fill" /> : <Play size={20} weight="fill" />}
              {sessionDisplay.primaryActionLabel}
            </button>
            {!canStart && !canStopSession && <p className="start-help">{snapshot.provider.active === "gemini" ? "Kết nối Gemini, chọn nguồn và xác nhận gửi audio để bắt đầu." : "Demo cục bộ đã sẵn sàng."}</p>}
          </section>

          <section id="diagnostics-panel" className="config-section diagnostics-panel" data-active={activeView === "diagnostics"}>
            <div className="diagnostics-heading-row">
              <ConfigHeading icon={<Stethoscope size={18} />}>Chẩn đoán hệ thống</ConfigHeading>
              <button className="button secondary compact" type="button" disabled={busy !== null} onClick={() => void runDiagnostics()}>
                {busy === "diagnostics" ? <CircleNotch className="spinner" size={15} /> : <ArrowClockwise size={15} />}
                {diagnostics ? "Kiểm tra lại" : "Kiểm tra ngay"}
              </button>
            </div>
            {!diagnostics && <div className="diagnostics-empty"><Gauge size={24} /><span><strong>Kiểm tra trong ứng dụng</strong><small>Runtime, Gemini SDK, kho bảo mật, extension, pairing và cổng nội bộ. Không đọc hoặc hiển thị API key.</small></span></div>}
            {diagnostics && diagnosticsOverall && <>
              <div className="diagnostics-summary" data-tone={diagnosticsOverall.tone}>
                <span><strong>{diagnosticsOverall.label}</strong><small>{new Date(diagnostics.checkedAt).toLocaleString("vi-VN")}</small></span>
                <span className="diagnostics-counts"><b>{diagnostics.summary.passed} đạt</b><b>{diagnostics.summary.warnings} cảnh báo</b><b>{diagnostics.summary.failed} lỗi</b></span>
              </div>
              <div className="diagnostic-check-list">
                {diagnostics.checks.map((check) => {
                  const actionTarget = diagnosticActionTarget(check.actionId);
                  const hasAction = actionTarget !== null || check.actionId === "retry-diagnostics";
                  return <article key={check.id} className="diagnostic-check" data-status={check.status}>
                    <span className="diagnostic-status-icon">{check.status === "pass" ? <CheckCircle size={17} weight="fill" /> : <WarningCircle size={17} weight="fill" />}</span>
                    <span><strong>{check.label}</strong><small>{check.detail}</small>{check.remediation && <em>{check.remediation}</em>}</span>
                    {hasAction && <button type="button" onClick={() => handleDiagnosticAction(check)}>{check.actionId === "retry-diagnostics" ? "Thử lại" : "Đi tới"}</button>}
                  </article>;
                })}
              </div>
            </>}
          </section>
        </aside>
      </main>

      <footer className="status-bar" data-tone={statusTone}>
        <div className="provider-live"><span className="status-pulse" aria-hidden="true" /><strong>{snapshot.provider.active === "demo" ? "Demo cục bộ" : snapshot.provider.connected ? `Gemini · ${languageInsight.label}` : "Gemini chưa kết nối"}</strong></div>
        <div className="audio-meter" aria-label={snapshot.session.paused ? "Đang tạm dừng gửi audio" : sessionDisplay.audioMeterLabel} title={`Peak ${Math.round(snapshot.audio.peak * 100)}% · im lặng ${snapshot.audio.silenceMs} ms`}>
          <SpeakerHigh size={18} /><span>{snapshot.session.paused ? "Đã tạm dừng" : snapshot.audio.speech ? "Có lời thoại" : "Âm lượng"}</span>
          <span className="meter-bars" aria-hidden="true">{Array.from({ length: 28 }, (_, index) => <span key={index} data-active={index < activeMeterSegments} />)}</span>
        </div>
        <div className="latency-readout" data-tone={latencyInsight.tone} role="status" aria-live="polite" title={latencyInsight.detail}><span>Độ trễ</span><strong>{latencyInsight.label}</strong></div>
        <button type="button" className="status-action" disabled={!transport.canTogglePause || busy !== null} title={transport.pauseHint} onClick={() => void runAction("pause", transport.paused ? () => client.resumeSession() : () => client.pauseSession())}>{transport.paused ? <Play size={18} weight="fill" /> : <Pause size={18} weight="fill" />} {transport.paused ? "Tiếp tục" : "Tạm dừng"}</button>
        <button type="button" className="status-action" disabled={!canStopSession || busy !== null} title={!canStopSession ? "Chỉ khả dụng khi một phiên đang chạy hoặc đang chờ nguồn" : "Dừng hoàn toàn nguồn audio và kết nối provider"} onClick={() => void runAction("session", () => client.stopSession())}><Stop size={18} weight="fill" /> Dừng</button>
        <button type="button" className="status-action" onClick={toggleOverlayLock}><LockKey size={18} weight="fill" /> {editingOverlay ? "Khóa overlay" : "Mở chỉnh sửa"}</button>
        <button type="button" className="status-action" title="Ẩn cửa sổ; phiên dịch vẫn tiếp tục" onClick={() => void client.hideControlCenter()}><Minus size={18} /> Xuống khay</button>
        <button type="button" className="status-action" onClick={() => void runAction("app", () => client.toggleOverlay())}><Subtitles size={18} /> {snapshot.app.overlayVisible ? "Ẩn overlay" : "Hiện overlay"}</button>
        <button type="button" className="status-action danger-action" disabled={busy !== null} onClick={() => void requestQuit()}><X size={18} /> Thoát</button>
      </footer>

      <span className="session-message" data-tone={statusTone}>{snapshot.session.message}</span>

      {uiError && (
        <div className="toast" role="alert"><WarningCircle size={20} weight="fill" /><span>{uiError}</span><button type="button" onClick={() => setUiError(null)} aria-label="Đóng thông báo lỗi">Đóng</button></div>
      )}
    </div>
  );
}
