const assert = require("node:assert/strict");
const test = require("node:test");

const { SensitiveClipboardManager } = require("../src/sensitive-clipboard");

function createHarness(ttlMs = 60_000) {
  let value = "";
  let readFailures = 0;
  let clearFailures = 0;
  const timers = [];
  const clipboard = {
    clearCalls: 0,
    readText() {
      if (readFailures > 0) {
        readFailures -= 1;
        throw new Error("temporary clipboard read failure");
      }
      return value;
    },
    writeText(nextValue) {
      value = String(nextValue);
    },
    clear() {
      if (clearFailures > 0) {
        clearFailures -= 1;
        throw new Error("temporary clipboard clear failure");
      }
      this.clearCalls += 1;
      value = "";
    },
  };
  const manager = new SensitiveClipboardManager({
    clipboard,
    ttlMs,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
  });
  return {
    clipboard,
    manager,
    timers,
    read: () => value,
    write: (nextValue) => {
      value = nextValue;
    },
    failReads: (count) => {
      readFailures = count;
    },
    failClears: (count) => {
      clearFailures = count;
    },
  };
}

test("copies a secret temporarily without retaining it in public manager state", () => {
  const harness = createHarness();
  const secret = "private-pairing-token-that-must-not-leak";

  assert.equal(harness.manager.copy(secret), true);

  assert.equal(harness.read(), secret);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delay, 60_000);
  assert.doesNotMatch(JSON.stringify(harness.manager), /private-pairing-token/);

  harness.timers[0].callback();
  assert.equal(harness.read(), "");
  assert.equal(harness.clipboard.clearCalls, 1);
});

test("never clears clipboard content copied by the user after the secret", () => {
  const harness = createHarness();
  harness.manager.copy("temporary-secret");
  harness.write("a link copied later by the user");

  harness.timers[0].callback();

  assert.equal(harness.read(), "a link copied later by the user");
  assert.equal(harness.clipboard.clearCalls, 0);
});

test("copying again restarts the expiry window and dispose clears only owned content", () => {
  const harness = createHarness(5_000);
  harness.manager.copy("temporary-secret");
  harness.manager.copy("temporary-secret");

  assert.equal(harness.timers[0].cleared, true);
  harness.timers[0].callback();
  assert.equal(harness.read(), "temporary-secret");

  assert.equal(harness.manager.dispose(), true);
  assert.equal(harness.timers[1].cleared, true);
  assert.equal(harness.read(), "");

  harness.manager.copy("another-secret");
  harness.write("new clipboard data");
  assert.equal(harness.manager.dispose(), false);
  assert.equal(harness.read(), "new clipboard data");
});

test("transient clipboard read and clear failures retain ownership and retry", () => {
  const harness = createHarness();
  harness.manager.copy("temporary-secret");
  harness.failReads(1);

  harness.timers[0].callback();
  assert.equal(harness.read(), "temporary-secret");
  assert.equal(harness.timers[1].delay, 1_000);
  harness.timers[1].callback();
  assert.equal(harness.read(), "");

  harness.manager.copy("another-secret");
  harness.failClears(1);
  harness.timers[2].callback();
  assert.equal(harness.read(), "another-secret");
  assert.equal(harness.timers[3].delay, 1_000);
  harness.timers[3].callback();
  assert.equal(harness.read(), "");
});

test("automatic clipboard cleanup retries are bounded without losing quit-time ownership", () => {
  const harness = createHarness();
  harness.manager.copy("temporary-secret");
  harness.failReads(3);

  harness.timers[0].callback();
  harness.timers[1].callback();
  harness.timers[2].callback();

  assert.equal(harness.timers.length, 3);
  assert.equal(harness.read(), "temporary-secret");
  assert.equal(harness.manager.dispose(), true);
  assert.equal(harness.read(), "");
});

test("dispose exhausts its own bounded cleanup budget before releasing ownership", () => {
  const harness = createHarness();
  harness.manager.copy("temporary-secret");
  harness.failReads(2);

  assert.equal(harness.manager.dispose(), true);
  assert.equal(harness.read(), "");

  harness.manager.copy("another-secret");
  harness.failClears(2);
  assert.equal(harness.manager.dispose(), true);
  assert.equal(harness.read(), "");
});
