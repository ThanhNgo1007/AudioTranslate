#!/usr/bin/env node

require("../src/cli")
  .main(process.argv.slice(2))
  .then((code) => {
    if (Number.isInteger(code)) process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
