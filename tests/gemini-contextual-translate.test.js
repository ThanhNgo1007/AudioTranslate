const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GeminiContextualTranslator,
} = require("../src/providers/gemini-contextual-translate");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createClock(start = 1_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    async advance(milliseconds) {
      now += milliseconds;
      const ready = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((left, right) => left[1].at - right[1].at);
      for (const [id, timer] of ready) {
        timers.delete(id);
        timer.callback();
      }
      await flush();
    },
  };
}

function createHarness(options = {}) {
  const clock = options.clock || createClock();
  const requests = [];
  const captions = [];
  const statuses = [];
  const errors = [];
  const terminals = [];
  let transcriberOptions;
  let transcriberStopped = 0;
  let textTranslatorStopped = 0;

  const transcriber = {
    async start() {},
    write() { return true; },
    setPaused() { return true; },
    setAudioActivity() { return true; },
    async stop() { transcriberStopped += 1; },
  };
  const textTranslator = {
    async translate(request) {
      requests.push(request);
      if (options.translate) return options.translate(request, requests.length - 1);
      const result = `vi:${request.text}`;
      request.onDelta?.(result);
      return result;
    },
    async stop() { textTranslatorStopped += 1; },
  };

  const provider = new GeminiContextualTranslator({
    apiKey: "contextual-test-key",
    sourceLanguage: "auto",
    sourceLanguageCandidates: ["en-US", "ja-JP"],
    targetLanguage: "vi",
    mode: options.mode || "balanced",
    contextTurns: options.contextTurns ?? 4,
    partialThrottleMs: options.partialThrottleMs ?? 450,
    glossary: "Stormhold = thành Stormhold",
    characterContext: "Alex is Sam's older sister.",
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    createTranscriber: (input) => {
      transcriberOptions = input;
      return transcriber;
    },
    createTextTranslator: () => textTranslator,
    onCaption: (caption) => captions.push(caption),
    onStatus: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
    onTerminal: (error) => terminals.push(error),
  });

  return {
    provider,
    clock,
    requests,
    captions,
    statuses,
    errors,
    terminals,
    emitTranscript(value) { transcriberOptions.onTranscript(value); },
    get transcriberConfig() { return transcriberOptions; },
    get transcriberStopped() { return transcriberStopped; },
    get textTranslatorStopped() { return textTranslatorStopped; },
  };
}

test("derives bounded ASR vocabulary from glossary and known character names", async () => {
  const harness = createHarness();
  assert.deepEqual(harness.transcriberConfig.customVocabulary, [
    "Stormhold",
    "Alex",
    "Sam",
  ]);
});

test("balanced mode waits for readable growth and throttles mutable partial requests", async () => {
  const harness = createHarness();
  await harness.provider.start();

  harness.emitTranscript({ text: "Hello", isFinal: false, capturedAt: 900 });
  await flush();
  assert.equal(harness.requests.length, 0);

  harness.emitTranscript({ text: "Hello all", isFinal: false, capturedAt: 900 });
  await flush();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].isFinal, false);

  harness.emitTranscript({ text: "Hello all and", isFinal: false, capturedAt: 900 });
  harness.emitTranscript({
    text: "Hello all and welcome everyone",
    isFinal: false,
    capturedAt: 900,
  });
  await flush();
  assert.equal(harness.requests.length, 1);

  await harness.clock.advance(449);
  assert.equal(harness.requests.length, 1);
  await harness.clock.advance(1);
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[1].text, "Hello all and welcome everyone");
});

test("accurate mode translates final utterances only", async () => {
  const harness = createHarness({ mode: "accurate" });
  await harness.provider.start();
  harness.emitTranscript({ text: "A long enough interim sentence", isFinal: false });
  await flush();
  assert.equal(harness.requests.length, 0);

  harness.emitTranscript({
    text: "A long enough final sentence.",
    isFinal: true,
    sourceLanguage: "en-US",
    capturedAt: 950,
  });
  await flush();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].isFinal, true);
  assert.equal(harness.captions.length, 1);
  assert.equal(harness.captions[0].isFinal, true);
  assert.equal(harness.captions[0].provider, "gemini-contextual");
});

