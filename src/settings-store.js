const fs = require("node:fs");
const path = require("node:path");

const SETTINGS_VERSION = 4;

const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  provider: "demo",
  source: Object.freeze({
    kind: "tab",
    language: "auto",
    languageHints: Object.freeze([]),
    targetLanguage: "vi",
  }),
  cloud: Object.freeze({
    consent: "",
    maxMinutes: 30,
  }),
  captions: Object.freeze({
    mode: "fastest",
    echoTargetLanguage: false,
    resetGapMs: 1100,
    finalDebounceMs: 120,
  }),
  overlay: Object.freeze({
    preset: "bottom",
    locked: true,
    showSource: false,
    highContrast: true,
    translationFontSize: 36,
    sourceFontSize: 17,
    fontWeight: 700,
    lineHeight: 1.24,
    backgroundOpacity: 0.92,
    maxWidth: 90,
    maxTranslationLines: 2,
    hideAfterMs: 8000,
    normalizedBounds: null,
    displayId: null,
  }),
});

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeNormalizedBounds(value) {
  if (!value || typeof value !== "object") return null;
  const x = clampNumber(value.x, 0.1, 0, 1);
  const y = clampNumber(value.y, 0.7, 0, 1);
  const width = clampNumber(value.width, 0.8, 0.2, 1);
  const height = clampNumber(value.height, 0.2, 0.08, 0.6);
  return {
    x: Math.min(x, 1 - width),
    y: Math.min(y, 1 - height),
    width,
    height,
  };
}

function sanitizeSettings(value = {}) {
  if (!isPlainObject(value)) value = {};
  const defaults = cloneDefaults();
  const source = isPlainObject(value.source) ? value.source : {};
  const cloud = isPlainObject(value.cloud) ? value.cloud : {};
  const captions = isPlainObject(value.captions) ? value.captions : {};
  const overlay = isPlainObject(value.overlay) ? value.overlay : {};
  const provider = ["demo", "azure", "gemini"].includes(value.provider)
    ? value.provider
    : defaults.provider;
  const sourceKind = ["tab", "file"].includes(source.kind) ? source.kind : defaults.source.kind;
  const language = String(source.language || defaults.source.language).slice(0, 35);
  const targetLanguage = String(source.targetLanguage || defaults.source.targetLanguage).slice(0, 35);
  const languageHints = Array.isArray(source.languageHints)
    ? [...new Set(source.languageHints.map((item) => String(item).slice(0, 35)).filter(Boolean))].slice(0, 8)
    : [];
  const consent = ["", "azure:tab-audio:v1", "gemini:audio:v1"].includes(cloud.consent)
    ? cloud.consent
    : "";
  const preset = ["bottom", "top", "floating"].includes(overlay.preset)
    ? overlay.preset
    : defaults.overlay.preset;
  const explicitCaptionMode = ["fastest", "bilingual"].includes(captions.mode)
    ? captions.mode
    : null;
  const legacySourcePreference = Object.hasOwn(overlay, "showSource")
    ? overlay.showSource !== false
    : null;
  const captionMode = explicitCaptionMode ||
    (legacySourcePreference === true ? "bilingual" : defaults.captions.mode);
  return {
    version: SETTINGS_VERSION,
    provider,
    source: { kind: sourceKind, language, languageHints, targetLanguage },
    cloud: {
      consent,
      maxMinutes: Math.round(clampNumber(cloud.maxMinutes, defaults.cloud.maxMinutes, 1, 1440)),
    },
    captions: {
      mode: captionMode,
      echoTargetLanguage: captions.echoTargetLanguage === true,
      resetGapMs: Math.round(
        clampNumber(captions.resetGapMs, defaults.captions.resetGapMs, 250, 5000),
      ),
      finalDebounceMs: Math.round(
        clampNumber(captions.finalDebounceMs, defaults.captions.finalDebounceMs, 0, 1000),
      ),
    },
    overlay: {
      preset,
      locked: overlay.locked !== false,
      showSource: captionMode === "bilingual",
      highContrast: overlay.highContrast !== false,
      translationFontSize: Math.round(
        clampNumber(overlay.translationFontSize, defaults.overlay.translationFontSize, 18, 64),
      ),
      sourceFontSize: Math.round(
        clampNumber(overlay.sourceFontSize, defaults.overlay.sourceFontSize, 11, 32),
      ),
      fontWeight: Math.round(clampNumber(overlay.fontWeight, defaults.overlay.fontWeight, 400, 800)),
      lineHeight: clampNumber(overlay.lineHeight, defaults.overlay.lineHeight, 1, 1.8),
      backgroundOpacity: clampNumber(
        overlay.backgroundOpacity,
        defaults.overlay.backgroundOpacity,
        0.3,
        1,
      ),
      maxWidth: Math.round(clampNumber(overlay.maxWidth, defaults.overlay.maxWidth, 45, 96)),
      maxTranslationLines: Math.round(
        clampNumber(overlay.maxTranslationLines, defaults.overlay.maxTranslationLines, 1, 2),
      ),
      hideAfterMs: Math.round(clampNumber(overlay.hideAfterMs, defaults.overlay.hideAfterMs, 0, 60_000)),
      normalizedBounds: sanitizeNormalizedBounds(overlay.normalizedBounds),
      displayId:
        overlay.displayId === null || overlay.displayId === undefined
          ? null
          : String(overlay.displayId).slice(0, 80),
    },
  };
}

function mergeSettings(current, patch) {
  const safeCurrent = isPlainObject(current) ? current : cloneDefaults();
  const safePatch = isPlainObject(patch) ? patch : {};
  const candidate = {
    ...safeCurrent,
    ...safePatch,
    source: {
      ...(isPlainObject(safeCurrent.source) ? safeCurrent.source : {}),
      ...(isPlainObject(safePatch.source) ? safePatch.source : {}),
    },
    cloud: {
      ...(isPlainObject(safeCurrent.cloud) ? safeCurrent.cloud : {}),
      ...(isPlainObject(safePatch.cloud) ? safePatch.cloud : {}),
    },
    captions: {
      ...(isPlainObject(safeCurrent.captions) ? safeCurrent.captions : {}),
      ...(isPlainObject(safePatch.captions) ? safePatch.captions : {}),
    },
    overlay: {
      ...(isPlainObject(safeCurrent.overlay) ? safeCurrent.overlay : {}),
      ...(isPlainObject(safePatch.overlay) ? safePatch.overlay : {}),
    },
  };
  return sanitizeSettings(candidate);
}

class SettingsStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.fs = options.fs || fs;
    this.state = cloneDefaults();
  }

  load() {
    try {
      const value = JSON.parse(this.fs.readFileSync(this.filePath, "utf8"));
      this.state = sanitizeSettings(value);
    } catch (error) {
      if (error.code !== "ENOENT" && error.name !== "SyntaxError") throw error;
      this.state = cloneDefaults();
    }
    return this.snapshot();
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  update(patch) {
    const next = mergeSettings(this.state, patch);
    const directory = path.dirname(this.filePath);
    this.fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const contents = `${JSON.stringify(next, null, 2)}\n`;
    try {
      this.fs.writeFileSync(tempPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      this.fs.renameSync(tempPath, this.filePath);
      try {
        this.fs.chmodSync(this.filePath, 0o600);
      } catch {
        // Windows and some network filesystems do not expose POSIX modes.
      }
    } catch (error) {
      try {
        this.fs.unlinkSync(tempPath);
      } catch {
        // Nothing to clean up.
      }
      throw error;
    }
    this.state = next;
    return this.snapshot();
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  SettingsStore,
  mergeSettings,
  sanitizeSettings,
};
