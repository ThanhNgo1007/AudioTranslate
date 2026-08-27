const statusElement = document.getElementById("status");
const statusText = document.getElementById("status-text");
const captionCard = document.getElementById("caption-card");
const finalLines = document.getElementById("final-lines");
const translatedLine = document.getElementById("partial-line");
const sourceLine = document.getElementById("source-line");
const draftBadge = document.getElementById("draft-badge");
const overflowBadge = document.getElementById("overflow-badge");
const latencyElement = document.getElementById("latency");
const editToolbar = document.getElementById("edit-toolbar");
const safeGuide = document.getElementById("safe-guide");
const finalAnnouncer = document.getElementById("final-announcer");

const state = {
  activeCaption: null,
  lastStatusLevel: "idle",
  preferences: {
    hideAfterMs: 8000,
    showSource: false,
    maxTranslationLines: 2,
    captionResetGapMs: 1100,
  },
};

const liveCaptionBlock = AudioTranslateLiveCaptionBlock.createLiveCaptionBlock({
  resetGapMs: state.preferences.captionResetGapMs,
});
const measurementCanvas = document.createElement("canvas");
const measurementContext = measurementCanvas.getContext?.("2d") || null;

const captionVisibility =
  AudioTranslateCaptionComposer.createCaptionVisibilityController({
    onHide() {
      captionCard.classList.add("hidden");
      statusElement.classList.toggle(
        "hidden",
        ["listening", "ok"].includes(state.lastStatusLevel),
      );
    },
  });

function pixels(value) {
  const number = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) ? number : 0;
}

function contentWidth() {
  const cardStyle = getComputedStyle(captionCard);
  const measuredCardWidth =
    Number(captionCard.clientWidth) ||
    Number(captionCard.getBoundingClientRect?.().width) ||
    Number(window.innerWidth) ||
    0;
  return Math.max(
    0,
    measuredCardWidth - pixels(cardStyle.paddingLeft) - pixels(cardStyle.paddingRight),
  );
}

function measurementFor(element) {
  if (!measurementContext) return null;
  const style = getComputedStyle(element);
  const composedFont = [
    style.fontStyle || "normal",
    style.fontVariant || "normal",
    style.fontWeight || "400",
    style.fontSize || "16px",
    style.fontFamily || "sans-serif",
  ].join(" ");
  measurementContext.font = style.font && style.font !== "normal" ? style.font : composedFont;
  const letterSpacing = pixels(style.letterSpacing);
  return (value) => {
    const text = String(value ?? "");
    const width = measurementContext.measureText(text).width;
    return (
      width +
      Math.max(0, AudioTranslateCaptionComposer.graphemeCount(text) - 1) * letterSpacing
    );
  };
}

function paginateTranslation(value) {
  const requestedLines = Number(state.preferences.maxTranslationLines);
  const maxLines = Number.isFinite(requestedLines)
    ? Math.min(2, Math.max(1, Math.floor(requestedLines)))
    : 2;
  return AudioTranslateCaptionComposer.composeMeasuredText(value, {
    maxLines,
    maxWidth: contentWidth(),
    measureText: measurementFor(translatedLine),
    fallbackMaxGraphemesPerLine: 52,
  });
}

function latestMeasuredPage(value, element, maxLines) {
  const composition = AudioTranslateCaptionComposer.composeMeasuredText(value, {
    maxLines,
    maxWidth: contentWidth(),
    measureText: measurementFor(element),
    fallbackMaxGraphemesPerLine: maxLines === 1 ? 84 : 52,
  });
  return composition.rollingPage || composition.pages.at(-1) || null;
}

function captionMetadata(caption, snapshot) {
  const metadata = [];
  if (caption?.sourceLanguageMode === "auto" && caption.sourceLanguage) {
    const details = [caption.languageDetectionConfidence]
      .filter(Boolean)
      .concat(
        Number.isFinite(caption.languageDetectionLatencyMs)
          ? `${Math.round(caption.languageDetectionLatencyMs)} ms`
          : [],
      )
      .join("/");
    metadata.push(`${caption.sourceLanguage}${details ? ` · LID ${details}` : ""}`);
  }
  const liveEdge = Number.isFinite(caption?.liveEdgeToPartialMs)
    ? caption.liveEdgeToPartialMs
    : caption?.latencyMs;
  if (Number.isFinite(liveEdge)) metadata.push(`~${Math.round(liveEdge)} ms`);
  if (snapshot.pageCount > 1) metadata.push("2 dòng mới nhất");
  return metadata.join(" · ");
}

function renderSource(caption, showSource) {
  const sourceText = showSource ? String(caption?.transcript || "") : "";
  const sourcePage = sourceText ? latestMeasuredPage(sourceText, sourceLine, 1) : null;
  sourceLine.textContent = sourcePage?.text || "";
  sourceLine.classList.toggle("hidden", !sourceLine.textContent);
}

