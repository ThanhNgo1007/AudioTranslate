const test = require("node:test");
const assert = require("node:assert/strict");
const { TogetherCascadeTranslator } = require("../src/providers/together-cascade");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label = "condition", timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createHarness(overrides = {}) {
  const captions = [];
  const statuses = [];
  const errors = [];
  const terminals = [];
  const writes = [];
  let asrCallbacks;
  let asrStartCount = 0;
  let asrStopCount = 0;

  const asr = {
    async start() {
      asrStartCount += 1;
    },
    write(pcm, timing) {
      writes.push({ pcm, timing });
      return true;
    },
    async stop() {
      asrStopCount += 1;
    },
  };
  const provider = new TogetherCascadeTranslator({
    sourceLanguage: "en-US",
    targetLanguage: "vi",
    partialThrottleMs: 0,
    mt: {
      async translate({ text }) {
        return `vi:${text}`;
      },
    },
    createAsr(callbacks) {
      asrCallbacks = callbacks;
      return asr;
    },
    onCaption: (caption) => captions.push(caption),
    onStatus: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
    onTerminal: (error) => terminals.push(error),
    ...overrides,
  });

  return {
    provider,
    asr,
    captions,
    statuses,
    errors,
    terminals,
    writes,
    emitTranscript(result) {
      asrCallbacks.onTranscript(result);
    },
    get asrCallbacks() {
      return asrCallbacks;
    },
    get asrStartCount() {
      return asrStartCount;
    },
    get asrStopCount() {
      return asrStopCount;
    },
  };
}

test("cascade starts fixed-source ASR, forwards PCM, and emits actual MT deltas", async () => {
  const requests = [];
  const harness = createHarness({
    asrOptions: { apiKey: "do-not-serialize", model: "openai/whisper-large-v3" },
    mt: {
      async translate(request) {
        requests.push(request);
        request.onDelta("Xin ");
        request.onDelta("chào");
        return "Xin chào";
      },
    },
  });

  assert.doesNotMatch(JSON.stringify(harness.provider), /do-not-serialize/);
  await harness.provider.start();
  assert.equal(harness.asrStartCount, 1);
  assert.equal(harness.asrCallbacks.sourceLanguage, "en-US");
  assert.equal(harness.asrCallbacks.apiKey, "do-not-serialize");
  const pcm = Buffer.alloc(640, 1);
  const timing = { sequence: 7, capturedAt: 1234 };
  assert.equal(harness.provider.write(pcm, timing), true);
  assert.deepEqual(harness.writes, [{ pcm, timing }]);

  harness.emitTranscript({ text: "Hello", isFinal: false });
  await waitFor(() => harness.captions.at(-1)?.translation === "Xin chào", "translated caption");

  assert.equal(requests.length, 1);
  assert.deepEqual(
    {
      text: requests[0].text,
      sourceLanguage: requests[0].sourceLanguage,
      targetLanguage: requests[0].targetLanguage,
    },
    { text: "Hello", sourceLanguage: "en-US", targetLanguage: "vi" },
  );
  assert.ok(requests[0].signal instanceof AbortSignal);
  assert.equal(typeof requests[0].onDelta, "function");
  assert.deepEqual(harness.captions.at(-1), {
    type: "caption",
    sequence: harness.captions.length - 1,
    transcript: "Hello",
    translation: "Xin chào",
    sourceLanguage: "en-US",
    sourceLanguageMode: "fixed",
    targetLanguage: "vi",
    isFinal: false,
    emittedAt: harness.captions.at(-1).emittedAt,
    latencyMs: null,
    provider: "together-cascade",
  });
  assert.equal(harness.terminals.length, 0);
  await harness.provider.stop();
});

test("cascade rejects automatic source language before constructing ASR", async () => {
  let constructed = false;
  const provider = new TogetherCascadeTranslator({
    sourceLanguage: "auto",
    targetLanguage: "vi",
    mt: { async translate() {} },
    createAsr() {
      constructed = true;
      return {};
    },
  });

  await assert.rejects(provider.start(), /requires a fixed source language/);
  assert.equal(constructed, false);
  assert.equal(provider.write(Buffer.alloc(2)), false);
  await provider.stop();
});

