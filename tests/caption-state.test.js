const test = require("node:test");
const assert = require("node:assert/strict");
const { CaptionState } = require("../src/caption-state");

function caption(sequence, translation, isFinal, sessionId = "session-1") {
  return { type: "caption", sessionId, sequence, translation, transcript: "source", isFinal };
}

test("partial caption is replaced while final history remains bounded", () => {
  const state = new CaptionState(2);
  state.apply(caption(0, "nháp một", false));
  assert.equal(state.snapshot().partial.translation, "nháp một");
  state.apply(caption(1, "câu một", true));
  state.apply(caption(2, "câu hai", true));
  state.apply(caption(3, "câu ba", true));
  assert.deepEqual(
    state.snapshot().finals.map((item) => item.translation),
    ["câu hai", "câu ba"],
  );
  assert.equal(state.snapshot().partial, null);
});

test("a new capture session resets sequence and committed history", () => {
  const state = new CaptionState();
  state.apply(caption(20, "phiên cũ", true, "session-1"));
  state.apply(caption(0, "phiên mới", false, "session-2"));
  assert.equal(state.snapshot().finals.length, 0);
  assert.equal(state.snapshot().partial.translation, "phiên mới");
  assert.equal(state.snapshot().lastSequence, 0);
  assert.equal(state.snapshot().sessionId, "session-2");
});

test("out-of-order and duplicate final captions are ignored", () => {
  const state = new CaptionState();
  state.apply(caption(3, "mới", true));
  state.apply(caption(2, "cũ", false));
  state.apply(caption(4, "mới", true));
  assert.equal(state.snapshot().finals.length, 1);
  assert.equal(state.snapshot().partial, null);
});
