const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { TogetherRealtimeAsr } = require("../src/providers/together-realtime-asr");

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closeCalls = 0;
    this.terminateCalls = 0;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  serverMessage(event) {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }

  send(payload, callback) {
    this.sent.push(String(payload));
    callback?.();
  }

  close(code = 1000, reason = "") {
    this.closeCalls += 1;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", code, Buffer.from(reason));
    });
  }

  terminate() {
    this.terminateCalls += 1;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.emit("close", 1006, Buffer.alloc(0)));
  }
}

function makeClient(overrides = {}) {
  return new TogetherRealtimeAsr({
    apiKey: "together-test-secret",
    model: "openai/whisper-large-v3",
    sourceLanguage: "en-US",
    WebSocketImpl: FakeWebSocket,
    startupTimeoutMs: 100,
    closeTimeoutMs: 50,
    ...overrides,
  });
}

async function startReady(client, sessionId = "session-1") {
  const starting = client.start();
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  socket.serverMessage({
    type: "session.created",
    session: { id: sessionId },
  });
  await starting;
  return socket;
}

test.beforeEach(() => {
  FakeWebSocket.instances = [];
});

test("start waits for session.created and keeps the API key out of the URL and serialization", async () => {
  const statuses = [];
  const client = makeClient({ onStatus: (status) => statuses.push(status) });
  let started = false;
  const starting = client.start().then(() => {
    started = true;
  });
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await Promise.resolve();
  assert.equal(started, false);

  const endpoint = new URL(socket.url);
  assert.equal(endpoint.protocol, "wss:");
  assert.equal(endpoint.searchParams.get("intent"), "transcription");
  assert.equal(endpoint.searchParams.get("model"), "openai/whisper-large-v3");
  assert.equal(endpoint.searchParams.get("input_audio_format"), "pcm_s16le_16000");
  assert.equal(endpoint.searchParams.get("language"), "en-US");
  assert.doesNotMatch(socket.url, /together-test-secret/);
  assert.equal(socket.options.headers.Authorization, "Bearer together-test-secret");
  assert.equal(socket.options.headers["OpenAI-Beta"], "realtime=v1");
  assert.doesNotMatch(JSON.stringify(client), /together-test-secret/);

  socket.serverMessage({ type: "session.created", session: { id: "session-42" } });
  await starting;
  assert.equal(client.sessionId, "session-42");
  assert.ok(statuses.some((status) => status.message.includes("session ready")));
  await client.stop();
});

test("write base64-encodes PCM16 and transcript deltas replace rather than append", async () => {
  const transcripts = [];
  const client = makeClient({ onTranscript: (event) => transcripts.push(event) });
  assert.equal(client.write(Buffer.from([0, 0])), false);
  const socket = await startReady(client);

  const pcm = Buffer.from([0x01, 0x02, 0xfe, 0xff]);
  assert.equal(client.write(pcm, { capturedAt: 123 }), true);
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    type: "input_audio_buffer.append",
    audio: pcm.toString("base64"),
  });

  socket.serverMessage({
    type: "conversation.item.input_audio_transcription.delta",
    delta: "Good",
  });
  socket.serverMessage({
    type: "conversation.item.input_audio_transcription.delta",
    delta: "Good morning",
  });
  socket.serverMessage({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "Good morning!",
  });
  assert.deepEqual(
    transcripts.map(({ text, isFinal }) => ({ text, isFinal })),
    [
      { text: "Good", isFinal: false },
      { text: "Good morning", isFinal: false },
      { text: "Good morning!", isFinal: true },
    ],
  );
  assert.equal(transcripts[0].sourceLanguage, "en-US");
  assert.equal(transcripts[0].provider, "together");
  assert.equal(client.commit(), true);
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { type: "input_audio_buffer.commit" });
  await client.stop();
});

