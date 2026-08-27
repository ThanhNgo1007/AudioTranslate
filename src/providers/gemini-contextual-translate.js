const { GeminiLiveTranscriber } = require("./gemini-live-transcribe");
const { GeminiContextualTextTranslator } = require("./gemini-text-translation");

const MIN_FIRST_PARTIAL_CHARS = 8;
const MIN_PARTIAL_GROWTH_CHARS = 12;
const MIN_OUTPUT_PHRASE_CHARS = 12;
const MAX_SOURCE_CHARS = 8_000;
const MAX_CONTEXT_FIELD_CHARS = 4_000;
const MAX_PENDING_FINALS = 8;
const MAX_PENDING_FINAL_CHARS = 32_000;
const MAX_HISTORY_CHARS = 12_000;
const VALID_MODES = new Set(["balanced", "accurate"]);

const secrets = new WeakMap();

function normalizeApiKey(value) {
  const apiKey = String(value || "");
  if (!apiKey) throw new Error("Gemini API key is required");
  if (apiKey.length > 16 * 1_024 || /[\u0000\r\n]/.test(apiKey)) {
    throw new Error("Invalid Gemini API key");
  }
  return apiKey;
}

function normalizeMode(value) {
  const mode = String(value || "balanced").trim().toLowerCase();
  if (!VALID_MODES.has(mode)) {
    throw new Error("Gemini contextual mode must be balanced or accurate");
  }
  return mode;
}

function normalizeLanguage(value, label, { allowAuto = false } = {}) {
  const language = String(value || "").trim();
  if (allowAuto && language.toLowerCase() === "auto") return "auto";
  if (!language || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) {
    throw new Error(`Invalid Gemini ${label} language`);
  }
  return language;
}

