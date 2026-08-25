const DEMO_LINES = [
  ["This is a low-latency subtitle preview.", "Đây là bản xem trước phụ đề có độ trễ thấp."],
  ["Partial captions can change while the speaker is talking.", "Phụ đề nháp có thể thay đổi khi người nói vẫn đang nói."],
  ["The final line is committed after the phrase ends.", "Dòng cuối được chốt sau khi cụm lời nói kết thúc."],
];

class DemoTranslator {
  constructor(options) {
    this.sourceLanguage = options.sourceLanguage;
    this.targetLanguage = options.targetLanguage;
    this.onCaption = options.onCaption;
    this.onStatus = options.onStatus;
    this.sequence = 0;
    this.samplesSinceUpdate = 0;
    this.lineIndex = 0;
    this.partialPhase = true;
    this.running = false;
  }

  async start() {
    this.running = true;
    this.onStatus?.({ level: "ok", message: "Engine phụ đề demo đã sẵn sàng" });
  }

  write(pcm) {
    if (!this.running) return;
    this.samplesSinceUpdate += pcm.byteLength / 2;
    if (this.samplesSinceUpdate < 8000) return;
    this.samplesSinceUpdate %= 8000;

    const [transcript, translation] = DEMO_LINES[this.lineIndex % DEMO_LINES.length];
    const isFinal = !this.partialPhase;
    this.onCaption?.({
      type: "caption",
      sequence: this.sequence++,
      transcript: isFinal ? transcript : transcript.slice(0, Math.ceil(transcript.length * 0.7)),
      translation: isFinal ? translation : translation.slice(0, Math.ceil(translation.length * 0.7)),
      sourceLanguage: this.sourceLanguage,
      targetLanguage: this.targetLanguage,
      isFinal,
      emittedAt: Date.now(),
      latencyMs: null,
      synthetic: true,
      provider: "demo",
    });

    if (isFinal) this.lineIndex += 1;
    this.partialPhase = !this.partialPhase;
  }

  async stop() {
    this.running = false;
  }
}

module.exports = { DemoTranslator, DEMO_LINES };
