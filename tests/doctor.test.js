const test = require("node:test");
const assert = require("node:assert/strict");
const { AZURE_CLOUD_CONSENT, GEMINI_CLOUD_CONSENT } = require("../src/config");
const { collectChecks, run } = require("../src/doctor");

function stream() {
  return {
    value: "",
    write(chunk) {
      this.value += String(chunk);
      return true;
    },
  };
}

function baseConfig(overrides = {}) {
  return {
    provider: "demo",
    headless: true,
    host: "127.0.0.1",
    port: 43765,
    authToken: "x".repeat(24),
    azureSpeechKey: "",
    azureSpeechRegion: "",
    geminiApiKey: "",
    cloudConsent: "",
    ...overrides,
  };
}

const healthyDeps = {
  dependencyInstalled: () => true,
  existsSync: () => true,
  checkPort: async () => true,
};

test("Node below 22.12 is a required doctor failure", async () => {
  const checks = await collectChecks(baseConfig(), { ...healthyDeps, nodeVersion: "22.11.0" });
  const node = checks.find((check) => check.name === "Node.js >=22.12");
  assert.equal(node.ok, false);
  assert.equal(node.required, true);

  const supported = await collectChecks(baseConfig(), { ...healthyDeps, nodeVersion: "22.12.0" });
  assert.equal(supported.find((check) => check.name === "Node.js >=22.12").ok, true);
});

test("Gemini doctor requires environment key and consent only for headless", async () => {
  const desktop = await collectChecks(
    baseConfig({ provider: "gemini", headless: false }),
    { ...healthyDeps, nodeVersion: "24.1.0" },
  );
  assert.equal(desktop.find((check) => check.name === "Gemini credentials").required, false);
  assert.equal(desktop.find((check) => check.name === "Cloud consent").required, false);

  const headless = await collectChecks(
    baseConfig({
      provider: "gemini",
      headless: true,
      geminiApiKey: "secret",
      cloudConsent: GEMINI_CLOUD_CONSENT,
    }),
    { ...healthyDeps, nodeVersion: "24.1.0" },
  );
  assert.equal(headless.every((check) => !check.required || check.ok), true);
});

test("desktop doctor ignores .env and reports only local desktop prerequisites", async () => {
  const output = stream();
  const ok = await run(["--json"], {
    ...healthyDeps,
    env: {
      AUDIOTRANSLATE_PROVIDER: "azure",
      AUDIOTRANSLATE_TOKEN: "invalid env token",
      AZURE_SPEECH_KEY: "should-not-be-read",
      AZURE_SPEECH_REGION: "should-not-be-read",
    },
    loadEnvFile() {
      throw new Error("desktop doctor must not load .env");
    },
    output,
    nodeVersion: "24.1.0",
  });

  assert.equal(ok, true);
  const result = JSON.parse(output.value);
  assert.equal(result.provider, "demo");
  assert.equal(result.checks.find((check) => check.name === "Pairing token").required, false);
  assert.equal(result.checks.find((check) => check.name === "Cloud consent").required, false);
});

test("desktop checks do not require pairing token or headless cloud configuration", async () => {
  const checks = await collectChecks(
    baseConfig({
      provider: "azure",
      headless: false,
      authToken: "",
      azureSpeechKey: "",
      azureSpeechRegion: "",
      cloudConsent: "",
    }),
    { ...healthyDeps, nodeVersion: "24.1.0" },
  );

  assert.equal(checks.find((check) => check.name === "Pairing token").required, false);
  assert.equal(checks.find((check) => check.name === "Pairing token").ok, true);
  assert.equal(checks.find((check) => check.name === "Azure credentials").required, false);
  assert.equal(checks.find((check) => check.name === "Cloud consent").required, false);
  assert.equal(checks.every((check) => !check.required || check.ok), true);
});

test("desktop doctor requires Gemini SDK but keeps Azure SDK headless-only", async () => {
  const checks = await collectChecks(baseConfig({ provider: "demo", headless: false }), {
    ...healthyDeps,
    dependencyInstalled: (name) =>
      !["@google/genai", "microsoft-cognitiveservices-speech-sdk"].includes(name),
    nodeVersion: "24.1.0",
  });
  const gemini = checks.find((check) => check.name === "Google Gen AI SDK");
  const azure = checks.find((check) => check.name === "Azure Speech SDK");

  assert.equal(gemini.required, true);
  assert.equal(gemini.ok, false);
  assert.equal(azure.required, false);
  assert.equal(checks.every((check) => !check.required || check.ok), false);
});

test("Azure doctor requires credentials and versioned cloud consent", async () => {
  const missing = await collectChecks(baseConfig({ provider: "azure" }), {
    ...healthyDeps,
    nodeVersion: "24.1.0",
  });
  assert.equal(missing.find((check) => check.name === "Azure credentials").ok, false);
  assert.equal(missing.find((check) => check.name === "Cloud consent").ok, false);

  const ready = await collectChecks(
    baseConfig({
      provider: "azure",
      azureSpeechKey: "secret",
      azureSpeechRegion: "southeastasia",
      cloudConsent: AZURE_CLOUD_CONSENT,
    }),
    { ...healthyDeps, nodeVersion: "24.1.0" },
  );
  assert.equal(ready.every((check) => !check.required || check.ok), true);
});

test("headless doctor uses strict token and nonblank credential validation", async () => {
  const gemini = await collectChecks(
    baseConfig({
      provider: "gemini",
      authToken: "x".repeat(513),
      geminiApiKey: "   ",
      cloudConsent: GEMINI_CLOUD_CONSENT,
    }),
    { ...healthyDeps, nodeVersion: "24.1.0" },
  );
  assert.equal(gemini.find((check) => check.name === "Pairing token").ok, false);
  assert.equal(gemini.find((check) => check.name === "Gemini credentials").ok, false);

  const azure = await collectChecks(
    baseConfig({
      provider: "azure",
      azureSpeechKey: "secret ",
      azureSpeechRegion: "\tsoutheastasia",
      cloudConsent: AZURE_CLOUD_CONSENT,
    }),
    { ...healthyDeps, nodeVersion: "24.1.0" },
  );
  assert.equal(azure.find((check) => check.name === "Azure credentials").ok, false);
});

test("doctor remediation describes production Electron and headless .env without wizard setup", async () => {
  const checks = await collectChecks(
    baseConfig({ provider: "azure", authToken: "", azureSpeechKey: "", azureSpeechRegion: "" }),
    { ...healthyDeps, dependencyInstalled: () => false, nodeVersion: "24.1.0" },
  );
  const guidance = checks
    .flatMap((check) => [check.detail, check.remediation])
    .filter(Boolean)
    .join("\n");

  assert.doesNotMatch(guidance, /setup|development dependenc/i);
  assert.match(guidance, /AZURE_SPEECH_KEY.+\.env/i);
  assert.match(guidance, /AUDIOTRANSLATE_TOKEN.+\.env/i);
});

test("doctor renders human output when normalized --json is false", async () => {
  for (const argv of [["--json=false"], ["--json=0"], ["--json", "false"]]) {
    const output = stream();
    const ok = await run(argv, {
      ...healthyDeps,
      config: baseConfig(),
      parsedArgs: { json: false },
      output,
      nodeVersion: "24.1.0",
    });

    assert.equal(ok, true, argv.join(" "));
    assert.match(output.value, /^\u2713 Node\.js >=22\.12:/, argv.join(" "));
    assert.doesNotMatch(output.value, /^\s*\{/, argv.join(" "));
  }
});
