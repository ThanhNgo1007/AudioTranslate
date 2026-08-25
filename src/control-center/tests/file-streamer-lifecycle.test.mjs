import assert from "node:assert/strict";
import test from "node:test";

import { stopOwnedFileStreamer } from "../src/file-streamer-lifecycle.mjs";

test("file invalidation releases renderer ownership before stopping playback", async () => {
  let active;
  let stopped = 0;
  active = {
    async stop() {
      assert.equal(active, null);
      stopped += 1;
    },
  };

  await stopOwnedFileStreamer(() => active, (next) => { active = next; });

  assert.equal(active, null);
  assert.equal(stopped, 1);
});

test("file invalidation is idempotent when no renderer streamer is active", async () => {
  let active = null;
  await stopOwnedFileStreamer(() => active, (next) => { active = next; });
  assert.equal(active, null);
});
