const statusElement = document.getElementById("status");
const statusText = document.getElementById("status-text");
const captionCard = document.getElementById("caption-card");
const finalLines = document.getElementById("final-lines");
const partialLine = document.getElementById("partial-line");
const sourceLine = document.getElementById("source-line");
const draftBadge = document.getElementById("draft-badge");
const overflowBadge = document.getElementById("overflow-badge");
const latencyElement = document.getElementById("latency");
const editToolbar = document.getElementById("edit-toolbar");
const safeGuide = document.getElementById("safe-guide");
const finalAnnouncer = document.getElementById("final-announcer");

const state = {
  finals: [],
  partial: null,
  lastSequence: -1,
  sessionId: null,
  activeCaption: null,
  lastStatusLevel: "idle",
  preferences: {
    hideAfterMs: 8000,
    showSource: true,
  },
};

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

function addTextLine(container, className, value) {
  const line = document.createElement("div");
  line.className = className;
  line.textContent = value;
  container.appendChild(line);
}

function captionMetadata(caption, pageMetadata) {
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
  if (Number.isFinite(caption?.latencyMs)) metadata.push(`~${Math.round(caption.latencyMs)} ms`);
  if (pageMetadata.pageCount > 1 && !pageMetadata.rolling) {
    metadata.push(`Trang ${pageMetadata.pageIndex + 1}/${pageMetadata.pageCount}`);
  }
  return metadata.join(" · ");
}

function renderCaptionPage(page, pageMetadata) {
  const caption = pageMetadata.context.caption;
  finalLines.replaceChildren();
  if (pageMetadata.isFinal && page.translation) {
    addTextLine(finalLines, "translation", page.translation);
  }

  partialLine.textContent = pageMetadata.isFinal ? "" : page.translation;
  partialLine.classList.toggle("hidden", pageMetadata.isFinal || !page.translation);
  draftBadge.classList.toggle("hidden", pageMetadata.isFinal);

  const shouldShowSource = pageMetadata.context.showSource && page.source;
  sourceLine.textContent = shouldShowSource ? page.source : "";
  sourceLine.classList.toggle("hidden", !shouldShowSource);

  overflowBadge.textContent = pageMetadata.overflow
    ? pageMetadata.rolling
      ? "DÀI · ĐANG CUỘN"
      : `DÀI · ${pageMetadata.pageIndex + 1}/${pageMetadata.pageCount}`
    : "";
  overflowBadge.classList.toggle("hidden", !pageMetadata.overflow);
  captionCard.dataset.overflow = String(pageMetadata.overflow);
  captionCard.dataset.needsReview = String(pageMetadata.needsReview);
  captionCard.dataset.pageIndex = String(pageMetadata.pageIndex);
  captionCard.dataset.pageCount = String(pageMetadata.pageCount);
  latencyElement.textContent = captionMetadata(caption, pageMetadata);

  captionCard.classList.remove("hidden");
  statusElement.classList.add("hidden");
  captionVisibility.show({
    isFinal: pageMetadata.isFinal,
    hideAfterMs: state.preferences.hideAfterMs,
  });

  if (pageMetadata.isFirstEmission) {
    requestAnimationFrame(() => {
      window.audioTranslate.reportRendered({
        sequence: caption.sequence,
        isFinal: caption.isFinal,
        rafAt: Date.now(),
        resultToRafMs: Math.max(0, Date.now() - Number(caption.emittedAt || Date.now())),
      });
    });
  }
}

const captionPager = AudioTranslateCaptionComposer.createCaptionPager({
  onPage: renderCaptionPage,
});

function showCaption(caption) {
  const primaryText = caption.translation || caption.transcript || "";
  const showSource =
    state.preferences.showSource !== false &&
    caption.showSource !== false &&
    Boolean(caption.translation && caption.transcript);
  const composition = AudioTranslateCaptionComposer.composeCaption(
    {
      translation: primaryText,
      transcript: showSource ? caption.transcript : "",
    },
    {
      maxLines: state.preferences.maxTranslationLines || 2,
      maxGraphemesPerLine: 42,
      sourceMaxLines: 1,
      sourceMaxGraphemesPerLine: 84,
    },
  );
  captionPager.show(composition, {
    isFinal: caption.isFinal,
    rolling: true,
    context: { caption, showSource },
  });
}

function renderCaption(caption) {
  if (!caption || caption.type !== "caption") return;
  if (caption.sessionId && caption.sessionId !== state.sessionId) {
    state.finals = [];
    state.partial = null;
    state.lastSequence = -1;
    state.sessionId = caption.sessionId;
  }
  if (Number.isFinite(caption.sequence) && caption.sequence < state.lastSequence) return;
  if (Number.isFinite(caption.sequence)) state.lastSequence = caption.sequence;

  if (caption.isFinal) {
    state.partial = null;
    if (caption.translation || caption.transcript) {
      const previous = state.finals[state.finals.length - 1];
      if (
        !previous ||
        previous.translation !== caption.translation ||
        previous.transcript !== caption.transcript
      ) {
        state.finals.push(caption);
      } else {
        return;
      }
      state.finals = state.finals.slice(-2);
      finalAnnouncer.textContent = caption.translation || caption.transcript;
    }
  } else {
    state.partial = caption;
  }
  state.activeCaption = caption;
  showCaption(caption);
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
  root.style.setProperty("--translation-size", `${preferences.translationFontSize || 36}px`);
  root.style.setProperty("--source-size", `${preferences.sourceFontSize || 17}px`);
  root.style.setProperty("--caption-weight", String(preferences.fontWeight || 700));
  root.style.setProperty("--caption-line-height", String(preferences.lineHeight || 1.24));
  root.style.setProperty("--panel-opacity", String(preferences.backgroundOpacity ?? 0.92));
  document.body.classList.toggle("high-contrast", preferences.highContrast !== false);
  if (state.activeCaption) showCaption(state.activeCaption);
});

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
