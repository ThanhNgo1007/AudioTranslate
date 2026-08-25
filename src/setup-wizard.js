const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const TOTAL_STEPS = 6;
const AZURE_CONSENT = "azure:tab-audio:v1";
const GEMINI_CONSENT = "gemini:audio:v1";
const DEFAULT_CANDIDATES = Object.freeze(["en-US", "ja-JP", "ko-KR", "zh-CN"]);
const BACK = Symbol("wizard-back");
const QUIT = Symbol("wizard-quit");

const PROVIDER_COPY = Object.freeze({
  demo: Object.freeze({
    name: "Demo an toàn",
    badges: "LOCAL · MIỄN PHÍ · MÔ PHỎNG",
    detail: "Không cần API key và không gửi audio. Phụ đề không phải bản dịch thật.",
  }),
  azure: Object.freeze({
    name: "Azure Speech Translation",
    badges: "CLOUD · F0 FREE QUOTA / S0 PAYG",
    detail: "Audio tab được gửi tới Azure. F0/S0 và quota do tài khoản Azure quyết định.",
  }),
  gemini: Object.freeze({
    name: "Gemini Live Translate",
    badges: "CLOUD · FREE TIER / PAYG · REALTIME",
    detail: "Audio đã chọn được gửi tới Google; API key được nhập trong Control Center và lưu mã hóa.",
  }),
  openai: Object.freeze({
    name: "OpenAI Realtime Translate",
    badges: "CHƯA KHẢ DỤNG",
    detail: "OpenAI API được thanh toán riêng với gói ChatGPT.",
  }),
  together: Object.freeze({
    name: "Together ASR + text MT",
    badges: "THỬ NGHIỆM · CHƯA KHẢ DỤNG",
    detail: "Module đã có test riêng nhưng chưa được phép gửi audio/transcript khi chạy thật.",
  }),
  local: Object.freeze({
    name: "Local/offline engine",
    badges: "DỰ KIẾN",
    detail: "Không tốn phí API nhưng model local chưa được đóng gói.",
  }),
});

const SOURCE_PRESETS = Object.freeze([
  ["en-US", "English (US)"],
  ["ja-JP", "日本語"],
  ["ko-KR", "한국어"],
  ["zh-CN", "中文（普通话）"],
  ["vi-VN", "Tiếng Việt"],
  ["fr-FR", "Français"],
]);

const TARGET_PRESETS = Object.freeze([
  ["vi", "Tiếng Việt"],
  ["en", "English"],
  ["ja", "日本語"],
  ["ko", "한국어"],
  ["zh-Hans", "中文（简体）"],
]);

class WizardCancelledError extends Error {
  constructor(message = "Thiết lập đã bị hủy") {
    super(message);
    this.name = "WizardCancelledError";
    this.code = "SETUP_CANCELLED";
  }
}

class NonInteractiveSetupError extends Error {
  constructor() {
    super(
      "Thiết lập tương tác cần một terminal (TTY). " +
        "Hãy chạy lại trong terminal; xem `audiotranslate setup --help` để biết cách dùng.",
    );
    this.name = "NonInteractiveSetupError";
    this.code = "SETUP_TTY_REQUIRED";
  }
}

class TerminalPrompter {
  constructor(options = {}) {
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.env = options.env || process.env;
    this.interactive = Boolean(this.input.isTTY && this.output.isTTY);
    this.colorEnabled =
      options.colorEnabled ??
      Boolean(this.output.isTTY && !this.env.NO_COLOR && this.env.TERM !== "dumb");
    this.ascii = options.ascii ?? this.env.TERM === "dumb";
  }

  write(value) {
    this.output.write(String(value));
  }

  async ask(prompt, options = {}) {
    if (!this.interactive) throw new NonInteractiveSetupError();
    if (options.secret) return this.#askSecret(prompt);
    return this.#askLine(prompt);
  }

  #askLine(prompt) {
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({
        input: this.input,
        output: this.output,
        terminal: true,
      });
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        rl.close();
        callback(value);
      };
      rl.once("SIGINT", () => finish(reject, new WizardCancelledError()));
      rl.once("close", () =>
        finish(reject, new WizardCancelledError("Input đã kết thúc")),
      );
      rl.question(prompt, (answer) => finish(resolve, answer));
    });
  }

  #askSecret(prompt) {
    if (typeof this.input.setRawMode !== "function") {
      throw new NonInteractiveSetupError();
    }
    this.write(prompt);
    return new Promise((resolve, reject) => {
      let value = "";
      let settled = false;
      const wasRaw = Boolean(this.input.isRaw);
      const wasPaused = typeof this.input.isPaused === "function" && this.input.isPaused();

      const cleanup = () => {
        this.input.removeListener("data", onData);
        this.input.removeListener("error", onError);
        this.input.removeListener("end", onEnd);
        this.input.removeListener("close", onEnd);
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        try {
          this.input.setRawMode(wasRaw);
        } catch {
          // The terminal may already be gone; listeners are still removed above.
        }
        if (wasPaused) this.input.pause();
      };
      const finish = (callback, result) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.write("\n");
        callback(result);
      };
      const onError = (error) => finish(reject, error);
      const onEnd = () => finish(reject, new WizardCancelledError("Input đã kết thúc"));
      const onSignal = () => finish(reject, new WizardCancelledError());
      const onData = (chunk) => {
        for (const character of String(chunk)) {
          if (character === "\u0003" || character === "\u0004") {
            finish(reject, new WizardCancelledError());
            return;
          }
          if (character === "\u001b") {
            finish(resolve, "\u001b");
            return;
          }
          if (character === "\r" || character === "\n") {
            finish(resolve, value);
            return;
          }
          if (character === "\u007f" || character === "\b") {
            value = Array.from(value).slice(0, -1).join("");
            continue;
          }
          if (!/[\u0000-\u001f\u007f]/.test(character)) value += character;
        }
      };

      this.input.on("data", onData);
      this.input.once("error", onError);
      this.input.once("end", onEnd);
      this.input.once("close", onEnd);
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        this.input.setRawMode(true);
        this.input.resume();
      } catch (error) {
        finish(reject, error);
      }
    });
  }
}

