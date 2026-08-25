class CaptionState {
  constructor(maxFinalLines = 2) {
    this.maxFinalLines = maxFinalLines;
    this.finals = [];
    this.partial = null;
    this.lastSequence = -1;
    this.sessionId = null;
  }

  apply(caption) {
    if (!caption || caption.type !== "caption") return this.snapshot();
    if (caption.sessionId && caption.sessionId !== this.sessionId) {
      this.finals = [];
      this.partial = null;
      this.lastSequence = -1;
      this.sessionId = caption.sessionId;
    }
    if (Number.isFinite(caption.sequence) && caption.sequence < this.lastSequence) {
      return this.snapshot();
    }
    if (Number.isFinite(caption.sequence)) this.lastSequence = caption.sequence;

    if (caption.isFinal) {
      this.partial = null;
      if (caption.translation || caption.transcript) {
        const previous = this.finals[this.finals.length - 1];
        const duplicate =
          previous &&
          previous.translation === caption.translation &&
          previous.transcript === caption.transcript;
        if (!duplicate) this.finals.push(caption);
      }
      this.finals = this.finals.slice(-this.maxFinalLines);
    } else {
      this.partial = caption;
    }
    return this.snapshot();
  }

  clear() {
    this.finals = [];
    this.partial = null;
    this.lastSequence = -1;
    this.sessionId = null;
    return this.snapshot();
  }

  snapshot() {
    return {
      finals: [...this.finals],
      partial: this.partial,
      lastSequence: this.lastSequence,
      sessionId: this.sessionId,
    };
  }
}

module.exports = { CaptionState };
