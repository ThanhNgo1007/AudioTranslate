const assert = require("node:assert/strict");
const test = require("node:test");

const {
  composeCaption,
  composeText,
  createCaptionPager,
  createCaptionVisibilityController,
  graphemeCount,
} = require("../src/overlay/caption-composer");

function originalText(composition) {
  return composition.pages.map((page) => page.rawText).join("");
}

test("Vietnamese captions prefer phrase boundaries and stay bottom-heavy", () => {
  const text =
    "Đây là một câu khá dài, được viết để kiểm tra cách ngắt phụ đề tự nhiên và dễ đọc.";
  const composition = composeText(text, { maxLines: 2, maxGraphemesPerLine: 42 });

  assert.equal(originalText(composition), text);
  assert.equal(composition.qc.overflow, false);
  assert.equal(composition.pages.length, 1);
  assert.equal(composition.pages[0].lines.length, 2);
  assert.ok(
    graphemeCount(composition.pages[0].rawLines[0]) <=
      graphemeCount(composition.pages[0].rawLines[1]),
    "the second subtitle line should be at least as long as the first",
  );
  for (const line of composition.pages[0].lines) {
    assert.ok(graphemeCount(line) <= 42);
  }
});

test("long text without punctuation is hard-wrapped without losing text", () => {
  const text = "a".repeat(42 * 5 + 17);
  const composition = composeText(text);

  assert.equal(originalText(composition), text);
  assert.equal(composition.qc.overflow, true);
  assert.equal(composition.qc.pageCount, 3);
  for (const page of composition.pages) {
    assert.ok(page.lines.length <= 2);
    for (const line of page.lines) assert.ok(graphemeCount(line) <= 42);
  }
});

test("emoji ZWJ sequences and combining characters are never split", () => {
  const family = "👨‍👩‍👧‍👦";
  const combined = "e\u0301";
  const text = `${family.repeat(45)}${combined.repeat(45)}`;
  const composition = composeText(text);

  assert.equal(graphemeCount(text), 90);
  assert.equal(originalText(composition), text);
  assert.equal(composition.pages[0].lines[0], family.repeat(42));
  assert.equal(composition.pages.at(-1).lines.at(-1), combined.repeat(6));
});

test("caption composition preserves both translation and source across paired pages", () => {
  const caption = {
    translation: "Bản dịch ".repeat(40).trimEnd(),
    transcript: "Original source sentence ".repeat(20).trimEnd(),
  };
  const composition = composeCaption(caption);

  assert.equal(composition.translation.rawText, caption.translation);
  assert.equal(composition.source.rawText, caption.transcript);
  assert.ok(composition.pages.length > 1);
  assert.equal(composition.qc.overflow, true);
  assert.equal(composition.qc.needsReview, true);
  assert.deepEqual(composition.qc.reasons, ["caption-overflow"]);
  assert.ok(composition.pages.every((page) => page.translation || page.source));
});

test("partial captions show only their current mutable tail", () => {
  const composition = composeCaption({ translation: "từ ".repeat(100).trimEnd() });
  const seen = [];
  const pager = createCaptionPager({ onPage: (page, metadata) => seen.push({ page, metadata }) });

  pager.show(composition, { isFinal: false, context: { sequence: 9 } });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].metadata.pageIndex, composition.pages.length - 1);
  assert.equal(seen[0].metadata.isTail, true);
  assert.equal(seen[0].metadata.context.sequence, 9);
});

test("rolling final captions keep only the newest two-line window without replay", () => {
  const composition = composeCaption({
    translation: `${"từ ".repeat(28)}KẾT THÚC`,
  });
  const seen = [];
  const scheduled = [];
  const pager = createCaptionPager({
    onPage: (page, metadata) => seen.push({ page, metadata }),
    setTimer(callback, delay) {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
  });

  pager.show(composition, { isFinal: true, rolling: true });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].metadata.pageIndex, composition.pages.length - 1);
  assert.equal(seen[0].metadata.isTail, true);
  assert.equal(seen[0].page.translation.split("\n").length, 2);
  assert.ok(
    graphemeCount(seen[0].page.translation) >= 60,
    "rolling must keep a readable two-line window instead of a tiny overflow remainder",
  );
  assert.match(seen[0].page.translation, /KẾT THÚC$/);
  assert.equal(scheduled.length, 0);
  assert.equal(pager.snapshot().pending, false);
});

test("only a completed utterance starts auto-hide and a new partial cancels it", () => {
  const scheduled = [];
  const cancelled = new Set();
  const hidden = [];
  let nextTimerId = 0;
  const visibility = createCaptionVisibilityController({
    onHide: () => hidden.push("hidden"),
    setTimer(callback, delay) {
      const task = { id: ++nextTimerId, callback, delay };
      scheduled.push(task);
      return task.id;
    },
    clearTimer(id) {
      cancelled.add(id);
    },
  });

  visibility.show({ isFinal: false, hideAfterMs: 3_000 });
  assert.equal(scheduled.length, 0, "speech in progress must remain visible");

  visibility.show({ isFinal: true, hideAfterMs: 3_000 });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 3_000);
  const staleFinal = scheduled[0];

  visibility.show({ isFinal: false, hideAfterMs: 3_000 });
  assert.ok(cancelled.has(staleFinal.id));
  staleFinal.callback();
  assert.deepEqual(hidden, [], "an already-queued stale callback must not hide new speech");

  visibility.show({ isFinal: true, hideAfterMs: 1_500 });
  assert.equal(scheduled.at(-1).delay, 1_500);
  scheduled.at(-1).callback();
  assert.deepEqual(hidden, ["hidden"]);
  assert.equal(visibility.snapshot().pending, false);

  visibility.show({ isFinal: true, hideAfterMs: 0 });
  assert.equal(visibility.snapshot().pending, false);
});

test("final pagination is finite and a newer caption cancels stale pages", () => {
  const scheduled = [];
  const cancelled = new Set();
  const events = [];
  let nextTimerId = 0;
  const pager = createCaptionPager({
    pageDurationMs: 1500,
    onPage: (page, metadata) => events.push({ page, metadata }),
    setTimer(callback, delay) {
      const task = { id: ++nextTimerId, callback, delay };
      scheduled.push(task);
      return task.id;
    },
    clearTimer(id) {
      cancelled.add(id);
    },
  });
  const oldCaption = composeCaption({ translation: "cũ ".repeat(120).trimEnd() });
  const newCaption = composeCaption({ translation: "nội dung mới" });

  pager.show(oldCaption, { isFinal: true, context: { sequence: 1 } });
  assert.equal(events.length, 1);
  const staleCallback = scheduled[0].callback;
  pager.show(newCaption, { isFinal: true, context: { sequence: 2 } });
  assert.ok(cancelled.has(scheduled[0].id));

  // Simulate a callback that was already queued by the event loop when it was cancelled.
  staleCallback();
  assert.deepEqual(
    events.map(({ metadata }) => metadata.context.sequence),
    [1, 2],
  );
  assert.equal(pager.snapshot().pending, false);

  // A fresh finite run emits each page exactly once and stops scheduling.
  events.length = 0;
  scheduled.length = 0;
  pager.show(oldCaption, { isFinal: true, context: { sequence: 3 } });
  while (pager.snapshot().pending) {
    const task = scheduled.shift();
    assert.ok(task, "pending pagination must own a scheduled callback");
    assert.equal(task.delay, 1500);
    task.callback();
  }
  assert.equal(events.length, oldCaption.pages.length);
  assert.deepEqual(
    events.map(({ metadata }) => metadata.pageIndex),
    oldCaption.pages.map((_, index) => index),
  );
});
