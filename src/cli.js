const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  AZURE_CLOUD_CONSENT,
  GEMINI_CLOUD_CONSENT,
  PROJECT_ROOT,
  getConfig,
  loadEnvFile,
} = require("./config");
const { isValidCloudCredential, isValidPairingToken } = require("./headless-validation");
const { isSupportedNodeVersion } = require("./node-version");
const { getProvider, renderProviderCatalog } = require("./provider-catalog");

const START_VALUE_OPTIONS = new Map([
  ["provider", "string"],
  ["source", "string"],
  ["source-candidates", "string"],
  ["target", "string"],
  ["port", "integer"],
  ["max-cloud-minutes", "integer"],
]);
const START_FLAG_OPTIONS = new Set([
  "headless",
  "allow-dev-clients",
  "show-source",
  "click-through",
]);
const BOOLEAN_VALUES = new Map([
  ["true", true],
  ["1", true],
  ["yes", true],
  ["on", true],
  ["false", false],
  ["0", false],
  ["no", false],
  ["off", false],
]);

function parseBooleanOption(name, value) {
  const parsed = BOOLEAN_VALUES.get(String(value).toLowerCase());
  if (parsed === undefined) return { error: `--${name} chỉ nhận true hoặc false.` };
  return { value: parsed };
}

function parseCommandOptions(args, options = {}) {
  const valueOptions = options.valueOptions || new Map();
  const flagOptions = options.flagOptions || new Set();
  const values = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) return { error: `Tham số không hợp lệ: ${token}` };
    const equalsIndex = token.indexOf("=");
    const name = token.slice(2, equalsIndex < 0 ? undefined : equalsIndex);
    const isValueOption = valueOptions.has(name);
    if (!name || (!isValueOption && !flagOptions.has(name))) {
      return { error: `Tùy chọn không hỗ trợ: --${name || "(trống)"}` };
    }

    if (flagOptions.has(name)) {
      if (equalsIndex >= 0) {
        const parsed = parseBooleanOption(name, token.slice(equalsIndex + 1));
        if (parsed.error) return parsed;
        values[name] = parsed.value;
        continue;
      }
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        const parsed = parseBooleanOption(name, next);
        if (parsed.error) return parsed;
        values[name] = parsed.value;
        index += 1;
      } else {
        values[name] = true;
      }
      continue;
    }

    const value = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : args[index + 1];
    if (!value || value.startsWith("--")) return { error: `Thiếu giá trị cho --${name}.` };
    const valueType = valueOptions.get(name);
    if (valueType === "integer" && !/^\d+$/.test(value)) {
      return { error: `--${name} phải là số nguyên không âm.` };
    }
    values[name] = valueType === "integer" ? Number(value) : value;
    if (equalsIndex < 0) index += 1;
  }
  return { values };
}

function validateOptions(args, options = {}) {
  return parseCommandOptions(args, options).error || null;
}

function parseOptionsOrReject(args, streams, options) {
  const parsed = parseCommandOptions(args, options);
  if (!parsed.error) return parsed.values;
  streams.errorOutput.write(`[ERROR] ${parsed.error}\n`);
  streams.errorOutput.write("Chạy `audiotranslate --help` để xem cú pháp.\n");
  return null;
}

function helpText() {
  return `
AudioTranslate CLI — launcher và chẩn đoán

Mở giao diện desktop (các lệnh tương đương):
  audiotranslate
  audiotranslate open
  audiotranslate start
  audiotranslate setup
  audiotranslate config edit

Lệnh nâng cao:
  audiotranslate preview             Mở UI với phụ đề mô phỏng, không dùng cloud
  audiotranslate doctor [--json]     Kiểm tra môi trường và cấu hình
  audiotranslate doctor --headless   Kiểm tra fallback .env cho terminal
  audiotranslate providers [--json]  So sánh provider, chi phí và riêng tư
  audiotranslate guide              Hướng dẫn kết nối Chrome/Edge
  audiotranslate config show         Xem fallback .env đã che secret
  audiotranslate config path         In đường dẫn fallback .env
  audiotranslate start --headless    Chạy terminal/JSONL bằng cấu hình .env

Tùy chọn chỉ dành cho start --headless:
  --provider gemini|azure|demo
  --source en-US|auto
  --source-candidates en-US,ja-JP,ko-KR
  --target vi
  --port 43765
  --show-source true|false
  --click-through true|false
  --max-cloud-minutes 30

Desktop: cài API key, nguồn audio, ngôn ngữ và overlay trong Control Center.
CLI desktop không ghi .env và không nhận API key qua tham số.

Headless: tự cấu hình .env, gồm AUDIOTRANSLATE_TOKEN, cloud consent
và credential của provider. Không truyền secret trên command line.

`;
}