test("a newer ASR hypothesis aborts and suppresses stale partial MT", async () => {
  const first = deferred();
  const harness = createHarness({
    partialThrottleMs: 250,
    translate: async (request, index) => {
      if (index === 0) return first.promise;
      request.onDelta?.("Bản dịch mới hoàn chỉnh.");
      return "Bản dịch mới hoàn chỉnh.";
    },
  });
  await harness.provider.start();
  harness.emitTranscript({ text: "First hypothesis", isFinal: false });
  await flush();
  const firstSignal = harness.requests[0].signal;

  harness.emitTranscript({
    text: "First hypothesis now corrected",
    isFinal: false,
  });
  assert.equal(firstSignal.aborted, true);
  first.resolve("Bản dịch cũ không được hiện.");
  await flush();
  await harness.clock.advance(250);
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.captions.some((caption) => /cũ/.test(caption.translation)), false);
  assert.match(harness.captions.at(-1).translation, /mới/);
});

test("coalesces token-sized model deltas into readable phrases", async () => {
  const gate = deferred();
  const harness = createHarness({
    translate: async (request) => {
      request.onDelta("Xin");
      await gate.promise;
      request.onDelta(" chào bạn");
      request.onDelta(".");
      return "Xin chào bạn.";
    },
  });
  await harness.provider.start();
  harness.emitTranscript({ text: "Hello there", isFinal: false });
  await flush();
  assert.equal(harness.captions.length, 0);

  gate.resolve();
  await flush();
  assert.equal(harness.captions.length >= 1, true);
  assert.equal(harness.captions.at(-1).translation, "Xin chào bạn.");
  assert.equal(harness.captions.at(-1).isFinal, false);
});

test("final replaces its partial, stores bounded context, and sends context to the next turn", async () => {
  const partial = deferred();
  const harness = createHarness({
    translate: async (request, index) => {
      if (index === 0) return partial.promise;
      if (request.text.includes("ceremony")) return "Alex nói chị ấy sẽ rời đi sau buổi lễ.";
      return "Chị ấy lãnh đạo hội đồng.";
    },
  });
  await harness.provider.start();
  harness.emitTranscript({ text: "She told Alex", isFinal: false });
  await flush();
  const partialSignal = harness.requests[0].signal;
  harness.emitTranscript({
    text: "She told Alex she would leave after the ceremony.",
    isFinal: true,
    sourceLanguage: "en-US",
    capturedAt: 900,
  });
  assert.equal(partialSignal.aborted, true);
  partial.resolve("Bản nháp cũ");
  await flush();
  await flush();
  assert.equal(harness.captions.length, 1);
  assert.equal(harness.captions[0].isFinal, true);

  harness.emitTranscript({
    text: "She leads the council.",
    isFinal: true,
    sourceLanguage: "en-US",
  });
  await flush();
  const next = harness.requests.at(-1);
  assert.deepEqual(next.previousTurns, [{
    source: "She told Alex she would leave after the ceremony.",
    target: "Alex nói chị ấy sẽ rời đi sau buổi lễ.",
  }]);
  assert.equal(next.glossary, "Stormhold = thành Stormhold");
  assert.equal(next.characterContext, "Alex is Sam's older sister.");
});

test("pause cancels mutable work while stop wipes RAM-only history", async () => {
  const active = deferred();
  const harness = createHarness({
    translate: async (request, index) => {
      if (index === 0) return "Câu hoàn chỉnh.";
      return active.promise;
    },
  });
  await harness.provider.start();
  harness.emitTranscript({ text: "Completed sentence.", isFinal: true });
  await flush();
  assert.equal(harness.provider.history.length, 1);

  harness.emitTranscript({ text: "Another interim sentence", isFinal: false });
  await flush();
  const signal = harness.requests.at(-1).signal;
  harness.provider.setPaused(true);
  assert.equal(signal.aborted, true);
  assert.equal(harness.provider.history.length, 1);

  await harness.provider.stop();
  assert.equal(harness.provider.history.length, 0);
  assert.equal(harness.transcriberStopped, 1);
  assert.equal(harness.textTranslatorStopped, 1);
});

test("translation failures terminate once without silently falling back", async () => {
  const quota = Object.assign(new Error("Free Tier quota reached"), {
    code: "GEMINI_FREE_TIER_QUOTA",
  });
  const harness = createHarness({ translate: async () => { throw quota; } });
  await harness.provider.start();
  harness.emitTranscript({ text: "This must fail safely.", isFinal: true });
  await flush();
  assert.equal(harness.terminals.length, 1);
  assert.equal(harness.terminals[0].code, "GEMINI_FREE_TIER_QUOTA");
  assert.equal(harness.provider.state, "failed");
  assert.equal(harness.captions.length, 0);
});
