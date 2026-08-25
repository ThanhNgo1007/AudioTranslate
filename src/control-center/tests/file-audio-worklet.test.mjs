import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const workletPath = path.join(testDir, "..", "public", "file-audio-worklet.js");

function createProcessor(sourceSampleRate = 48_000) {
  let RegisteredProcessor = null;
  const posted = [];

  class StubAudioWorkletProcessor {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage(message) {
          posted.push(message);
        },
      };
    }
  }

  const sandbox = {
    AudioWorkletProcessor: StubAudioWorkletProcessor,
    Int16Array,
    Math,
    sampleRate: sourceSampleRate,
    registerProcessor(name, implementation) {
      assert.equal(name, "audiotranslate-file-pcm16");
      RegisteredProcessor = implementation;
    },
  };
  vm.runInNewContext(fs.readFileSync(workletPath, "utf8"), sandbox, {
    filename: workletPath,
  });
  assert.equal(typeof RegisteredProcessor, "function");
  return { processor: new RegisteredProcessor(), posted };
}

test("worklet converts one second of stereo 48 kHz audio into exact 100 ms PCM16 frames", () => {
  const { processor, posted } = createProcessor();
  const blockSize = 128;
  const blocks = 48_000 / blockSize;

  for (let block = 0; block < blocks; block += 1) {
    const left = new Float32Array(blockSize);
    const right = new Float32Array(blockSize);
    for (let index = 0; index < blockSize; index += 1) {
      const time = (block * blockSize + index) / 48_000;
      left[index] = Math.sin(2 * Math.PI * 440 * time) * 0.5;
      right[index] = Math.sin(2 * Math.PI * 220 * time) * 0.25;
    }
    const outputLeft = new Float32Array(blockSize);
    const outputRight = new Float32Array(blockSize);
    assert.equal(processor.process([[left, right]], [[outputLeft, outputRight]]), true);
    assert.deepEqual(outputLeft, left, "worklet must preserve audible playback");
    assert.deepEqual(outputRight, right, "worklet must preserve stereo playback");
  }

  processor.port.onmessage({ data: { type: "flush" } });
  const pcmFrames = posted.filter((message) => message.type === "pcm16");
  assert.equal(pcmFrames.length, 10, "16,000 output samples must form ten 100 ms frames");
  for (const message of pcmFrames) {
    assert.ok(message.pcm instanceof ArrayBuffer);
    assert.equal(message.pcm.byteLength, 3_200);
  }
  assert.equal(posted.at(-1).type, "flushed");
});

test("worklet clamps over-range samples and pads only the final partial frame", () => {
  const { processor, posted } = createProcessor(16_000);
  const positive = new Float32Array(800).fill(2);
  const negative = new Float32Array(800).fill(-2);
  processor.process([[positive]], [[new Float32Array(800), new Float32Array(800)]]);
  processor.process([[negative]], [[new Float32Array(800), new Float32Array(800)]]);
  processor.port.onmessage({ data: { type: "flush" } });

  const pcmFrames = posted.filter((message) => message.type === "pcm16");
  assert.equal(pcmFrames.length, 1);
  assert.equal(pcmFrames[0].pcm.byteLength, 3_200);
  const samples = new Int16Array(pcmFrames[0].pcm);
  assert.equal(samples[0], 32_767);
  assert.equal(samples[799], 32_767);
  assert.ok(samples[800] <= -32_767);
});
