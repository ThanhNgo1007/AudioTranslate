import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowCounterClockwise,
  ArrowRight,
  Browser,
  Check,
  CheckCircle,
  CircleNotch,
  CurrencyCircleDollar,
  Eye,
  EyeSlash,
  FileAudio,
  Key,
  LockKey,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  Stop,
  Subtitles,
  Trash,
  Translate,
  WarningCircle,
  Waveform,
} from "@phosphor-icons/react";
import { getControlCenterClient } from "./bridge";
import type {
  CaptionPreview,
  ControlCenterSnapshot,
  LanguageState,
  OverlayPreset,
  OverlaySettings,
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
  transcript: "We should leave before the storm reaches the coast.",
  translation: "Chúng ta nên đi trước khi cơn bão tràn tới bờ biển.",
  isFinal: true,
};

const languageOptions = [
  { value: "auto", label: "Tự động nhận diện" },
  { value: "en-US", label: "Tiếng Anh" },
  { value: "ja-JP", label: "Tiếng Nhật" },
  { value: "ko-KR", label: "Tiếng Hàn" },
  { value: "zh-CN", label: "Tiếng Trung" },
  { value: "vi-VN", label: "Tiếng Việt" },
];

const targetLanguageOptions = languageOptions.filter((language) => language.value !== "auto");

const presetSettings: Record<OverlayPreset, Partial<OverlaySettings>> = {
  cinema: { preset: "cinema", fontSize: 34, backgroundOpacity: 72, maxWidth: 78 },
  accessible: { preset: "accessible", fontSize: 42, backgroundOpacity: 88, maxWidth: 90 },
  compact: { preset: "compact", fontSize: 27, backgroundOpacity: 60, maxWidth: 62 },
};

type BusyAction =
  | "save-key"
  | "delete-key"
  | "test-key"
  | "source"
  | "session"
  | "reset"
  | null;

type StepId = 1 | 2 | 3;

interface StepButtonProps {
  id: StepId;
  active: boolean;
  complete: boolean;
  title: string;
  description: string;
  icon: ReactNode;
  onClick: () => void;
}

function StepButton({ id, active, complete, title, description, icon, onClick }: StepButtonProps) {
  return (
    <button
      className="step-button"
      data-active={active}
      data-complete={complete}
      type="button"
      onClick={onClick}
      aria-current={active ? "step" : undefined}
    >
      <span className="step-marker" aria-hidden="true">
        {complete ? <Check size={15} weight="bold" /> : id}
      </span>
      <span className="step-copy">
        <span className="step-title-row">
          <span className="step-icon">{icon}</span>
          <span className="step-title">{title}</span>
        </span>
        <span className="step-description">{description}</span>
      </span>
    </button>
  );
}

