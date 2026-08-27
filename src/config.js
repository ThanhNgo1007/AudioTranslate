const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const AZURE_CLOUD_CONSENT = "azure:tab-audio:v1";
const GEMINI_CLOUD_CONSENT = "gemini:audio:v1";

function loadEnvFile(envPath = path.join(PROJECT_ROOT, ".env")) {
  if (!fs.existsSync(envPath)) return;

  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
    return;
  }

  // Fallback for older Electron Node runtimes. Existing environment wins.
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function parseArgs(argv = []) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 2) {
      result[token.slice(2, equalsIndex)] = token.slice(equalsIndex + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(String(value).toLowerCase())) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function toPort(value, fallback = 43765) {
  const parsed = Number(String(value ?? fallback));
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid WebSocket port: ${value}`);
  }
  return parsed;
}

function toLanguageList(value, fallback = []) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const languages = raw.map((item) => String(item).trim()).filter(Boolean);
  return languages.length > 0 ? languages : [...fallback];
}

function toMaxCloudMinutes(value, fallback = 0) {
  const parsed = Number(String(value ?? fallback));
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1440) {
    throw new Error(`Invalid maximum cloud minutes: ${value}`);
  }
  return parsed;
}

function toTranslationMode(value, fallback = "fastest") {
  const mode = String(value ?? fallback).trim().toLowerCase();
  if (!new Set(["fastest", "balanced", "accurate"]).has(mode)) {
    throw new Error(`Invalid Gemini translation mode: ${value}`);
  }
  return mode;
}

function getConfig(argv = process.argv.slice(2), env = process.env, parsedArgs) {
  const args = parsedArgs || parseArgs(argv);
  const provider = String(args.provider ?? env.AUDIOTRANSLATE_PROVIDER ?? "demo").toLowerCase();
  if (!["azure", "demo", "gemini"].includes(provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  return {
    projectRoot: PROJECT_ROOT,
    host: "127.0.0.1",
    port: toPort(args.port ?? env.AUDIOTRANSLATE_PORT),
    provider,
    sourceLanguage: String(
      args.source ?? env.AUDIOTRANSLATE_SOURCE ?? (provider === "gemini" ? "auto" : "en-US"),
    ),
    sourceLanguageCandidates: toLanguageList(
      args["source-candidates"] ?? env.AUDIOTRANSLATE_SOURCE_CANDIDATES,
      provider === "azure" ? ["en-US", "ja-JP", "ko-KR", "zh-CN"] : [],
    ),
    targetLanguage: String(args.target ?? env.AUDIOTRANSLATE_TARGET ?? "vi"),
    showSource: toBoolean(args["show-source"] ?? env.AUDIOTRANSLATE_SHOW_SOURCE, true),
    clickThrough: toBoolean(
      args["click-through"] ?? env.AUDIOTRANSLATE_CLICK_THROUGH,
      true,
    ),
    allowDevClients: toBoolean(
      args["allow-dev-clients"] ?? env.AUDIOTRANSLATE_ALLOW_DEV_CLIENTS,
      false,
    ),
    authToken: String(env.AUDIOTRANSLATE_TOKEN || ""),
    cloudConsent: String(env.AUDIOTRANSLATE_CLOUD_CONSENT || ""),
    maxCloudMinutes: toMaxCloudMinutes(
      args["max-cloud-minutes"] ?? env.AUDIOTRANSLATE_MAX_CLOUD_MINUTES,
      0,
    ),
    allowedExtensionIds: String(
      env.AUDIOTRANSLATE_EXTENSION_IDS || "docfjemeacdakckkamiiopljhmgjgfgl",
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    headless: toBoolean(args.headless, false),
    preview: toBoolean(args.preview, false),
    azureSpeechKey: env.AZURE_SPEECH_KEY || "",
    azureSpeechRegion: env.AZURE_SPEECH_REGION || "",
    geminiApiKey: env.GEMINI_API_KEY || "",
    geminiModel: String(
      env.GEMINI_LIVE_MODEL || "gemini-3.5-live-translate-preview",
    ),
    geminiTranslationMode: toTranslationMode(
      args["translation-mode"] ?? env.AUDIOTRANSLATE_TRANSLATION_MODE,
      "fastest",
    ),
    geminiTranscriptionModel: String(
      env.GEMINI_TRANSCRIBE_MODEL || "gemini-3.5-transcribe-live",
    ),
    geminiTextModel: String(
      env.GEMINI_TEXT_MODEL || "gemini-3.5-flash-lite",
    ),
    geminiSessionResumption: toBoolean(
      env.GEMINI_SESSION_RESUMPTION,
      false,
    ),
  };
}

module.exports = {
  AZURE_CLOUD_CONSENT,
  GEMINI_CLOUD_CONSENT,
  PROJECT_ROOT,
  getConfig,
  loadEnvFile,
  parseArgs,
  toBoolean,
  toLanguageList,
  toMaxCloudMinutes,
  toPort,
  toTranslationMode,
};
