const test = require("node:test");
const assert = require("node:assert/strict");
const { ProviderRegistry } = require("../src/provider-registry");
const {
  OPENAI_COMPATIBLE_TEXT_PROTOCOL,
  createOpenAiCompatibleTextDefinition,
} = require("../src/openai-compatible-translation");

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function createTranslator(fetchImpl, options = {}) {
  const definition = createOpenAiCompatibleTextDefinition({ id: "vendor-text" });
  const registry = new ProviderRegistry([definition]);
  const profile = registry.createProfile("vendor-text", {
    protocol: OPENAI_COMPATIBLE_TEXT_PROTOCOL,
    baseUrl: "https://api.example.com/v1",
    apiKey: "test-secret",
    model: "translate-fast",
  });
  return registry.create("vendor-text", profile, {
    fetchImpl,
    lookup: publicLookup,
    ...options,
  });
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

test("builds a fixed chat-completions request and accepts JSON fallback", async () => {
  let request;
  const translator = createTranslator(async (url, options) => {
    request = { url, options };
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Xin chào" } }] }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  const deltas = [];

  const result = await translator.translate({
    text: "Hello",
    sourceLanguage: "en",
    targetLanguage: "vi",
    onDelta: (delta) => deltas.push(delta),
  });

  assert.equal(result, "Xin chào");
  assert.deepEqual(deltas, ["Xin chào"]);
  assert.equal(request.url, "https://api.example.com/v1/chat/completions");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers.Authorization, "Bearer test-secret");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.model, "translate-fast");
  assert.equal(payload.stream, true);
  assert.deepEqual(JSON.parse(payload.messages[1].content), {
    sourceLanguage: "en",
    targetLanguage: "vi",
    text: "Hello",
  });
  assert.match(payload.messages[0].content, /untrusted data/);
});

test("appends fragmented OpenAI chat SSE deltas", async () => {
  const translator = createTranslator(async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"Xin"}}]}\n',
      "\n",
      'data: {"choices":[{"delta":{"content":[{"type":"text","text":" chào"}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );
  const deltas = [];

  const result = await translator.translate({
    text: "Hello",
    sourceLanguage: "en",
    targetLanguage: "vi",
    onDelta: async (delta) => deltas.push(delta),
  });

  assert.equal(result, "Xin chào");
  assert.deepEqual(deltas, ["Xin", " chào"]);
});

test("rejects private DNS resolution before fetch", async () => {
  let fetchCalls = 0;
  const translator = createTranslator(
    async () => {
      fetchCalls += 1;
      return new Response("{}");
    },
    { lookup: async () => [{ address: "127.0.0.1", family: 4 }] },
  );

  await assert.rejects(
    () =>
      translator.translate({
        text: "Hello",
        sourceLanguage: "en",
        targetLanguage: "vi",
      }),
    (error) => error.code === "TRANSLATION_ENDPOINT_REJECTED",
  );
  assert.equal(fetchCalls, 0);
});

test("enforces response size and does not expose the API key in errors", async () => {
  const translator = createTranslator(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "x".repeat(100) } }] }), {
        headers: { "Content-Type": "application/json" },
      }),
    { maxResponseBytes: 32 },
  );

  await assert.rejects(
    () =>
      translator.translate({
        text: "Hello",
        sourceLanguage: "en",
        targetLanguage: "vi",
      }),
    (error) => {
      assert.equal(error.code, "TRANSLATION_RESPONSE_TOO_LARGE");
      assert.doesNotMatch(error.message, /test-secret/);
      return true;
    },
  );
});

test("maps caller cancellation and timeout to stable error codes", async (t) => {
  await t.test("caller cancellation", async () => {
    const translator = createTranslator(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = translator.translate({
      text: "Hello",
      sourceLanguage: "en",
      targetLanguage: "vi",
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, (error) => error.code === "TRANSLATION_ABORTED");
  });

  await t.test("timeout", async () => {
    const translator = createTranslator(() => new Promise(() => {}), { timeoutMs: 20 });
    await assert.rejects(
      () =>
        translator.translate({
          text: "Hello",
          sourceLanguage: "en",
          targetLanguage: "vi",
        }),
      (error) => error.code === "TRANSLATION_TIMEOUT",
    );
  });
});
