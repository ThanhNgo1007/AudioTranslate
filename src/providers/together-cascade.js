const DEFAULT_PARTIAL_THROTTLE_MS = 180;
const DEFAULT_MAX_CONSECUTIVE_MT_FAILURES = 3;
const DEFAULT_MAX_PENDING_FINALS = 8;
const DEFAULT_MAX_PENDING_FINAL_CHARS = 32_000;
const DEFAULT_MT_STOP_TIMEOUT_MS = 1000;
const cascadeSecrets = new WeakMap();

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function isTranslationAbort(error, signal) {
  return Boolean(
    signal?.aborted ||
      error?.name === "AbortError" ||
      error?.code === "ABORT_ERR" ||
      error?.code === "TRANSLATION_ABORTED",
  );
}

function toFiniteInteger(value, fallback, { min, max, label }) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function createDefaultAsr(options) {
  // Lazy loading keeps the cascade independently testable and avoids loading
  // the WebSocket transport until a real Together session starts.
  const { TogetherRealtimeAsr } = require("./together-realtime-asr");
  return new TogetherRealtimeAsr(options);
}

function waitForSettlement(promise, timeoutMs, setTimer, clearTimer) {
  if (!promise) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimer(timer);
      resolve(completed);
    };
    timer = setTimer(() => finish(false), timeoutMs);
    Promise.resolve(promise).then(
      () => finish(true),
      () => finish(true),
    );
  });
}

class TogetherCascadeTranslator {
  constructor(options = {}) {
    this.sourceLanguage = String(options.sourceLanguage || "").trim();
    this.targetLanguage = String(options.targetLanguage || "").trim();
    const asrOptions = Object.freeze({ ...(options.asrOptions || {}) });
    cascadeSecrets.set(this, { asrOptions });
    this.createAsr = options.createAsr || createDefaultAsr;
    this.mt = options.mt;

    this.onCaption = options.onCaption;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
    this.onTerminal = options.onTerminal;

    this.partialThrottleMs = toFiniteInteger(
      options.partialThrottleMs,
      DEFAULT_PARTIAL_THROTTLE_MS,
      { min: 0, max: 5000, label: "partialThrottleMs" },
    );
    this.maxConsecutiveMtFailures = toFiniteInteger(
      options.maxConsecutiveMtFailures,
      DEFAULT_MAX_CONSECUTIVE_MT_FAILURES,
      { min: 1, max: 100, label: "maxConsecutiveMtFailures" },
    );
    this.maxPendingFinals = toFiniteInteger(options.maxPendingFinals, DEFAULT_MAX_PENDING_FINALS, {
      min: 1,
      max: 100,
      label: "maxPendingFinals",
    });
    this.maxPendingFinalChars = toFiniteInteger(
      options.maxPendingFinalChars,
      DEFAULT_MAX_PENDING_FINAL_CHARS,
      { min: 1, max: 1_000_000, label: "maxPendingFinalChars" },
    );
    this.mtStopTimeoutMs = toFiniteInteger(
      options.mtStopTimeoutMs,
      DEFAULT_MT_STOP_TIMEOUT_MS,
      { min: 1, max: 30_000, label: "mtStopTimeoutMs" },
    );
    this.now = options.now || Date.now;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;

    this.state = "idle";
    this.asr = null;
    this.asrStopPromise = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.partialTimer = null;
    this.pendingPartial = null;
    this.pendingFinals = [];
    this.activeJob = null;
    this.lastAcceptedPartialText = "";
    this.nextGeneration = 1;
    this.sequence = 0;
    this.lastPartialStartedAt = Number.NEGATIVE_INFINITY;
    this.consecutiveMtFailures = 0;
    this.terminalSignaled = false;
    this.terminalError = null;
  }

