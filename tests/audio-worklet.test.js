const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadProcessor(inputSampleRate) {
  let ProcessorClass;
  class AudioWorkletProcessorStub {
    constructor() {
      this.emitted = [];
      this.port = {
        postMessage: (buffer) => this.emitted.push(new Int16Array(buffer.slice(0))),
      };
    }
  }
  const source = fs.readFileSync(
    path.join(__dirname, "..", "extension", "audio-worklet.js"),
    "utf8",
  );
  vm.runInNewContext(source, {
    AudioWorkletProcessor: AudioWorkletProcessorStub,
    Float32Array,
    Int16Array,
    Math,
    registerProcessor: (_name, implementation) => {
      ProcessorClass = implementation;
    },
    sampleRate: inputSampleRate,
  });
  return ProcessorClass;
}

function resampleTone(frequency, inputSampleRate = 48000) {
  const Processor = loadProcessor(inputSampleRate);
  const processor = new Processor({
    processorOptions: { targetSampleRate: 16000, chunkSamples: 320 },
  });
  for (let offset = 0; offset < inputSampleRate; offset += 128) {
    const input = new Float32Array(128);
    for (let index = 0; index < input.length; index += 1) {
      input[index] = Math.sin((2 * Math.PI * frequency * (offset + index)) / inputSampleRate);
    }
    processor.process([[input]], [[new Float32Array(128), new Float32Array(128)]]);
  }
  return Int16Array.from(processor.emitted.flatMap((chunk) => [...chunk]));
}

function rms(samples, skip = 512) {
  let sum = 0;
  for (let index = skip; index < samples.length; index += 1) {
    const value = samples[index] / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / (samples.length - skip));
}

test("AudioWorklet emits exactly 16 kHz PCM chunks", () => {
  const samples = resampleTone(1000);
  assert.equal(samples.length, 16000);
  assert.ok(rms(samples) > 0.6);
});

test("AudioWorklet low-pass suppresses a 12 kHz alias before decimation", () => {
  const samples = resampleTone(12000);
  assert.ok(rms(samples) < 0.08, `alias RMS was ${rms(samples)}`);
});