class ScriptedPrompter {
  constructor(answers = [], options = {}) {
    this.answers = [...answers];
    this.transcript = "";
    this.questions = [];
    this.interactive = options.interactive ?? true;
    this.colorEnabled = options.colorEnabled ?? false;
    this.ascii = options.ascii ?? false;
  }

  write(value) {
    this.transcript += String(value);
  }

  async ask(prompt, options = {}) {
    this.write(prompt);
    this.questions.push({ prompt: String(prompt), secret: options.secret === true });
    if (this.answers.length === 0) {
      throw new Error(`ScriptedPrompter đã hết câu trả lời tại: ${prompt}`);
    }
    const answer = this.answers.shift();
    if (answer instanceof Error) throw answer;
    return String(answer ?? "");
  }
}

function color(prompter, code, value) {
  if (!prompter.colorEnabled) return value;
  return `\u001b[${code}m${value}\u001b[0m`;
}

function writeLine(prompter, value = "") {
  prompter.write(`${value}\n`);
}

function renderStep(prompter, step, title, lines = []) {
  const progress = `Bước ${step}/${TOTAL_STEPS}: ${title}`;
  const heading = color(prompter, "1;36", progress);
  if (prompter.ascii) {
    writeLine(prompter, `+-- ${heading} --+`);
    for (const line of lines) writeLine(prompter, `| ${line}`);
    writeLine(prompter, "+----------------------------------------+");
  } else {
    writeLine(prompter, `┌─ ${heading} ─┐`);
    for (const line of lines) writeLine(prompter, `│ ${line}`);
    writeLine(prompter, "└────────────────────────────────────────┘");
  }
}

function normalizeNavigation(value) {
  if (value === BACK || value === QUIT) return value;
  const normalized = String(value).trim().toLowerCase();
  if (["b", "back", "/back", "\u001b"].includes(normalized)) return BACK;
  if (["q", "quit", "/quit"].includes(normalized)) return QUIT;
  return value;
}

async function ask(prompter, prompt, options = {}) {
  return normalizeNavigation(await prompter.ask(prompt, options));
}

function canonicalizeLanguage(value, { requireRegion = false } = {}) {
  const raw = String(value).trim();
  if (!raw || raw.length > 64 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    const canonical = Intl.getCanonicalLocales(raw)[0];
    if (!canonical) return null;
    if (requireRegion && !new Intl.Locale(canonical).region) return null;
    return canonical;
  } catch {
    return null;
  }
}

function validateCandidates(value) {
  const rawCandidates = String(value)
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  if (rawCandidates.length < 2 || rawCandidates.length > 4) {
    return { error: "Cần từ 2 đến 4 locale; ví dụ en-US,ja-JP,ko-KR." };
  }
  const candidates = [];
  for (const candidate of rawCandidates) {
    const canonical = canonicalizeLanguage(candidate, { requireRegion: true });
    if (!canonical) {
      return { error: `Locale không hợp lệ: ${candidate}. Ví dụ hợp lệ: en-US hoặc vi-VN.` };
    }
    candidates.push(canonical);
  }
  const baseLanguages = candidates.map((candidate) => new Intl.Locale(candidate).language);
  if (new Set(baseLanguages).size !== baseLanguages.length) {
    return { error: "Mỗi ngôn ngữ chỉ dùng một locale; không chọn đồng thời en-US và en-GB." };
  }
  return { candidates };
}

function parseYesNo(value, fallback) {
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (["y", "yes", "c", "co", "có", "true", "1", "on"].includes(normalized)) return true;
  if (["n", "no", "k", "khong", "không", "false", "0", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function findEnvComment(value) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      if (quote === character) quote = null;
      else if (!quote) quote = character;
      continue;
    }
    if (!quote && character === "#") return index;
  }
  return -1;
}

