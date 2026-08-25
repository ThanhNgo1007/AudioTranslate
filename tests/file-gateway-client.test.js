const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  FileGatewayClient,
  INTERNAL_ORIGIN,
  MAX_SOCKET_BUFFER_BYTES,
} = require("../src/file-gateway-client");
const { decodeAudioFrame, PROTOCOL_VERSION } = require("../src/protocol");

const TOKEN = "pairing-token-that-never-crosses-the-wire";

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(endpoint, options) {
    super();
    this.endpoint = endpoint;
    this.options = options;
    this.readyState = FakeWebSocket.OPEN;
    this.bufferedAmount = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.emit("close"));
  }

  terminate() {
    this.close();
  }
}

function configuration(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 43765,
    authToken: TOKEN,
    sourceLanguage: "auto",
    sourceLanguageCandidates: [],
    targetLanguage: "vi",
    showSource: true,
    ...overrides,
  };
}

function hello(token = TOKEN, nonce = "n".repeat(32)) {
  return {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    authRequired: true,
    authentication: {
      scheme: "hmac-sha256-v1",
      nonce,
      serverProof: crypto
        .createHmac("sha256", token)
        .update(`ATR1|server|${nonce}`)
        .digest("base64url"),
    },
  };
}

async function connect(client) {
  const operation = client.start();
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit("message", Buffer.from(JSON.stringify(hello())), false);
  socket.emit("message", Buffer.from(JSON.stringify({ type: "started" })), false);
  await operation;
  return socket;
}

test.beforeEach(() => {
  FakeWebSocket.instances = [];
});

test("FileGatewayClient refuses non-loopback or unresolved endpoints", () => {
  assert.throws(
    () => new FileGatewayClient(configuration({ host: "localhost" }), { WebSocketImpl: FakeWebSocket }),
    /exact IPv4 loopback/,
  );
  assert.throws(
    () => new FileGatewayClient(configuration({ host: "192.0.2.10" }), { WebSocketImpl: FakeWebSocket }),
    /exact IPv4 loopback/,
  );
  assert.throws(
    () => new FileGatewayClient(configuration({ port: 0 }), { WebSocketImpl: FakeWebSocket }),
    /port is invalid/,
  );
});

test("FileGatewayClient mutually authenticates without transmitting its token", async () => {
  const client = new FileGatewayClient(
    configuration({ geminiApiKey: "must-not-enter-transport", unrelated: "discard-me" }),
    { WebSocketImpl: FakeWebSocket },
  );
  assert.equal(client.config.geminiApiKey, undefined);
  assert.equal(client.config.unrelated, undefined);
  assert.equal(client.config.authToken, undefined);
  assert.doesNotMatch(JSON.stringify(client), new RegExp(TOKEN));
  const socket = await connect(client);
  assert.equal(socket.endpoint, "ws://127.0.0.1:43765");
  assert.equal(socket.options.origin, INTERNAL_ORIGIN);
  const start = JSON.parse(String(socket.sent[0]));
  assert.equal(start.type, "start");
  assert.equal(start.sourceLanguage, "auto");
  assert.equal(start.authentication.scheme, "hmac-sha256-v1");
  assert.doesNotMatch(JSON.stringify(start), new RegExp(TOKEN));
  await client.stop();
});

test("FileGatewayClient rejects an unauthenticated gateway and never becomes ready", async () => {
  const client = new FileGatewayClient(configuration(), { WebSocketImpl: FakeWebSocket });
  const operation = client.start();
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit("message", Buffer.from(JSON.stringify(hello("wrong-token"))), false);
  await assert.rejects(operation, /authentication is not enabled/);
  assert.equal(client.ready, false);
  assert.equal(client.socket, null);
});

test("stopping during handshake prevents a late started message from reviving the route", async () => {
  const client = new FileGatewayClient(configuration(), { WebSocketImpl: FakeWebSocket });
  const operation = client.start();
  const socket = FakeWebSocket.instances.at(-1);
  const stopped = client.stop();
  socket.emit("message", Buffer.from(JSON.stringify({ type: "started" })), false);
  await stopped;
  await assert.rejects(operation, /closed before it was ready/);
  assert.equal(client.ready, false);
  assert.equal(client.socket, null);
});

test("FileGatewayClient bounds socket buffering and keeps fallback sequences monotonic", async () => {
  const client = new FileGatewayClient(configuration(), { WebSocketImpl: FakeWebSocket });
  const socket = await connect(client);
  assert.equal(client.write(Buffer.alloc(3_200), { sequence: 7, capturedAt: 100 }), true);
  assert.equal(client.write(Buffer.alloc(3_200), { capturedAt: 200 }), true);
  const frames = socket.sent.slice(1).map((value) => decodeAudioFrame(value));
  assert.deepEqual(frames.map((frame) => frame.sequence), [7, 8]);
  assert.deepEqual(frames.map((frame) => frame.capturedAt), [100, 200]);

  socket.bufferedAmount = MAX_SOCKET_BUFFER_BYTES - 3_200;
  assert.equal(client.write(Buffer.alloc(3_200), { sequence: 9 }), false);
  await client.stop();
});
