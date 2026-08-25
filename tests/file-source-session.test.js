const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  FILE_SOURCE_CHANNELS,
  FileSourceSessionManager,
  GEMINI_FILE_CONSENT,
  createExactSenderAuthorizer,
  registerFileSourceIpc,
  validateStartRequest,
} = require("../src/audio/file-source-session");

function startRequest(overrides = {}) {
  return {
    displayName: "movie.mkv",
    fileBytes: 4_000_000,
    mimeType: "video/x-matroska",
    sampleRate: 16_000,
    channels: 1,
    encoding: "pcm_s16le",
    destination: "google-gemini",
    consentVersion: GEMINI_FILE_CONSENT,
    ...overrides,
  };
}

function testLimits(overrides = {}) {
  return {
    maxFileBytes: 10_000_000,
    maxChunkBytes: 640,
    maxQueueBytes: 1_280,
    maxQueueAgeMs: 1_000,
    maxChunksPerSecond: 80,
    maxBytesPerSecond: 96_000,
    maxSessionPcmBytes: 100_000,
    ...overrides,
  };
}

function makeManager(options = {}) {
  return new FileSourceSessionManager({
    writePcm: options.writePcm || (() => {}),
    authorizeDestination: options.authorizeDestination || (() => true),
    onStatus: options.onStatus,
    now: options.now,
    randomBytes: options.randomBytes || (() => Buffer.alloc(24, 7)),
    schedule: options.schedule,
    limits: testLimits(options.limits),
  });
}

test("file metadata requires explicit Gemini consent and rejects paths or credentials", () => {
  assert.equal(validateStartRequest(startRequest()).destination, "google-gemini");
  assert.throws(
    () => validateStartRequest(startRequest({ consentVersion: "" })),
    (error) => error.code === "CLOUD_CONSENT_REQUIRED",
  );
  const pathValue = "/Users/alice/private/movie.mkv";
  assert.throws(
    () => validateStartRequest(startRequest({ displayName: pathValue })),
    (error) => error.code === "INVALID_FILE_NAME" && !error.message.includes(pathValue),
  );
  assert.throws(
    () => validateStartRequest({ ...startRequest(), apiKey: "do-not-cross-ipc" }),
    (error) => error.code === "INVALID_START" && !error.message.includes("do-not-cross-ipc"),
  );
  assert.throws(
    () => validateStartRequest({ ...startRequest(), path: "/tmp/audio.wav" }),
    (error) => error.code === "INVALID_START" && !error.message.includes("/tmp"),
  );
});

test("Gemini starts only through an authenticated main-process destination route", () => {
  const denied = makeManager({ authorizeDestination: () => false });
  assert.throws(
    () => denied.start(11, startRequest()),
    (error) => error.code === "DESTINATION_NOT_READY",
  );
  const allowed = makeManager({ authorizeDestination: (destination) => destination === "google-gemini" });
  const response = allowed.start(11, startRequest());
  assert.equal(response.sampleRate, 16_000);
  assert.match(response.privacy, /Google Gemini/);
  allowed.stop(11, { sessionId: response.sessionId });
});

test("bounded queue drops oldest PCM and preserves realtime ordering", async () => {
  const scheduled = [];
  const received = [];
  const manager = makeManager({
    schedule: (task) => scheduled.push(task),
    writePcm: (pcm, metadata) => received.push({ sequence: metadata.sequence, pcm: Buffer.from(pcm) }),
  });
  const { sessionId } = manager.start(21, startRequest());
  for (let sequence = 0; sequence < 4; sequence += 1) {
    manager.push(21, { sessionId, sequence, pcm: Buffer.alloc(640, sequence + 1) });
  }
  assert.equal(manager.activeSession.queuedBytes, 1_280);
  assert.equal(manager.activeSession.droppedFrames, 2);

  await scheduled.shift()();
  assert.deepEqual(
    received.map((entry) => entry.sequence),
    [2, 3],
  );
  assert.equal(received[0].pcm[0], 3);
  assert.equal(received[1].pcm[0], 4);
  manager.stop(21, { sessionId });
});

test("queued PCM older than one second is wiped and never reaches the writer", async () => {
  let now = 1_000;
  const scheduled = [];
  const received = [];
  const staleInput = Buffer.alloc(640, 9);
  const manager = makeManager({
    now: () => now,
    schedule: (task) => scheduled.push(task),
    writePcm: (_pcm, metadata) => received.push(metadata.sequence),
  });
  const { sessionId } = manager.start("control-center", startRequest());
  manager.push("control-center", { sessionId, sequence: 0, pcm: staleInput });
  now += 1_001;
  manager.push("control-center", { sessionId, sequence: 1, pcm: Buffer.alloc(640, 4) });
  await scheduled.shift()();

  assert.deepEqual(received, [1]);
  assert.equal(manager.activeSession.droppedFrames, 1);
  // The manager owns and wipes a private copy; caller-owned input remains untouched.
  assert.equal(staleInput[0], 9);
  manager.stop("control-center", { sessionId });
});