function readEnvValue(contents, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=\\s*(.*)$`, "gm");
  const source = String(contents || "");
  let match;
  let lastValue;
  while ((match = pattern.exec(source)) !== null) lastValue = match[1];
  if (lastValue === undefined) return "";
  const commentIndex = findEnvComment(lastValue);
  const raw = (commentIndex === -1 ? lastValue : lastValue.slice(0, commentIndex)).trim();
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function makePairingToken(contents, randomBytes) {
  const existing = readEnvValue(contents, "AUDIOTRANSLATE_TOKEN");
  if (existing.length >= 24) return { token: existing, reused: true };
  return { token: randomBytes(24).toString("base64url"), reused: false };
}

function isCatalogProviderAvailable(provider) {
  if (!provider || typeof provider !== "object") return false;
  if (
    provider.runnable === false ||
    provider.enabled === false ||
    provider.available === false ||
    provider.selectable === false
  ) {
    return false;
  }
  const status = String(provider.status || provider.availability || "available").toLowerCase();
  return ![
    "disabled",
    "planned",
    "unavailable",
    "in-development",
    "coming-soon",
    "coming_soon",
  ].includes(status);
}

async function chooseProvider(prompter, catalog, currentProvider = "demo") {
  const listed = await Promise.resolve(catalog.listProviders());
  const providers = new Map(
    (Array.isArray(listed) ? listed : []).map((provider) => [provider.id, provider]),
  );
  const writeCost = (id) => {
    const summary = providers.get(id)?.cost?.summary;
    if (summary) writeLine(prompter, `     Chi phí: ${summary}`);
  };

  renderStep(prompter, 1, "Chọn provider", [
    "Mặc định an toàn là demo: không gửi audio và không cần API key.",
    "Dùng b hoặc /back để quay lại; q hoặc /quit để thoát.",
  ]);
  writeLine(
    prompter,
    `  1) Demo an toàn${currentProvider === "demo" ? " [MẶC ĐỊNH]" : ""}`,
  );
  writeLine(prompter, `     [${PROVIDER_COPY.demo.badges}] ${PROVIDER_COPY.demo.detail}`);
  writeCost("demo");
  writeLine(
    prompter,
    `  2) Azure Speech Translation${currentProvider === "azure" ? " [MẶC ĐỊNH]" : ""}`,
  );
  writeLine(prompter, `     [${PROVIDER_COPY.azure.badges}] ${PROVIDER_COPY.azure.detail}`);
  writeCost("azure");
  for (const [number, id] of [
    [3, "gemini"],
    [4, "openai"],
    [5, "together"],
    [6, "local"],
  ]) {
    const copy = PROVIDER_COPY[id];
    writeLine(prompter, `  ${number}) ${copy.name} [${copy.badges}]`);
    writeLine(prompter, `     ${copy.detail}`);
    writeCost(id);
  }

  const choices = new Map([
    ["", ["azure", "gemini"].includes(currentProvider) ? currentProvider : "demo"],
    ["1", "demo"],
    ["demo", "demo"],
    ["2", "azure"],
    ["azure", "azure"],
    ["3", "gemini"],
    ["gemini", "gemini"],
    ["4", "openai"],
    ["openai", "openai"],
    ["5", "together"],
    ["together", "together"],
    ["6", "local"],
    ["local", "local"],
  ]);

  while (true) {
    const defaultNumber = currentProvider === "azure" ? "2" : currentProvider === "gemini" ? "3" : "1";
    const answer = await ask(prompter, `Chọn [${defaultNumber}]: `);
    if (answer === BACK || answer === QUIT) return answer;
    const id = choices.get(String(answer).trim().toLowerCase());
    if (!id) {
      writeLine(prompter, "[LỖI] Hãy chọn một số từ 1 đến 6.");
      continue;
    }
    if (!new Set(["demo", "azure", "gemini"]).has(id)) {
      writeLine(prompter, `[THÔNG TIN] ${PROVIDER_COPY[id].name} chưa khả dụng trong bản này.`);
      continue;
    }
    let provider = providers.get(id);
    if (!provider) {
      try {
        provider = await Promise.resolve(catalog.getProvider(id));
      } catch {
        provider = null;
      }
    }
    if (!isCatalogProviderAvailable(provider)) {
      writeLine(prompter, `[LỖI] Provider ${id} chưa được runtime hiện tại kích hoạt.`);
      continue;
    }
    return id;
  }
}

async function chooseSource(
  prompter,
  provider,
  currentSource = "en-US",
  currentCandidates = DEFAULT_CANDIDATES,
) {
  renderStep(prompter, 2, "Ngôn ngữ đầu vào", [
    provider === "gemini"
      ? "Gemini tự nhận diện liên tục; locale bạn chọn chỉ là gợi ý, không khóa ngôn ngữ."
      : "Chọn đúng ngôn ngữ thường nhanh và chính xác hơn tự nhận diện.",
  ]);
  SOURCE_PRESETS.forEach(([locale, name], index) => {
    writeLine(prompter, `  ${index + 1}) ${name} — ${locale}${index === 0 ? " [MẶC ĐỊNH]" : ""}`);
  });
  writeLine(prompter, "  7) Tự nhập locale");
  if (provider === "azure") {
    writeLine(prompter, "  8) Tự nhận diện từ 2–4 locale ứng viên");
  } else if (provider === "gemini") {
    writeLine(prompter, "  8) Tự nhận diện hoàn toàn (không gợi ý locale)");
  }

  const fixedOrHint = (locale) =>
    provider === "gemini"
      ? { sourceLanguage: "auto", sourceLanguageCandidates: locale ? [locale] : [] }
      : { sourceLanguage: locale, sourceLanguageCandidates: DEFAULT_CANDIDATES };

  while (true) {
    const answer = await ask(prompter, `Chọn [${currentSource}]: `);
    if (answer === BACK || answer === QUIT) return answer;
    const normalized = String(answer).trim();
    if (!normalized) {
      if (currentSource === "auto" && ["azure", "gemini"].includes(provider)) {
        return {
          sourceLanguage: "auto",
          sourceLanguageCandidates: [...currentCandidates],
        };
      }
      const existing = canonicalizeLanguage(currentSource, { requireRegion: true });
      return fixedOrHint(existing || "en-US");
    }
    const numeric = Number.parseInt(normalized, 10);
    if (String(numeric) === normalized && numeric >= 1 && numeric <= SOURCE_PRESETS.length) {
      return fixedOrHint(SOURCE_PRESETS[numeric - 1][0]);
    }
    if ((normalized === "8" || normalized.toLowerCase() === "auto") && provider === "azure") {
      while (true) {
        const candidatesAnswer = await ask(
          prompter,
          "Nhập 2–4 locale, cách nhau bằng dấu phẩy (ví dụ en-US,ja-JP,ko-KR): ",
        );
        if (candidatesAnswer === BACK || candidatesAnswer === QUIT) return candidatesAnswer;
        const result = validateCandidates(candidatesAnswer);
        if (result.error) {
          writeLine(prompter, `[LỖI] ${result.error}`);
          continue;
        }
        return { sourceLanguage: "auto", sourceLanguageCandidates: result.candidates };
      }
    }
    if ((normalized === "8" || normalized.toLowerCase() === "auto") && provider === "gemini") {
      return { sourceLanguage: "auto", sourceLanguageCandidates: [] };
    }
    if (normalized === "7" || normalized.toLowerCase() === "custom") {
      const custom = await ask(prompter, "Locale đầu vào (ví dụ en-US): ");
      if (custom === BACK || custom === QUIT) return custom;
      const locale = canonicalizeLanguage(custom, { requireRegion: true });
      if (!locale) {
        writeLine(prompter, "[LỖI] Cần locale đầy đủ, ví dụ en-US hoặc vi-VN.");
        continue;
      }
      return fixedOrHint(locale);
    }
    const directLocale = canonicalizeLanguage(normalized, { requireRegion: true });
    if (directLocale) {
      return fixedOrHint(directLocale);
    }
    if (normalized.toLowerCase() === "auto") {
      writeLine(prompter, "[LỖI] Provider này không hỗ trợ lựa chọn tự nhận diện như đã nhập.");
    } else {
      writeLine(prompter, "[LỖI] Hãy chọn một mục hoặc nhập locale đầy đủ như en-US.");
    }
  }
}

async function chooseTarget(prompter, currentTarget = "vi") {
  renderStep(prompter, 3, "Ngôn ngữ bản dịch", ["Tiếng Việt là lựa chọn mặc định."]);
  TARGET_PRESETS.forEach(([locale, name], index) => {
    writeLine(prompter, `  ${index + 1}) ${name} — ${locale}${index === 0 ? " [MẶC ĐỊNH]" : ""}`);
  });
  writeLine(prompter, "  6) Tự nhập mã ngôn ngữ");
  while (true) {
    const answer = await ask(prompter, `Chọn [${currentTarget}]: `);
    if (answer === BACK || answer === QUIT) return answer;
    const normalized = String(answer).trim();
    if (!normalized) return canonicalizeLanguage(currentTarget) || "vi";
    const numeric = Number.parseInt(normalized, 10);
    if (String(numeric) === normalized && numeric >= 1 && numeric <= TARGET_PRESETS.length) {
      return TARGET_PRESETS[numeric - 1][0];
    }
    let candidate = normalized;
    if (normalized === "6" || normalized.toLowerCase() === "custom") {
      const custom = await ask(prompter, "Mã ngôn ngữ đích (ví dụ vi hoặc zh-Hans): ");
      if (custom === BACK || custom === QUIT) return custom;
      candidate = custom;
    }
    const language = canonicalizeLanguage(candidate);
    if (language) return language;
    writeLine(prompter, "[LỖI] Mã ngôn ngữ không hợp lệ; ví dụ vi, en hoặc zh-Hans.");
  }
}

async function chooseDisplay(prompter, currentShowSource = true) {
  renderStep(prompter, 4, "Hiển thị", [
    "Bạn có thể hiện transcript gốc phía trên bản dịch.",
  ]);
  while (true) {
    const answer = await ask(
      prompter,
      `Hiển thị cả transcript gốc? [${currentShowSource ? "Y/n" : "y/N"}]: `,
    );
    if (answer === BACK || answer === QUIT) return answer;
    const result = parseYesNo(answer, currentShowSource);
    if (result !== null) return result;
    writeLine(prompter, "[LỖI] Nhập y/có hoặc n/không.");
  }
}

function validAzureRegion(value) {
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value);
}

function validAzureKey(value) {
  return value.length >= 8 && value.length <= 16_384 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

async function configureProvider(prompter, state) {
  if (state.provider === "demo") {
    renderStep(prompter, 5, "Kiểm tra đường dữ liệu", [
      "LOCAL · Không cần API key · Không gửi audio lên cloud.",
      "Preview dùng phụ đề mô phỏng, không phải bản dịch audio thật.",
    ]);
    return { maxCloudMinutes: 0, cloudConsent: "" };
  }

  if (state.provider === "gemini") {
    renderStep(prompter, 5, "Cấu hình Gemini cloud", [
      "Audio tab/file đã chọn → Google Gemini Live → phụ đề trên máy này.",
      "API key sẽ được nhập trong Control Center và lưu bằng kho mã hóa hệ điều hành.",
      "Free Tier/quota hoặc phí Paid Tier thuộc project Gemini API của bạn.",
    ]);
    while (true) {
      writeLine(prompter, "");
      writeLine(prompter, color(prompter, "1;33", "DỮ LIỆU SẼ RỜI KHỎI MÁY"));
      writeLine(prompter, "Chỉ audio từ tab hoặc file bạn chủ động bắt đầu mới được gửi tới Google.");
      writeLine(prompter, "AudioTranslate không ghi audio xuống đĩa và không đưa API key vào extension.");
      const answer = await ask(prompter, "Gõ CHO PHEP để đồng ý, b để quay lại hoặc q để thoát: ");
      if (answer === BACK || answer === QUIT) return answer;
      if (String(answer).trim() === "CHO PHEP") break;
      writeLine(prompter, "[LỖI] Chưa có đồng ý cloud. Cần nhập chính xác: CHO PHEP");
    }
    let maxCloudMinutes = state.maxCloudMinutes || 30;
    while (true) {
      const answer = await ask(
        prompter,
        `Tự dừng cloud sau bao nhiêu phút mỗi phiên? [${maxCloudMinutes}]: `,
      );
      if (answer === BACK || answer === QUIT) return answer;
      const raw = String(answer).trim();
      const candidate = raw ? Number(raw) : maxCloudMinutes;
      if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 1440) {
        maxCloudMinutes = candidate;
        break;
      }
      writeLine(prompter, "[LỖI] Nhập số phút nguyên từ 1 đến 1440.");
    }
    return { maxCloudMinutes, cloudConsent: GEMINI_CONSENT };
  }

  renderStep(prompter, 5, "Cấu hình Azure cloud", [
    "Audio tab → Azure Speech → phụ đề trên máy này.",
    "F0/S0, quota và hóa đơn do tài khoản Azure quyết định.",
    "Giới hạn phút bên dưới là guardrail thời lượng, không phải billing cap.",
  ]);

  let region = state.azureRegion || "southeastasia";
  while (true) {
    const answer = await ask(prompter, `Azure region [${region}]: `);
    if (answer === BACK || answer === QUIT) return answer;
    const candidate = String(answer).trim().toLowerCase() || region;
    if (validAzureRegion(candidate)) {
      region = candidate;
      break;
    }
    writeLine(prompter, "[LỖI] Region chỉ gồm chữ thường, số hoặc dấu gạch ngang.");
  }

  let key = state.azureKey || "";
  while (true) {
    const suffix = key ? " (Enter để giữ key hiện có)" : "";
    const answer = await ask(
      prompter,
      `Dán AZURE_SPEECH_KEY${suffix}; Esc hoặc b để quay lại: `,
      { secret: true },
    );
    if (answer === BACK || answer === QUIT) return answer;
    const candidate = String(answer) || key;
    if (validAzureKey(candidate)) {
      key = candidate;
      break;
    }
    writeLine(prompter, "[LỖI] API key trống hoặc không hợp lệ. Key không được hiển thị hay ghi log.");
  }

  while (true) {
    writeLine(prompter, "");
    writeLine(prompter, color(prompter, "1;33", "DỮ LIỆU SẼ RỜI KHỎI MÁY"));
    writeLine(prompter, "Audio tab sẽ được gửi tới Azure Speech để nhận transcript/bản dịch.");
    writeLine(prompter, "AudioTranslate không ghi audio xuống đĩa, nhưng chính sách Azure vẫn áp dụng.");
    const answer = await ask(prompter, "Gõ CHO PHEP để đồng ý, b để quay lại hoặc q để thoát: ");
    if (answer === BACK || answer === QUIT) return answer;
    if (String(answer).trim() === "CHO PHEP") break;
    writeLine(prompter, "[LỖI] Chưa có đồng ý cloud. Cần nhập chính xác: CHO PHEP");
  }

  let maxCloudMinutes = state.maxCloudMinutes || 30;
  while (true) {
    const answer = await ask(
      prompter,
      `Tự dừng cloud sau bao nhiêu phút mỗi phiên? [${maxCloudMinutes}]: `,
    );
    if (answer === BACK || answer === QUIT) return answer;
    const raw = String(answer).trim();
    const candidate = raw ? Number(raw) : maxCloudMinutes;
    if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 1440) {
      maxCloudMinutes = candidate;
      break;
    }
    writeLine(prompter, "[LỖI] Nhập số phút nguyên từ 1 đến 1440.");
  }

  return {
    azureRegion: region,
    azureKey: key,
    maxCloudMinutes,
    cloudConsent: AZURE_CONSENT,
  };
}

function summaryLines(state, tokenInfo) {
  const providerName = PROVIDER_COPY[state.provider]?.name || state.provider;
  const dataPath =
    state.provider === "demo"
      ? "LOCAL — không gửi audio"
      : state.provider === "gemini"
        ? "Audio đã chọn → Google Gemini Live → overlay/terminal local"
        : "Audio tab → Azure Speech → overlay/terminal local";
  const lines = [
    `Provider: ${providerName}`,
    `Đường dữ liệu: ${dataPath}`,
    `Ngôn ngữ: ${state.sourceLanguage} → ${state.targetLanguage}`,
    `Transcript gốc: ${state.showSource ? "Có" : "Không"}`,
    `Pairing token: ${tokenInfo.reused ? "giữ token hiện có" : "tạo token mới khi lưu"}`,
  ];
  if (state.sourceLanguage === "auto") {
    lines.push(`Ứng viên auto: ${state.sourceLanguageCandidates.join(",")}`);
  }
  if (state.provider === "azure") {
    lines.push(`Azure region: ${state.azureRegion}`);
    lines.push("Azure API key: •••••••• (đã nhập; không hiển thị)");
    lines.push("Cloud consent: Đã nhập CHO PHEP");
    lines.push(
      `Guardrail: tự dừng sau ${state.maxCloudMinutes} phút/phiên (không phải billing cap)`,
    );
  } else if (state.provider === "gemini") {
    lines.push("Gemini API key: nhập sau trong Control Center (không ghi plaintext vào .env)");
    lines.push("Cloud consent: Đã nhập CHO PHEP");
    lines.push(
      `Guardrail: tự dừng sau ${state.maxCloudMinutes} phút/phiên (không phải billing cap)`,
    );
  } else {
    lines.push("Cloud consent: Không có");
    lines.push("Guardrail cloud: 0 phút");
  }
  return lines;
}

async function confirmAndSave(prompter, state, context) {
  renderStep(prompter, 6, "Xác nhận và lưu", summaryLines(state, context.tokenInfo));
  let showPairingToken = false;
  while (true) {
    const answer = await ask(
      prompter,
      "Hiển thị pairing token một lần trên terminal sau khi lưu? [y/N]: ",
    );
    if (answer === BACK || answer === QUIT) return answer;
    const result = parseYesNo(answer, false);
    if (result !== null) {
      showPairingToken = result;
      break;
    }
    writeLine(prompter, "[LỖI] Nhập y/có hoặc n/không.");
  }
  while (true) {
    const answer = await ask(prompter, "Lưu cấu hình này? [y/N]: ");
    if (answer === BACK || answer === QUIT) return answer;
    const result = parseYesNo(answer, false);
    if (result === null) {
      writeLine(prompter, "[LỖI] Nhập y/có để lưu, n/không để hủy, b để quay lại.");
      continue;
    }
    if (!result) return QUIT;
    break;
  }

  const updates = {
    AUDIOTRANSLATE_PROVIDER: state.provider,
    AUDIOTRANSLATE_SOURCE: state.sourceLanguage,
    AUDIOTRANSLATE_SOURCE_CANDIDATES: state.sourceLanguageCandidates.join(","),
    AUDIOTRANSLATE_TARGET: state.targetLanguage,
    AUDIOTRANSLATE_SHOW_SOURCE: String(state.showSource),
    AUDIOTRANSLATE_TOKEN: context.tokenInfo.token,
    AUDIOTRANSLATE_MAX_CLOUD_MINUTES: String(
      ["azure", "gemini"].includes(state.provider) ? state.maxCloudMinutes : 0,
    ),
  };
  const removeKeys = [];
  if (state.provider === "azure") {
    if (
      state.cloudConsent !== AZURE_CONSENT ||
      !validAzureKey(state.azureKey) ||
      !validAzureRegion(state.azureRegion) ||
      !Number.isInteger(state.maxCloudMinutes) ||
      state.maxCloudMinutes < 1 ||
      state.maxCloudMinutes > 1440
    ) {
      throw new Error("Cấu hình Azure chưa đủ key, region, consent hoặc guardrail hợp lệ");
    }
    updates.AZURE_SPEECH_KEY = state.azureKey;
    updates.AZURE_SPEECH_REGION = state.azureRegion;
    updates.AUDIOTRANSLATE_CLOUD_CONSENT = AZURE_CONSENT;
  } else if (state.provider === "gemini") {
    if (
      state.cloudConsent !== GEMINI_CONSENT ||
      !Number.isInteger(state.maxCloudMinutes) ||
      state.maxCloudMinutes < 1 ||
      state.maxCloudMinutes > 1440
    ) {
      throw new Error("Cấu hình Gemini chưa có consent hoặc guardrail hợp lệ");
    }
    updates.AUDIOTRANSLATE_CLOUD_CONSENT = GEMINI_CONSENT;
  } else {
    removeKeys.push("AUDIOTRANSLATE_CLOUD_CONSENT");
  }

  await context.withEnvFileLock(context.envPath, async () => {
    const latestState = await Promise.resolve(context.readLatestEnvState());
    if (
      !latestState ||
      typeof latestState.contents !== "string" ||
      !latestState.version ||
      typeof latestState.version !== "object"
    ) {
      throw new TypeError("readLatestEnvState must return contents and an environment version");
    }
    const nextContents = context.upsertEnvContents(latestState.contents, updates, {
      removeKeys,
    });
    return Promise.resolve(
      context.writeEnvAtomic(context.envPath, nextContents, {
        expectedVersion: latestState.version,
      }),
    );
  });

  writeLine(prompter, "");
  writeLine(prompter, color(prompter, "1;32", `[OK] Đã lưu cấu hình: ${context.envPath}`));
  if (showPairingToken) {
    writeLine(prompter, "Pairing token (dán một lần vào Extension → Kết nối nâng cao):");
    writeLine(prompter, context.tokenInfo.token);
  } else {
    writeLine(prompter, "Pairing token không được in ra terminal.");
    writeLine(prompter, "Sau khi chạy app, dùng menu tray → Sao chép pairing token.");
  }
  writeLine(prompter, "");
  if (state.provider === "demo") {
    writeLine(prompter, "Chạy thử overlay: npm run preview");
  } else {
    writeLine(prompter, "Tiếp theo:");
    writeLine(prompter, "  1. npm run doctor");
    writeLine(prompter, "  2. npm start");
    writeLine(prompter, "  3. Load unpacked thư mục extension trong chrome://extensions hoặc edge://extensions");
    writeLine(prompter, "  4. Mở video, dán pairing token và chọn Bắt đầu dịch tab này");
  }
  return {
    status: "saved",
    cancelled: false,
    provider: state.provider,
    sourceLanguage: state.sourceLanguage,
    sourceLanguageCandidates: [...state.sourceLanguageCandidates],
    targetLanguage: state.targetLanguage,
    showSource: state.showSource,
    maxCloudMinutes: ["azure", "gemini"].includes(state.provider) ? state.maxCloudMinutes : 0,
    envPath: context.envPath,
  };
}

function defaultReadEnv(envPath) {
  try {
    return fs.readFileSync(envPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function initialStateFromEnv(contents) {
  const providerValue = readEnvValue(contents, "AUDIOTRANSLATE_PROVIDER").toLowerCase();
  const provider = ["azure", "gemini"].includes(providerValue) ? providerValue : "demo";
  const candidateResult = validateCandidates(
    readEnvValue(contents, "AUDIOTRANSLATE_SOURCE_CANDIDATES"),
  );
  const sourceLanguageCandidates = candidateResult.candidates || [...DEFAULT_CANDIDATES];
  const sourceValue = readEnvValue(contents, "AUDIOTRANSLATE_SOURCE");
  const sourceLanguage =
    sourceValue === "auto" && ["azure", "gemini"].includes(provider)
      ? "auto"
      : canonicalizeLanguage(sourceValue, { requireRegion: true }) || "en-US";
  const targetLanguage =
    canonicalizeLanguage(readEnvValue(contents, "AUDIOTRANSLATE_TARGET")) || "vi";
  const showSourceValue = parseYesNo(
    readEnvValue(contents, "AUDIOTRANSLATE_SHOW_SOURCE"),
    true,
  );
  const existingMaxMinutes = Number(
    readEnvValue(contents, "AUDIOTRANSLATE_MAX_CLOUD_MINUTES"),
  );
  return {
    provider,
    sourceLanguage,
    sourceLanguageCandidates,
    targetLanguage,
    showSource: showSourceValue === null ? true : showSourceValue,
    azureKey: readEnvValue(contents, "AZURE_SPEECH_KEY"),
    azureRegion: readEnvValue(contents, "AZURE_SPEECH_REGION").toLowerCase() || "southeastasia",
    cloudConsent: "",
    maxCloudMinutes:
      Number.isInteger(existingMaxMinutes) && existingMaxMinutes >= 1 && existingMaxMinutes <= 1440
        ? existingMaxMinutes
        : 30,
  };
}

function loadDependencies(options) {
  const envTools = options.envTools || require("./env-file");
  const catalog = options.catalog ||
    (options.listProviders && options.getProvider ? {} : require("./provider-catalog"));
  return {
    createEnvFileVersion: options.createEnvFileVersion || envTools.createEnvFileVersion,
    readEnvFileState: options.readEnvFileState || envTools.readEnvFileState,
    writeEnvAtomic: options.writeEnvAtomic || envTools.writeEnvAtomic,
    upsertEnvContents: options.upsertEnvContents || envTools.upsertEnvContents,
    withEnvFileLock: options.withEnvFileLock || envTools.withEnvFileLock,
    catalog: {
      listProviders: options.listProviders || catalog.listProviders,
      getProvider: options.getProvider || catalog.getProvider,
    },
  };
}

async function runSetupWizard(options = {}) {
  const prompter = options.prompter || new TerminalPrompter(options);
  if (prompter.interactive === false) throw new NonInteractiveSetupError();
  const dependencies = loadDependencies(options);
  if (typeof dependencies.writeEnvAtomic !== "function") {
    throw new TypeError("writeEnvAtomic must be a function");
  }
  if (typeof dependencies.upsertEnvContents !== "function") {
    throw new TypeError("upsertEnvContents must be a function");
  }
  if (typeof dependencies.withEnvFileLock !== "function") {
    throw new TypeError("withEnvFileLock must be a function");
  }
  if (typeof dependencies.createEnvFileVersion !== "function") {
    throw new TypeError("createEnvFileVersion must be a function");
  }
  if (typeof dependencies.readEnvFileState !== "function") {
    throw new TypeError("readEnvFileState must be a function");
  }
  if (
    typeof dependencies.catalog.listProviders !== "function" ||
    typeof dependencies.catalog.getProvider !== "function"
  ) {
    throw new TypeError("Provider catalog must export listProviders() and getProvider()");
  }

  const envPath = options.envPath || path.resolve(__dirname, "..", ".env");
  const hasProvidedContents =
    Object.prototype.hasOwnProperty.call(options, "existingContents") ||
    Object.prototype.hasOwnProperty.call(options, "envContents");
  const readEnv = options.readEnv || defaultReadEnv;
  const existingContents =
    options.existingContents ??
    options.envContents ??
    readEnv(envPath);
  if (typeof existingContents !== "string") {
    throw new TypeError("readEnv must return environment contents as a string");
  }
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const tokenInfo = makePairingToken(existingContents, randomBytes);
  const state = initialStateFromEnv(existingContents);
  const fallbackLatestReader =
    options.readLatestEnv ||
    (hasProvidedContents ? () => existingContents : options.readEnv ? () => readEnv(envPath) : null);
  const readLatestEnvState =
    options.readLatestEnvState ||
    (fallbackLatestReader
      ? async () => {
          const contents = await Promise.resolve(fallbackLatestReader());
          if (typeof contents !== "string") {
            throw new TypeError("readLatestEnv must return environment contents as a string");
          }
          return {
            contents,
            version: dependencies.createEnvFileVersion(contents, { exists: null }),
          };
        }
      : () => dependencies.readEnvFileState(envPath));
  const context = {
    existingContents,
    envPath,
    tokenInfo,
    readLatestEnvState,
    writeEnvAtomic: dependencies.writeEnvAtomic,
    upsertEnvContents: dependencies.upsertEnvContents,
    withEnvFileLock: dependencies.withEnvFileLock,
  };

  writeLine(prompter, "");
  writeLine(prompter, color(prompter, "1", "AudioTranslate — thiết lập lần đầu"));
  writeLine(prompter, "Không có audio nào rời máy trước khi bạn chọn và đồng ý provider cloud.");
  writeLine(prompter, "");

  let step = 1;
  try {
    while (step >= 1 && step <= TOTAL_STEPS) {
      if (step === 1) {
        const result = await chooseProvider(prompter, dependencies.catalog, state.provider);
        if (result === QUIT || result === BACK) {
          return { status: "cancelled", cancelled: true, reason: "quit" };
        }
        if (state.provider !== result) {
          const previousSource = state.sourceLanguage;
          state.provider = result;
          state.cloudConsent = "";
          if (result === "demo" && state.sourceLanguage === "auto") {
            state.sourceLanguage = "en-US";
          } else if (result === "gemini" && previousSource !== "auto") {
            state.sourceLanguage = "auto";
            state.sourceLanguageCandidates = previousSource ? [previousSource] : [];
          }
        }
        step = 2;
        continue;
      }
      if (step === 2) {
        const result = await chooseSource(
          prompter,
          state.provider,
          state.sourceLanguage,
          state.sourceLanguageCandidates,
        );
        if (result === QUIT) return { status: "cancelled", cancelled: true, reason: "quit" };
        if (result === BACK) {
          step = 1;
          continue;
        }
        Object.assign(state, result);
        step = 3;
        continue;
      }
      if (step === 3) {
        const result = await chooseTarget(prompter, state.targetLanguage);
        if (result === QUIT) return { status: "cancelled", cancelled: true, reason: "quit" };
        if (result === BACK) {
          step = 2;
          continue;
        }
        state.targetLanguage = result;
        step = 4;
        continue;
      }
      if (step === 4) {
        const result = await chooseDisplay(prompter, state.showSource);
        if (result === QUIT) return { status: "cancelled", cancelled: true, reason: "quit" };
        if (result === BACK) {
          step = 3;
          continue;
        }
        state.showSource = result;
        step = 5;
        continue;
      }
      if (step === 5) {
        const result = await configureProvider(prompter, state);
        if (result === QUIT) return { status: "cancelled", cancelled: true, reason: "quit" };
        if (result === BACK) {
          step = 4;
          continue;
        }
        Object.assign(state, result);
        step = 6;
        continue;
      }
      const result = await confirmAndSave(prompter, state, context);
      if (result === BACK) {
        step = 5;
        continue;
      }
      if (result === QUIT) {
        return { status: "cancelled", cancelled: true, reason: "not-confirmed" };
      }
      state.azureKey = "";
      return result;
    }
  } catch (error) {
    if (error instanceof WizardCancelledError || error?.code === "SETUP_CANCELLED") {
      return { status: "cancelled", cancelled: true, reason: "interrupt" };
    }
    throw error;
  } finally {
    state.azureKey = "";
  }
  return { status: "cancelled", cancelled: true, reason: "quit" };
}

module.exports = {
  AZURE_CONSENT,
  GEMINI_CONSENT,
  NonInteractiveSetupError,
  ScriptedPrompter,
  TerminalPrompter,
  WizardCancelledError,
  canonicalizeLanguage,
  normalizeNavigation,
  parseYesNo,
  readEnvValue,
  renderStep,
  runSetupWizard,
  initialStateFromEnv,
  summaryLines,
  validateCandidates,
};