function Toggle({
  checked,
  label,
  description,
  onChange,
}: {
  checked: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>
        <span className="toggle-label">{label}</span>
        <span className="toggle-description">{description}</span>
      </span>
      <input
        className="toggle-input"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="toggle-control" aria-hidden="true">
        <span />
      </span>
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
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="slider-field" htmlFor={id}>
      <span className="slider-label-row">
        <span>{label}</span>
        <output htmlFor={id}>{value}{unit}</output>
      </span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

export function LegacyApp() {
  const [snapshot, setSnapshot] = useState<ControlCenterSnapshot>(fallbackSnapshot);
  const [caption, setCaption] = useState<CaptionPreview>(previewFallback);
  const [activeStep, setActiveStep] = useState<StepId>(1);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [uiError, setUiError] = useState<string | null>(null);
  const [cloudConsent, setCloudConsent] = useState(false);

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

  const completed = useMemo(
    () => ({
      1: snapshot.provider.connected,
      2: snapshot.source.connected,
      3: snapshot.session.state === "listening",
    }),
    [snapshot],
  );

  const canStart = snapshot.provider.connected && snapshot.source.connected && cloudConsent;
  const isListening = snapshot.session.state === "listening";
  const isWorking = snapshot.session.state === "connecting" || snapshot.session.state === "stopping";

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
    setSnapshot((current) => ({
      ...current,
      overlay: { ...current.overlay, ...next },
    }));
    void client.updateOverlay(next).then(setSnapshot).catch((error: unknown) => {
      setUiError(error instanceof Error ? error.message : "Không thể cập nhật overlay");
    });
  }

  function selectSource(kind: SourceKind) {
    void runAction("source", () => client.selectSource({ kind }));
  }

  const previewStyle = {
    "--caption-font-size": `${Math.round(snapshot.overlay.fontSize * 0.55)}px`,
    "--caption-opacity": snapshot.overlay.backgroundOpacity / 100,
    "--caption-width": `${snapshot.overlay.maxWidth}%`,
  } as CSSProperties;

  const statusTone = snapshot.session.state === "error"
    ? "error"
    : snapshot.session.state === "listening"
      ? "live"
      : "idle";

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <Waveform size={23} weight="bold" />
          </span>
          <span>
            <span className="brand-name">AudioTranslate</span>
            <span className="brand-edition">Gemini Live</span>
          </span>
        </div>
        <div className="header-statuses">
          {client.mode === "mock" && <span className="dev-badge">Bản xem thử</span>}
          <span className="security-badge">
            <ShieldCheck size={17} weight="fill" aria-hidden="true" />
            Bảo mật chủ động
          </span>
          <span className="provider-badge" data-connected={snapshot.provider.connected}>
            <span className="status-dot" aria-hidden="true" />
            {snapshot.provider.connected ? "Gemini đã kết nối" : "Gemini chưa kết nối"}
          </span>
        </div>
      </header>

      <main className="main-layout">
        <aside className="setup-rail" aria-label="Thiết lập dịch trực tiếp">
          <div className="setup-heading">
            <p className="eyebrow">Thiết lập nhanh</p>
            <h1>Phụ đề trực tiếp trong 3 bước</h1>
            <p>Mỗi lựa chọn đều có giải thích rõ trước khi âm thanh được gửi đi.</p>
          </div>

          <nav className="steps" aria-label="Tiến trình thiết lập">
            <StepButton
              id={1}
              active={activeStep === 1}
              complete={completed[1]}
              title="Kết nối Gemini"
              description={completed[1] ? "Khoá hợp lệ, kết nối sẵn sàng" : "Lưu khoá và kiểm tra kết nối"}
              icon={<Key size={17} weight="bold" />}
              onClick={() => setActiveStep(1)}
            />
            <StepButton
              id={2}
              active={activeStep === 2}
              complete={completed[2]}
              title="Chọn nguồn và ngôn ngữ"
              description={completed[2] ? snapshot.source.label : "Tab Chrome, Edge hoặc tệp audio"}
              icon={<Translate size={17} weight="bold" />}
              onClick={() => setActiveStep(2)}
            />
            <StepButton
              id={3}
              active={activeStep === 3}
              complete={completed[3]}
              title="Bật phụ đề"
              description={completed[3] ? "Đang dịch trực tiếp" : "Kiểm tra riêng tư rồi bắt đầu"}
              icon={<Subtitles size={17} weight="bold" />}
              onClick={() => setActiveStep(3)}
            />
          </nav>

          <section className="step-content" aria-live="polite">
            {activeStep === 1 && (
              <div className="step-panel" aria-labelledby="step-one-title">
                <div className="panel-title-row">
                  <div>
                    <p className="section-kicker">Bước 1</p>
                    <h2 id="step-one-title">Kết nối Gemini API</h2>
                  </div>
                  {snapshot.provider.keyConfigured && (
                    <CheckCircle className="success-icon" size={23} weight="fill" aria-label="Đã lưu khoá" />
                  )}
                </div>

                <div className="provider-row">
                  <span className="provider-monogram" aria-hidden="true"><Waveform size={20} weight="bold" /></span>
                  <span>
                    <strong>Gemini Live Translate</strong>
                    <small>{snapshot.provider.model}</small>
                  </span>
                  <span className="provider-type">Thời gian thực</span>
                </div>

                {snapshot.provider.keyConfigured && (
                  <div className="key-saved-state">
                    <LockKey size={18} weight="fill" aria-hidden="true" />
                    <span>
                      <strong>Khoá đã lưu an toàn</strong>
                      <small>{snapshot.provider.maskedKeyHint || "••••••••••••••••"}</small>
                    </span>
                    <button
                      type="button"
                      className="key-delete"
                      disabled={busy !== null}
                      onClick={() => void runAction("delete-key", () => client.clearGeminiKey())}
                      aria-label="Xoá khoá Gemini đã lưu"
                    >
                      {busy === "delete-key" ? <CircleNotch className="spinner" size={16} /> : <Trash size={16} />}
                      Xoá
                    </button>
                  </div>
                )}

                <label className="field-label" htmlFor="gemini-key">Khoá API Gemini</label>
                <div className="secret-field">
                  <input
                    id="gemini-key"
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.currentTarget.value)}
                    placeholder={snapshot.provider.keyConfigured ? "Nhập khoá mới để thay thế" : "Dán khoá API tại đây"}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="key-help"
                  />
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setShowKey((visible) => !visible)}
                    aria-label={showKey ? "Ẩn khoá API" : "Hiện khoá API"}
                  >
                    {showKey ? <EyeSlash size={19} /> : <Eye size={19} />}
                  </button>
                </div>
                <p className="field-help" id="key-help">
                  Không ghi vào lịch sử, log hoặc bộ nhớ trình duyệt. Tiến trình chính phải lưu khoá bằng kho mật khẩu của hệ điều hành.
                </p>

                <div className="button-row">
                  <button
                    className="button secondary"
                    type="button"
                    disabled={!snapshot.provider.keyConfigured || busy !== null}
                    onClick={() => void runAction("test-key", () => client.testGeminiConnection())}
                  >
                    {busy === "test-key" ? <CircleNotch className="spinner" size={18} /> : <Waveform size={18} />}
                    Kiểm tra kết nối
                  </button>
                  <button
                    className="button primary"
                    type="button"
                    disabled={apiKey.trim().length < 20 || busy !== null}
                    onClick={() => void saveKey()}
                  >
                    {busy === "save-key" ? <CircleNotch className="spinner" size={18} /> : <LockKey size={18} />}
                    Lưu khoá
                  </button>
                </div>
                {snapshot.provider.connected && (
                  <button className="text-action" type="button" onClick={() => setActiveStep(2)}>
                    Tiếp tục chọn nguồn <ArrowRight size={16} weight="bold" />
                  </button>
                )}
              </div>
            )}

            {activeStep === 2 && (
              <div className="step-panel" aria-labelledby="step-two-title">
                <div className="panel-title-row">
                  <div>
                    <p className="section-kicker">Bước 2</p>
                    <h2 id="step-two-title">Nguồn âm thanh</h2>
                  </div>
                </div>

                <div className="segmented-control" aria-label="Loại nguồn âm thanh">
                  <button
                    type="button"
                    data-selected={snapshot.source.kind === "browser-tab"}
                    onClick={() => selectSource("browser-tab")}
                  >
                    <Browser size={18} /> Tab trình duyệt
                  </button>
                  <button
                    type="button"
                    data-selected={snapshot.source.kind === "file"}
                    onClick={() => selectSource("file")}
                  >
                    <FileAudio size={18} /> Tệp audio / video
                  </button>
                </div>

                <div className="source-state" data-connected={snapshot.source.connected}>
                  {snapshot.source.kind === "browser-tab" ? <Browser size={24} /> : <FileAudio size={24} />}
                  <span>
                    <strong>{snapshot.source.label}</strong>
                    <small>
                      {snapshot.source.kind === "browser-tab"
                        ? "Chỉ tab bạn xác nhận mới được thu âm"
                        : "Tệp không được sao chép vào thư mục ứng dụng"}
                    </small>
                  </span>
                  <button
                    className="button compact secondary"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void runAction(
                      "source",
                      snapshot.source.kind === "browser-tab"
                        ? () => client.connectBrowserTab()
                        : () => client.pickAudioFile(),
                    )}
                  >
                    {busy === "source" ? <CircleNotch className="spinner" size={16} /> : null}
                    {snapshot.source.connected ? "Chọn lại" : snapshot.source.kind === "browser-tab" ? "Ghép nối" : "Chọn tệp"}
                  </button>
                </div>

                <div className="language-grid">
                  <label>
                    <span>Ngôn ngữ đầu vào</span>
                    <select
                      value={snapshot.languages.source}
                      onChange={(event) => updateLanguages({ source: event.currentTarget.value })}
                    >
                      {languageOptions.map((language) => (
                        <option key={language.value} value={language.value}>{language.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Dịch sang</span>
                    <select
                      value={snapshot.languages.target}
                      onChange={(event) => updateLanguages({ target: event.currentTarget.value })}
                    >
                      {targetLanguageOptions.map((language) => (
                        <option key={language.value} value={language.value}>{language.label}</option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="info-strip">
                  <ShieldCheck size={19} weight="fill" aria-hidden="true" />
                  <p><strong>Luồng có kiểm soát.</strong> Audio chỉ đi từ nguồn đã chọn tới Gemini qua TLS trong lúc phiên dịch đang chạy.</p>
                </div>
                <button
                  className="text-action"
                  type="button"
                  disabled={!snapshot.source.connected}
                  onClick={() => setActiveStep(3)}
                >
                  Tiếp tục kiểm tra <ArrowRight size={16} weight="bold" />
                </button>
              </div>
            )}

            {activeStep === 3 && (
              <div className="step-panel" aria-labelledby="step-three-title">
                <div className="panel-title-row">
                  <div>
                    <p className="section-kicker">Bước 3</p>
                    <h2 id="step-three-title">Sẵn sàng bật phụ đề</h2>
                  </div>
                </div>

                <div className="readiness-list">
                  <div data-ready={snapshot.provider.connected}>
                    {snapshot.provider.connected ? <CheckCircle size={20} weight="fill" /> : <WarningCircle size={20} weight="fill" />}
                    <span><strong>Gemini</strong><small>{snapshot.provider.connected ? "Đã xác thực" : "Chưa kiểm tra kết nối"}</small></span>
                  </div>
                  <div data-ready={snapshot.source.connected}>
                    {snapshot.source.connected ? <CheckCircle size={20} weight="fill" /> : <WarningCircle size={20} weight="fill" />}
                    <span><strong>Nguồn audio</strong><small>{snapshot.source.label}</small></span>
                  </div>
                  <div data-ready="true">
                    <ShieldCheck size={20} weight="fill" />
                    <span><strong>Không lưu bản ghi</strong><small>Audio bị huỷ ngay sau khi xử lý</small></span>
                  </div>
                </div>

                <div className="consent-control">
                  <Toggle
                    checked={cloudConsent}
                    label="Cho phép gửi audio tới Google Gemini"
                    description="Chỉ trong phiên hiện tại; có thể dừng và thu hồi ngay"
                    onChange={setCloudConsent}
                  />
                </div>

                <details className="disclosure">
                  <summary><ShieldCheck size={18} /> Chính xác thì dữ liệu đi đâu?</summary>
                  <p>Audio từ tab hoặc tệp được chuyển theo thời gian thực tới Gemini API để nhận diện và dịch. AudioTranslate không lưu audio, transcript hay API key trong giao diện này. Không hệ thống kết nối mạng nào có thể cam kết “bảo mật tuyệt đối”; thiết kế này giảm rủi ro bằng quyền tối thiểu, TLS, ghép nối cục bộ và kho mật khẩu hệ điều hành.</p>
                </details>
                <details className="disclosure">
                  <summary><CurrencyCircleDollar size={18} /> Chi phí Gemini API</summary>
                  <p>Google có thể tính phí theo model và lượng audio sử dụng. AudioTranslate không tự đăng ký gói, không thêm phụ phí và cần hiển thị mức dùng do API trả về khi tích hợp backend.</p>
                </details>

                <button
                  className={isListening ? "button stop full-width" : "button primary full-width"}
                  type="button"
                  disabled={(!canStart && !isListening) || busy !== null || isWorking}
                  onClick={() => void runAction(
                    "session",
                    isListening ? () => client.stopSession() : () => client.startSession(),
                  )}
                >
                  {busy === "session" || isWorking ? (
                    <CircleNotch className="spinner" size={19} />
                  ) : isListening ? (
                    <Stop size={19} weight="fill" />
                  ) : (
                    <Play size={19} weight="fill" />
                  )}
                  {isListening ? "Dừng phiên dịch" : "Bắt đầu dịch trực tiếp"}
                </button>
                {!canStart && !isListening && (
                  <p className="start-help">Hoàn tất kết nối, chọn nguồn và xác nhận gửi audio tới Gemini để bắt đầu.</p>
                )}
              </div>
            )}
          </section>
        </aside>

        <section className="workspace" aria-label="Bản xem trước và tuỳ chỉnh overlay">
          <div className="workspace-header">
            <div>
              <p className="eyebrow">Bản xem trước trực tiếp</p>
              <h2>Overlay phụ đề</h2>
            </div>
            <div className="preview-actions">
              <span className="live-indicator" data-live={isListening}>
                <span aria-hidden="true" /> {isListening ? "Đang dịch" : "Xem trước"}
              </span>
              <button
                className="button compact ghost"
                type="button"
                disabled={busy !== null}
                onClick={() => void runAction("reset", () => client.resetOverlay())}
              >
                <ArrowCounterClockwise size={17} /> Đặt lại
              </button>
            </div>
          </div>

          <div className="preview-frame" style={previewStyle}>
            <div className="preview-topline">
              <span><Waveform size={16} /> Kênh âm thanh chính</span>
              <span>00:42:16</span>
            </div>
            <div className={`caption-anchor position-${snapshot.overlay.position}`}>
              <div className="caption-box">
                <p className="translated-caption">{caption.translation}</p>
                {snapshot.overlay.showSource && <p className="source-caption">{caption.transcript}</p>}
              </div>
              <div className="safe-area-label" aria-hidden="true">Vùng hiển thị an toàn</div>
            </div>
          </div>

          <section className="overlay-editor" aria-labelledby="overlay-editor-title">
            <div className="editor-title-row">
              <div>
                <p className="section-kicker">Tinh chỉnh overlay</p>
                <h3 id="overlay-editor-title">Kiểu hiển thị</h3>
              </div>
              <SlidersHorizontal size={21} aria-hidden="true" />
            </div>

            <div className="preset-row" aria-label="Mẫu overlay">
              {(
                [
                  ["cinema", "Điện ảnh", "Cân bằng"],
                  ["accessible", "Dễ đọc", "Chữ lớn"],
                  ["compact", "Gọn", "Ít che hình"],
                ] as const
              ).map(([id, label, hint]) => (
                <button
                  type="button"
                  key={id}
                  data-selected={snapshot.overlay.preset === id}
                  onClick={() => updateOverlay(presetSettings[id])}
                >
                  <strong>{label}</strong>
                  <small>{hint}</small>
                </button>
              ))}
            </div>

            <div className="editor-grid">
              <div className="sliders-group">
                <Slider
                  id="font-size"
                  label="Cỡ chữ"
                  value={snapshot.overlay.fontSize}
                  min={22}
                  max={52}
                  unit=" px"
                  onChange={(fontSize) => updateOverlay({ fontSize })}
                />
                <Slider
                  id="background-opacity"
                  label="Nền phụ đề"
                  value={snapshot.overlay.backgroundOpacity}
                  min={25}
                  max={95}
                  unit="%"
                  onChange={(backgroundOpacity) => updateOverlay({ backgroundOpacity })}
                />
                <Slider
                  id="caption-width"
                  label="Chiều rộng"
                  value={snapshot.overlay.maxWidth}
                  min={45}
                  max={94}
                  unit="%"
                  onChange={(maxWidth) => updateOverlay({ maxWidth })}
                />
              </div>

              <div className="editor-options">
                <div className="position-field">
                  <span>Vị trí màn hình</span>
                  <div className="position-buttons">
                    {(["top", "center", "bottom"] as const).map((position) => (
                      <button
                        type="button"
                        key={position}
                        data-selected={snapshot.overlay.position === position}
                        onClick={() => updateOverlay({ position })}
                      >
                        {position === "top" ? "Trên" : position === "center" ? "Giữa" : "Dưới"}
                      </button>
                    ))}
                  </div>
                </div>
                <Toggle
                  checked={snapshot.overlay.showSource}
                  label="Hiện câu gốc"
                  description="Một dòng nhỏ dưới bản dịch"
                  onChange={(showSource) => updateOverlay({ showSource })}
                />
                <Toggle
                  checked={snapshot.overlay.clickThrough}
                  label="Khoá thao tác"
                  description="Click xuyên qua overlay khi xem phim"
                  onChange={(clickThrough) => updateOverlay({ clickThrough })}
                />
              </div>
            </div>
          </section>
        </section>
      </main>

      <footer className="status-bar" data-tone={statusTone}>
        <div className="session-status" role="status" aria-live="polite">
          <span className="status-pulse" aria-hidden="true" />
          <strong>{snapshot.session.message}</strong>
          {snapshot.session.latencyMs !== null && <span>Độ trễ ~{snapshot.session.latencyMs} ms</span>}
        </div>
        <div className="privacy-status">
          <ShieldCheck size={16} weight="fill" /> Không lưu audio
          <span aria-hidden="true">·</span>
          <LockKey size={16} weight="fill" /> Khoá ngoài renderer
        </div>
      </footer>

      {uiError && (
        <div className="toast" role="alert">
          <WarningCircle size={20} weight="fill" />
          <span>{uiError}</span>
          <button type="button" onClick={() => setUiError(null)} aria-label="Đóng thông báo lỗi">Đóng</button>
        </div>
      )}
    </div>
  );
}

export { App } from "./FidelityApp";