test("invalid rate or explicit stop terminates the session and clears pending audio", async () => {
  const scheduled = [];
  const received = [];
  const manager = makeManager({
    schedule: (task) => scheduled.push(task),
    writePcm: (_pcm, metadata) => received.push(metadata.sequence),
    limits: { maxChunksPerSecond: 2 },
  });
  const { sessionId } = manager.start(31, startRequest());
  manager.push(31, { sessionId, sequence: 0, pcm: Buffer.alloc(640) });
  manager.push(31, { sessionId, sequence: 1, pcm: Buffer.alloc(640) });
  assert.throws(
    () => manager.push(31, { sessionId, sequence: 2, pcm: Buffer.alloc(640) }),
    (error) => error.code === "RATE_LIMITED",
  );
  assert.equal(manager.activeSession, null);
  await scheduled.shift()();
  assert.deepEqual(received, []);

  const second = manager.start(31, startRequest());
  manager.push(31, { sessionId: second.sessionId, sequence: 0, pcm: Buffer.alloc(640) });
  manager.stop(31, { sessionId: second.sessionId });
  await scheduled.shift()();
  assert.deepEqual(received, []);
});

test("pausing a file session wipes its queue, drops new PCM, and resumes the same session", async () => {
  const scheduled = [];
  const received = [];
  const manager = makeManager({
    schedule: (task) => scheduled.push(task),
    writePcm: (_pcm, metadata) => received.push(metadata.sequence),
  });
  const { sessionId } = manager.start(37, startRequest());
  manager.push(37, { sessionId, sequence: 0, pcm: Buffer.alloc(640, 4) });
  const queuedPcm = manager.activeSession.queue[0].pcm;

  assert.deepEqual(manager.setPaused(true, "wrong-session"), {
    changed: false,
    paused: false,
    sessionId,
  });
  assert.deepEqual(manager.setPaused(true, sessionId), {
    changed: true,
    paused: true,
    sessionId,
  });
  assert.equal(manager.activeSession.queuedBytes, 0);
  assert.deepEqual(queuedPcm, Buffer.alloc(640));
  assert.deepEqual(
    manager.push(37, { sessionId, sequence: 1, pcm: Buffer.alloc(640, 9) }),
    { accepted: false, reason: "paused", droppedFrames: 2 },
  );
  await scheduled.shift()();
  assert.deepEqual(received, []);

  assert.deepEqual(manager.setPaused(false, sessionId), {
    changed: true,
    paused: false,
    sessionId,
  });
  manager.push(37, { sessionId, sequence: 2, pcm: Buffer.alloc(640, 5) });
  await scheduled.shift()();
  assert.deepEqual(received, [2]);
  assert.equal(manager.activeSession.id, sessionId);
  manager.stop(37, { sessionId });
});

test("file writer receives the trusted enqueue timestamp for downstream queue-age telemetry", async () => {
  let now = 1_000;
  const scheduled = [];
  const received = [];
  const manager = makeManager({
    now: () => now,
    schedule: (task) => scheduled.push(task),
    writePcm: (_pcm, metadata) => received.push(metadata),
  });
  const { sessionId } = manager.start(39, startRequest());
  manager.push(39, { sessionId, sequence: 0, pcm: Buffer.alloc(640) });
  now = 1_250;
  await scheduled.shift()();

  assert.equal(received[0].capturedAt, 1_000);
  manager.stop(39, { sessionId });
});

test("status and IPC responses never expose file name, path, pairing token, or API key", () => {
  const status = [];
  const pairingToken = "main-only-pairing-token";
  const apiKey = "main-only-gemini-key";
  const manager = makeManager({
    onStatus: (value) => status.push(value),
    writePcm: () => {
      // A future main integration may close over credentials, but neither crosses this boundary.
      assert.ok(pairingToken && apiKey);
    },
  });
  const response = manager.start(41, startRequest({ displayName: "private-film.mkv" }));
  const serialized = JSON.stringify({ response, status });
  assert.doesNotMatch(serialized, /private-film|main-only-pairing|main-only-gemini/);
  manager.stop(41, { sessionId: response.sessionId });

  const moduleSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "audio", "file-source-session.js"),
    "utf8",
  );
  assert.doesNotMatch(moduleSource, /require\(["']node:(?:fs|path)["']\)/);
});

test("IPC registration binds every operation to one exact renderer ID and URL", () => {
  const handlers = new Map();
  const removed = [];
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => removed.push(channel),
  };
  const manager = makeManager();
  const authorizeSender = createExactSenderAuthorizer({
    webContentsId: 51,
    url: "audiotranslate://control-center/",
  });
  const dispose = registerFileSourceIpc({ ipcMain, manager, authorizeSender });
  const sender = { id: 51, once() {} };
  const exactEvent = {
    sender,
    senderFrame: { url: "audiotranslate://control-center/" },
  };
  const wrongOrigin = {
    sender,
    senderFrame: { url: "https://attacker.invalid/" },
  };
  assert.throws(
    () => handlers.get(FILE_SOURCE_CHANNELS.start)(wrongOrigin, startRequest()),
    (error) => error.code === "FORBIDDEN",
  );

  const response = handlers.get(FILE_SOURCE_CHANNELS.start)(exactEvent, startRequest());
  assert.equal(typeof response.sessionId, "string");
  assert.throws(
    () =>
      handlers.get(FILE_SOURCE_CHANNELS.chunk)(
        { sender: { id: 52 }, senderFrame: exactEvent.senderFrame },
        { sessionId: response.sessionId, sequence: 0, pcm: Buffer.alloc(640) },
      ),
    (error) => error.code === "FORBIDDEN",
  );
  handlers.get(FILE_SOURCE_CHANNELS.stop)(exactEvent, { sessionId: response.sessionId });
  dispose();
  assert.deepEqual(removed.sort(), Object.values(FILE_SOURCE_CHANNELS).sort());
});
