const test = require("node:test");
const assert = require("node:assert/strict");
const { decodeAudioFrame, encodeAudioFrame, safeParseControl } = require("../src/protocol");

test("ATR1 audio frame round-trips metadata and PCM16", () => {
  const pcm = Buffer.from([0, 0, 255, 127, 0, 128]);
  const encoded = encodeAudioFrame(pcm, { sequence: 42, capturedAt: 1234.5 });
  const decoded = decodeAudioFrame(encoded);
  assert.equal(decoded.sequence, 42);
  assert.equal(decoded.capturedAt, 1234.5);
  assert.deepEqual(decoded.pcm, pcm);
});

test("audio frame rejects malformed data", () => {
  assert.throws(() => decodeAudioFrame(Buffer.alloc(8)), /ATR1/);
  assert.throws(() => encodeAudioFrame(Buffer.alloc(3)), /even byte length/);
});

test("control messages require JSON object and type", () => {
  assert.deepEqual(safeParseControl('{"type":"ping"}'), { type: "ping" });
  assert.throws(() => safeParseControl("not-json"), /valid JSON/);
  assert.throws(() => safeParseControl("{}"), /requires/);
});
