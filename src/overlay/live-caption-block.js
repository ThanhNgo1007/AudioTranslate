(function exposeLiveCaptionBlock(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AudioTranslateLiveCaptionBlock = api;
})(typeof globalThis === "object" ? globalThis : this, function createModule() {
  "use strict";

  const DEFAULT_RESET_GAP_MS = 1100;

  function normalizeResetGap(value) {
    const number = Number(value ?? DEFAULT_RESET_GAP_MS);
    if (!Number.isFinite(number)) return DEFAULT_RESET_GAP_MS;
    return Math.min(5000, Math.max(250, Math.round(number)));
  }

  function normalizeText(value) {
    return String(value ?? "").replace(/\s+/gu, " ").trim();
  }

  function appendText(prefix, suffix) {
    const left = normalizeText(prefix);
    const right = normalizeText(suffix);
    if (!left) return right;
    if (!right) return left;
    if (/^[,.;:!?…。！？、，；：%)\]}»”’]/u.test(right)) return `${left}${right}`;
    if (/[\s([{«“‘]$/u.test(left)) return `${left}${right}`;
    return `${left} ${right}`;
  }

  function splitGraphemes(value) {
    const text = String(value ?? "");
    if (!text) return [];
    if (typeof Intl === "object" && typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      return Array.from(segmenter.segment(text), ({ segment }) => segment);
    }
    return Array.from(text);
  }

  function defaultLayout(text) {
    if (!text) return { pages: [] };
    return {
      pages: [{ index: 0, rawText: text, text, lines: [text] }],
      qc: { overflow: false, pageCount: 1 },
    };
  }

  function normalizePage(page, index) {
    const rawText = String(page?.rawText ?? page?.text ?? "");
    const lines = Array.isArray(page?.lines)
      ? page.lines.map((line) => String(line))
      : String(page?.text ?? rawText)
          .split("\n")
          .filter(Boolean);
    return Object.freeze({
      index: Number.isFinite(page?.index) ? Math.max(0, Math.floor(page.index)) : index,
      rawText,
      text: String(page?.text ?? lines.join("\n")),
      lines: Object.freeze(lines),
    });
  }

  function createLiveCaptionBlock(options = {}) {
    let resetGapMs = normalizeResetGap(options.resetGapMs);
    const now = typeof options.now === "function" ? options.now : Date.now;
    let committedPrefix = "";
    let mutableSuffix = "";
    let lastFinalAt = null;
    let sessionId = null;
    let streamGeneration = null;
    let lastSequence = -1;
    let generation = 0;
    let isFinal = false;
    let latestMetadata = null;
    let lastPaginate = defaultLayout;
    let rendered = {
      rawText: "",
      text: "",
      lines: Object.freeze([]),
      pageIndex: -1,
      pageCount: 0,
      overflow: false,
    };

    function semanticText() {
      return appendText(committedPrefix, mutableSuffix);
    }

    function resetContent() {
      committedPrefix = "";
      mutableSuffix = "";
      lastFinalAt = null;
      isFinal = false;
      latestMetadata = null;
      generation += 1;
    }

    function compose(paginate = lastPaginate) {
      if (typeof paginate !== "function") throw new TypeError("paginate must be a function");
      lastPaginate = paginate;
      const semantic = semanticText();
      const candidate = paginate(semantic);
      const pages = Array.isArray(candidate?.pages)
        ? candidate.pages.map(normalizePage)
        : defaultLayout(semantic).pages.map(normalizePage);
      const pageCount = pages.length;
      const pageIndex = pageCount - 1;
      let page = pageIndex >= 0 ? pages[pageIndex] : null;
      const maxLines = Number(candidate?.qc?.maxLines);
      const maxGraphemesPerLine = Number(candidate?.qc?.maxGraphemesPerLine);
      if (pageCount > 1 && candidate?.rollingPage) {
        page = normalizePage(candidate.rollingPage, pageIndex);
      } else if (
        pageCount > 1 &&
        Number.isSafeInteger(maxLines) &&
        maxLines > 0 &&
        Number.isSafeInteger(maxGraphemesPerLine) &&
        maxGraphemesPerLine > 0
      ) {
        const graphemes = splitGraphemes(semantic);
        const tail = graphemes.slice(-(maxLines * maxGraphemesPerLine)).join("").trimStart();
        const tailCandidate = paginate(tail);
        const tailPages = Array.isArray(tailCandidate?.pages)
          ? tailCandidate.pages.map(normalizePage)
          : [];
        if (tailPages.length > 0) page = tailPages[tailPages.length - 1];
      }
      rendered = {
        rawText: page?.rawText || "",
        text: page?.text || "",
        lines: page?.lines || Object.freeze([]),
        pageIndex,
        pageCount,
        overflow: pageCount > 1 || candidate?.qc?.overflow === true,
      };
      return snapshot();
    }

    function switchStream(nextSessionId, nextStreamGeneration) {
      const hasCurrentIdentity = sessionId !== null || streamGeneration !== null;
      const sessionChanged =
        nextSessionId !== null && sessionId !== null && nextSessionId !== sessionId;
      const generationChanged =
        nextStreamGeneration !== null &&
        streamGeneration !== null &&
        nextStreamGeneration !== streamGeneration;
      if (hasCurrentIdentity && (sessionChanged || generationChanged)) {
        resetContent();
        lastSequence = -1;
        sessionId = null;
        streamGeneration = null;
      }
      if (nextSessionId !== null) sessionId = nextSessionId;
      if (nextStreamGeneration !== null) streamGeneration = nextStreamGeneration;
    }

    function apply(caption = {}, paginate = lastPaginate) {
      if (!caption || caption.type !== "caption") return snapshot();
      const nextSessionId = caption.sessionId == null ? null : String(caption.sessionId);
      const nextStreamGeneration = Number.isFinite(caption.generation)
        ? Number(caption.generation)
        : null;
      switchStream(nextSessionId, nextStreamGeneration);

      const sequence = Number(caption.sequence);
      if (Number.isFinite(sequence) && sequence <= lastSequence) return snapshot();
      const emittedAt = Number(caption.emittedAt);
      const eventAt = Number.isFinite(emittedAt) ? emittedAt : Number(now());
      const text = normalizeText(caption.translation || caption.transcript || "");

      if (
        caption.isFinal !== true &&
        !mutableSuffix &&
        committedPrefix &&
        Number.isFinite(lastFinalAt) &&
        Number.isFinite(eventAt) &&
        eventAt - lastFinalAt > resetGapMs
      ) {
        resetContent();
      }

      if (Number.isFinite(sequence)) lastSequence = sequence;
      latestMetadata = Object.freeze({
        sessionId,
        sequence: Number.isFinite(sequence) ? sequence : null,
        emittedAt: Number.isFinite(eventAt) ? eventAt : null,
        isFinal: caption.isFinal === true,
        latencyMs: Number.isFinite(caption.latencyMs) ? Math.max(0, caption.latencyMs) : null,
        liveEdgeToPartialMs: Number.isFinite(caption.liveEdgeToPartialMs)
          ? Math.max(0, caption.liveEdgeToPartialMs)
          : null,
        partialToFinalMs: Number.isFinite(caption.partialToFinalMs)
          ? Math.max(0, caption.partialToFinalMs)
          : null,
      });

      if (caption.isFinal === true) {
        const finalized = text || mutableSuffix;
        if (finalized) committedPrefix = appendText(committedPrefix, finalized);
        mutableSuffix = "";
        lastFinalAt = Number.isFinite(eventAt) ? eventAt : Number(now());
        isFinal = true;
      } else {
        if (text) mutableSuffix = text;
        isFinal = false;
      }
      return compose(paginate);
    }

    function reflow(paginate = lastPaginate) {
      return compose(paginate);
    }

    function setResetGapMs(value) {
      resetGapMs = normalizeResetGap(value);
      return snapshot();
    }

    function clear() {
      committedPrefix = "";
      mutableSuffix = "";
      lastFinalAt = null;
      sessionId = null;
      streamGeneration = null;
      lastSequence = -1;
      isFinal = false;
      latestMetadata = null;
      generation += 1;
      rendered = {
        rawText: "",
        text: "",
        lines: Object.freeze([]),
        pageIndex: -1,
        pageCount: 0,
        overflow: false,
      };
      return snapshot();
    }

    function snapshot() {
      return Object.freeze({
        committedPrefix,
        mutableSuffix,
        semanticText: semanticText(),
        rawText: rendered.rawText,
        text: rendered.text,
        lines: Object.freeze([...rendered.lines]),
        pageIndex: rendered.pageIndex,
        pageCount: rendered.pageCount,
        overflow: rendered.overflow,
        isFinal,
        lastFinalAt,
        lastSequence,
        sessionId,
        streamGeneration,
        generation,
        metadata: latestMetadata,
      });
    }

    return Object.freeze({ apply, clear, reflow, setResetGapMs, snapshot });
  }

  return Object.freeze({ appendText, createLiveCaptionBlock });
});