  async start() {
    if (this.state === "running") return;
    if (this.startPromise) return this.startPromise;
    if (this.state !== "idle") {
      throw new Error(`Together cascade cannot start from state ${this.state}`);
    }

    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  async startInternal() {
    if (!this.sourceLanguage || this.sourceLanguage.toLowerCase() === "auto") {
      throw new Error("Together cascade requires a fixed source language");
    }
    if (!this.targetLanguage) throw new Error("Together cascade requires a target language");
    if (!this.mt || typeof this.mt.translate !== "function") {
      throw new Error("Together cascade requires a text translation adapter");
    }
    if (typeof this.createAsr !== "function") {
      throw new Error("Together cascade requires an ASR factory");
    }

    this.state = "starting";
    try {
      this.asr = this.createAsr({
        ...cascadeSecrets.get(this).asrOptions,
        sourceLanguage: this.sourceLanguage,
        onTranscript: (result) => this.handleTranscript(result),
        onStatus: (status) => {
          if (this.state !== "stopping" && this.state !== "stopped") this.onStatus?.(status);
        },
        onError: (error) => {
          if (this.state !== "stopping" && this.state !== "stopped") {
            this.onError?.(normalizeError(error));
          }
        },
        onTerminal: (error) => {
          if (this.state !== "stopping" && this.state !== "stopped") {
            this.signalTerminal(normalizeError(error));
          }
        },
      });
    } catch (error) {
      this.state = "stopped";
      throw normalizeError(error);
    }
    if (
      !this.asr ||
      typeof this.asr.start !== "function" ||
      typeof this.asr.write !== "function" ||
      typeof this.asr.stop !== "function"
    ) {
      this.state = "stopped";
      throw new Error("Together ASR factory returned an invalid adapter");
    }

    try {
      await this.asr.start();
      if (this.terminalError) throw this.terminalError;
      if (this.state !== "starting") {
        throw new Error("Together cascade was stopped during startup");
      }
      this.state = "running";
      this.onStatus?.({
        level: "ok",
        message: "Together ASR and text translation cascade is ready",
      });
    } catch (error) {
      const externallyStopping = this.state === "stopping" || this.state === "stopped";
      if (!externallyStopping) this.state = "failing";
      await this.stopAsrOnce().catch(() => {});
      if (!externallyStopping) {
        this.state = "stopped";
        this.asr = null;
      }
      throw normalizeError(error);
    }
  }

  write(pcm, timing = {}) {
    if (
      this.state !== "running" ||
      this.terminalSignaled ||
      !this.asr ||
      typeof this.asr.write !== "function"
    ) {
      return false;
    }
    return this.asr.write(pcm, timing);
  }

  handleTranscript(rawResult) {
    if (this.state !== "running" || this.terminalSignaled) return;
    const text = String(rawResult?.text || "").trim();
    if (!text) return;
    const isFinal = rawResult?.isFinal === true;

    if (!isFinal) {
      if (
        this.lastAcceptedPartialText === text ||
        (this.pendingPartial && this.pendingPartial.text === text) ||
        (this.activeJob?.kind === "partial" &&
          this.activeJob.valid &&
          this.activeJob.text === text)
      ) {
        return;
      }

      if (this.activeJob?.kind === "partial") this.activeJob.valid = false;
      this.lastAcceptedPartialText = text;
      this.pendingPartial = this.createJob("partial", text);
      this.pump();
      return;
    }

    this.clearPartialTimer();
    this.lastAcceptedPartialText = "";
    this.pendingPartial = null;
    if (this.activeJob?.kind === "partial") {
      this.activeJob.valid = false;
      this.activeJob.controller?.abort();
    }
    const pendingFinalChars = this.pendingFinals.reduce(
      (total, pending) => total + pending.text.length,
      0,
    );
    if (
      this.pendingFinals.length >= this.maxPendingFinals ||
      pendingFinalChars + text.length > this.maxPendingFinalChars
    ) {
      const error = new Error(
        "Together translation backlog exceeded its bounded final-caption queue",
      );
      error.code = "TRANSLATION_BACKLOG_LIMIT";
      this.signalTerminal(error);
      return;
    }
    this.pendingFinals.push(this.createJob("final", text));
    this.pump();
  }

  createJob(kind, text) {
    return {
      kind,
      text,
      generation: this.nextGeneration++,
      valid: true,
      controller: null,
      streamedTranslation: "",
      lastEmittedTranslation: "",
    };
  }

  pump() {
    if (this.state !== "running" || this.terminalSignaled || this.activeJob) return;

    let job = this.pendingFinals.shift();
    if (!job && this.pendingPartial) {
      const waitMs = Math.max(
        0,
        this.lastPartialStartedAt + this.partialThrottleMs - this.now(),
      );
      if (waitMs > 0) {
        if (!this.partialTimer) {
          this.partialTimer = this.setTimer(() => {
            this.partialTimer = null;
            this.pump();
          }, waitMs);
          this.partialTimer.unref?.();
        }
        return;
      }
      job = this.pendingPartial;
      this.pendingPartial = null;
    }
    if (!job) return;

    if (job.kind === "partial") this.lastPartialStartedAt = this.now();
    this.runTranslation(job);
  }

  runTranslation(job) {
    const controller = new AbortController();
    job.controller = controller;
    this.activeJob = job;

    const request = {
      text: job.text,
      sourceLanguage: this.sourceLanguage,
      targetLanguage: this.targetLanguage,
      signal: controller.signal,
      onDelta: (delta) => this.handleTranslationDelta(job, delta),
    };

    job.promise = Promise.resolve()
      .then(() => {
        if (!this.isJobLive(job)) {
          job.valid = false;
          controller.abort();
          const error = new Error("Translation generation was superseded before it started");
          error.code = "TRANSLATION_ABORTED";
          throw error;
        }
        return this.mt.translate(request);
      })
      .then(
        (translation) => this.handleTranslationSuccess(job, translation),
        (error) => this.handleTranslationFailure(job, normalizeError(error)),
      )
      .finally(() => {
        if (this.activeJob === job) this.activeJob = null;
        this.pump();
      });
  }

  handleTranslationDelta(job, rawDelta) {
    if (!this.isJobLive(job)) return;
    const delta = typeof rawDelta === "string" ? rawDelta : "";
    if (!delta) return;
    job.streamedTranslation += delta;
    const visible = job.streamedTranslation.trim();
    if (!visible || visible === job.lastEmittedTranslation) return;
    job.lastEmittedTranslation = visible;
    this.emitCaption(job, visible, false);
  }

  handleTranslationSuccess(job, rawTranslation) {
    if (job.controller?.signal.aborted) return;
    if (typeof rawTranslation !== "string") {
      const error = new Error("Text translation adapter returned a non-string result");
      error.code = "TRANSLATION_PROTOCOL_ERROR";
      this.handleTranslationFailure(job, error);
      return;
    }

    const translation = rawTranslation.trim() || job.streamedTranslation.trim();
    if (!translation) {
      const error = new Error("Text translation adapter returned an empty result");
      error.code = "TRANSLATION_PROTOCOL_ERROR";
      this.handleTranslationFailure(job, error);
      return;
    }

    this.consecutiveMtFailures = 0;
    if (!this.isJobLive(job)) return;

    if (job.kind === "final") {
      job.lastEmittedTranslation = translation;
      this.emitCaption(job, translation, true);
    } else if (translation !== job.lastEmittedTranslation) {
      job.lastEmittedTranslation = translation;
      this.emitCaption(job, translation, false);
    }
  }

  handleTranslationFailure(job, error) {
    if (isTranslationAbort(error, job.controller?.signal)) return;
    if (job.kind === "partial" && this.lastAcceptedPartialText === job.text) {
      this.lastAcceptedPartialText = "";
    }
    this.consecutiveMtFailures += 1;
    this.onError?.(error);
    if (this.consecutiveMtFailures < this.maxConsecutiveMtFailures) return;

    const terminal = new Error(
      `Together text translation failed ${this.consecutiveMtFailures} consecutive times: ${error.message}`,
    );
    terminal.code = "TRANSLATION_FAILURE_LIMIT";
    terminal.cause = error;
    this.signalTerminal(terminal);
  }

  isJobLive(job) {
    return Boolean(
      this.state === "running" &&
        !this.terminalSignaled &&
        job.valid &&
        this.activeJob === job &&
        !job.controller?.signal.aborted,
    );
  }

  emitCaption(job, translation, isFinal) {
    if (!this.isJobLive(job)) return;
    this.onCaption?.({
      type: "caption",
      sequence: this.sequence++,
      transcript: job.text,
      translation,
      sourceLanguage: this.sourceLanguage,
      sourceLanguageMode: "fixed",
      targetLanguage: this.targetLanguage,
      isFinal,
      emittedAt: this.now(),
      latencyMs: null,
      provider: "together-cascade",
    });
  }

  signalTerminal(rawError) {
    if (this.terminalSignaled) return;
    const error = normalizeError(rawError);
    this.terminalSignaled = true;
    this.terminalError = error;
    if (this.state !== "stopping" && this.state !== "stopped") this.state = "failed";
    this.clearPartialTimer();
    this.pendingPartial = null;
    this.pendingFinals = [];
    this.lastAcceptedPartialText = "";
    if (this.activeJob) {
      this.activeJob.valid = false;
      this.activeJob.controller?.abort();
    }
    this.onTerminal?.(error);
  }

  clearPartialTimer() {
    if (!this.partialTimer) return;
    this.clearTimer(this.partialTimer);
    this.partialTimer = null;
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  stopAsrOnce() {
    if (this.asrStopPromise) return this.asrStopPromise;
    const asr = this.asr;
    if (!asr || typeof asr.stop !== "function") return Promise.resolve();
    this.asrStopPromise = Promise.resolve().then(() => asr.stop());
    return this.asrStopPromise;
  }

  async stopInternal() {
    if (this.state === "stopped") return;
    const startup = this.startPromise;
    this.state = "stopping";
    this.clearPartialTimer();
    this.pendingPartial = null;
    this.pendingFinals = [];
    this.lastAcceptedPartialText = "";
    const activeTranslation = this.activeJob?.promise;
    if (this.activeJob) {
      this.activeJob.valid = false;
      this.activeJob.controller?.abort();
    }

    const translationDrain = waitForSettlement(
      activeTranslation,
      this.mtStopTimeoutMs,
      this.setTimer,
      this.clearTimer,
    );
    let stopError = null;
    try {
      await this.stopAsrOnce();
    } catch (error) {
      stopError = normalizeError(error);
    }
    if (startup) await startup.catch(() => {});
    await translationDrain;
    try {
      if (stopError) throw stopError;
    } finally {
      this.state = "stopped";
      this.asr = null;
    }
  }
}

module.exports = {
  DEFAULT_MAX_CONSECUTIVE_MT_FAILURES,
  DEFAULT_MAX_PENDING_FINALS,
  DEFAULT_MAX_PENDING_FINAL_CHARS,
  DEFAULT_MT_STOP_TIMEOUT_MS,
  DEFAULT_PARTIAL_THROTTLE_MS,
  TogetherCascadeTranslator,
};