function renderSnapshot(snapshot, caption, options = {}) {
  // Keep exactly one translated DOM node for partial and final updates. Replacing
  // only textContent prevents layout churn and avoids replaying old caption pages.
  finalLines.replaceChildren();
  finalLines.classList.add("hidden");
  translatedLine.textContent = snapshot.text;
  translatedLine.classList.toggle("hidden", !snapshot.text);
  translatedLine.classList.toggle("partial", snapshot.isFinal !== true);
  draftBadge.classList.add("hidden");

  const showSource =
    state.preferences.showSource === true &&
    caption?.showSource !== false &&
    Boolean(caption?.translation && caption?.transcript);
  renderSource(caption, showSource);

  overflowBadge.textContent = snapshot.overflow ? "DÀI · ĐANG CUỘN" : "";
  overflowBadge.classList.toggle("hidden", !snapshot.overflow);
  captionCard.dataset.overflow = String(snapshot.overflow);
  captionCard.dataset.needsReview = String(snapshot.overflow);
  captionCard.dataset.pageIndex = String(snapshot.pageIndex);
  captionCard.dataset.pageCount = String(snapshot.pageCount);
  latencyElement.textContent = captionMetadata(caption, snapshot);

  if (!snapshot.text) {
    captionCard.classList.add("hidden");
    return;
  }
  captionCard.classList.remove("hidden");
  statusElement.classList.add("hidden");
  if (options.updateVisibility !== false) {
    captionVisibility.show({
      isFinal: snapshot.isFinal,
      hideAfterMs: state.preferences.hideAfterMs,
    });
  }
  if (snapshot.isFinal && options.announce !== false) {
    finalAnnouncer.textContent = snapshot.semanticText;
  }
}

function reportRendered(caption) {
  requestAnimationFrame(() => {
    const rafAt = Date.now();
    const emittedAt = Number(caption?.emittedAt);
    window.audioTranslate.reportRendered({
      sessionId: caption?.sessionId == null ? null : String(caption.sessionId),
      generation: Number.isFinite(caption?.generation) ? Number(caption.generation) : null,
      sequence: Number.isFinite(caption?.sequence) ? Number(caption.sequence) : null,
      isFinal: caption?.isFinal === true,
      rafAt,
      resultToRafMs: Number.isFinite(emittedAt) ? Math.max(0, rafAt - emittedAt) : 0,
    });
  });
}

function renderCaption(caption) {
  if (!caption || caption.type !== "caption") return;
  const previousMetadata = liveCaptionBlock.snapshot().metadata;
  const snapshot = liveCaptionBlock.apply(caption, paginateTranslation);
  if (snapshot.metadata === previousMetadata) return;
  state.activeCaption = caption;
  renderSnapshot(snapshot, caption);
  reportRendered(caption);
}

let reflowScheduled = false;
function scheduleReflow() {
  if (reflowScheduled) return;
  reflowScheduled = true;
  requestAnimationFrame(() => {
    reflowScheduled = false;
    if (!state.activeCaption || !liveCaptionBlock.snapshot().semanticText) return;
    const snapshot = liveCaptionBlock.reflow(paginateTranslation);
    renderSnapshot(snapshot, state.activeCaption, {
      announce: false,
      updateVisibility: false,
    });
  });
}

window.audioTranslate.onCaption(renderCaption);
window.audioTranslate.onStatus((status) => {
  state.lastStatusLevel = status.level || "idle";
  statusElement.dataset.level = status.level || "idle";
  statusText.textContent = status.message || "Đang chờ audio từ trình duyệt…";
  if (captionCard.classList.contains("hidden")) {
    statusElement.classList.toggle("hidden", ["listening", "ok"].includes(state.lastStatusLevel));
  }
});
window.audioTranslate.onInteraction(({ clickThrough }) => {
  document.body.classList.toggle("interactive", !clickThrough);
  editToolbar.classList.toggle("hidden", clickThrough);
  safeGuide.classList.toggle("hidden", clickThrough);
});
window.audioTranslate.onPreferences((preferences = {}) => {
  state.preferences = { ...state.preferences, ...preferences };
  const root = document.documentElement;
  const translationFontSize = Number(state.preferences.translationFontSize) || 36;
  const captionLineHeight = Number(state.preferences.lineHeight) || 1.24;
  root.style.setProperty("--translation-size", `${translationFontSize}px`);
  root.style.setProperty("--source-size", `${state.preferences.sourceFontSize || 17}px`);
  root.style.setProperty("--caption-weight", String(state.preferences.fontWeight || 700));
  root.style.setProperty("--caption-line-height", String(captionLineHeight));
  root.style.setProperty(
    "--caption-two-line-height",
    `${Math.ceil(translationFontSize * captionLineHeight * 2)}px`,
  );
  root.style.setProperty("--panel-opacity", String(state.preferences.backgroundOpacity ?? 0.92));
  document.body.classList.toggle("high-contrast", state.preferences.highContrast !== false);
  liveCaptionBlock.setResetGapMs(state.preferences.captionResetGapMs);
  scheduleReflow();
});
window.addEventListener("resize", scheduleReflow);

document.getElementById("lock-overlay").addEventListener("click", () => {
  window.audioTranslate.setLocked(true);
});
document.getElementById("open-settings").addEventListener("click", () => {
  window.audioTranslate.openControlCenter();
});
document.getElementById("preset-bottom").addEventListener("click", () => {
  window.audioTranslate.applyPreset("bottom");
});
document.getElementById("preset-top").addEventListener("click", () => {
  window.audioTranslate.applyPreset("top");
});

document.addEventListener("keydown", (event) => {
  if (!document.body.classList.contains("interactive")) return;
  const command = AudioTranslateOverlayKeyboard.commandForOverlayKey(event.key, event.shiftKey);
  if (!command) return;
  event.preventDefault();
  if (command.type === "lock") {
    window.audioTranslate.setLocked(true);
    return;
  }
  window.audioTranslate.nudge({ x: command.x, y: command.y });
});
