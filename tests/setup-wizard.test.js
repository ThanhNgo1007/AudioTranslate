const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { upsertEnvContents } = require("../src/env-file");
const {
  AZURE_CONSENT,
  NonInteractiveSetupError,
  ScriptedPrompter,
  TerminalPrompter,
  initialStateFromEnv,
  readEnvValue,
  runSetupWizard,
  validateCandidates,
} = require("../src/setup-wizard");

function catalog() {
  const providers = [
    { id: "demo", status: "runnable", runnable: true },
    { id: "azure", status: "runnable", runnable: true },
    { id: "gemini", status: "in-development", runnable: false },
    { id: "openai", status: "in-development", runnable: false },
    { id: "together", status: "in-development", runnable: false },
    { id: "local", status: "in-development", runnable: false },
  ];
  return {
    listProviders: () => providers,
    getProvider: (id) => providers.find((provider) => provider.id === id),
  };
}

function envTools() {
  const calls = [];
  return {
    calls,
    async withEnvFileLock(envPath, operation) {
      calls.push({ type: "lock", envPath });
      return operation();
    },
    upsertEnvContents(existing, updates, options = {}) {
      calls.push({ type: "upsert", existing, updates: { ...updates }, options });
      const values = new Map();
      for (const line of String(existing).split(/\r?\n/)) {
        const separator = line.indexOf("=");
        if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
      }
      for (const key of options.removeKeys || []) values.delete(key);
      for (const [key, value] of Object.entries(updates)) values.set(key, String(value));
      return `${[...values].map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
    },
    async writeEnvAtomic(envPath, contents) {
      calls.push({ type: "write", envPath, contents });
    },
  };
}

function fixedRandomBytes(size) {
  return Buffer.alloc(size, 7);
}

test("default path is demo, writes only after final confirmation and removes cloud consent", async () => {
  const prompter = new ScriptedPrompter(["", "", "", "", "", "y"]);
  const tools = envTools();
  const result = await runSetupWizard({
    prompter,
    catalog: catalog(),
    ...tools,
    existingContents:
      "AZURE_SPEECH_KEY=keep-existing\nAZURE_SPEECH_REGION=southeastasia\n" +
      `AUDIOTRANSLATE_CLOUD_CONSENT=${AZURE_CONSENT}\n`,
    envPath: "/tmp/audiotranslate-test.env",
    randomBytes: fixedRandomBytes,
  });

  assert.equal(result.status, "saved");
  assert.equal(result.cancelled, false);
  assert.equal(result.provider, "demo");
  assert.equal(tools.calls.filter((call) => call.type === "write").length, 1);
  const upsert = tools.calls.find((call) => call.type === "upsert");
  assert.equal(upsert.updates.AUDIOTRANSLATE_PROVIDER, "demo");
  assert.equal(upsert.updates.AUDIOTRANSLATE_SOURCE, "en-US");
  assert.equal(upsert.updates.AUDIOTRANSLATE_TARGET, "vi");
  assert.equal(upsert.updates.AUDIOTRANSLATE_SHOW_SOURCE, "true");
  assert.equal(upsert.updates.AUDIOTRANSLATE_MAX_CLOUD_MINUTES, "0");
  assert.match(upsert.updates.AUDIOTRANSLATE_TOKEN, /^[A-Za-z0-9_-]{24,}$/);
  assert.deepEqual(upsert.options.removeKeys, ["AUDIOTRANSLATE_CLOUD_CONSENT"]);
  const written = tools.calls.find((call) => call.type === "write").contents;
  assert.match(written, /AZURE_SPEECH_KEY=keep-existing/);
  assert.doesNotMatch(written, /AUDIOTRANSLATE_CLOUD_CONSENT/);
  assert.match(prompter.transcript, /Gemini Live Translate.*CHƯA KHẢ DỤNG/s);
  assert.match(prompter.transcript, /Bước 6\/6/);
  assert.doesNotMatch(prompter.transcript, new RegExp(fixedRandomBytes(24).toString("base64url")));
  assert.match(prompter.transcript, /Pairing token không được in/);
});

test("Azure path requires explicit consent, masks the key and saves a duration guardrail", async () => {
  const secret = "azure-super-secret-key";
  const prompter = new ScriptedPrompter([
    "2",
    "1",
    "1",
    "n",
    "southeastasia",
    secret,
    "không đồng ý",
    "CHO PHEP",
    "45",
    "n",
    "y",
  ]);
  const tools = envTools();
  const result = await runSetupWizard({
    prompter,
    catalog: catalog(),
    ...tools,
    existingContents: "",
    envPath: "/tmp/audiotranslate-test.env",
    randomBytes: fixedRandomBytes,
  });

  assert.equal(result.status, "saved");
  assert.equal(result.provider, "azure");
  assert.equal(result.maxCloudMinutes, 45);
  const upsert = tools.calls.find((call) => call.type === "upsert");
  assert.equal(upsert.updates.AZURE_SPEECH_KEY, secret);
  assert.equal(upsert.updates.AZURE_SPEECH_REGION, "southeastasia");
  assert.equal(upsert.updates.AUDIOTRANSLATE_CLOUD_CONSENT, AZURE_CONSENT);
  assert.equal(upsert.updates.AUDIOTRANSLATE_MAX_CLOUD_MINUTES, "45");
  assert.doesNotMatch(prompter.transcript, new RegExp(secret));
  assert.match(prompter.transcript, /••••••••/);
  assert.match(prompter.transcript, /không phải billing cap/);
  assert.match(prompter.transcript, /Cần nhập chính xác: CHO PHEP/);
  const secretQuestion = prompter.questions.find((question) =>
    question.prompt.includes("AZURE_SPEECH_KEY"),
  );
  assert.equal(secretQuestion.secret, true);
});

test("Azure auto source validates 2-4 unique candidate languages", async () => {
  const prompter = new ScriptedPrompter([
    "azure",
    "auto",
    "en-US",
    "en-US,en-GB",
    "en-us,ja-jp,ko-kr",
    "vi",
    "y",
    "southeastasia",
    "valid-azure-key",
    "CHO PHEP",
    "30",
    "n",
    "y",
  ]);
  const tools = envTools();
  const result = await runSetupWizard({
    prompter,
    catalog: catalog(),
    ...tools,
    existingContents: "",
    envPath: "/tmp/audiotranslate-test.env",
    randomBytes: fixedRandomBytes,
  });

  assert.equal(result.sourceLanguage, "auto");
  assert.deepEqual(result.sourceLanguageCandidates, ["en-US", "ja-JP", "ko-KR"]);
  assert.match(prompter.transcript, /Cần từ 2 đến 4 locale/);
  assert.match(prompter.transcript, /không chọn đồng thời en-US và en-GB/);
  const upsert = tools.calls.find((call) => call.type === "upsert");
  assert.equal(upsert.updates.AUDIOTRANSLATE_SOURCE_CANDIDATES, "en-US,ja-JP,ko-KR");
});

test("back works across steps and Esc backs out of masked key input", async () => {
  const prompter = new ScriptedPrompter([
    "azure",
    "en-US",
    "vi",
    "y",
    "southeastasia",
    "\u001b",
    "b",
    "b",
    "b",
    "demo",
    "en-US",
    "vi",
    "y",
    "n",
    "y",
  ]);
  const tools = envTools();
  const result = await runSetupWizard({
    prompter,
    catalog: catalog(),
    ...tools,
    existingContents: "",
    envPath: "/tmp/audiotranslate-test.env",
    randomBytes: fixedRandomBytes,
  });

  assert.equal(result.status, "saved");
  assert.equal(result.provider, "demo");
  assert.equal(tools.calls.filter((call) => call.type === "write").length, 1);
});

test("back after Azure consent can switch to demo without persisting the new cloud key", async () => {
  const newSecret = "must-not-be-persisted";
  const prompter = new ScriptedPrompter([
    "azure",
    "",
    "",
    "",
    "",
    newSecret,
    "CHO PHEP",
    "30",
    "b",
    "b",
    "b",
    "b",
    "b",
    "demo",
    "",
    "",
    "",
    "n",
    "y",
  ]);
  const tools = envTools();
  const result = await runSetupWizard({
    prompter,
    catalog: catalog(),
    ...tools,
    existingContents: "",
    envPath: "/tmp/audiotranslate-test.env",
    randomBytes: fixedRandomBytes,
  });

  assert.equal(result.provider, "demo");
  const upsert = tools.calls.find((call) => call.type === "upsert");
  const written = tools.calls.find((call) => call.type === "write").contents;
  assert.equal(upsert.updates.AZURE_SPEECH_KEY, undefined);
  assert.equal(upsert.updates.AUDIOTRANSLATE_CLOUD_CONSENT, undefined);
  assert.deepEqual(upsert.options.removeKeys, ["AUDIOTRANSLATE_CLOUD_CONSENT"]);
  assert.doesNotMatch(written, new RegExp(newSecret));
  assert.doesNotMatch(prompter.transcript, new RegExp(newSecret));
});

test("config edit hydrates Azure, language and display defaults from exported env values", async () => {
  const secret = "existing-azure-secret";
  const token = "existing-pairing-token-1234567890";
  const existingContents = [
    "  export AUDIOTRANSLATE_PROVIDER = azure # current profile",
    "AUDIOTRANSLATE_SOURCE=auto",
    "AUDIOTRANSLATE_SOURCE_CANDIDATES=en-US,ja-JP,ko-KR",
    "AUDIOTRANSLATE_TARGET=ja",
    "AUDIOTRANSLATE_SHOW_SOURCE=false",
    `export AZURE_SPEECH_KEY=\"${secret}\" # keep secret`,
    "AZURE_SPEECH_REGION=eastus",
    "AUDIOTRANSLATE_MAX_CLOUD_MINUTES=90",
    `export AUDIOTRANSLATE_TOKEN=${token} # keep pairing`,
    "",
  ].join("\n");
  const prompter = new ScriptedPrompter([
    "",
    "",
    "",
    "",
    "",
    "",
    "CHO PHEP",
    "",
    "n",
    "y",
  ]);
  const tools = envTools();
  const result = await runSetupWizard({
    prompter,
    catalog: catalog(),
    ...tools,
    existingContents,
    envPath: "/tmp/audiotranslate-test.env",
    randomBytes: fixedRandomBytes,
  });

  assert.equal(result.provider, "azure");
  assert.equal(result.sourceLanguage, "auto");
  assert.deepEqual(result.sourceLanguageCandidates, ["en-US", "ja-JP", "ko-KR"]);
  assert.equal(result.targetLanguage, "ja");
  assert.equal(result.showSource, false);
  assert.equal(result.maxCloudMinutes, 90);
  const upsert = tools.calls.find((call) => call.type === "upsert");
  assert.equal(upsert.updates.AZURE_SPEECH_KEY, secret);
  assert.equal(upsert.updates.AUDIOTRANSLATE_TOKEN, token);
  assert.doesNotMatch(prompter.transcript, new RegExp(secret));
  assert.doesNotMatch(prompter.transcript, new RegExp(token));
});

