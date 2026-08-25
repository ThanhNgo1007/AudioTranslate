import assert from "node:assert/strict";
import test from "node:test";

import { describeTransportControls } from "../src/transport-controls.mjs";

test("a live session offers instant pause without pretending to stop capture", () => {
  assert.deepEqual(describeTransportControls({ state: "listening", canPause: true, canStop: true }), {
    canTogglePause: true,
    paused: false,
    pauseLabel: "Tạm dừng gửi audio",
    pauseHint: "Giữ phiên và quyền capture; audio mới sẽ bị bỏ an toàn",
    canStop: true,
  });
});

test("a paused session clearly offers resume and remains stoppable", () => {
  assert.deepEqual(describeTransportControls({ state: "listening", paused: true, canResume: true, canStop: true }), {
    canTogglePause: true,
    paused: true,
    pauseLabel: "Tiếp tục dịch",
    pauseHint: "Bắt đầu gửi audio mới; đoạn đã bỏ khi tạm dừng không được phát lại",
    canStop: true,
  });
});

test("idle and terminal inactive states never expose a fake pause action", () => {
  assert.equal(describeTransportControls({ state: "idle" }).canTogglePause, false);
  assert.equal(describeTransportControls({ state: "error", canStop: false }).canStop, false);
});
