const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");

function linkModuleEntries(sourceModules, fixtureModules, excludedEntries = new Set()) {
  fs.mkdirSync(fixtureModules, { recursive: true });
  for (const entry of fs.readdirSync(sourceModules)) {
    if ((entry.startsWith(".") && entry !== ".bin") || excludedEntries.has(entry)) {
      continue;
    }
    fs.symlinkSync(
      path.join(sourceModules, entry),
      path.join(fixtureModules, entry),
      process.platform === "win32" ? "junction" : undefined,
    );
  }
}

test("package keeps Electron available in production while remaining private", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

  assert.equal(packageJson.private, true);
  assert.match(packageJson.dependencies?.electron || "", /^\S+$/);
  assert.equal(packageJson.devDependencies?.electron, undefined);
  assert.equal(packageJson.engines?.node, ">=22.12.0");
});

test("a clean package fixture builds and includes the desktop UI during prepack", () => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-pack-fixture-"));
  try {
    const excludedDist = path.join("src", "control-center", "dist");
    const copyFilter = (source) => {
      const relative = path.relative(projectRoot, source);
      const segments = relative.split(path.sep);
      return (
        relative !== excludedDist &&
        !relative.startsWith(`${excludedDist}${path.sep}`) &&
        !segments.includes("node_modules") &&
        path.basename(source) !== ".DS_Store"
      );
    };
    for (const relative of [
      ".env.example",
      "README.md",
      "package.json",
      "bin",
      "extension",
      "scripts",
      "src",
    ]) {
      fs.cpSync(path.join(projectRoot, relative), path.join(fixtureDirectory, relative), {
        recursive: true,
        filter: copyFilter,
      });
    }
    const sourceModules = path.join(projectRoot, "node_modules");
    const fixtureModules = path.join(fixtureDirectory, "node_modules");
    linkModuleEntries(sourceModules, fixtureModules, new Set(["audiotranslate-control-center"]));
    linkModuleEntries(
      path.join(projectRoot, "src", "control-center", "node_modules"),
      path.join(fixtureDirectory, "src", "control-center", "node_modules"),
    );
    const fixtureDist = path.join(fixtureDirectory, excludedDist);
    assert.equal(fs.existsSync(fixtureDist), false);

    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--dry-run", "--json"],
      {
        cwd: fixtureDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_cache: path.join(fixtureDirectory, ".npm-cache"),
          npm_config_loglevel: "silent",
        },
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const jsonStart = result.stdout.lastIndexOf("[\n  {");
    assert.notEqual(jsonStart, -1, result.stdout);
    const report = JSON.parse(result.stdout.slice(jsonStart));
    const files = new Set(report[0].files.map((entry) => entry.path));

    assert.equal(fs.existsSync(path.join(fixtureDist, "index.html")), true);
    for (const requiredPath of [
      "bin/audiotranslate.js",
      "extension/manifest.json",
      "src/main-app.js",
      "src/overlay/index.html",
      "src/control-center/dist/index.html",
    ]) {
      assert.equal(files.has(requiredPath), true, `missing ${requiredPath}`);
    }
    assert.equal(files.has(".env"), false);
    assert.equal([...files].some((file) => file.startsWith("tests/")), false);
  } finally {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});