test("save rebases updates onto the latest env contents", async () => {
  const prompter = new ScriptedPrompter(["", "", "", "", "n", "y"]);
  const tools = envTools();
  await runSetupWizard({
    prompter,
    catalog: catalog(),
    ...tools,
    existingContents: "BASE=before\n",
    readLatestEnv: () => "BASE=after\nUNRELATED=preserve-me\n",
    envPath: "/tmp/audiotranslate-test.env",
    randomBytes: fixedRandomBytes,
  });

  const upsert = tools.calls.find((call) => call.type === "upsert");
  const written = tools.calls.find((call) => call.type === "write").contents;
  assert.equal(upsert.existing, "BASE=after\nUNRELATED=preserve-me\n");
  assert.match(written, /BASE=after/);
  assert.match(written, /UNRELATED=preserve-me/);
});

test("save holds one env lock across latest-read, merge and atomic write", async () => {
  const events = [];
  let lockHeld = false;
  const prompter = new ScriptedPrompter(["", "", "", "", "n", "y"]);
  await runSetupWizard({
    prompter,
    catalog: catalog(),
    withEnvFileLock: async (_envPath, operation) => {
      events.push("lock");
      lockHeld = true;
      try {
        return await operation();
      } finally {
        lockHeld = false;
        events.push("unlock");
      }
    },
    readLatestEnv: () => {
      assert.equal(lockHeld, true);
      events.push("read");
      return "UNRELATED=latest\n";
    },
    upsertEnvContents: (contents) => {
      assert.equal(lockHeld, true);
      events.push("merge");
      return contents;
    },
    writeEnvAtomic: async () => {
      assert.equal(lockHeld, true);
      events.push("write");
    },
    existingContents: "UNRELATED=initial\n",
    envPath: "/tmp/audiotranslate-test.env",
    randomBytes: fixedRandomBytes,
  });

  assert.deepEqual(events, ["lock", "read", "merge", "write", "unlock"]);
});

