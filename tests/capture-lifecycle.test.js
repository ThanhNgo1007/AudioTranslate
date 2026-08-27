const assert = require("node:assert/strict");
const test = require("node:test");

const { prepareThenAttach } = require("../extension/capture-lifecycle");

test("provider readiness always precedes tab stream acquisition and attachment", async () => {
  const events = [];
  const result = await prepareThenAttach({
    async prepareLocalSession() {
      events.push("prepare-local-session");
      events.push("provider-ready");
      return { provider: "gemini" };
    },
    async getTabStreamId() {
      events.push("get-tab-stream-id");
      return "one-time-stream";
    },
    async attachTabStream(streamId) {
      assert.equal(streamId, "one-time-stream");
      events.push("attach-tab-stream");
      return { connected: true };
    },
    async cancelPreparedSession() {
      events.push("cancel-prepared-session");
    },
  });

  assert.deepEqual(events, [
    "prepare-local-session",
    "provider-ready",
    "get-tab-stream-id",
    "attach-tab-stream",
  ]);
  assert.deepEqual(result, {
    preparation: { provider: "gemini" },
    attachment: { connected: true },
  });
});

test("a preparation failure never requests a tab stream", async () => {
  let streamRequests = 0;
  let cancellations = 0;
  await assert.rejects(
    prepareThenAttach({
      async prepareLocalSession() {
        throw new Error("provider unavailable");
      },
      async getTabStreamId() {
        streamRequests += 1;
        return "must-not-run";
      },
      async attachTabStream() {},
      async cancelPreparedSession() {
        cancellations += 1;
      },
    }),
    /provider unavailable/,
  );
  assert.equal(streamRequests, 0);
  assert.equal(cancellations, 0);
});

test("an attachment failure cancels exactly one prepared provider session", async () => {
  let cancellations = 0;
  await assert.rejects(
    prepareThenAttach({
      async prepareLocalSession() {
        return { provider: "gemini" };
      },
      async getTabStreamId() {
        return "one-time-stream";
      },
      async attachTabStream() {
        throw new Error("capture denied");
      },
      async cancelPreparedSession() {
        cancellations += 1;
      },
    }),
    /capture denied/,
  );
  assert.equal(cancellations, 1);
});

test("cleanup errors never replace the original attachment error", async () => {
  await assert.rejects(
    prepareThenAttach({
      async prepareLocalSession() {},
      async getTabStreamId() {
        throw new Error("stream id expired");
      },
      async attachTabStream() {},
      async cancelPreparedSession() {
        throw new Error("cleanup failed");
      },
    }),
    /stream id expired/,
  );
});