function normalizeLanguageCandidates(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Gemini source language candidates must be an array");
  const seen = new Set();
  return value.slice(0, 8).map((language) =>
    normalizeLanguage(language, "source language hint"),
  ).filter((language) => {
    const key = language.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeInteger(value, fallback, label, minimum, maximum) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

function normalizeDataText(value, maximum = MAX_CONTEXT_FIELD_CHARS) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, maximum);
}

function normalizeTranscript(value) {
  return normalizeDataText(value, MAX_SOURCE_CHARS).replace(/\s+/g, " ").trim();
}

function readableLength(value) {
  return String(value || "").replace(/\s/g, "").length;
}

function hasPhraseBoundary(value) {
  return /[.!?…,:;。！？]\s*$/u.test(String(value || ""));
}

function deriveCustomVocabulary(glossary, characterContext) {
  const result = [];
  const seen = new Set();
  const add = (value) => {
    const term = String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/['’]s$/i, "")
      .slice(0, 100);
    if (!term) return;
    const key = term.toLocaleLowerCase("und");
    if (seen.has(key) || result.length >= 100) return;
    seen.add(key);
    result.push(term);
  };

  for (const line of String(glossary || "").split("\n")) {
    add(line.includes("=") ? line.slice(0, line.indexOf("=")) : line);
  }
  for (const line of String(characterContext || "").split("\n")) {
    if (line.includes(":")) add(line.slice(0, line.indexOf(":")));
    for (const match of line.matchAll(/(?:^|[^\p{L}\p{M}])(\p{Lu}[\p{L}\p{M}'’.-]{1,49})/gu)) {
      add(match[1]);
    }
  }
  return result;
}

function abortError() {
  const error = new Error("Contextual translation job was aborted");
  error.name = "AbortError";
  error.code = "TRANSLATION_ABORTED";
  return error;
}

function isAbortError(error, job) {
  return job?.controller?.signal?.aborted || error?.code === "TRANSLATION_ABORTED" || error?.name === "AbortError";
}

function boundedHistory(history, maximumTurns) {
  if (maximumTurns === 0) return [];
  const candidates = history.slice(-maximumTurns);
  const result = [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = [candidates[index], ...result];
    if (JSON.stringify(candidate).length > MAX_HISTORY_CHARS) continue;
    result.unshift(candidates[index]);
  }
  return result;
}

function defaultCreateTranscriber(options) {
  return new GeminiLiveTranscriber(options);
}

function defaultCreateTextTranslator(options) {
  return new GeminiContextualTextTranslator(options);
}

class GeminiContextualTranslator {
  constructor(options = {}) {
    const apiKey = normalizeApiKey(options.apiKey ?? options.key);
    secrets.set(this, { apiKey });
    this.mode = normalizeMode(options.mode);
    this.sourceLanguage = normalizeLanguage(options.sourceLanguage || "auto", "source", {
      allowAuto: true,
    });
    this.sourceLanguageCandidates = normalizeLanguageCandidates(options.sourceLanguageCandidates);
    this.targetLanguage = normalizeLanguage(options.targetLanguage, "target");
    this.transcriptionModel = options.transcriptionModel;
    this.textModel = options.textModel;
    this.contextTurns = normalizeInteger(
      options.contextTurns,
      4,
      "Gemini contextTurns",
      0,
      6,
    );
    this.partialThrottleMs = normalizeInteger(
      options.partialThrottleMs,
      450,
      "Gemini partialThrottleMs",
      0,
      2_000,
    );
    this.glossary = normalizeDataText(options.glossary);
    this.characterContext = normalizeDataText(options.characterContext);
    const customVocabulary = deriveCustomVocabulary(this.glossary, this.characterContext);
    this.onCaption = options.onCaption;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
    this.onTerminal = options.onTerminal;
    this.onLanguageDetected = options.onLanguageDetected;
    this.onUsage = options.onUsage;
    this.now = options.now || Date.now;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;

    const createTranscriber = options.createTranscriber || defaultCreateTranscriber;
    const createTextTranslator = options.createTextTranslator || defaultCreateTextTranslator;
    if (typeof createTranscriber !== "function" || typeof createTextTranslator !== "function") {
      throw new Error("Gemini contextual provider factories must be functions");
    }

    Object.defineProperties(this, {
      history: { value: [], writable: false, enumerable: false },
      pendingFinals: { value: [], writable: false, enumerable: false },
      transcriber: {
        value: createTranscriber({
          apiKey,
          model: this.transcriptionModel,
          sourceLanguage: this.sourceLanguage,
          sourceLanguageCandidates: this.sourceLanguageCandidates,
          customVocabulary,
          onTranscript: (transcript) => this.handleTranscript(transcript),
          onStatus: (status) => this.onStatus?.(status),
          onError: (error) => this.onError?.(error),
          onTerminal: (error) => this.signalTerminal(error),
          onLanguageDetected: (detection) => this.handleLanguageDetected(detection),
          onUsage: (usage) => this.onUsage?.(usage),
        }),
        writable: false,
        enumerable: false,
      },
      textTranslator: {
        value: createTextTranslator({
          apiKey,
          model: this.textModel,
          onUsage: (usage) => this.onUsage?.(usage),
        }),
        writable: false,
        enumerable: false,
      },
      currentJob: { value: null, writable: true, enumerable: false },
      pendingPartial: { value: null, writable: true, enumerable: false },
      deferredPartial: { value: null, writable: true, enumerable: false },
    });

    this.state = "idle";
    this.paused = false;
    this.sequence = 0;
    this.generation = 0;
    this.partialTimer = null;
    this.lastPartialStartedAt = Number.NEGATIVE_INFINITY;
    this.lastPartialCandidate = "";
    this.detectedLanguage = null;
    this.languageDetectionLatencyMs = null;
    this.terminalSignaled = false;
    this.startPromise = null;
    this.stopPromise = null;
  }

  start() {
    if (this.state === "running") return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.state !== "idle") {
      return Promise.reject(new Error(`Gemini contextual provider cannot start from state ${this.state}`));
    }
    this.state = "starting";
    this.startPromise = Promise.resolve(this.transcriber.start()).then(() => {
      if (this.state !== "starting") throw new Error("Gemini contextual provider stopped during startup");
      this.state = "running";
      this.onStatus?.({
        level: "ok",
        message: this.mode === "accurate"
          ? "Gemini dịch ngữ cảnh ở chế độ chính xác"
          : "Gemini dịch ngữ cảnh ở chế độ cân bằng",
      });
    }).catch((error) => {
      if (this.state === "starting") this.state = "failed";
      throw error;
    });
    return this.startPromise;
  }

  write(pcm, timing) {
    if (this.state !== "running" || this.paused || this.terminalSignaled) return false;
    return this.transcriber.write(pcm, timing) !== false;
  }

  setAudioActivity(value) {
    if (this.state !== "running" || this.paused || this.terminalSignaled) return false;
    return this.transcriber.setAudioActivity?.(value) === true;
  }

  handleLanguageDetected(detection) {
    const language = String(detection?.language || "").trim();
    if (language) this.detectedLanguage = language;
    this.languageDetectionLatencyMs = Number.isFinite(detection?.detectionLatencyMs)
      ? detection.detectionLatencyMs
      : null;
    this.onLanguageDetected?.(detection);
  }

  handleTranscript(transcript = {}) {
    if (this.state !== "running" || this.paused || this.terminalSignaled) return;
    const text = normalizeTranscript(transcript.text);
    if (!text) return;
    const sourceLanguage = String(transcript.sourceLanguage || "").trim() ||
      this.detectedLanguage || this.sourceLanguage;
    const capturedAt = Number.isFinite(Number(transcript.capturedAt))
      ? Number(transcript.capturedAt)
      : null;

    if (transcript.isFinal === true) {
      this.enqueueFinal({ text, sourceLanguage, capturedAt });
      return;
    }
    if (this.mode !== "balanced") return;
    this.considerPartial({ text, sourceLanguage, capturedAt });
  }

  considerPartial(candidate) {
    if (readableLength(candidate.text) < MIN_FIRST_PARTIAL_CHARS) return;
    if (candidate.text === this.lastPartialCandidate) return;
    if (
      this.lastPartialCandidate &&
      candidate.text.startsWith(this.lastPartialCandidate) &&
      readableLength(candidate.text.slice(this.lastPartialCandidate.length)) < MIN_PARTIAL_GROWTH_CHARS
    ) {
      return;
    }

    this.lastPartialCandidate = candidate.text;
    const job = this.createJob("partial", candidate);
    if (this.currentJob?.kind === "partial") this.currentJob.controller.abort();

    const elapsed = this.now() - this.lastPartialStartedAt;
    if (elapsed >= this.partialThrottleMs) {
      this.clearPartialTimer();
      this.deferredPartial = null;
      this.queuePartial(job);
      return;
    }

    this.deferredPartial = job;
    if (this.partialTimer !== null) return;
    const delay = Math.max(0, this.partialThrottleMs - elapsed);
    this.partialTimer = this.setTimer(() => {
      this.partialTimer = null;
      const deferredJob = this.deferredPartial;
      this.deferredPartial = null;
      if (deferredJob && this.state === "running" && !this.paused) {
        this.queuePartial(deferredJob);
      }
    }, delay);
    this.partialTimer?.unref?.();
  }

  createJob(kind, candidate) {
    return {
      generation: ++this.generation,
      kind,
      text: candidate.text,
      sourceLanguage: candidate.sourceLanguage,
      capturedAt: candidate.capturedAt,
      controller: new AbortController(),
      streamedTranslation: "",
      lastEmittedTranslation: "",
      firstPartialEmittedAt: null,
    };
  }

  queuePartial(job) {
    if (this.pendingPartial) this.pendingPartial.controller.abort();
    this.pendingPartial = job;
    this.drainJobs();
  }

  enqueueFinal(candidate) {
    this.clearPartialTimer();
    this.deferredPartial?.controller.abort();
    this.deferredPartial = null;
    this.pendingPartial?.controller.abort();
    this.pendingPartial = null;
    if (this.currentJob?.kind === "partial") this.currentJob.controller.abort();
    this.lastPartialCandidate = "";

    const job = this.createJob("final", candidate);
    const queuedChars = this.pendingFinals.reduce((sum, item) => sum + item.text.length, 0);
    if (
      this.pendingFinals.length >= MAX_PENDING_FINALS ||
      queuedChars + job.text.length > MAX_PENDING_FINAL_CHARS
    ) {
      const error = new Error("Gemini contextual final-translation queue limit exceeded");
      error.code = "TRANSLATION_QUEUE_LIMIT";
      this.signalTerminal(error);
      return;
    }
    this.pendingFinals.push(job);
    this.drainJobs();
  }

  drainJobs() {
    if (this.currentJob || this.state !== "running" || this.paused || this.terminalSignaled) return;
    const job = this.pendingFinals.shift() || this.pendingPartial;
    if (!job) return;
    if (job === this.pendingPartial) this.pendingPartial = null;
    this.currentJob = job;
    if (job.kind === "partial") this.lastPartialStartedAt = this.now();
    void this.processJob(job).catch((error) => {
      if (!isAbortError(error, job) && !this.terminalSignaled) this.signalTerminal(error);
    }).finally(() => {
      if (this.currentJob === job) this.currentJob = null;
      this.drainJobs();
    });
  }

  isCurrentPartial(job) {
    return (
      job.kind === "partial" &&
      !job.controller.signal.aborted &&
      job.generation === this.generation &&
      this.state === "running" &&
      !this.paused &&
      !this.terminalSignaled
    );
  }

  async processJob(job) {
    if (job.controller.signal.aborted) throw abortError();
    const previousTurns = boundedHistory(this.history, this.contextTurns).map((turn) => ({ ...turn }));
    const translation = await this.textTranslator.translate({
      text: job.text,
      sourceLanguage: job.sourceLanguage,
      targetLanguage: this.targetLanguage,
      previousTurns,
      glossary: this.glossary,
      characterContext: this.characterContext,
      isFinal: job.kind === "final",
      signal: job.controller.signal,
      ...(job.kind === "partial"
        ? { onDelta: (delta) => this.handlePartialDelta(job, delta) }
        : {}),
    });

    if (job.controller.signal.aborted) throw abortError();
    if (job.kind === "partial") {
      if (!this.isCurrentPartial(job)) return;
      const normalized = String(translation || "").trim();
      if (normalized && normalized !== job.lastEmittedTranslation) {
        job.streamedTranslation = normalized;
        this.emitCaption(job, normalized, false);
        job.lastEmittedTranslation = normalized;
      }
      return;
    }

    if (this.state !== "running" || this.paused || this.terminalSignaled) return;
    const normalized = String(translation || "").trim();
    if (!normalized) throw new Error("Gemini returned an empty final translation");
    this.emitCaption(job, normalized, true);
    if (this.contextTurns > 0) {
      this.history.push({ source: job.text, target: normalized });
      const bounded = boundedHistory(this.history, this.contextTurns);
      this.history.splice(0, this.history.length, ...bounded);
    }
  }

  handlePartialDelta(job, delta) {
    if (!this.isCurrentPartial(job)) return;
    if (typeof delta !== "string") throw new Error("Gemini returned a non-text translation delta");
    job.streamedTranslation += delta;
    const normalized = job.streamedTranslation.trim();
    if (!normalized || normalized === job.lastEmittedTranslation) return;
    const growth = normalized.length - job.lastEmittedTranslation.length;
    if (growth < MIN_OUTPUT_PHRASE_CHARS && !hasPhraseBoundary(normalized)) return;
    this.emitCaption(job, normalized, false);
    job.lastEmittedTranslation = normalized;
  }

  emitCaption(job, translation, isFinal) {
    const emittedAt = Number(this.now());
    const latencyMs = Number.isFinite(job.capturedAt) && Number.isFinite(emittedAt)
      ? Math.max(0, Math.round(emittedAt - job.capturedAt))
      : null;
    if (!isFinal && job.firstPartialEmittedAt === null) job.firstPartialEmittedAt = emittedAt;
    const autoDetected = this.sourceLanguage === "auto";
    this.onCaption?.({
      type: "caption",
      sequence: this.sequence++,
      transcript: job.text,
      translation,
      sourceLanguage: autoDetected ? job.sourceLanguage || this.detectedLanguage || "auto" : this.sourceLanguage,
      sourceLanguageMode: autoDetected ? "auto" : "fixed",
      languageDetectionConfidence: null,
      languageDetectionLatencyMs: autoDetected ? this.languageDetectionLatencyMs : null,
      targetLanguage: this.targetLanguage,
      isFinal,
      emittedAt,
      latencyMs,
      ...(!isFinal
        ? { liveEdgeToPartialMs: latencyMs }
        : { partialToFinalMs: job.firstPartialEmittedAt === null ? null : Math.max(0, emittedAt - job.firstPartialEmittedAt) }),
      provider: "gemini-contextual",
    });
  }

  clearPartialTimer() {
    if (this.partialTimer === null) return;
    this.clearTimer(this.partialTimer);
    this.partialTimer = null;
  }

  clearMutableJobs() {
    this.clearPartialTimer();
    this.currentJob?.controller.abort();
    this.pendingPartial?.controller.abort();
    this.deferredPartial?.controller.abort();
    for (const job of this.pendingFinals) job.controller.abort();
    this.pendingFinals.splice(0);
    this.pendingPartial = null;
    this.deferredPartial = null;
    this.generation += 1;
    this.lastPartialCandidate = "";
  }

  setPaused(paused) {
    const next = paused === true;
    if (next === this.paused) return false;
    this.paused = next;
    if (next) this.clearMutableJobs();
    this.transcriber.setPaused?.(next);
    if (!next) this.drainJobs();
    return true;
  }

  signalTerminal(error) {
    if (this.terminalSignaled || this.state === "stopping" || this.state === "stopped") return;
    this.terminalSignaled = true;
    this.state = "failed";
    this.clearMutableJobs();
    this.onTerminal?.(error instanceof Error ? error : new Error(String(error || "Gemini error")));
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  async stopInternal() {
    if (this.state === "stopped") return;
    this.state = "stopping";
    this.clearMutableJobs();
    this.history.splice(0);
    this.glossary = "";
    this.characterContext = "";
    const secret = secrets.get(this);
    if (secret) secret.apiKey = "";
    await Promise.allSettled([
      Promise.resolve(this.transcriber.stop?.()),
      Promise.resolve(this.textTranslator.stop?.()),
    ]);
    this.paused = false;
    this.state = "stopped";
    this.onStatus?.({ level: "idle", message: "Gemini dịch ngữ cảnh đã dừng" });
  }
}

module.exports = {
  GeminiContextualTranslator,
};