test("mutable partials are coalesced, stale generations are dropped, and MT stays serial", async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const harness = createHarness({
    mt: {
      async translate(request) {
        const result = deferred();
        const call = { request, result };
        calls.push(call);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await result.promise;
        } finally {
          active -= 1;
        }
      },
    },
  });
  await harness.provider.start();

  harness.emitTranscript({ text: "one", isFinal: false });
  await waitFor(() => calls.length === 1, "first MT request");
  harness.emitTranscript({ text: "one two", isFinal: false });
  harness.emitTranscript({ text: "one two three", isFinal: false });
  calls[0].request.onDelta("stale");
  assert.equal(harness.captions.length, 0);
  assert.equal(calls.length, 1);

  calls[0].result.resolve("cũ");
  await waitFor(() => calls.length === 2, "coalesced MT request");
  assert.equal(calls[1].request.text, "one two three");
  assert.equal(maxActive, 1);
  calls[1].result.resolve("một hai ba");
  await waitFor(() => harness.captions.length === 1, "fresh translated partial");
  assert.equal(harness.captions[0].transcript, "one two three");
  assert.equal(harness.captions[0].translation, "một hai ba");
  assert.equal(harness.captions.some((caption) => caption.translation === "cũ"), false);

  await harness.provider.stop();
});

test("partial translation starts are throttled and the timer keeps only the latest hypothesis", async () => {
  let now = 1000;
  let scheduled;
  const calls = [];
  const harness = createHarness({
    partialThrottleMs: 100,
    now: () => now,
    setTimer(callback, delay) {
      scheduled = { callback, delay, unref() {} };
      return scheduled;
    },
    clearTimer(timer) {
      if (scheduled === timer) scheduled = null;
    },
    mt: {
      async translate({ text }) {
        calls.push(text);
        return `vi:${text}`;
      },
    },
  });
  await harness.provider.start();

  harness.emitTranscript({ text: "first", isFinal: false });
  await waitFor(() => calls.length === 1, "first partial translation");
  await waitFor(() => harness.provider.activeJob === null, "first partial completion");
  now = 1040;
  harness.emitTranscript({ text: "second", isFinal: false });
  harness.emitTranscript({ text: "third", isFinal: false });
  assert.deepEqual(calls, ["first"]);
  assert.equal(scheduled.delay, 60);

  now = 1100;
  const callback = scheduled.callback;
  scheduled = null;
  callback();
  await waitFor(() => calls.length === 2, "throttled partial translation");
  assert.deepEqual(calls, ["first", "third"]);
  await harness.provider.stop();
});

test("an unchanged partial is not translated again after its previous request settles", async () => {
  const calls = [];
  const harness = createHarness({
    mt: {
      async translate({ text }) {
        calls.push(text);
        return `vi:${text}`;
      },
    },
  });
  await harness.provider.start();

  harness.emitTranscript({ text: "same hypothesis", isFinal: false });
  await waitFor(() => harness.provider.activeJob === null && calls.length === 1, "first hypothesis");
  harness.emitTranscript({ text: "same hypothesis", isFinal: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["same hypothesis"]);

  harness.emitTranscript({ text: "same hypothesis", isFinal: true });
  await waitFor(() => calls.length === 2, "final reset");
  await waitFor(() => harness.provider.activeJob === null, "final translation completion");
  harness.emitTranscript({ text: "same hypothesis", isFinal: false });
  await waitFor(() => calls.length === 3, "new utterance hypothesis");
  await harness.provider.stop();
});

test("a final aborts an in-flight partial and is translated next without overlap", async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const harness = createHarness({
    mt: {
      async translate(request) {
        const result = deferred();
        const call = { request, result };
        calls.push(call);
        active += 1;
        maxActive = Math.max(maxActive, active);
        const onAbort = () => {
          const error = new Error("superseded");
          error.code = "TRANSLATION_ABORTED";
          result.reject(error);
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
        try {
          return await result.promise;
        } finally {
          request.signal.removeEventListener("abort", onAbort);
          active -= 1;
        }
      },
    },
  });
  await harness.provider.start();

  harness.emitTranscript({ text: "draft", isFinal: false });
  await waitFor(() => calls.length === 1, "partial MT request");
  harness.emitTranscript({ text: "final sentence", isFinal: true });
  assert.equal(calls[0].request.signal.aborted, true);
  await waitFor(() => calls.length === 2, "final MT request");
  assert.equal(calls[1].request.text, "final sentence");
  assert.equal(maxActive, 1);

  calls[1].request.onDelta("câu ");
  calls[1].request.onDelta("hoàn chỉnh");
  calls[1].result.resolve("câu hoàn chỉnh");
  await waitFor(() => harness.captions.at(-1)?.isFinal === true, "final caption");
  assert.equal(harness.captions.at(-1).transcript, "final sentence");
  assert.equal(harness.captions.at(-1).translation, "câu hoàn chỉnh");
  assert.equal(harness.errors.length, 0);
  assert.equal(harness.terminals.length, 0);

  await harness.provider.stop();
});

test("a synchronously superseded generation is skipped before making an MT request", async () => {
  const requests = [];
  const harness = createHarness({
    mt: {
      async translate(request) {
        requests.push(request);
        return `vi:${request.text}`;
      },
    },
  });
  await harness.provider.start();

  harness.emitTranscript({ text: "obsolete partial", isFinal: false });
  harness.emitTranscript({ text: "authoritative final", isFinal: true });
  await waitFor(() => harness.captions.at(-1)?.isFinal === true, "authoritative final caption");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].text, "authoritative final");
  assert.equal(harness.errors.length, 0);
  assert.equal(harness.captions.some((caption) => caption.transcript === "obsolete partial"), false);
  await harness.provider.stop();
});