test("save does not overwrite an external edit made after its latest read", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-wizard-conflict-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  fs.writeFileSync(envPath, "BASE=initial\n");
  const prompter = new ScriptedPrompter(["", "", "", "", "n", "y"]);

  await assert.rejects(
    () =>
      runSetupWizard({
        prompter,
        catalog: catalog(),
        envPath,
        randomBytes: fixedRandomBytes,
        upsertEnvContents(contents, updates, options) {
          const nextContents = upsertEnvContents(contents, updates, options);
          fs.writeFileSync(envPath, "BASE=external\nUNRELATED=preserve\n");
          return nextContents;
        },
      }),
    (error) => error.code === "ENV_FILE_CONFLICT" && error.committed === false,
  );

  assert.equal(fs.readFileSync(envPath, "utf8"), "BASE=external\nUNRELATED=preserve\n");
  assert.doesNotMatch(prompter.transcript, /\[OK\] Đã lưu cấu hình/);
});

test("catalog fail-closed prevents a disabled Azure entry from collecting a key", async () => {
  const providers = [
    { id: "demo", status: "runnable", runnable: true },
    { id: "azure", status: "in-development", runnable: false },
  ];
  const prompter = new ScriptedPrompter(["azure", "q"]);
  const tools = envTools();
  const result = await runSetupWizard({
    prompter,
    catalog: {
      listProviders: () => providers,
      getProvider: (id) => providers.find((provider) => provider.id === id),
    },
    ...tools,
    existingContents: "",
    envPath: "/tmp/audiotranslate-test.env",
    randomBytes: fixedRandomBytes,
  });

  assert.equal(result.cancelled, true);
  assert.equal(tools.calls.length, 0);
  assert.match(prompter.transcript, /azure chưa được runtime hiện tại kích hoạt/);
  assert.equal(prompter.questions.some((question) => question.secret), false);
});

