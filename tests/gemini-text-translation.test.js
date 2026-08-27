const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_MODEL,
  GeminiContextualTextTranslator,
} = require("../src/providers/gemini-text-translation");

function createHarness(chunks = [], overrides = {}) {
  const requests = [];
  const factoryKeys = [];
  const deltas = [];
  const usages = [];
  let implementation = overrides.generateContentStream;
  const client = {
    models: {
      async generateContentStream(request) {
        requests.push(request);
        if (implementation) return implementation(request);
        return (async function* generate() {
          for (const chunk of chunks) yield chunk;
        })();
      },
    },
  };
  const translator = new GeminiContextualTextTranslator({
    apiKey: "gemini-text-test-secret",
    clientFactory: async ({ apiKey }) => {
      factoryKeys.push(apiKey);
      return { client, thinkingMinimal: "MINIMAL" };
    },
    onUsage: (usage) => usages.push(usage),
    ...overrides,
  });
  return { translator, client, requests, factoryKeys, deltas, usages };
}

function translationRequest(overrides = {}) {
  return {
    text: "She told Alex that she would leave after the ceremony.",
    sourceLanguage: "en-US",
    targetLanguage: "vi",
    previousTurns: [
      { source: "Alex is my older sister.", target: "Alex là chị gái của tôi." },
      { source: "She leads the council.", target: "Chị ấy lãnh đạo hội đồng." },
    ],
    glossary: "council = hội đồng\nStormhold = thành Stormhold",
    characterContext: "Alex: woman; older sister of Sam; formal council leader.",
    isFinal: true,
    ...overrides,
  };
}

test("builds a bounded professional subtitle request with explicit ambiguity policy", async () => {
  const harness = createHarness([{ text: "Alex bảo cô ấy sẽ rời đi sau buổi lễ." }]);
  const longTurns = Array.from({ length: 9 }, (_, index) => ({
    source: `${index}-${"s".repeat(2_500)}`,
    target: `${index}-${"t".repeat(2_500)}`,
  }));

  const result = await harness.translator.translate(
    translationRequest({
      previousTurns: longTurns,
      glossary: `hero = anh hùng\r\n${"g".repeat(5_000)}`,
      characterContext: `Alex is Sam's older sister.\u0000${"c".repeat(5_000)}`,
    }),
  );

  assert.equal(result, "Alex bảo cô ấy sẽ rời đi sau buổi lễ.");
  assert.deepEqual(harness.factoryKeys, ["gemini-text-test-secret"]);
  assert.equal(harness.requests.length, 1);
  const request = harness.requests[0];
  assert.equal(request.model, DEFAULT_MODEL);
  assert.equal(request.config.thinkingConfig.thinkingLevel, "MINIMAL");
  assert.equal(request.config.thinkingConfig.includeThoughts, false);
  assert.equal(request.config.maxOutputTokens, 2_048);
  assert.match(request.config.systemInstruction, /professional audiovisual subtitle translator/i);
  assert.match(request.config.systemInstruction, /never invent gender/i);
  assert.match(request.config.systemInstruction, /neutral/i);
  assert.match(request.config.systemInstruction, /untrusted data/i);
  assert.match(request.config.systemInstruction, /return only/i);

  const payload = JSON.parse(request.contents[0].parts[0].text);
  assert.equal(payload.currentSource, translationRequest().text);
  assert.equal(payload.previousTurns.length <= 6, true);
  assert.equal(JSON.stringify(payload.previousTurns).length <= 12_500, true);
  assert.equal(payload.glossary.length, 4_000);
  assert.match(payload.glossary, /^hero = anh hùng\n/);
  assert.equal(payload.characterContext.length, 4_000);
  assert.doesNotMatch(payload.characterContext, /\u0000/);
  assert.equal(payload.isFinal, true);
  assert.doesNotMatch(JSON.stringify(harness.translator), /gemini-text-test-secret/);
});