test("the final-caption queue is bounded and overload becomes terminal", async () => {
  const first = deferred();
  const requests = [];
  const harness = createHarness({
    maxPendingFinals: 1,
    mt: {
      async translate(request) {
        requests.push(request);
        return first.promise;
      },
    },
  });
  await harness.provider.start();

  harness.emitTranscript({ text: "active final", isFinal: true });
  await waitFor(() => requests.length === 1, "active final translation");
  harness.emitTranscript({ text: "queued final", isFinal: true });
  harness.emitTranscript({ text: "overflow final", isFinal: true });
  await waitFor(() => harness.terminals.length === 1, "backlog terminal event");

  assert.equal(harness.terminals[0].code, "TRANSLATION_BACKLOG_LIMIT");
  assert.equal(harness.provider.state, "failed");
  assert.equal(harness.provider.write(Buffer.alloc(2)), false);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests.length, 1);
  first.resolve("late result");
  await waitFor(() => harness.provider.activeJob === null, "aborted active final cleanup");
  assert.equal(harness.captions.length, 0);
  await harness.provider.stop();
});

test("consecutive MT failures become terminal but an abort is not counted", async () => {
  let attempt = 0;
  const harness = createHarness({
    maxConsecutiveMtFailures: 2,
    mt: {
      async translate() {
        attempt += 1;
        const error = new Error(`failure-${attempt}`);
        error.code = "TRANSLATION_HTTP_ERROR";
        throw error;
      },
    },
  });
  await harness.provider.start();

  harness.emitTranscript({ text: "first", isFinal: true });
  await waitFor(() => harness.errors.length === 1, "first recoverable MT error");
  assert.equal(harness.terminals.length, 0);
  harness.emitTranscript({ text: "second", isFinal: true });
  await waitFor(() => harness.terminals.length === 1, "terminal MT error");

  assert.equal(harness.errors.length, 2);
  assert.equal(harness.terminals[0].code, "TRANSLATION_FAILURE_LIMIT");
  assert.match(harness.terminals[0].message, /2 consecutive times/);
  assert.equal(harness.provider.state, "failed");
  assert.equal(harness.provider.write(Buffer.alloc(2)), false);
  harness.emitTranscript({ text: "ignored", isFinal: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempt, 2);
  await harness.provider.stop();
});

test("non-string and empty MT responses count toward the protocol failure limit", async () => {
  const responses = [null, "   "];
  const harness = createHarness({
    maxConsecutiveMtFailures: 2,
    mt: {
      async translate() {
        return responses.shift();
      },
    },
  });
  await harness.provider.start();

  harness.emitTranscript({ text: "first", isFinal: true });
  await waitFor(() => harness.errors.length === 1, "non-string protocol error");
  assert.equal(harness.errors[0].code, "TRANSLATION_PROTOCOL_ERROR");
  harness.emitTranscript({ text: "second", isFinal: true });
  await waitFor(() => harness.terminals.length === 1, "protocol failure terminal event");

  assert.equal(harness.errors.length, 2);
  assert.equal(harness.errors[1].code, "TRANSLATION_PROTOCOL_ERROR");
  assert.equal(harness.terminals[0].code, "TRANSLATION_FAILURE_LIMIT");
  assert.equal(harness.captions.length, 0);
  await harness.provider.stop();
});

test("a successful stale MT call still breaks a consecutive failure streak", async () => {
  const calls = [];
  const harness = createHarness({
    maxConsecutiveMtFailures: 2,
    mt: {
      async translate(request) {
        const result = deferred();
        calls.push({ request, result });
        return result.promise;
      },
    },
  });
  await harness.provider.start();

  harness.emitTranscript({ text: "failure", isFinal: false });
  await waitFor(() => calls.length === 1, "first translation call");
  calls[0].result.reject(new Error("first failure"));
  await waitFor(() => harness.errors.length === 1, "first failure callback");

  harness.emitTranscript({ text: "will become stale", isFinal: false });
  await waitFor(() => calls.length === 2, "stale translation call");
  harness.emitTranscript({ text: "latest", isFinal: false });
  calls[1].result.resolve("successful stale output");
  await waitFor(() => calls.length === 3, "latest translation call");
  calls[2].result.reject(new Error("failure after success"));
  await waitFor(() => harness.errors.length === 2, "second non-consecutive failure callback");

  assert.equal(harness.terminals.length, 0);
  await harness.provider.stop();
});

test("stop is idempotent, aborts MT, and prevents late captions", async () => {
  const translation = deferred();
  let request;
  const harness = createHarness({
    mt: {
      async translate(value) {
        request = value;
        const onAbort = () => {
          const error = new Error("stopped");
          error.code = "TRANSLATION_ABORTED";
          translation.reject(error);
        };
        value.signal.addEventListener("abort", onAbort, { once: true });
        try {
          return await translation.promise;
        } finally {
          value.signal.removeEventListener("abort", onAbort);
        }
      },
    },
  });
  await harness.provider.start();
  harness.emitTranscript({ text: "pending", isFinal: false });
  await waitFor(() => request, "pending MT request");

  await Promise.all([harness.provider.stop(), harness.provider.stop(), harness.provider.stop()]);
  assert.equal(harness.asrStopCount, 1);
  assert.equal(request.signal.aborted, true);
  request.onDelta("too late");
  translation.resolve("too late");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.captions.length, 0);
  assert.equal(harness.provider.write(Buffer.alloc(2)), false);
  await harness.provider.stop();
  assert.equal(harness.asrStopCount, 1);
});