function setupHelpText() {
  return `
AudioTranslate setup

Lệnh này chỉ mở AudioTranslate Control Center. Trong giao diện, bạn
thiết lập API key, nguồn audio, ngôn ngữ, cloud consent và overlay.

Setup desktop không chạy wizard terminal và không sửa .env.
Chế độ headless/automation vẫn dùng .env; xem “audiotranslate --help”.

`;
}

function guideText(projectRoot = PROJECT_ROOT) {
  const extensionPath = path.join(projectRoot, "extension");
  return `
HƯỚNG DẪN CHROME / EDGE

1. Chạy “audiotranslate” và hoàn tất thiết lập trong Control Center.
2. Chrome mở chrome://extensions; Edge mở edge://extensions.
3. Bật Developer mode → Load unpacked.
4. Chọn thư mục:
   ${extensionPath}
5. Trong Control Center, chọn Browser tab, kiểm tra Gemini rồi bấm
   “Bắt đầu dịch” và “Sao chép pairing token”.
6. Mở video, mở popup AudioTranslate, dán token trong phần Kết nối
   nâng cao rồi nhấn “Bắt đầu dịch tab này”.

Không có API key? Chạy “audiotranslate preview” để kiểm tra overlay trước.
`;
}

function configurationSummary(config, envPath) {
  return {
    path: envPath,
    provider: config.provider,
    sourceLanguage: config.sourceLanguage,
    sourceLanguageCandidates: config.sourceLanguageCandidates,
    targetLanguage: config.targetLanguage,
    port: config.port,
    showSource: config.showSource,
    clickThrough: config.clickThrough,
    maxCloudMinutes: config.maxCloudMinutes,
    pairingToken: isValidPairingToken(config.authToken) ? "configured" : "missing",
    azureCredentials:
      isValidCloudCredential(config.azureSpeechKey) &&
      isValidCloudCredential(config.azureSpeechRegion)
        ? "configured"
        : "missing",
    geminiCredentials: isValidCloudCredential(config.geminiApiKey)
      ? "configured-in-environment"
      : "gui-or-missing",
    cloudConsent:
      config.cloudConsent === AZURE_CLOUD_CONSENT
        ? "azure-tab-audio-approved"
        : config.cloudConsent === GEMINI_CLOUD_CONSENT
          ? "gemini-selected-audio-approved"
          : "missing",
  };
}

function preflightConfig(config, options = {}) {
  const errors = [];
  const warnings = [];
  const nodeVersion = options.nodeVersion || process.versions.node;
  if (!isSupportedNodeVersion(nodeVersion)) {
    errors.push(`Node.js ${nodeVersion} không được hỗ trợ; cài Node.js 24 LTS.`);
  }
  if (!config.headless) {
    if (config.provider === "demo") {
      warnings.push("Provider demo chỉ tạo caption mô phỏng, không dịch audio thật.");
    }
    return { errors, warnings };
  }
  if (!isValidPairingToken(config.authToken)) {
    errors.push(
      "AUDIOTRANSLATE_TOKEN trong .env phải có 24–512 ký tự ASCII hợp lệ và không có khoảng trắng.",
    );
  }
  if (config.provider === "azure") {
    if (!isValidCloudCredential(config.azureSpeechKey)) {
      errors.push("AZURE_SPEECH_KEY trong .env bị trống hoặc chứa khoảng trắng/ký tự điều khiển.");
    }
    if (!isValidCloudCredential(config.azureSpeechRegion)) {
      errors.push("AZURE_SPEECH_REGION trong .env bị trống hoặc chứa khoảng trắng/ký tự điều khiển.");
    }
    if (config.cloudConsent !== AZURE_CLOUD_CONSENT) {
      errors.push("Chưa xác nhận gửi audio tab tới Azure trong AUDIOTRANSLATE_CLOUD_CONSENT.");
    }
    if (config.maxCloudMinutes > 0) {
      warnings.push(
        `Cloud sẽ tự dừng sau ${config.maxCloudMinutes} phút mỗi phiên; đây không phải billing cap.`,
      );
    }
  } else if (config.provider === "gemini") {
    if (!isValidCloudCredential(config.geminiApiKey)) {
      errors.push("GEMINI_API_KEY trong .env bị trống hoặc chứa khoảng trắng/ký tự điều khiển.");
    }
    if (config.cloudConsent !== GEMINI_CLOUD_CONSENT) {
      errors.push("Chưa xác nhận gửi audio tới Gemini trong AUDIOTRANSLATE_CLOUD_CONSENT.");
    }
  } else if (config.provider === "demo") {
    warnings.push("Provider demo chỉ tạo caption mô phỏng, không dịch audio thật.");
  }
  return { errors, warnings };
}

