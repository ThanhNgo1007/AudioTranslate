const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { AZURE_CLOUD_CONSENT, GEMINI_CLOUD_CONSENT } = require("../src/config");
const {
  configurationSummary,
  main,
  preflightConfig,
  validateOptions,
} = require("../src/cli");

function stream(isTTY = false) {
  return {
    isTTY,
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
    sourceLanguage: "en-US",
    sourceLanguageCandidates: ["en-US", "ja-JP"],
    targetLanguage: "vi",
    port: 43765,
    showSource: true,
    clickThrough: true,
    maxCloudMinutes: 0,
    authToken: "x".repeat(24),
    azureSpeechKey: "",
    azureSpeechRegion: "",
    cloudConsent: "",
    ...overrides,
  };
}

test("no-argument CLI opens Control Center without reading desktop configuration", async () => {
  for (const isTTY of [true, false]) {
    const launches = [];
    const code = await main([], {
      input: stream(isTTY),
      output: stream(),
      errorOutput: stream(),
      env: { TEST_MODE: "desktop" },
      projectRoot: "/project",
      loadEnvFile() {
        throw new Error("desktop launcher must not load .env");
      },
      getConfig() {
        throw new Error("desktop launcher must not parse runtime config");
      },
      runElectron: async (args, options) => {
        launches.push({ args, options });
        return 0;
      },
    });

    assert.equal(code, 0);
    assert.deepEqual(launches, [
      {
        args: [],
        options: { projectRoot: "/project", env: { TEST_MODE: "desktop" } },
      },
    ]);
  }
});

test("an unknown root option exits with usage error instead of opening help or setup", async () => {
  const errorOutput = stream();
  let electronCalls = 0;
  const code = await main(["--bogus"], {
    input: stream(true),
    output: stream(),
    errorOutput,
    runElectron: async () => {
      electronCalls += 1;
      return 0;
    },
  });

  assert.equal(code, 2);
  assert.equal(electronCalls, 0);
  assert.match(errorOutput.value, /Tùy chọn không hỗ trợ: --bogus/);
});

test("desktop aliases all open the same Control Center launcher", async () => {
  for (const args of [[], ["open"], ["start"], ["setup"], ["config", "edit"]]) {
    const launches = [];
    const code = await main(args, {
      input: stream(false),
      output: stream(),
      errorOutput: stream(),
      loadEnvFile() {
        throw new Error("desktop launcher must not load .env");
      },
      getConfig() {
        throw new Error("desktop launcher must not parse runtime config");
      },
      runElectron: async (electronArgs) => {
        launches.push(electronArgs);
        return 0;
      },
    });

    assert.equal(code, 0, args.join(" "));
    assert.deepEqual(launches, [[]], args.join(" "));
  }
});

test("desktop launcher rejects language/provider flags owned by Control Center", async () => {
  for (const args of [
    ["open", "--target", "vi"],
    ["setup", "--provider", "azure"],
    ["config", "edit", "--source", "en-US"],
    ["start", "--target", "vi"],
  ]) {
    const errorOutput = stream();
    let electronCalls = 0;
    const code = await main(args, {
      output: stream(),
      errorOutput,
      runElectron: async () => {
        electronCalls += 1;
        return 0;
      },
    });

    assert.equal(code, 2, args.join(" "));
    assert.equal(electronCalls, 0, args.join(" "));
    assert.match(errorOutput.value, /Control Center|không hỗ trợ/i, args.join(" "));
  }
});

test("setup, guide and config path reject unexpected arguments", async () => {
  for (const args of [
    ["setup", "--provider", "azure"],
    ["guide", "--json"],
    ["config", "path", "--json"],
  ]) {
    const errorOutput = stream();
    let electronCalls = 0;
    const code = await main(args, {
      input: stream(true),
      output: stream(),
      errorOutput,
      runElectron: async () => {
        electronCalls += 1;
        return 0;
      },
    });

    assert.equal(code, 2, args.join(" "));
    assert.equal(electronCalls, 0, args.join(" "));
    assert.match(errorOutput.value, /không hỗ trợ|không hợp lệ/i, args.join(" "));
  }
});

test("headless start blocks runtime until Azure env credentials, token and consent exist", async () => {
  const errorOutput = stream();
  let electronCalls = 0;
  let headlessCalls = 0;
  const code = await main(["start", "--headless"], {
    input: stream(false),
    output: stream(),
    errorOutput,
    loadEnvFile() {},
    getConfig: () =>
      baseConfig({ provider: "azure", authToken: "", maxCloudMinutes: 30, headless: true }),
    runElectron: async () => {
      electronCalls += 1;
      return 0;
    },
    runHeadless: async () => {
      headlessCalls += 1;
    },
  });
  assert.equal(code, 2);
  assert.equal(electronCalls, 0);
  assert.equal(headlessCalls, 0);
  assert.match(errorOutput.value, /AZURE_SPEECH_KEY/);
  assert.match(errorOutput.value, /AUDIOTRANSLATE_TOKEN/);
  assert.match(errorOutput.value, /Chưa xác nhận/);
});