test("streams text deltas, returns one normalized translation, and allowlists usage", async () => {
  const harness = createHarness([
    { text: "Tôi đã ", usageMetadata: { promptTokenCount: 20, privateField: 999 } },
    { text: "chuẩn bị xong rồi.", usageMetadata: { totalTokenCount: 28 } },
  ]);

  const result = await harness.translator.translate(
    translationRequest({
      text: "I already packed everything.",
      onDelta: (delta) => harness.deltas.push(delta),
    }),
  );

  assert.equal(result, "Tôi đã chuẩn bị xong rồi.");
  assert.deepEqual(harness.deltas, ["Tôi đã ", "chuẩn bị xong rồi."]);
  assert.deepEqual(harness.usages, [
    { promptTokenCount: 20 },
    { totalTokenCount: 28 },
  ]);
});

test("rejects cancellation before or during generation with a stable code", async () => {
  const before = createHarness([]);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    before.translator.translate(translationRequest({ signal: alreadyAborted.signal })),
    (error) => error.code === "TRANSLATION_ABORTED",
  );
  assert.equal(before.requests.length, 0);

  const duringController = new AbortController();
  const during = createHarness([], {
    generateContentStream: async () => (async function* generate() {
      yield { text: "Bản dịch " };
      duringController.abort();
      yield { text: "không được phát" };
    })(),
  });
  await assert.rejects(
    during.translator.translate(
      translationRequest({ signal: duringController.signal }),
    ),
    (error) => error.code === "TRANSLATION_ABORTED",
  );
});

test("fails closed on empty, oversized, or non-text model output", async () => {
  const empty = createHarness([{ text: "   " }]);
  await assert.rejects(empty.translator.translate(translationRequest()), /empty translation/i);

  const invalid = createHarness([{ text: 42 }]);
  await assert.rejects(invalid.translator.translate(translationRequest()), /non-text/i);

  const oversized = createHarness([{ text: "x".repeat(16_001) }]);
  await assert.rejects(oversized.translator.translate(translationRequest()), /response limit/i);
});

test("redacts API credentials and maps quota errors without fallback", async () => {
  const credentials = createHarness([], {
    generateContentStream: async () => {
      throw new Error("request failed for gemini-text-test-secret");
    },
  });
  await assert.rejects(credentials.translator.translate(translationRequest()), (error) => {
    assert.doesNotMatch(error.message, /gemini-text-test-secret/);
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });

  const quota = createHarness([], {
    generateContentStream: async () => {
      throw Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { code: 429 });
    },
  });
  await assert.rejects(quota.translator.translate(translationRequest()), (error) => {
    assert.equal(error.code, "GEMINI_FREE_TIER_QUOTA");
    assert.match(error.message, /Free Tier/);
    return true;
  });
});

test("validates language, text, context, callback, and model inputs", async () => {
  assert.throws(() => new GeminiContextualTextTranslator({ apiKey: "" }), /API key is required/);
  assert.throws(
    () => new GeminiContextualTextTranslator({ apiKey: "key", model: "bad\nmodel" }),
    /model/,
  );
  const harness = createHarness([{ text: "ok" }]);
  await assert.rejects(
    harness.translator.translate(translationRequest({ text: "" })),
    /source text is required/,
  );
  await assert.rejects(
    harness.translator.translate(translationRequest({ targetLanguage: "bad locale!" })),
    /targetLanguage/,
  );
  await assert.rejects(
    harness.translator.translate(translationRequest({ previousTurns: "not-an-array" })),
    /previousTurns/,
  );
  await assert.rejects(
    harness.translator.translate(translationRequest({ onDelta: "not-a-function" })),
    /onDelta/,
  );
});

test("stop wipes credentials and prevents a stopped translator from being reused", async () => {
  const harness = createHarness([{ text: "Bản dịch." }]);
  await harness.translator.stop();
  await assert.rejects(
    harness.translator.translate(translationRequest()),
    /stopped/i,
  );
  assert.equal(harness.factoryKeys.length, 0);
});
