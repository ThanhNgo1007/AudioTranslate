import assert from "node:assert/strict";
import test from "node:test";

import { describeSessionDisplay } from "../src/session-display.mjs";

test("running Demo never claims that real audio is being received or translated", () => {
  assert.deepEqual(describeSessionDisplay("demo", "listening"), {
    hasLiveAudio: false,
    canStop: true,
    sceneLabel: "Demo đang chạy",
    primaryActionLabel: "Dừng Demo",
    audioMeterLabel: "Demo không nhận audio",
  });
});

test("running Gemini reports a real live audio translation session", () => {
  assert.deepEqual(describeSessionDisplay("gemini", "listening"), {
    hasLiveAudio: true,
    canStop: true,
    sceneLabel: "Đang dịch trực tiếp",
    primaryActionLabel: "Dừng phiên dịch",
    audioMeterLabel: "Đang nhận tín hiệu audio",
  });
});

test("idle providers use honest preview/start labels", () => {
  assert.equal(describeSessionDisplay("demo", "idle").primaryActionLabel, "Chạy Demo");
  assert.equal(describeSessionDisplay("gemini", "idle").primaryActionLabel, "Bắt đầu dịch");
  assert.equal(describeSessionDisplay("gemini", "idle").audioMeterLabel, "Chưa nhận audio");
});

test("a connecting tab session remains cancellable while waiting for the extension", () => {
  assert.deepEqual(describeSessionDisplay("gemini", "connecting"), {
    hasLiveAudio: false,
    canStop: true,
    sceneLabel: "Đang chờ nguồn audio",
    primaryActionLabel: "Hủy kết nối",
    audioMeterLabel: "Đang chờ nguồn audio",
  });
});

test("a stopping session cannot be started or stopped again", () => {
  const display = describeSessionDisplay("gemini", "stopping");
  assert.equal(display.canStop, false);
  assert.equal(display.primaryActionLabel, "Đang dừng…");
});

test("a paused session remains stoppable without claiming live audio or a start action", () => {
  assert.deepEqual(describeSessionDisplay("gemini", "paused", true), {
    hasLiveAudio: false,
    canStop: true,
    sceneLabel: "Đã tạm dừng",
    primaryActionLabel: "Dừng phiên dịch",
    audioMeterLabel: "Đã tạm dừng gửi audio",
  });
});

test("an active error stays visibly erroneous while still allowing Stop", () => {
  assert.deepEqual(describeSessionDisplay("gemini", "error", true), {
    hasLiveAudio: false,
    canStop: true,
    sceneLabel: "Phiên dịch gặp lỗi",
    primaryActionLabel: "Dừng phiên lỗi",
    audioMeterLabel: "Phiên có lỗi; hãy dừng hoặc thử lại",
  });
  assert.equal(describeSessionDisplay("gemini", "error", false).canStop, false);
});
