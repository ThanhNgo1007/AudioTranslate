const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const security = require("../extension/realtime-security");

const projectRoot = path.join(__dirname, "..");

function validSettings(overrides = {}) {
  return {
    endpoint: "ws://127.0.0.1:43765",
    token: "safe-pairing-token-123456789",
    ...overrides,
  };
}

test("manifest pins one stable Chrome/Edge extension origin and loopback-only access", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "extension", "manifest.json"), "utf8"),
  );
  const publicKey = Buffer.from(manifest.key, "base64");
  const digest = crypto.createHash("sha256").update(publicKey).digest().subarray(0, 16);
  const alphabet = "abcdefghijklmnop";
  const extensionId = [...digest]
    .map((byte) => `${alphabet[byte >> 4]}${alphabet[byte & 15]}`)
    .join("");

  assert.equal(extensionId, "docfjemeacdakckkamiiopljhmgjgfgl");
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.match(manifest.content_security_policy.extension_pages, /ws:\/\/127\.0\.0\.1:\*/);
  assert.doesNotMatch(JSON.stringify(manifest), /localhost/);
});

test("capture settings accept only exact loopback and split the token into session storage", () => {
  const split = security.splitSettingsForStorage(validSettings());
  assert.equal(split.publicSettings.endpoint, "ws://127.0.0.1:43765");
  assert.equal(Object.hasOwn(split.publicSettings, "token"), false);
  assert.equal(
    split.sessionSecrets[security.TOKEN_STORAGE_KEY],
    "safe-pairing-token-123456789",
  );
  assert.throws(
    () => security.sanitizeCaptureSettings(validSettings({ endpoint: "ws://localhost:43765" })),
    /127\.0\.0\.1/,
  );
  assert.throws(
    () => security.sanitizeCaptureSettings({ ...validSettings(), apiKey: "must-not-enter" }),
    /trường không được hỗ trợ/,
  );
  assert.throws(
    () => security.sanitizeCaptureSettings(validSettings({ token: "" })),
    /Pairing token là bắt buộc/,
  );
});

test("extension capture settings contain only the loopback endpoint and pairing token", () => {
  const endpoint = "ws://127.0.0.1:43765";
  const token = "safe-pairing-token-123456789";
  const settings = security.sanitizeCaptureSettings({ endpoint, token });

  assert.deepEqual({ ...settings }, { endpoint, token });
  assert.throws(
    () => security.sanitizeCaptureSettings({ endpoint, token, sourceLanguage: "ja-JP" }),
    /trường không được hỗ trợ/,
  );
  assert.deepEqual(security.splitSettingsForStorage({ endpoint, token }), {
    publicSettings: { endpoint },
    sessionSecrets: { [security.TOKEN_STORAGE_KEY]: token },
  });
});

test("status sanitizer redacts known and labelled credentials", () => {
  const secret = "safe-pairing-token-123456789";
  const message = security.sanitizeStatusMessage(
    `failure ${secret}; api_key=another-secret; Authorization: Bearer abc123`,
    [secret],
  );
  assert.doesNotMatch(message, /safe-pairing|another-secret|abc123/);
  assert.match(message, /đã ẩn/);
});

test("extension verifies gateway HMAC proof before creating a one-time client proof", async () => {
  const token = "safe-pairing-token-123456789";
  const nonce = crypto.randomBytes(32).toString("base64url");
  const authentication = {
    scheme: security.AUTH_SCHEME,
    nonce,
    serverProof: crypto
      .createHmac("sha256", token)
      .update(`ATR1|server|${nonce}`)
      .digest("base64url"),
  };
  assert.equal(
    await security.verifyServerAuthentication(authentication, token, crypto.webcrypto.subtle),
    true,
  );
  const client = await security.createClientAuthentication(
    authentication,
    token,
    crypto.webcrypto,
  );
  assert.equal(client.scheme, security.AUTH_SCHEME);
  assert.doesNotMatch(JSON.stringify(client), new RegExp(token));
  const expected = crypto
    .createHmac("sha256", token)
    .update(`ATR1|client|${nonce}|${client.clientNonce}`)
    .digest("base64url");
  assert.equal(client.clientProof, expected);

  await assert.rejects(
    security.createClientAuthentication(
      { ...authentication, serverProof: "invalid" },
      token,
      crypto.webcrypto,
    ),
    /không chứng minh/,
  );
});

