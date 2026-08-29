const { createHash, timingSafeEqual } = require("node:crypto");

const DEFAULT_CLIPBOARD_TTL_MS = 60_000;
const DEFAULT_CLEAR_RETRY_MS = 1_000;
const DEFAULT_MAX_CLEAR_ATTEMPTS = 3;
const MAX_CLIPBOARD_TTL_MS = 10 * 60_000;
const MAX_SENSITIVE_TEXT_LENGTH = 64 * 1024;
const states = new WeakMap();

function fingerprint(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function sameFingerprint(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && timingSafeEqual(left, right);
}

function normalizeTtl(value) {
  const ttlMs = value === undefined ? DEFAULT_CLIPBOARD_TTL_MS : Number(value);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_CLIPBOARD_TTL_MS) {
    throw new Error(`Sensitive clipboard TTL must be between 1 and ${MAX_CLIPBOARD_TTL_MS} ms`);
  }
  return ttlMs;
}

function positiveInteger(value, fallback, label, maximum) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return number;
}

class SensitiveClipboardManager {
  constructor(options = {}) {
    const clipboard = options.clipboard;
    if (
      !clipboard ||
      typeof clipboard.writeText !== "function" ||
      typeof clipboard.readText !== "function"
    ) {
      throw new Error("Sensitive clipboard requires readText and writeText support");
    }
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
      throw new Error("Sensitive clipboard requires timer functions");
    }
    states.set(this, {
      clipboard,
      setTimer,
      clearTimer,
      ttlMs: normalizeTtl(options.ttlMs),
      retryDelayMs: positiveInteger(
        options.retryDelayMs,
        DEFAULT_CLEAR_RETRY_MS,
        "Sensitive clipboard retry delay",
        60_000,
      ),
      maxClearAttempts: positiveInteger(
        options.maxClearAttempts,
        DEFAULT_MAX_CLEAR_ATTEMPTS,
        "Sensitive clipboard clear attempts",
        10,
      ),
      timer: null,
      generation: 0,
      fingerprint: null,
      clearAttempts: 0,
    });
  }

  copy(value) {
    const text = String(value || "");
    if (!text || text.length > MAX_SENSITIVE_TEXT_LENGTH || /[\u0000\r\n]/.test(text)) {
      throw new Error("Sensitive clipboard text is invalid");
    }

    const state = states.get(this);
    const nextFingerprint = fingerprint(text);
    state.clipboard.writeText(text);
    if (state.timer !== null) state.clearTimer(state.timer);
    state.generation += 1;
    const generation = state.generation;
    state.fingerprint = nextFingerprint;
    state.clearAttempts = 0;
    try {
      this.scheduleCleanup(generation, state.ttlMs);
    } catch (error) {
      state.timer = null;
      this.attemptClear(generation, false);
      throw error;
    }
    return true;
  }

  clearIfOwned() {
    const state = states.get(this);
    return this.attemptClear(state.generation, false);
  }

  scheduleCleanup(generation, delay) {
    const state = states.get(this);
    state.timer = state.setTimer(() => {
      if (state.generation !== generation) return;
      state.timer = null;
      this.attemptClear(generation, true);
    }, delay);
    state.timer?.unref?.();
  }

  attemptClear(generation, retryOnError) {
    const state = states.get(this);
    if (state.generation !== generation) return false;
    const expected = state.fingerprint;
    if (!expected) return false;

    try {
      const current = state.clipboard.readText();
      if (!sameFingerprint(fingerprint(String(current || "")), expected)) {
        state.fingerprint = null;
        state.clearAttempts = 0;
        return false;
      }
      if (typeof state.clipboard.clear === "function") state.clipboard.clear();
      else state.clipboard.writeText("");
      state.fingerprint = null;
      state.clearAttempts = 0;
      return true;
    } catch {
      state.clearAttempts += 1;
      if (retryOnError && state.clearAttempts < state.maxClearAttempts) {
        try {
          this.scheduleCleanup(generation, state.retryDelayMs);
        } catch {
          state.timer = null;
        }
      }
      return false;
    }
  }

  dispose() {
    const state = states.get(this);
    if (state.timer !== null) state.clearTimer(state.timer);
    state.timer = null;
    const generation = state.generation;
    state.clearAttempts = 0;
    let cleared = false;
    for (
      let attempt = 0;
      attempt < state.maxClearAttempts && state.fingerprint;
      attempt += 1
    ) {
      cleared = this.attemptClear(generation, false);
      if (cleared) break;
    }
    state.generation += 1;
    state.fingerprint = null;
    state.clearAttempts = 0;
    return cleared;
  }
}

module.exports = {
  DEFAULT_CLIPBOARD_TTL_MS,
  DEFAULT_CLEAR_RETRY_MS,
  DEFAULT_MAX_CLEAR_ATTEMPTS,
  SensitiveClipboardManager,
};