test("provider step explains free tiers and metered API costs before setup", async () => {
  const prompter = new ScriptedPrompter(["q"]);
  const result = await runSetupWizard({
    prompter,
    ...envTools(),
    existingContents: "",
    envPath: "/tmp/audiotranslate-test.env",
    randomBytes: fixedRandomBytes,
  });

  assert.equal(result.cancelled, true);
  assert.match(prompter.transcript, /Gemini Live Translate[\s\S]+Free Tier/);
  assert.match(prompter.transcript, /OpenAI Realtime Translate[\s\S]+0,034 USD\/phút/);
  assert.match(prompter.transcript, /Together ASR \+ text MT[\s\S]+prepaid/i);
});

test("quit or rejected final confirmation never writes a file", async () => {
  for (const answers of [["q"], ["", "", "", "", "n", "n"]]) {
    const prompter = new ScriptedPrompter(answers);
    const tools = envTools();
    const result = await runSetupWizard({
      prompter,
      catalog: catalog(),
      ...tools,
      existingContents: "",
      envPath: "/tmp/audiotranslate-test.env",
      randomBytes: fixedRandomBytes,
    });
    assert.equal(result.status, "cancelled");
    assert.equal(result.cancelled, true);
    assert.equal(tools.calls.length, 0);
  }
});

