const TARGET_SAMPLE_RATE = 16_000;
const TARGET_FRAME_SAMPLES = 1_600;

class AudioTranslateFilePcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_SAMPLE_RATE;
    this.nextInputFrame = 0;
    this.totalInputFrames = 0;
    this.previousSample = 0;
    this.frame = new Int16Array(TARGET_FRAME_SAMPLES);
    this.frameOffset = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") {
        this.flush();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  emitSample(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.frame[this.frameOffset] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.frameOffset += 1;
    if (this.frameOffset === TARGET_FRAME_SAMPLES) this.emitFrame();
  }

  emitFrame() {
    const complete = this.frame;
    this.frame = new Int16Array(TARGET_FRAME_SAMPLES);
    this.frameOffset = 0;
    this.port.postMessage({ type: "pcm16", pcm: complete.buffer }, [complete.buffer]);
  }

  flush() {
    if (this.frameOffset === 0) return;
    this.frame.fill(0, this.frameOffset);
    this.emitFrame();
  }

  process(inputs, outputs) {
    const channels = inputs[0] || [];
    const outputChannels = outputs[0] || [];
    const frameCount = channels[0]?.length || 0;

    // Preserve normal playback while observing the decoded PCM stream.
    for (let channel = 0; channel < outputChannels.length; channel += 1) {
      const input = channels[Math.min(channel, channels.length - 1)];
      if (input) outputChannels[channel].set(input);
      else outputChannels[channel].fill(0);
    }

    if (frameCount === 0 || channels.length === 0) return true;
    const blockStart = this.totalInputFrames;
    const blockEnd = blockStart + frameCount;
    const monoAt = (index) => {
      let sum = 0;
      for (const channel of channels) sum += channel[index] || 0;
      return sum / channels.length;
    };

    while (this.nextInputFrame < blockEnd) {
      const local = this.nextInputFrame - blockStart;
      let mixed;
      if (local < 0) {
        const fraction = local + 1;
        mixed = this.previousSample + (monoAt(0) - this.previousSample) * fraction;
      } else {
        const lower = Math.floor(local);
        if (lower + 1 >= frameCount) break;
        const fraction = local - lower;
        const left = monoAt(lower);
        mixed = left + (monoAt(lower + 1) - left) * fraction;
      }
      this.emitSample(mixed);
      this.nextInputFrame += this.ratio;
    }

    this.previousSample = monoAt(frameCount - 1);
    this.totalInputFrames = blockEnd;
    return true;
  }
}

registerProcessor("audiotranslate-file-pcm16", AudioTranslateFilePcm16Processor);
