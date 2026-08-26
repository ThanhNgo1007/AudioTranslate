const assert = require("node:assert/strict");
const test = require("node:test");

const { composeText } = require("../src/overlay/caption-composer");
const { createLiveCaptionBlock } = require("../src/overlay/live-caption-block");

function caption(sequence, translation, isFinal, emittedAt, overrides = {}) {
  return {
    type: "caption",
    sessionId: "session-1",
    sequence,
    translation,
    isFinal,
    emittedAt,
    ...overrides,
  };
}

function paginate(maxGraphemesPerLine = 20) {
  return (text) => composeText(text, { maxLines: 2, maxGraphemesPerLine });
}

test("a revised partial replaces one mutable suffix without duplicating words", () => {
  const block = createLiveCaptionBlock();
  block.apply(caption(0, "Xin", false, 1000), paginate());
  const snapshot = block.apply(caption(1, "Xin chào", false, 1020), paginate());

  assert.equal(snapshot.committedPrefix, "");
  assert.equal(snapshot.mutableSuffix, "Xin chào");
  assert.equal(snapshot.rawText, "Xin chào");
  assert.equal(snapshot.isFinal, false);
  assert.doesNotMatch(snapshot.rawText, /Xin Xin/);
});

test("final commits the suffix and a close utterance appends to the same block", () => {
  const block = createLiveCaptionBlock({ resetGapMs: 1100 });
  block.apply(caption(0, "Xin chào", false, 1000), paginate());
  const final = block.apply(caption(1, "Xin chào", true, 1050), paginate());
  assert.equal(final.committedPrefix, "Xin chào");
  assert.equal(final.mutableSuffix, "");
  assert.equal(final.isFinal, true);

  const continuation = block.apply(
    caption(2, "Bạn khỏe không?", false, 1800),
    paginate(),
  );
  assert.equal(continuation.rawText, "Xin chào Bạn khỏe không?");
  assert.equal(continuation.committedPrefix, "Xin chào");
  assert.equal(continuation.mutableSuffix, "Bạn khỏe không?");
});

test("a pause beyond the reset gap starts a clean subtitle block", () => {
  const block = createLiveCaptionBlock({ resetGapMs: 1100 });
  block.apply(caption(0, "Câu trước", true, 1000), paginate());
  const previousGeneration = block.snapshot().generation;
  const next = block.apply(caption(1, "Câu mới", false, 2101), paginate());

  assert.equal(next.rawText, "Câu mới");
  assert.equal(next.committedPrefix, "");
  assert.equal(next.mutableSuffix, "Câu mới");
  assert.equal(next.generation, previousGeneration + 1);
});

test("overflow exposes only the newest complete two-line page without clipping graphemes", () => {
  const block = createLiveCaptionBlock();
  const family = "👨‍👩‍👧‍👦";
  const text = `${family.repeat(14)}KẾT`;
  const snapshot = block.apply(caption(0, text, false, 1000), paginate(4));

  assert.equal(snapshot.overflow, true);
  assert.ok(snapshot.pageCount > 1);
  assert.equal(snapshot.pageIndex, snapshot.pageCount - 1);
  assert.ok(snapshot.lines.length <= 2);
  assert.match(snapshot.rawText, /KẾT$/);
  assert.equal(snapshot.semanticText, text);
  for (const line of snapshot.lines) assert.doesNotMatch(line, /\u200d$/u);
});

test("session or stream generation changes clear stale committed text and sequence", () => {
  const block = createLiveCaptionBlock();
  block.apply(caption(20, "Phiên cũ", true, 1000, { generation: 3 }), paginate());
  const next = block.apply(
    caption(0, "Phiên mới", false, 1100, { sessionId: "session-2", generation: 4 }),
    paginate(),
  );

  assert.equal(next.sessionId, "session-2");
  assert.equal(next.streamGeneration, 4);
  assert.equal(next.lastSequence, 0);
  assert.equal(next.rawText, "Phiên mới");
  assert.equal(next.committedPrefix, "");

  const withoutGeneration = createLiveCaptionBlock();
  withoutGeneration.apply(caption(9, "Cũ", true, 1000, { generation: 9 }), paginate());
  const reset = withoutGeneration.apply(
    caption(0, "Mới", false, 1100, { sessionId: "session-without-generation" }),
    paginate(),
  );
  assert.equal(reset.streamGeneration, null);
});

test("duplicate and out-of-order sequence numbers cannot roll captions backward", () => {
  const block = createLiveCaptionBlock();
  block.apply(caption(3, "Nội dung mới", false, 1000), paginate());
  block.apply(caption(3, "Bị trùng", true, 1010), paginate());
  const snapshot = block.apply(caption(2, "Nội dung cũ", false, 1020), paginate());

  assert.equal(snapshot.rawText, "Nội dung mới");
  assert.equal(snapshot.lastSequence, 3);
  assert.equal(snapshot.isFinal, false);
});

test("reflow preserves semantic text while recalculating pages", () => {
  const block = createLiveCaptionBlock();
  const text = "Một câu phụ đề đủ dài để thay đổi cách xuống dòng khi cửa sổ đổi kích thước.";
  const wide = block.apply(caption(0, text, false, 1000), paginate(30));
  const narrow = block.reflow(paginate(10));

  assert.equal(narrow.semanticText, text);
  assert.equal(narrow.mutableSuffix, text);
  assert.ok(narrow.pageCount >= wide.pageCount);
  assert.ok(narrow.lines.length <= 2);
});

test("clear returns an empty render-ready snapshot", () => {
  const block = createLiveCaptionBlock();
  block.apply(caption(0, "Tạm thời", false, 1000), paginate());
  const cleared = block.clear();

  assert.equal(cleared.rawText, "");
  assert.equal(cleared.semanticText, "");
  assert.equal(cleared.lastSequence, -1);
  assert.equal(cleared.sessionId, null);
  assert.deepEqual(cleared.lines, []);
});