test("write validates PCM16 chunks and enforces bounded WebSocket buffering", async () => {
  const statuses = [];
  const client = makeClient({
    maxBufferedAmountBytes: 100,
    maxAudioChunkBytes: 8,
    onStatus: (status) => statuses.push(status),
  });
  const socket = await startReady(client);

  assert.throws(() => client.write(Buffer.from([0x01])), /even number of bytes/);
  assert.throws(() => client.write(Buffer.alloc(10)), /exceeds 8 byte limit/);
  socket.bufferedAmount = 90;
  assert.equal(client.write(Buffer.alloc(4)), false);
  assert.equal(socket.sent.length, 0);
  assert.equal(statuses.filter((status) => status.level === "warning").length, 1);

  socket.bufferedAmount = 0;
  assert.equal(client.write(Buffer.alloc(4)), true);
  assert.equal(socket.sent.length, 1);
  assert.ok(statuses.some((status) => status.message.includes("recovered")));
  await client.stop();
});

test("startup times out if session.created never arrives", async () => {
  const terminals = [];
  const client = makeClient({
    startupTimeoutMs: 10,
    onTerminal: (error) => terminals.push(error),
  });
  const starting = client.start();
  FakeWebSocket.instances[0].open();
  await assert.rejects(starting, /startup timed out after 10 ms/);
  assert.equal(terminals.length, 1);
  assert.match(terminals[0].message, /startup timed out/);
  assert.doesNotMatch(terminals[0].message, /together-test-secret/);
  await client.stop();
});

test("unexpected close is terminal once and all surfaced errors redact the API key", async () => {
  const errors = [];
  const terminals = [];
  const client = makeClient({
    onError: (error) => errors.push(error),
    onTerminal: (error) => terminals.push(error),
  });
  const socket = await startReady(client);
  socket.emit("error", new Error("authorization together-test-secret was rejected"));
  socket.readyState = FakeWebSocket.CLOSED;
  socket.emit("close", 4401, Buffer.from("bad token together-test-secret"));
  socket.emit("close", 4401, Buffer.from("duplicate close"));

  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0].message, /together-test-secret/);
  assert.match(errors[0].message, /\[REDACTED\]/);
  assert.equal(terminals.length, 1);
  assert.match(terminals[0].message, /closed unexpectedly \(code 4401\)/);
  assert.doesNotMatch(terminals[0].message, /together-test-secret/);
  await client.stop();
});

test("stop is concurrent-safe, idempotent, and never reports an intentional close as terminal", async () => {
  const terminals = [];
  const client = makeClient({ onTerminal: (error) => terminals.push(error) });
  const socket = await startReady(client);
  const firstStop = client.stop();
  const secondStop = client.stop();
  assert.equal(firstStop, secondStop);
  await Promise.all([firstStop, secondStop]);
  assert.equal(socket.closeCalls, 1);
  assert.equal(terminals.length, 0);
  assert.equal(client.write(Buffer.alloc(2)), false);
  await client.stop();
  assert.equal(socket.closeCalls, 1);
});

test("server utterance failures are non-terminal while malformed events fail the session", async () => {
  const errors = [];
  const terminals = [];
  const client = makeClient({
    onError: (error) => errors.push(error),
    onTerminal: (error) => terminals.push(error),
  });
  const socket = await startReady(client);
  socket.serverMessage({
    type: "conversation.item.input_audio_transcription.failed",
    error: { message: "utterance rejected" },
  });
  assert.equal(errors.length, 1);
  assert.equal(terminals.length, 0);

  socket.emit("message", Buffer.from("not-json"));
  assert.equal(terminals.length, 1);
  assert.match(terminals[0].message, /malformed JSON/);
  await client.stop();
});

test("constructor rejects auto language mode, insecure endpoints, and credential injection", () => {
  assert.throws(() => makeClient({ sourceLanguage: "auto" }), /auto language detection/);
  assert.throws(() => makeClient({ baseUrl: "ws://api.together.ai/v1/realtime" }), /must use wss/);
  assert.throws(
    () => makeClient({ baseUrl: "wss://api.together.ai/v1/realtime?api_key=secret" }),
    /must not contain credentials/,
  );
  assert.throws(() => makeClient({ apiKey: "secret\r\nInjected: yes" }), /Invalid Together API key/);
});
