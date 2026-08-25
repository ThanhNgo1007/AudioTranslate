const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const sourceRoots = ["bin", "extension", "scripts", "src", "tests"];
const ignoredDirectories = new Set(["node_modules", "dist", "coverage"]);
const javascriptFiles = [];

function collect(directory) {
  const absoluteDirectory = path.join(projectRoot, directory);
  if (!fs.existsSync(absoluteDirectory)) return;
  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = path.join(directory, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) collect(relativePath);
    else if (entry.isFile() && entry.name.endsWith(".js")) javascriptFiles.push(relativePath);
  }
}

for (const root of sourceRoots) collect(root);

let failed = false;
for (const file of javascriptFiles.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || `${file}: syntax check failed\n`);
  }
}

for (const jsonFile of ["package.json", "extension/manifest.json"]) {
  try {
    JSON.parse(fs.readFileSync(path.join(projectRoot, jsonFile), "utf8"));
  } catch (error) {
    failed = true;
    process.stderr.write(`${jsonFile}: ${error.message}\n`);
  }
}

if (failed) process.exitCode = 1;
else process.stdout.write(`Checked ${javascriptFiles.length} JavaScript files and 2 JSON manifests.\n`);