function writeLines(stream, lines, prefix = "") {
  for (const line of lines) stream.write(`${prefix}${line}\n`);
}

function defaultRunElectron(extraArgs = [], options = {}) {
  const projectRoot = options.projectRoot || PROJECT_ROOT;
  let electronPath;
  try {
    electronPath = require("electron");
  } catch {
    throw new Error("Electron chưa được cài. Chạy `npm install` trước.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [projectRoot, ...extraArgs], {
      cwd: projectRoot,
      env: options.env || process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) resolve(1);
      else resolve(code ?? 0);
    });
  });
}

async function main(argv = [], dependencies = {}) {
  const output = dependencies.output || process.stdout;
  const errorOutput = dependencies.errorOutput || process.stderr;
  const env = dependencies.env || process.env;
  const projectRoot = dependencies.projectRoot || PROJECT_ROOT;
  const envPath = dependencies.envPath || path.join(projectRoot, ".env");
  const loadEnvironment = dependencies.loadEnvFile || loadEnvFile;
  const getConfiguration = dependencies.getConfig || getConfig;
  const runElectron = dependencies.runElectron || defaultRunElectron;
  const runDoctor = dependencies.runDoctor;
  const runHeadless = dependencies.runHeadless;

  const args = [...argv];
  if (args[0] === "--help" || args[0] === "-h") {
    output.write(helpText());
    return 0;
  }
  if (args[0]?.startsWith("-")) {
    errorOutput.write(`[ERROR] Tùy chọn không hỗ trợ: ${args[0]}\n`);
    errorOutput.write("Chạy `audiotranslate --help` để xem cú pháp.\n");
    return 2;
  }

  let command = args[0] && !args[0].startsWith("-") ? args.shift() : null;
  if (!command) command = "open";

  if (command === "help") {
    output.write(args[0] === "setup" ? setupHelpText() : helpText());
    return 0;
  }

  if (["open", "setup"].includes(command) || (command === "config" && args[0] === "edit")) {
    const launcherArgs = command === "config" ? args.slice(1) : args;
    if (launcherArgs.length === 1 && ["--help", "-h"].includes(launcherArgs[0])) {
      output.write(setupHelpText());
      return 0;
    }
    if (!parseOptionsOrReject(launcherArgs, { errorOutput }, {})) return 2;
    return runElectron([], { projectRoot, env });
  }

  if (command === "providers") {
    const options = parseOptionsOrReject(args, { errorOutput }, {
      flagOptions: new Set(["json"]),
    });
    if (!options) return 2;
    output.write(renderProviderCatalog({ json: options.json === true }));
    return 0;
  }

  if (command === "guide") {
    if (!parseOptionsOrReject(args, { errorOutput }, {})) return 2;
    output.write(guideText(projectRoot));
    return 0;
  }

  if (command === "config") {
    const action = args[0] || "show";
    if (action === "path") {
      if (!parseOptionsOrReject(args.slice(1), { errorOutput }, {})) return 2;
      output.write(`${envPath}\n`);
      return 0;
    }
    if (action !== "show") {
      errorOutput.write(`Lệnh config không hợp lệ: ${action}\n`);
      return 2;
    }
    const options = parseOptionsOrReject(args.slice(1), { errorOutput }, {
      flagOptions: new Set(["json"]),
    });
    if (!options) return 2;
    let config;
    try {
      loadEnvironment(envPath);
      config = getConfiguration([], env);
    } catch (error) {
      errorOutput.write(`[ERROR] Không thể đọc cấu hình: ${error.message}\n`);
      errorOutput.write("Sửa nhanh: desktop dùng Control Center; headless kiểm tra file .env.\n");
      return 2;
    }
    const summary = configurationSummary(config, envPath);
    if (options.json === true) output.write(`${JSON.stringify(summary, null, 2)}\n`);
    else {
      output.write("Cấu hình fallback headless từ .env (secret đã được che)\n\n");
      for (const [key, value] of Object.entries(summary)) {
        output.write(`${key}: ${Array.isArray(value) ? value.join(",") : value}\n`);
      }
    }
    return 0;
  }

  if (command === "doctor") {
    const options = parseOptionsOrReject(args, { errorOutput }, {
      flagOptions: new Set(["headless", "json"]),
    });
    if (!options) return 2;
    let ok;
    try {
      ok = await (runDoctor || require("./doctor").run)(args, {
        parsedArgs: options,
        output,
      });
    } catch (error) {
      errorOutput.write(`[ERROR] Không thể chạy doctor: ${error.message}\n`);
      errorOutput.write("Sửa nhanh: desktop dùng Control Center; headless kiểm tra tham số và .env.\n");
      return 2;
    }
    return ok ? 0 : 1;
  }

  if (command === "preview") {
    if (!parseOptionsOrReject(args, { errorOutput }, {})) return 2;
    return runElectron(["--provider", "demo", "--preview"], {
      projectRoot,
      env,
    });
  }

  if (command !== "start") {
    errorOutput.write(`Lệnh không hợp lệ: ${command}\n`);
    errorOutput.write("Chạy `audiotranslate --help` để xem hướng dẫn.\n");
    return 2;
  }

  if (args.some((argument) => ["--help", "-h"].includes(argument))) {
    output.write(helpText());
    return 0;
  }
  const options = parseOptionsOrReject(args, { errorOutput }, {
    valueOptions: START_VALUE_OPTIONS,
    flagOptions: START_FLAG_OPTIONS,
  });
  if (!options) return 2;
  if (options.headless !== true) {
    const desktopOverrides = Object.keys(options).filter((name) => name !== "headless");
    if (desktopOverrides.length > 0) {
      errorOutput.write(
        `[ERROR] Tùy chọn --${desktopOverrides.join(", --")} chỉ dành cho start --headless.\n`,
      );
      errorOutput.write("Hãy cấu hình desktop trong Control Center.\n");
      return 2;
    }
    return runElectron([], { projectRoot, env });
  }
  let config;
  try {
    loadEnvironment(envPath);
    config = getConfiguration(args, env, options);
  } catch (error) {
    errorOutput.write(`[ERROR] Không thể đọc cấu hình: ${error.message}\n`);
    errorOutput.write("Sửa nhanh: kiểm tra tham số headless và file .env.\n");
    return 2;
  }
  const provider = getProvider(config.provider);
  if (!provider.runnable) {
    errorOutput.write(`Provider ${provider.label} chưa được kích hoạt trong bản này.\n`);
    return 2;
  }
  const preflight = preflightConfig(config);
  writeLines(errorOutput, preflight.warnings, "[WARN] ");
  if (preflight.errors.length > 0) {
    writeLines(errorOutput, preflight.errors, "[ERROR] ");
    errorOutput.write("Sửa nhanh: cập nhật .env cho headless, sau đó chạy `audiotranslate doctor`.\n");
    return 2;
  }

  if (config.headless) {
    await (runHeadless || require("./headless").run)(args);
    return 0;
  }
  return runElectron(args, { projectRoot, env });
}

module.exports = {
  configurationSummary,
  defaultRunElectron,
  guideText,
  helpText,
  main,
  preflightConfig,
  setupHelpText,
  validateOptions,
};
