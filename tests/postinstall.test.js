const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.resolve(__dirname, "..", "scripts", "postinstall.js");

function runPostinstall(globalInstall) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_global: globalInstall ? "true" : "false",
    },
  });
}

test("postinstall launches Control Center directly for local and global installs", () => {
  const local = runPostinstall(false);
  assert.equal(local.status, 0);
  assert.match(local.stdout, /npm start/);
  assert.doesNotMatch(local.stdout, /npm run setup/);
  assert.match(local.stdout, /npm run providers/);

  const global = runPostinstall(true);
  assert.equal(global.status, 0);
  assert.match(global.stdout, /Tiếp theo: audiotranslate\s/);
  assert.doesNotMatch(global.stdout, /audiotranslate setup/);
  assert.match(global.stdout, /audiotranslate providers/);
});
