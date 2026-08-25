const AUDIO_MAGIC = 0x31525441; // ASCII "ATR1" as little-endian uint32.
const AUDIO_HEADER_BYTES = 16;
const PROTOCOL_VERSION = 1;
const MAX_PCM_BYTES = 256 * 1024;

function encodeAudioFrame(pcm, { sequence = 0, capturedAt = Date.now() } = {}) {
  const pcmBuffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  if (pcmBuffer.byteLength % 2 !== 0) throw new Error("PCM16 payload must have an even byte length");
  const frame = Buffer.allocUnsafe(AUDIO_HEADER_BYTES + pcmBuffer.byteLength);
  frame.writeUInt32LE(AUDIO_MAGIC, 0);
  frame.writeUInt32LE(sequence >>> 0, 4);
  frame.writeDoubleLE(capturedAt, 8);
  pcmBuffer.copy(frame, AUDIO_HEADER_BYTES);
  return frame;
}

function decodeAudioFrame(input) {
  const frame = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (frame.byteLength < AUDIO_HEADER_BYTES || frame.readUInt32LE(0) !== AUDIO_MAGIC) {
    throw new Error("Unsupported audio frame: expected ATR1 header");
  }
  const pcm = frame.subarray(AUDIO_HEADER_BYTES);
  if (pcm.byteLength === 0 || pcm.byteLength > MAX_PCM_BYTES || pcm.byteLength % 2 !== 0) {
    throw new Error(`Invalid PCM16 payload size: ${pcm.byteLength}`);
  }
  return {
    sequence: frame.readUInt32LE(4),
    capturedAt: frame.readDoubleLE(8),
    pcm,
  };
}

function safeParseControl(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Control message must be valid JSON");
  }
  if (!value || typeof value !== "object" || typeof value.type !== "string") {
    throw new Error("Control message requires a string `type`");
  }
  return value;
}

module.exports = {
  AUDIO_HEADER_BYTES,
  AUDIO_MAGIC,
  PROTOCOL_VERSION,
  decodeAudioFrame,
  encodeAudioFrame,
  safeParseControl,
};