test("bounded preroll wipes stale and overflow frames within a one-second budget", () => {
  let now = 10_000;
  const queue = new security.BoundedPreroll({
    now: () => now,
    maxAgeMs: 1_000,
    maxBytes: 8,
  });
  const first = Uint8Array.from([1, 1, 1, 1]).buffer;
  const second = Uint8Array.from([2, 2, 2, 2]).buffer;
  const third = Uint8Array.from([3, 3, 3, 3]).buffer;
  queue.push(first);
  queue.push(second);
  queue.push(third);
  assert.equal(queue.length, 2);
  assert.deepEqual([...new Uint8Array(first)], [0, 0, 0, 0]);

  now += 1_001;
  queue.prune();
  assert.equal(queue.length, 0);
  assert.deepEqual([...new Uint8Array(second)], [0, 0, 0, 0]);
  assert.deepEqual([...new Uint8Array(third)], [0, 0, 0, 0]);
});

test("offscreen capture queues PCM until the gateway acknowledges started", () => {
  const helperSource = fs.readFileSync(
    path.join(projectRoot, "extension", "realtime-security.js"),
    "utf8",
  );
  const offscreenSource = fs.readFileSync(
    path.join(projectRoot, "extension", "offscreen.js"),
    "utf8",
  );
  const listeners = [];
  const context = vm.createContext({
    AbortController,
    ArrayBuffer,
    AudioContext: class {},
    AudioWorkletNode: class {},
    DataView,
    Date,
    JSON,
    Math,
    Promise,
    SharedArrayBuffer,
    String,
    URL,
    Uint8Array,
    WebSocket: { OPEN: 1 },
    chrome: {
      runtime: {
        id: "a".repeat(32),
        onMessage: { addListener: (listener) => listeners.push(listener) },
        sendMessage: async () => ({}),
      },
    },
    clearTimeout,
    console,
    navigator: { mediaDevices: {} },
    setTimeout,
  });
  vm.runInContext(helperSource, context);
  vm.runInContext(
    `${offscreenSource}\n;globalThis.__offscreenTest = {\n` +
      `sendOrQueuePcm, flushPreroll,\n` +
      `setReady(value) { gatewayReady = value; },\n` +
      `setSocket(value) { socket = value; }\n` +
      `};`,
    context,
  );
  const sent = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (frame) => sent.push(frame),
  };
  context.__offscreenTest.setSocket(socket);
  context.__offscreenTest.sendOrQueuePcm(new ArrayBuffer(640));
  assert.equal(sent.length, 0);

  context.__offscreenTest.setReady(true);
  context.__offscreenTest.flushPreroll(socket);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].byteLength, 656);
});

test("offscreen start handshake carries authentication but no language authority", () => {
  const helperSource = fs.readFileSync(
    path.join(projectRoot, "extension", "realtime-security.js"),
    "utf8",
  );
  const offscreenSource = fs.readFileSync(
    path.join(projectRoot, "extension", "offscreen.js"),
    "utf8",
  );
  const context = vm.createContext({
    AbortController,
    ArrayBuffer,
    AudioContext: class {},
    AudioWorkletNode: class {},
    DataView,
    Date,
    JSON,
    Math,
    Promise,
    SharedArrayBuffer,
    String,
    URL,
    Uint8Array,
    WebSocket: { OPEN: 1 },
    chrome: {
      runtime: {
        id: "a".repeat(32),
        onMessage: { addListener() {} },
        sendMessage: async () => ({}),
      },
    },
    clearTimeout,
    console,
    navigator: { mediaDevices: {} },
    setTimeout,
  });
  vm.runInContext(helperSource, context);
  vm.runInContext(
    `${offscreenSource}\n;globalThis.__startMessageTest = {\n` +
      `startMessage, setSettings(value) { activeSettings = value; }\n` +
      `};`,
    context,
  );
  const authentication = { scheme: "hmac-sha256-v1", clientNonce: "nonce", clientProof: "proof" };
  context.__startMessageTest.setSettings(validSettings());

  const message = JSON.parse(
    JSON.stringify(context.__startMessageTest.startMessage(authentication)),
  );

  assert.deepEqual(message, {
    type: "start",
    protocolVersion: 1,
    authentication,
  });
});

test("provider privacy labels distinguish Gemini cloud from local demo", () => {
  assert.match(security.privacyLabelForProvider("gemini", "tab"), /Google Gemini cloud/);
  assert.match(security.privacyLabelForProvider("demo", "tab"), /không gửi/i);
  assert.doesNotMatch(security.privacyLabelForProvider("gemini", "tab"), /không lưu/i);
});