test("non-TTY mode fails with an actionable command", async () => {
  const prompter = new ScriptedPrompter([], { interactive: false });
  await assert.rejects(
    () =>
      runSetupWizard({
        prompter,
        catalog: catalog(),
        ...envTools(),
        existingContents: "",
      }),
    (error) =>
      error instanceof NonInteractiveSetupError &&
      /audiotranslate setup --help/.test(error.message),
  );
});

test("TerminalPrompter masked input does not echo and restores raw mode on Ctrl-C", async () => {
  class FakeInput extends EventEmitter {
    constructor() {
      super();
      this.isTTY = true;
      this.isRaw = false;
      this.paused = true;
    }
    setRawMode(value) {
      this.isRaw = value;
    }
    isPaused() {
      return this.paused;
    }
    resume() {
      this.paused = false;
    }
    pause() {
      this.paused = true;
    }
  }
  const input = new FakeInput();
  let output = "";
  const prompter = new TerminalPrompter({
    input,
    output: { isTTY: true, write: (value) => (output += value) },
    env: { NO_COLOR: "1", TERM: "dumb" },
  });
  const pending = prompter.ask("Secret: ", { secret: true });
  input.emit("data", "not-echoed\u0003");
  await assert.rejects(pending, /Thiết lập đã bị hủy/);
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
  assert.equal(output, "Secret: \n");
});

test("TerminalPrompter restores raw mode instead of hanging on Ctrl-D or EOF", async () => {
  class FakeInput extends EventEmitter {
    constructor() {
      super();
      this.isTTY = true;
      this.isRaw = false;
      this.paused = true;
    }
    setRawMode(value) {
      this.isRaw = value;
    }
    isPaused() {
      return this.paused;
    }
    resume() {
      this.paused = false;
    }
    pause() {
      this.paused = true;
    }
  }

  for (const interrupt of [
    (input) => input.emit("data", "partial-secret\u0004"),
    (input) => input.emit("end"),
    (input) => input.emit("close"),
  ]) {
    const input = new FakeInput();
    let output = "";
    const prompter = new TerminalPrompter({
      input,
      output: { isTTY: true, write: (value) => (output += value) },
      env: { NO_COLOR: "1", TERM: "dumb" },
    });
    const pending = prompter.ask("Secret: ", { secret: true });
    interrupt(input);
    await assert.rejects(pending, /Thiết lập đã bị hủy|Input đã kết thúc/);
    assert.equal(input.isRaw, false);
    assert.equal(input.paused, true);
    assert.equal(output, "Secret: \n");
  }
});

test("TerminalPrompter regular input rejects instead of hanging on EOF", async () => {
  const { PassThrough, Writable } = require("node:stream");
  const input = new PassThrough();
  input.isTTY = true;
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  output.isTTY = true;
  const prompter = new TerminalPrompter({
    input,
    output,
    env: { NO_COLOR: "1", TERM: "dumb" },
  });

  const pending = prompter.ask("Choice: ");
  input.end();
  const outcome = await Promise.race([
    pending.then(
      () => "resolved",
      (error) => `rejected:${error.code}:${error.message}`,
    ),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
  ]);

  assert.match(outcome, /^rejected:SETUP_CANCELLED:Input đã kết thúc$/);
});

test("candidate validator canonicalizes locales and rejects ambiguous lists", () => {
  assert.deepEqual(validateCandidates("en-us,ja-jp"), {
    candidates: ["en-US", "ja-JP"],
  });
  assert.match(validateCandidates("en-US").error, /2 đến 4/);
  assert.match(validateCandidates("en-US,en-GB").error, /Mỗi ngôn ngữ/);
});

test("env value reader matches runtime last-duplicate semantics", () => {
  const contents = [
    '  export SAMPLE_KEY = "value#inside" # outside comment',
    "SAMPLE_KEY=second-value",
    "AUDIOTRANSLATE_SHOW_SOURCE=off # disabled",
  ].join("\n");
  assert.equal(readEnvValue(contents, "SAMPLE_KEY"), "second-value");
  assert.equal(readEnvValue(contents, "AUDIOTRANSLATE_SHOW_SOURCE"), "off");
  assert.equal(initialStateFromEnv(contents).showSource, false);
});
