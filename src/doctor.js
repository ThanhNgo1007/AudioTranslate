const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const {
  AZURE_CLOUD_CONSENT,
  GEMINI_CLOUD_CONSENT,
  getConfig,
  loadEnvFile,
  parseArgs,
  PROJECT_ROOT,
  toBoolean,
} = require("./config");
const { isValidCloudCredential, isValidPairingToken } = require("./headless-validation");
const { isSupportedNodeVersion } = require("./node-version");

function checkPort(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function dependencyInstalled(name) {
  try {
    require.resolve(name, { paths: [PROJECT_ROOT] });
    return true;
  } catch {
    return false;
  }
}

async function collectChecks(config, options = {}) {
  const nodeVersion = options.nodeVersion || process.versions.node;
  const hasDependency = options.dependencyInstalled || dependencyInstalled;
  const exists = options.existsSync || fs.existsSync;
  const portAvailable = options.checkPort || checkPort;
  const headless = config.headless === true;
  const azureHeadless = headless && config.provider === "azure";
  const geminiHeadless = headless && config.provider === "gemini";
  const cloudHeadless = azureHeadless || geminiHeadless;
  const checks = [
    {
      name: "Node.js >=22.12",
      ok: isSupportedNodeVersion(nodeVersion),
      required: true,
      detail: `detected ${nodeVersion}; Node 24 LTS is recommended`,
      remediation: "Install Node.js 24 LTS, then run `npm install` again.",
    },
    {
      name: "Electron dependency",
      ok: hasDependency("electron"),
      required: !headless,
      detail: headless
        ? "optional in --headless mode; required for the transparent overlay"
        : "production dependency required for Control Center and the transparent overlay",
      remediation: "Run `npm install` to restore the production Electron dependency.",
    },
    {
      name: "WebSocket dependency",
      ok: hasDependency("ws"),
      required: true,
      detail: "local audio gateway",
      remediation: "Run `npm install`.",
    },
    {
      name: "Azure Speech SDK",
      ok: hasDependency("microsoft-cognitiveservices-speech-sdk"),
      required: azureHeadless,
      detail: "required when headless uses the Azure provider",
      remediation: "Run `npm install`.",
    },
    {
      name: "Google Gen AI SDK",
      ok: hasDependency("@google/genai"),
      required: !headless || geminiHeadless,
      detail: !headless
        ? "production dependency required by Control Center for Gemini Live Translate"
        : geminiHeadless
          ? "required when headless uses Gemini Live Translate"
          : "optional unless headless selects the Gemini provider",
      remediation: "Run `npm install`.",
    },
    {
      name: "Chromium extension",
      ok: exists(path.join(PROJECT_ROOT, "extension", "manifest.json")),
      required: true,
      detail: path.join(PROJECT_ROOT, "extension"),
      remediation: "Restore the `extension` directory from the AudioTranslate package.",
    },
    {
      name: "Azure credentials",
      ok:
        !azureHeadless ||
        (isValidCloudCredential(config.azureSpeechKey) &&
          isValidCloudCredential(config.azureSpeechRegion)),
      required: azureHeadless,
      detail: azureHeadless
        ? "set nonblank AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in .env"
        : "not read from .env by desktop doctor; configure cloud in Control Center",
      remediation:
        "Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in .env, then rerun `audiotranslate doctor --headless`.",
    },
    {
      name: "Gemini credentials",
      ok: !geminiHeadless || isValidCloudCredential(config.geminiApiKey),
      required: geminiHeadless,
      detail: geminiHeadless
        ? "set a nonblank GEMINI_API_KEY in .env for headless mode"
        : "desktop doctor does not read cloud credentials; Control Center uses safeStorage",
      remediation:
        "Set GEMINI_API_KEY in .env, then rerun `audiotranslate doctor --headless`.",
    },
    {
      name: "Cloud consent",
      ok:
        !cloudHeadless
          ? true
          : config.provider === "azure"
          ? config.cloudConsent === AZURE_CLOUD_CONSENT
          : config.cloudConsent === GEMINI_CLOUD_CONSENT,
      required: cloudHeadless,
      detail:
        !cloudHeadless
          ? "desktop consent is managed in Control Center; .env is not read"
          : config.provider === "azure"
            ? "headless requires explicit Azure consent in AUDIOTRANSLATE_CLOUD_CONSENT"
            : "headless requires explicit Google consent in AUDIOTRANSLATE_CLOUD_CONSENT",
      remediation:
        config.provider === "gemini"
          ? `After reviewing the data flow, set AUDIOTRANSLATE_CLOUD_CONSENT=${GEMINI_CLOUD_CONSENT} in .env.`
          : `After reviewing the data flow, set AUDIOTRANSLATE_CLOUD_CONSENT=${AZURE_CLOUD_CONSENT} in .env.`,
    },
    ...(["azure", "gemini"].includes(config.provider)
      ? [
          {
            name: `${config.provider === "azure" ? "Azure" : "Gemini"} cloud usage`,
            ok: false,
            required: false,
            detail:
              config.provider === "azure"
                ? "audio leaves this device; F0 currently includes 5 audio hours/month and may block at quota, while S0 is billed"
                : "selected audio leaves this device; Gemini Free Tier/quota and paid billing depend on the API project",
          },
        ]
      : []),
    {
      name: "Pairing token",
      ok: !headless || isValidPairingToken(config.authToken),
      required: headless,
      detail: headless
        ? "set AUDIOTRANSLATE_TOKEN in .env using 24–512 allowed ASCII characters"
        : "generated and managed by the desktop app",
      remediation:
        "Set a random 24–512 character AUDIOTRANSLATE_TOKEN in .env, then copy the same token to the extension.",
    },
    {
      name: `Loopback port ${config.port}`,
      ok: await portAvailable(config.host, config.port),
      required: true,
      detail: `${config.host}:${config.port}`,
      remediation: `Stop the process using port ${config.port}; for headless, set --port or AUDIOTRANSLATE_PORT and update the extension endpoint.`,
    },
  ];

  return checks;
}

async function run(argv = [], options = {}) {
  const args = options.parsedArgs || parseArgs(argv);
  const headless = toBoolean(args.headless, false);
  const loadEnvironment = options.loadEnvFile || loadEnvFile;
  const getConfiguration = options.getConfig || getConfig;
  let config = options.config;
  if (!config && headless) {
    loadEnvironment();
    config = getConfiguration(argv, options.env || process.env, args);
  } else if (!config) {
    config = getConfiguration([], {}, { headless: false });
  }
  const output = options.output || process.stdout;
  const checks = await collectChecks(config, options);

  const ok = checks.every((check) => !check.required || check.ok);
  if (toBoolean(args.json, false)) {
    output.write(`${JSON.stringify({ ok, provider: config.provider, checks }, null, 2)}\n`);
  } else {
    for (const check of checks) {
      const icon = check.ok ? "✓" : check.required ? "✗" : "!";
      output.write(`${icon} ${check.name}: ${check.detail}\n`);
      if (!check.ok && check.required && check.remediation) {
        output.write(`  Sửa: ${check.remediation}\n`);
      }
    }
    output.write(ok ? "\nReady to run.\n" : "\nSetup is incomplete. See the failed checks above.\n");
  }
  return ok;
}

module.exports = { checkPort, collectChecks, dependencyInstalled, run };
