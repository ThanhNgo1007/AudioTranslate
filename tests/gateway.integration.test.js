const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { WebSocket } = require("ws");
const { AUTH_SCHEME, RealtimeGateway } = require("../src/gateway");
const { encodeAudioFrame, PROTOCOL_VERSION } = require("../src/protocol");

function waitForMessage(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

test("gateway authenticates with mutual HMAC, accepts PCM, and emits demo captions", async (context) => {
  const authToken = "integration-pairing-secret-that-stays-local";
  const gateway = new RealtimeGateway({
    host: "127.0.0.1",
    port: 0,
    provider: "demo",
    sourceLanguage: "en-US",
    targetLanguage: "vi",
    showSource: true,
    allowDevClients: true,
    authToken,
  });
  context.after(async () => gateway.close());
  let address;
  try {
    address = await gateway.start();
  } catch (error) {
    if (error.code === "EPERM") {
      context.skip("sandbox does not permit loopback listeners");
      return;
    }
    throw error;
  }

  const socket = new WebSocket(`ws://${address.host}:${address.port}`);
  context.after(() => socket.terminate());
  const helloPromise = waitForMessage(socket, (message) => message.type === "hello");
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const hello = await helloPromise;
  assert.equal(hello.authRequired, true);
  assert.equal(hello.authentication.scheme, AUTH_SCHEME);
  const expectedServerProof = crypto
    .createHmac("sha256", authToken)
    .update(`ATR1|server|${hello.authentication.nonce}`)
    .digest("base64url");
  assert.equal(hello.authentication.serverProof, expectedServerProof);
  assert.doesNotMatch(JSON.stringify(hello), new RegExp(authToken));

  const clientNonce = crypto.randomBytes(24).toString("base64url");
  const authentication = {
    scheme: AUTH_SCHEME,
    clientNonce,
    clientProof: crypto
      .createHmac("sha256", authToken)
      .update(`ATR1|client|${hello.authentication.nonce}|${clientNonce}`)
      .digest("base64url"),
  };

  const startedPromise = waitForMessage(socket, (message) => message.type === "started");
  const startMessage = {
    type: "start",
    protocolVersion: PROTOCOL_VERSION,
    authentication,
  };
  assert.doesNotMatch(JSON.stringify(startMessage), new RegExp(authToken));
  socket.send(JSON.stringify(startMessage));
  await startedPromise;

  const partialPromise = waitForMessage(
    socket,
    (message) => message.type === "caption" && message.isFinal === false,
  );
  for (let index = 0; index < 25; index += 1) {
    socket.send(encodeAudioFrame(Buffer.alloc(640), { sequence: index }));
  }
  const partial = await partialPromise;
  assert.equal(partial.targetLanguage, "vi");
  assert.ok(partial.translation.length > 0);

  const finalPromise = waitForMessage(
    socket,
    (message) => message.type === "caption" && message.isFinal === true,
  );
  for (let index = 25; index < 50; index += 1) {
    socket.send(encodeAudioFrame(Buffer.alloc(640), { sequence: index }));
  }
  const final = await finalPromise;
  assert.equal(final.isFinal, true);
  assert.equal(final.showSource, true);
});
