class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options.processorOptions || {};
    this.targetSampleRate = processorOptions.targetSampleRate || 16000;
    this.chunkSamples = processorOptions.chunkSamples || 320;
    this.accumulator = 0;
    this.bucketSum = 0;
    this.bucketCount = 0;
    this.chunk = new Int16Array(this.chunkSamples);
    this.chunkOffset = 0;
    this.lowpassStages = [
      this.createLowpassStage(0.45 * this.targetSampleRate, 0.5411961),
      this.createLowpassStage(0.45 * this.targetSampleRate, 1.306563),
    ];
  }

  createLowpassStage(cutoffHz, qualityFactor) {
    const omega = (2 * Math.PI * cutoffHz) / sampleRate;
    const cosine = Math.cos(omega);
    const alpha = Math.sin(omega) / (2 * qualityFactor);
    const scale = 1 / (1 + alpha);
    return {
      b0: ((1 - cosine) / 2) * scale,
      b1: (1 - cosine) * scale,
      b2: ((1 - cosine) / 2) * scale,
      a1: -2 * cosine * scale,
      a2: (1 - alpha) * scale,
      x1: 0,
      x2: 0,
      y1: 0,
      y2: 0,
    };
  }

  lowpass(value) {
    let output = value;
    for (const stage of this.lowpassStages) {
      const next =
        stage.b0 * output +
        stage.b1 * stage.x1 +
        stage.b2 * stage.x2 -
        stage.a1 * stage.y1 -
        stage.a2 * stage.y2;
      stage.x2 = stage.x1;
      stage.x1 = output;
      stage.y2 = stage.y1;
      stage.y1 = next;
      output = next;
    }
    return output;
  }

  pushSample(value) {
    const clamped = Math.max(-1, Math.min(1, value));
    this.chunk[this.chunkOffset++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (this.chunkOffset === this.chunkSamples) {
      const output = this.chunk.buffer;
      this.port.postMessage(output, [output]);
      this.chunk = new Int16Array(this.chunkSamples);
      this.chunkOffset = 0;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    // Pass the captured tab audio through so the viewer still hears the video.
    for (let channel = 0; channel < output.length; channel += 1) {
      const sourceChannel = input[Math.min(channel, input.length - 1)];
      if (sourceChannel) output[channel].set(sourceChannel);
      else output[channel].fill(0);
    }

    const frameCount = input[0].length;
    for (let frame = 0; frame < frameCount; frame += 1) {
      let mixed = 0;
      for (let channel = 0; channel < input.length; channel += 1) mixed += input[channel][frame];
      mixed /= input.length;
      mixed = this.lowpass(mixed);

      // A 4th-order Butterworth low-pass plus bucket integration limits aliasing
      // while converting common 44.1/48 kHz inputs to 16 kHz.
      this.bucketSum += mixed;
      this.bucketCount += 1;
      this.accumulator += this.targetSampleRate;
      if (this.accumulator >= sampleRate) {
        this.accumulator -= sampleRate;
        this.pushSample(this.bucketSum / this.bucketCount);
        this.bucketSum = 0;
        this.bucketCount = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm16-downsampler", Pcm16Downsampler);
