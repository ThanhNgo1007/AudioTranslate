import assert from "node:assert/strict";
import test from "node:test";

import { finishFileSessionWithFreshSnapshot } from "../src/file-session-result.mjs";

test("file session returns the snapshot published after the streamer starts", async () => {
  let connected = false;
  const result = await finishFileSessionWithFreshSnapshot(
    async () => {
      connected = true;
    },
    async () => ({ source: { connected } }),
  );

  assert.deepEqual(result, { source: { connected: true } });
});
