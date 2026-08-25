(function exposeCaptionComposer(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AudioTranslateCaptionComposer = api;
})(typeof globalThis === "object" ? globalThis : this, function createCaptionComposer() {
  "use strict";

  const DEFAULT_MAX_LINES = 2;
  const DEFAULT_MAX_GRAPHEMES = 42;
  const DEFAULT_PAGE_DURATION_MS = 2200;

  function positiveInteger(value, fallback) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }

  function splitGraphemes(value) {
    const text = String(value ?? "");
    if (!text) return [];
    if (typeof Intl === "object" && typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      return Array.from(segmenter.segment(text), ({ segment }) => segment);
    }

    // Supported Electron/Node versions provide Intl.Segmenter. This fallback still
    // keeps common combining marks, emoji modifiers and ZWJ emoji together.
    const graphemes = [];
    const combiningOrModifier = /[\p{M}\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]/u;
    const regionalIndicator = /\p{Regional_Indicator}/u;
    for (const symbol of Array.from(text)) {
      const previous = graphemes[graphemes.length - 1];
      if (
        previous &&
        (combiningOrModifier.test(symbol) || symbol === "\u200D" || previous.endsWith("\u200D"))
      ) {
        graphemes[graphemes.length - 1] += symbol;
      } else if (previous && regionalIndicator.test(symbol) && regionalIndicator.test(previous)) {
        graphemes[graphemes.length - 1] += symbol;
      } else {
        graphemes.push(symbol);
      }
    }
    return graphemes;
  }

  function graphemeCount(value) {
    return splitGraphemes(value).length;
  }

  function boundaryKind(grapheme) {
    if (!grapheme) return 0;
    if (/[.!?…。！？]["'”’»）)\]]*$/u.test(grapheme)) return 3;
    if (/[,;:，、；：]["'”’»）)\]]*$/u.test(grapheme)) return 2;
    if (/\s/u.test(grapheme)) return 1;
    return 0;
  }

  function chooseBoundary(graphemes, start, minimum, maximum) {
    let bestIndex = -1;
    let bestKind = 0;
    for (let index = Math.max(start + 1, minimum); index <= maximum; index += 1) {
      const kind = boundaryKind(graphemes[index - 1]);
      if (kind > bestKind || (kind === bestKind && kind > 0 && index > bestIndex)) {
        bestKind = kind;
        bestIndex = index;
      }
    }
    return bestIndex;
  }

  function splitPageLines(pageGraphemes, maxLines, maxGraphemesPerLine) {
    if (pageGraphemes.length === 0) return [];
    const neededLines = Math.min(
      maxLines,
      Math.ceil(pageGraphemes.length / maxGraphemesPerLine),
    );
    const rawLines = [];
    let cursor = 0;

    for (let lineIndex = 0; lineIndex < neededLines; lineIndex += 1) {
      const linesRemaining = neededLines - lineIndex;
      const graphemesRemaining = pageGraphemes.length - cursor;
      if (linesRemaining === 1) {
        rawLines.push(pageGraphemes.slice(cursor).join(""));
        break;
      }

      const minimumLength = Math.max(
        1,
        graphemesRemaining - maxGraphemesPerLine * (linesRemaining - 1),
      );
      // Breaking at or before the average makes the later/bottom line at least
      // as full as the current one, which is easier to scan as a subtitle.
      const preferredLength = Math.min(
        maxGraphemesPerLine,
        Math.floor(graphemesRemaining / linesRemaining),
      );
      const minimum = cursor + minimumLength;
      const maximum = cursor + Math.max(minimumLength, preferredLength);
      const semanticBoundary = chooseBoundary(pageGraphemes, cursor, minimum, maximum);
      const end = semanticBoundary > cursor ? semanticBoundary : maximum;
      rawLines.push(pageGraphemes.slice(cursor, end).join(""));
      cursor = end;
    }

    return rawLines;
  }

  function composeText(value, options = {}) {
    const rawText = String(value ?? "");
    const maxLines = positiveInteger(options.maxLines, DEFAULT_MAX_LINES);
    const maxGraphemesPerLine = positiveInteger(
      options.maxGraphemesPerLine,
      DEFAULT_MAX_GRAPHEMES,
    );
    const pageCapacity = maxLines * maxGraphemesPerLine;
    const graphemes = splitGraphemes(rawText);
    const pages = [];
    let cursor = 0;

    while (cursor < graphemes.length) {
      const remaining = graphemes.length - cursor;
      let end = Math.min(graphemes.length, cursor + pageCapacity);
      if (remaining > pageCapacity) {
        const minimum = cursor + Math.ceil(pageCapacity * 0.55);
        const semanticBoundary = chooseBoundary(graphemes, cursor, minimum, end);
        if (semanticBoundary > cursor) end = semanticBoundary;
      }

      const pageGraphemes = graphemes.slice(cursor, end);
      const rawLines = splitPageLines(pageGraphemes, maxLines, maxGraphemesPerLine);
      const lines = rawLines.map((line) => line.trim());
      pages.push(
        Object.freeze({
          index: pages.length,
          rawText: rawLines.join(""),
          text: lines.join("\n"),
          lines: Object.freeze(lines),
          rawLines: Object.freeze(rawLines),
          graphemeCount: pageGraphemes.length,
        }),
      );
      cursor = end;
    }

    const overflow = pages.length > 1;
    return Object.freeze({
      rawText,
      pages: Object.freeze(pages),
      qc: Object.freeze({
        overflow,
        needsReview: overflow,
        reasons: Object.freeze(overflow ? ["caption-overflow"] : []),
        pageCount: pages.length,
        graphemeCount: graphemes.length,
        maxLines,
        maxGraphemesPerLine,
      }),
    });
  }

  function mappedPage(layout, pageIndex, pageCount) {
    if (!layout.pages.length) return null;
    const mappedIndex = Math.min(
      layout.pages.length - 1,
      Math.floor((pageIndex * layout.pages.length) / pageCount),
    );
    return layout.pages[mappedIndex];
  }

  function composeCaption(caption = {}, options = {}) {
    const translationValue = caption.translation || caption.transcript || "";
    const sourceValue = caption.transcript || "";
    const translation = composeText(translationValue, {
      maxLines: options.maxLines,
      maxGraphemesPerLine: options.maxGraphemesPerLine,
    });
    const source = composeText(sourceValue, {
      maxLines: options.sourceMaxLines || 1,
      maxGraphemesPerLine: options.sourceMaxGraphemesPerLine || 84,
    });
    const pageCount = Math.max(translation.pages.length, source.pages.length);
    const pages = [];

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const translationPage = mappedPage(translation, pageIndex, pageCount);
      const sourcePage = mappedPage(source, pageIndex, pageCount);
      pages.push(
        Object.freeze({
          index: pageIndex,
          translation: translationPage?.text || "",
          translationRaw: translationPage?.rawText || "",
          source: sourcePage?.text || "",
          sourceRaw: sourcePage?.rawText || "",
        }),
      );
    }

    const overflow = pageCount > 1;
    return Object.freeze({
      pages: Object.freeze(pages),
      translation,
      source,
      qc: Object.freeze({
        overflow,
        needsReview: overflow,
        reasons: Object.freeze(overflow ? ["caption-overflow"] : []),
        pageCount,
      }),
    });
  }

  function rollingTailPage(layout) {
    const rawText = String(layout?.rawText || "");
    if (!rawText) return null;
    const maxLines = positiveInteger(layout?.qc?.maxLines, DEFAULT_MAX_LINES);
    const maxGraphemesPerLine = positiveInteger(
      layout?.qc?.maxGraphemesPerLine,
      DEFAULT_MAX_GRAPHEMES,
    );
    const capacity = maxLines * maxGraphemesPerLine;
    const graphemes = splitGraphemes(rawText);
    let start = Math.max(0, graphemes.length - capacity);

    // When the rolling window starts inside a spaced word, discard only that
    // broken prefix. Languages without spaces keep the exact grapheme window.
    if (start > 0) {
      while (start < graphemes.length && /\s/u.test(graphemes[start])) start += 1;
      const previous = graphemes[start - 1];
      const current = graphemes[start];
      if (current && boundaryKind(previous) === 0 && boundaryKind(current) === 0) {
        const searchLimit = Math.min(
          graphemes.length,
          start + Math.max(4, Math.floor(maxGraphemesPerLine / 3)),
        );
        for (let index = start; index < searchLimit; index += 1) {
          if (/\s/u.test(graphemes[index])) {
            start = index + 1;
            break;
          }
        }
      }
    }

    const tail = graphemes.slice(start).join("").trimStart();
    return composeText(tail, { maxLines, maxGraphemesPerLine }).pages.at(-1) || null;
  }

  function rollingCaptionPage(composition, pageIndex) {
    const translationPage = rollingTailPage(composition?.translation);
    const sourcePage = rollingTailPage(composition?.source);
    return Object.freeze({
      index: pageIndex,
      translation: translationPage?.text || "",
      translationRaw: translationPage?.rawText || "",
      source: sourcePage?.text || "",
      sourceRaw: sourcePage?.rawText || "",
    });
  }

  function createCaptionPager(options = {}) {
    if (typeof options.onPage !== "function") {
      throw new TypeError("createCaptionPager requires an onPage callback");
    }
    const setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
    const clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
    const pageDurationMs = positiveInteger(options.pageDurationMs, DEFAULT_PAGE_DURATION_MS);
    let generation = 0;
    let timer = null;
    let activePageIndex = -1;
    let activePageCount = 0;

    function cancel() {
      generation += 1;
      if (timer !== null) clearTimer(timer);
      timer = null;
      activePageIndex = -1;
      activePageCount = 0;
    }

    function show(composition, showOptions = {}) {
      cancel();
      const pages = Array.isArray(composition?.pages) ? composition.pages : [];
      if (pages.length === 0) return;
      const isFinal = showOptions.isFinal !== false;
      const rolling = showOptions.rolling === true;
      const indexes =
        isFinal && !rolling ? pages.map((_, index) => index) : [pages.length - 1];
      const currentGeneration = generation;
      let step = 0;
      activePageCount = pages.length;

      function emitPage() {
        if (currentGeneration !== generation) return;
        const pageIndex = indexes[step];
        activePageIndex = pageIndex;
        options.onPage(
          rolling ? rollingCaptionPage(composition, pageIndex) : pages[pageIndex],
          Object.freeze({
            pageIndex,
            pageCount: pages.length,
            isFinal,
            rolling,
            isTail: pageIndex === pages.length - 1,
            isFirstEmission: step === 0,
            overflow: composition.qc?.overflow === true,
            needsReview: composition.qc?.needsReview === true,
            context: showOptions.context,
          }),
        );
        step += 1;
        if (step < indexes.length) timer = setTimer(emitPage, pageDurationMs);
        else timer = null;
      }

      emitPage();
    }

    function snapshot() {
      return Object.freeze({
        pending: timer !== null,
        pageIndex: activePageIndex,
        pageCount: activePageCount,
      });
    }

    return Object.freeze({ cancel, dispose: cancel, show, snapshot });
  }

  function createCaptionVisibilityController(options = {}) {
    if (typeof options.onHide !== "function") {
      throw new TypeError("createCaptionVisibilityController requires an onHide callback");
    }
    const setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
    const clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
    let generation = 0;
    let timer = null;

    function cancel() {
      generation += 1;
      if (timer !== null) clearTimer(timer);
      timer = null;
    }

    function show(showOptions = {}) {
      cancel();
      const hideAfterMs = Number(showOptions.hideAfterMs);
      const delay = Number.isFinite(hideAfterMs)
        ? Math.max(0, Math.floor(hideAfterMs))
        : 0;
      if (showOptions.isFinal !== true || delay === 0) return;

      const currentGeneration = generation;
      timer = setTimer(() => {
        if (currentGeneration !== generation) return;
        timer = null;
        options.onHide();
      }, delay);
      timer?.unref?.();
    }

    function snapshot() {
      return Object.freeze({ pending: timer !== null });
    }

    return Object.freeze({ cancel, dispose: cancel, show, snapshot });
  }

  return Object.freeze({
    composeCaption,
    composeText,
    createCaptionPager,
    createCaptionVisibilityController,
    graphemeCount,
    splitGraphemes,
  });
});