test("stop waits for MT cancellation only up to its configured bound", async () => {
  const translation = deferred();
  let request;
  let stopTimer;
  const harness = createHarness({
    mtStopTimeoutMs: 25,
    setTimer(callback, delay) {
      stopTimer = { callback, delay, unref() {} };
      return stopTimer;
    },
    clearTimer(timer) {
      if (stopTimer === timer) stopTimer = null;
    },
    mt: {
      async translate(value) {
        request = value;
        return translation.promise;
      },
    },
  });
  await harness.provider.start();
  harness.emitTranscript({ text: "hung translation", isFinal: false });
  await waitFor(() => request, "hung MT request");

  let stopped = false;
  const stopPromise = harness.provider.stop().then(() => {
    stopped = true;
  });
  await waitFor(() => stopTimer, "bounded MT drain timer");
  assert.equal(stopTimer.delay, 25);
  assert.equal(request.signal.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  const expire = stopTimer.callback;
  expire();
  await stopPromise;
  assert.equal(stopped, true);
  assert.equal(harness.asrStopCount, 1);
  translation.resolve("late result");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.captions.length, 0);
});

test("stop during ASR startup owns cleanup once and waits for startup to settle", async () => {
  const startup = deferred();
  const cleanup = deferred();
  let stopCount = 0;
  const provider = new TogetherCascadeTranslator({
    sourceLanguage: "en-US",
    targetLanguage: "vi",
    mt: { async translate({ text }) { return text; } },
    createAsr() {
      return {
        start() {
          return startup.promise;
        },
        write() {
          return true;
        },
        stop() {
          stopCount += 1;
          startup.reject(new Error("startup canceled"));
          return cleanup.promise;
        },
      };
    },
  });

  const startOutcome = provider.start().then(
    () => null,
    (error) => error,
  );
  await waitFor(() => provider.state === "starting", "ASR startup");
  let stopSettled = false;
  const stopPromise = provider.stop().then(() => {
    stopSettled = true;
  });
  await waitFor(() => stopCount === 1, "ASR cleanup");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false);

  cleanup.resolve();
  await stopPromise;
  assert.match((await startOutcome).message, /startup canceled/);
  assert.equal(stopCount, 1);
  assert.equal(provider.state, "stopped");
  await provider.stop();
  assert.equal(stopCount, 1);
});