test("valid Azure headless config reaches terminal runtime and secrets stay out of summary", async () => {
  const secret = "never-print-this-key";
  const config = baseConfig({
    provider: "azure",
    headless: true,
    azureSpeechKey: secret,
    azureSpeechRegion: "southeastasia",
    cloudConsent: AZURE_CLOUD_CONSENT,
    maxCloudMinutes: 30,
  });
  let receivedArgs;
  const code = await main(["start", "--headless", "--target", "vi"], {
    input: stream(false),
    output: stream(),
    errorOutput: stream(),
    loadEnvFile() {},
    getConfig: () => config,
    runHeadless: async (args) => {
      receivedArgs = args;
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(receivedArgs, ["--headless", "--target", "vi"]);

  const summary = configurationSummary(config, "/project/.env");
  assert.equal(summary.azureCredentials, "configured");
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(secret));
});

test("headless CLI accepts and forwards an explicit Gemini translation mode", async () => {
  let receivedArgs;
  let receivedOptions;
  const args = ["start", "--headless", "--translation-mode", "accurate"];
  const code = await main(args, {
    output: stream(),
    errorOutput: stream(),
    loadEnvFile() {},
    getConfig: (_argv, _env, options) => {
      receivedOptions = options;
      return baseConfig({ provider: "demo", headless: true });
    },
    runHeadless: async (runtimeArgs) => {
      receivedArgs = runtimeArgs;
    },
  });

  assert.equal(code, 0);
  assert.equal(receivedOptions["translation-mode"], "accurate");
  assert.deepEqual(receivedArgs, ["--headless", "--translation-mode", "accurate"]);
});

test("config summary reports malformed or whitespace-only env credentials as missing", () => {
  const summary = configurationSummary(
    baseConfig({
      authToken: " ".repeat(24),
      azureSpeechKey: "   ",
      azureSpeechRegion: "southeastasia",
      geminiApiKey: "secret ",
    }),
    "/project/.env",
  );

  assert.equal(summary.pairingToken, "missing");
  assert.equal(summary.azureCredentials, "missing");
  assert.equal(summary.geminiCredentials, "gui-or-missing");
});

test("preflight labels demo as simulated and OpenAI-style subscriptions are not implied", () => {
  const demo = preflightConfig(baseConfig());
  assert.deepEqual(demo.errors, []);
  assert.match(demo.warnings[0], /mô phỏng/);
});

test("preflight enforces the Electron and Vite Node 22.12 runtime floor", () => {
  assert.match(
    preflightConfig(baseConfig(), { nodeVersion: "22.11.0" }).errors.join("\n"),
    /Node\.js 24 LTS/,
  );
  assert.doesNotMatch(
    preflightConfig(baseConfig(), { nodeVersion: "22.12.0" }).errors.join("\n"),
    /Node\.js/,
  );
});

test("desktop preflight does not require API keys, language or pairing env", () => {
  const desktop = preflightConfig(
    baseConfig({
      provider: "gemini",
      headless: false,
      authToken: "",
      geminiApiKey: "",
      cloudConsent: "",
    }),
  );

  assert.deepEqual(desktop.errors, []);
});

test("Gemini headless preflight requires explicit env key, token and cloud consent", () => {
  const headless = preflightConfig(
    baseConfig({
      provider: "gemini",
      headless: true,
      authToken: "",
      geminiApiKey: "",
      cloudConsent: "",
    }),
  );

  assert.equal(headless.errors.length, 3);
  assert.match(headless.errors.join("\n"), /AUDIOTRANSLATE_TOKEN/);
  assert.match(headless.errors.join("\n"), /GEMINI_API_KEY/);
  assert.match(headless.errors.join("\n"), /AUDIO.*CONSENT|xác nhận/i);
});

test("headless preflight accepts only 24-512 character ASCII pairing tokens", () => {
  const valid = preflightConfig(
    baseConfig({ provider: "demo", headless: true, authToken: "A._~+/=-".repeat(3) }),
  );
  assert.doesNotMatch(valid.errors.join("\n"), /AUDIOTRANSLATE_TOKEN/);

  for (const authToken of [
    "x".repeat(23),
    "x".repeat(513),
    ` ${"x".repeat(24)}`,
    `${"x".repeat(24)}\n`,
    `${"x".repeat(23)}!`,
  ]) {
    const result = preflightConfig(baseConfig({ provider: "demo", headless: true, authToken }));
    assert.match(result.errors.join("\n"), /AUDIOTRANSLATE_TOKEN/, JSON.stringify(authToken));
  }
});

test("headless preflight rejects blank or whitespace-padded cloud credentials", () => {
  for (const geminiApiKey of ["   ", "\t", "secret ", "\nsecret", "secret\u0080control"]) {
    const result = preflightConfig(
      baseConfig({
        provider: "gemini",
        headless: true,
        geminiApiKey,
        cloudConsent: GEMINI_CLOUD_CONSENT,
      }),
    );
    assert.match(result.errors.join("\n"), /GEMINI_API_KEY/, JSON.stringify(geminiApiKey));
  }

  const azure = preflightConfig(
    baseConfig({
      provider: "azure",
      headless: true,
      azureSpeechKey: "   ",
      azureSpeechRegion: " southeastasia",
      cloudConsent: AZURE_CLOUD_CONSENT,
    }),
  );
  assert.match(azure.errors.join("\n"), /AZURE_SPEECH_KEY/);
  assert.match(azure.errors.join("\n"), /AZURE_SPEECH_REGION/);
});

test("providers command exposes Gemini as runnable and planned providers as disabled", async () => {
  const output = stream();
  const code = await main(["providers"], {
    input: stream(false),
    output,
    errorOutput: stream(),
  });
  assert.equal(code, 0);
  assert.match(output.value, /gemini .+RUNNABLE/);
  assert.match(output.value, /openai .+DISABLED/);
  assert.match(output.value, /gói ChatGPT không bao gồm API usage/);
});

test("providers accepts the equals form for its JSON option", async () => {
  const output = stream();
  const code = await main(["providers", "--json=true"], {
    input: stream(false),
    output,
    errorOutput: stream(),
  });

  assert.equal(code, 0);
  assert.equal(Array.isArray(JSON.parse(output.value)), true);
});

test("preview rejects provider overrides before Electron can start", async () => {
  const errorOutput = stream();
  let electronCalls = 0;
  const code = await main(["preview", "--provider", "azure"], {
    input: stream(false),
    output: stream(),
    errorOutput,
    runElectron: async () => {
      electronCalls += 1;
      return 0;
    },
  });

  assert.equal(code, 2);
  assert.equal(electronCalls, 0);
  assert.match(errorOutput.value, /không hỗ trợ: --provider/);
});

test("preview rejects cloud, headless, and development-client overrides", async () => {
  for (const args of [
    ["preview", "--max-cloud-minutes", "30"],
    ["preview", "--headless"],
    ["preview", "--allow-dev-clients"],
  ]) {
    let electronCalls = 0;
    const code = await main(args, {
      input: stream(false),
      output: stream(),
      errorOutput: stream(),
      runElectron: async () => {
        electronCalls += 1;
        return 0;
      },
    });

    assert.equal(code, 2, args.join(" "));
    assert.equal(electronCalls, 0, args.join(" "));
  }
});

test("start treats --headless=true as the headless execution mode", async () => {
  let headlessCalls = 0;
  let electronCalls = 0;
  const code = await main(["start", "--headless=true"], {
    input: stream(false),
    output: stream(),
    errorOutput: stream(),
    loadEnvFile() {},
    getConfig: () => baseConfig({ headless: true }),
    runHeadless: async () => {
      headlessCalls += 1;
    },
    runElectron: async () => {
      electronCalls += 1;
      return 0;
    },
  });

  assert.equal(code, 0);
  assert.equal(headlessCalls, 1);
  assert.equal(electronCalls, 0);
});

test("start accepts both -h and --help without loading config or Electron", async () => {
  for (const helpFlag of ["-h", "--help"]) {
    const output = stream();
    let electronCalls = 0;
    const code = await main(["start", helpFlag], {
      output,
      errorOutput: stream(),
      loadEnvFile() {
        throw new Error("help must not load .env");
      },
      getConfig() {
        throw new Error("help must not parse config");
      },
      runElectron: async () => {
        electronCalls += 1;
        return 0;
      },
    });

    assert.equal(code, 0, helpFlag);
    assert.equal(electronCalls, 0, helpFlag);
    assert.match(output.value, /AudioTranslate CLI/, helpFlag);
  }
});

test("configuration failures are actionable usage errors instead of uncaught exceptions", async () => {
  const errorOutput = stream();
  const code = await main(["start", "--headless"], {
    input: stream(false),
    output: stream(),
    errorOutput,
    loadEnvFile() {},
    getConfig: () => {
      throw new Error("Invalid WebSocket port: 30minutes");
    },
  });

  assert.equal(code, 2);
  assert.match(errorOutput.value, /Không thể đọc cấu hình/);
  assert.match(errorOutput.value, /headless|\.env/i);
  assert.doesNotMatch(errorOutput.value, /\n {4}at /);
});

test("doctor reports configuration failures as actionable usage errors", async () => {
  const errorOutput = stream();
  const code = await main(["doctor"], {
    output: stream(),
    errorOutput,
    runDoctor: async () => {
      throw new Error("Invalid boolean value: maybe");
    },
  });

  assert.equal(code, 2);
  assert.match(errorOutput.value, /Không thể chạy doctor/);
  assert.match(errorOutput.value, /Control Center|\.env/i);
});

test("doctor rejects every runtime override even in headless mode", async () => {
  for (const args of [
    ["doctor", "--provider", "gemini"],
    ["doctor", "--provider", "gemini", "--headless"],
    ["doctor", "--json", "--target", "vi"],
    ["doctor", "--headless", "--provider", "gemini"],
    ["doctor", "--headless", "--port", "43766"],
    ["doctor", "--headless=false", "--source", "en-US"],
  ]) {
    const errorOutput = stream();
    let doctorCalls = 0;
    const code = await main(args, {
      output: stream(),
      errorOutput,
      runDoctor: async () => {
        doctorCalls += 1;
        return true;
      },
    });

    assert.equal(code, 2, args.join(" "));
    assert.equal(doctorCalls, 0, args.join(" "));
    assert.match(errorOutput.value, /không hỗ trợ|start --headless/i, args.join(" "));
  }
});

test("doctor accepts only JSON and headless mode flags in either order", async () => {
  for (const args of [
    ["doctor", "--json"],
    ["doctor", "--headless"],
    ["doctor", "--headless", "--json"],
    ["doctor", "--json", "--headless"],
  ]) {
    let receivedArgs;
    const code = await main(args, {
      output: stream(),
      errorOutput: stream(),
      runDoctor: async (doctorArgs) => {
        receivedArgs = doctorArgs;
        return true;
      },
    });

    assert.equal(code, 0, args.join(" "));
    assert.deepEqual(receivedArgs, args.slice(1), args.join(" "));
  }
});

test("doctor receives normalized false values for every supported boolean form", async () => {
  for (const args of [
    ["doctor", "--json=false"],
    ["doctor", "--json=0"],
    ["doctor", "--json", "false"],
  ]) {
    let receivedOptions;
    const code = await main(args, {
      output: stream(),
      errorOutput: stream(),
      runDoctor: async (_argv, options) => {
        receivedOptions = options;
        return true;
      },
    });

    assert.equal(code, 0, args.join(" "));
    assert.equal(receivedOptions?.parsedArgs?.json, false, args.join(" "));
  }
});

test("non-headless commands do not load the gateway runtime before dispatch", async () => {
  const originalLoad = Module._load;
  const forbiddenLoads = [];
  Module._load = function loadWithRuntimeGuard(request, parent, isMain) {
    if (
      parent?.filename.endsWith("/src/cli.js") &&
      ["./headless", "./gateway", "ws"].includes(request)
    ) {
      forbiddenLoads.push(request);
      throw new Error(`unexpected runtime import: ${request}`);
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    assert.equal(await main(["--help"], { output: stream(), errorOutput: stream() }), 0);
    assert.equal(
      await main(["setup"], {
        input: stream(false),
        output: stream(),
        errorOutput: stream(),
        runElectron: async () => 0,
      }),
      0,
    );
    assert.equal(await main(["providers"], { output: stream(), errorOutput: stream() }), 0);
    assert.equal(
      await main(["doctor"], {
        output: stream(),
        errorOutput: stream(),
        runDoctor: async () => true,
      }),
      0,
    );
  } finally {
    Module._load = originalLoad;
  }

  assert.deepEqual(forbiddenLoads, []);
});

test("invalid or incomplete CLI options fail with an actionable message", async () => {
  const unknownError = stream();
  const unknownCode = await main(["start", "--traget", "vi"], {
    input: stream(false),
    output: stream(),
    errorOutput: unknownError,
  });
  assert.equal(unknownCode, 2);
  assert.match(unknownError.value, /không hỗ trợ: --traget/);

  const missingError = stream();
  const missingCode = await main(["start", "--target"], {
    input: stream(false),
    output: stream(),
    errorOutput: missingError,
  });
  assert.equal(missingCode, 2);
  assert.match(missingError.value, /Thiếu giá trị cho --target/);

  assert.equal(
    validateOptions(["--headless=false"], {
      flagOptions: new Set(["headless"]),
    }),
    null,
  );

  const booleanError = stream();
  assert.equal(
    await main(["start", "--headless=maybe"], {
      input: stream(false),
      output: stream(),
      errorOutput: booleanError,
    }),
    2,
  );
  assert.match(booleanError.value, /chỉ nhận true hoặc false/);

  const integerError = stream();
  assert.equal(
    await main(["start", "--max-cloud-minutes=30minutes"], {
      input: stream(false),
      output: stream(),
      errorOutput: integerError,
    }),
    2,
  );
  assert.match(integerError.value, /phải là số nguyên/);
});
