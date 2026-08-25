const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseEnvDocument,
  readEnvFileState,
  redactEnv,
  upsertEnvContents,
  withEnvFileLock,
  writeEnvAtomic,
} = require("../src/env-file");

test("parseEnvDocument reports structure without exposing assignment values", () => {
  const secret = "must-not-serialize";
  const document = parseEnvDocument(`# heading\r\nTOKEN=${secret}\r\nUNKNOWN LINE\r\n`);

  assert.equal(document.newline, "\r\n");
  assert.equal(document.trailingNewline, true);
  assert.deepEqual(document.keys, ["TOKEN"]);
  assert.deepEqual(document.entries, [
    { type: "comment", lineNumber: 1 },
    { type: "assignment", lineNumber: 2, key: "TOKEN" },
    { type: "unknown", lineNumber: 3 },
  ]);
  assert.doesNotMatch(JSON.stringify(document), new RegExp(secret));
});

test("upsert preserves comments, unknown lines, formatting and newline style", () => {
  const source = [
    "# keep this comment",
    " export AZURE_SPEECH_KEY = old-secret  # key note",
    "UNRECOGNIZED value",
    "AUDIOTRANSLATE_PORT=43765",
    "",
  ].join("\r\n");

  const updated = upsertEnvContents(source, {
    AZURE_SPEECH_KEY: "new-secret",
    AUDIOTRANSLATE_PROVIDER: "azure",
  });

  assert.equal(
    updated,
    [
      "# keep this comment",
      " export AZURE_SPEECH_KEY = new-secret  # key note",
      "UNRECOGNIZED value",
      "AUDIOTRANSLATE_PORT=43765",
      "AUDIOTRANSLATE_PROVIDER=azure",
      "",
    ].join("\r\n"),
  );
});

test("upsert updates duplicate exact keys and supports explicit removals", () => {
  const source = "TOKEN=old\nTOKEN=stale\nTOKEN_SUFFIX=untouched\nREMOVE=one\nREMOVE=two";
  const updated = upsertEnvContents(
    source,
    { TOKEN: "fresh", ADDED: "value with spaces", NULL_REMOVAL: null },
    { removeKeys: ["REMOVE"] },
  );

  assert.equal(
    updated,
    'TOKEN=fresh\nTOKEN=fresh\nTOKEN_SUFFIX=untouched\nADDED="value with spaces"',
  );
});

test("redactEnv removes all parsed values while preserving safe context", () => {
  const secret = "secret-value";
  const source = `# context\nTOKEN="${secret}#inside" # keep\nEMPTY=\nUNKNOWN LINE\n`;
  const redacted = redactEnv(source);

  assert.equal(
    redacted,
    "# context\nTOKEN=[REDACTED] # keep\nEMPTY=[REDACTED]\nUNKNOWN LINE\n",
  );
  assert.doesNotMatch(redacted, new RegExp(secret));
});

test("invalid keys and multiline values fail without including the value", () => {
  const secret = "private\nmaterial";
  assert.throws(() => upsertEnvContents("", { "NOT-A-KEY": "x" }), /Invalid environment key/);
  assert.throws(
    () => upsertEnvContents("TOKEN=old", { TOKEN: secret }),
    (error) => {
      assert.match(error.message, /must not contain/);
      assert.doesNotMatch(error.message, /private|material/);
      return true;
    },
  );
});

test("writeEnvAtomic replaces through a same-directory mode-0600 file", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-env-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  fs.writeFileSync(envPath, "TOKEN=old\n", { mode: 0o644 });

  const result = writeEnvAtomic(envPath, "TOKEN=new\n", {
    randomBytes: () => Buffer.from("0123456789abcdef", "hex"),
  });

  assert.equal(fs.readFileSync(envPath, "utf8"), "TOKEN=new\n");
  assert.equal(result.path, envPath);
  assert.equal(result.bytesWritten, Buffer.byteLength("TOKEN=new\n"));
  if (process.platform !== "win32") assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), [".env"]);
});

test("writeEnvAtomic keeps the original and removes its temp file when rename fails", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-env-fail-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  fs.writeFileSync(envPath, "TOKEN=original\n");
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = () => {
    const error = new Error("rename rejected");
    error.code = "EACCES";
    throw error;
  };

  assert.throws(
    () =>
      writeEnvAtomic(envPath, "TOKEN=replacement\n", {
        fsImpl,
        randomBytes: () => Buffer.from("fedcba9876543210", "hex"),
      }),
    /rename rejected/,
  );
  assert.equal(fs.readFileSync(envPath, "utf8"), "TOKEN=original\n");
  assert.deepEqual(fs.readdirSync(directory), [".env"]);
});

test("withEnvFileLock rejects a concurrent writer and always removes its private lock", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-env-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");

  await withEnvFileLock(envPath, async () => {
    assert.deepEqual(fs.readdirSync(directory), [".env.lock"]);
    await assert.rejects(
      () => withEnvFileLock(envPath, async () => {}),
      (error) => error.code === "ENV_FILE_LOCKED" && /setup khác đang cập nhật/.test(error.message),
    );
  });

  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(await withEnvFileLock(envPath, async () => "released"), "released");
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("writeEnvAtomic preserves a non-cooperating external edit and reports a conflict", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-env-conflict-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  fs.writeFileSync(envPath, "BASE=before\n");
  const expectedState = readEnvFileState(envPath);

  fs.writeFileSync(envPath, "BASE=external\nUNRELATED=preserve\n");

  assert.throws(
    () =>
      writeEnvAtomic(envPath, "BASE=wizard\n", {
        expectedVersion: expectedState.version,
        randomBytes: () => Buffer.from("0011223344556677", "hex"),
      }),
    (error) =>
      error.code === "ENV_FILE_CONFLICT" &&
      error.committed === false &&
      !/external|wizard|UNRELATED/.test(error.message),
  );
  assert.equal(fs.readFileSync(envPath, "utf8"), "BASE=external\nUNRELATED=preserve\n");
  assert.deepEqual(fs.readdirSync(directory), [".env"]);
});

test("withEnvFileLock reclaims an old lock whose owner process is gone", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-env-stale-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  const lockPath = `${envPath}.lock`;
  fs.writeFileSync(
    lockPath,
    "pid=424242\nstartedAt=2020-01-01T00:00:00.000Z\nnonce=old-owner\n",
  );

  let ran = false;
  const result = await withEnvFileLock(
    envPath,
    async () => {
      ran = true;
      return "recovered";
    },
    {
      isProcessAlive: () => false,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      randomBytes: () => Buffer.from("8899aabbccddeeff", "hex"),
    },
  );

  assert.equal(result, "recovered");
  assert.equal(ran, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test("withEnvFileLock never reclaims an old lock while its owner is alive", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-env-active-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  const lockPath = `${envPath}.lock`;
  const activeContents =
    `pid=${process.pid}\nstartedAt=2020-01-01T00:00:00.000Z\nnonce=active-owner\n`;
  fs.writeFileSync(lockPath, activeContents);

  await assert.rejects(
    () =>
      withEnvFileLock(envPath, async () => "must-not-run", {
        isProcessAlive: () => true,
        now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      }),
    (error) => error.code === "ENV_FILE_LOCKED" && error.committed === false,
  );
  assert.equal(fs.readFileSync(lockPath, "utf8"), activeContents);
});

test("withEnvFileLock does not reclaim an old lock owned on another host", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-env-remote-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  const lockPath = `${envPath}.lock`;
  const remoteContents =
    "pid=515151\nstartedAt=2020-01-01T00:00:00.000Z\n" +
    "hostname=another-host\nnonce=remote-owner\n";
  fs.writeFileSync(lockPath, remoteContents);

  await assert.rejects(
    () =>
      withEnvFileLock(envPath, async () => "must-not-run", {
        hostname: "this-host",
        isProcessAlive: () => {
          throw new Error("A remote PID must not be probed locally");
        },
        now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      }),
    (error) => error.code === "ENV_FILE_LOCKED" && error.committed === false,
  );
  assert.equal(fs.readFileSync(lockPath, "utf8"), remoteContents);
});

test("withEnvFileLock reclaims an orphaned stale reclaim guard", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-env-stale-guard-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  const lockPath = `${envPath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  fs.writeFileSync(
    lockPath,
    "pid=410001\nstartedAt=2020-01-01T00:00:00.000Z\nhostname=this-host\nnonce=old-lock\n",
  );
  fs.writeFileSync(
    reclaimPath,
    "pid=410002\nstartedAt=2020-01-01T00:00:00.000Z\nhostname=this-host\nnonce=dead-reclaimer\n",
  );

  const result = await withEnvFileLock(envPath, async () => "recovered", {
    hostname: "this-host",
    isProcessAlive: () => false,
    now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    randomBytes: () => Buffer.from("102030405060708090a0b0c0d0e0f000", "hex"),
  });

  assert.equal(result, "recovered");
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(reclaimPath), false);
});

test("withEnvFileLock preserves an active reclaim guard", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-env-active-guard-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  const lockPath = `${envPath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  fs.writeFileSync(
    lockPath,
    "pid=420001\nstartedAt=2020-01-01T00:00:00.000Z\nhostname=this-host\nnonce=old-lock\n",
  );
  const guardContents =
    `pid=${process.pid}\nstartedAt=2020-01-01T00:00:00.000Z\n` +
    "hostname=this-host\nnonce=active-reclaimer\n";
  fs.writeFileSync(reclaimPath, guardContents);

  await assert.rejects(
    () =>
      withEnvFileLock(envPath, async () => "must-not-run", {
        hostname: "this-host",
        isProcessAlive: (pid) => pid === process.pid,
        now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      }),
    (error) => error.code === "ENV_FILE_LOCKED" && error.committed === false,
  );
  assert.equal(fs.readFileSync(reclaimPath, "utf8"), guardContents);
});

test("withEnvFileLock preserves a reclaim guard owned on another host", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-env-remote-guard-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  const lockPath = `${envPath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  fs.writeFileSync(
    lockPath,
    "pid=430001\nstartedAt=2020-01-01T00:00:00.000Z\nhostname=this-host\nnonce=old-lock\n",
  );
  const guardContents =
    "pid=430002\nstartedAt=2020-01-01T00:00:00.000Z\n" +
    "hostname=another-host\nnonce=remote-reclaimer\n";
  fs.writeFileSync(reclaimPath, guardContents);

  await assert.rejects(
    () =>
      withEnvFileLock(envPath, async () => "must-not-run", {
        hostname: "this-host",
        isProcessAlive: () => false,
        now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      }),
    (error) => error.code === "ENV_FILE_LOCKED" && error.committed === false,
  );
  assert.equal(fs.readFileSync(reclaimPath, "utf8"), guardContents);
});

test("stale-lock cleanup does not unlink a reclaim guard whose nonce changed", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-env-guard-owner-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  const lockPath = `${envPath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  fs.writeFileSync(
    lockPath,
    "pid=440001\nstartedAt=2020-01-01T00:00:00.000Z\nhostname=this-host\nnonce=active-lock\n",
  );
  const replacement =
    `pid=${process.pid}\nstartedAt=2026-01-01T00:00:00.000Z\n` +
    "hostname=this-host\nnonce=replacement-owner\n";
  let replaced = false;

  await assert.rejects(
    () =>
      withEnvFileLock(envPath, async () => "must-not-run", {
        hostname: "this-host",
        isProcessAlive: () => {
          if (!replaced) {
            replaced = true;
            fs.writeFileSync(reclaimPath, replacement);
          }
          return true;
        },
        now: () => Date.parse("2026-01-01T00:00:00.000Z"),
        randomBytes: () => Buffer.from("ffeeddccbbaa00998877665544332211", "hex"),
      }),
    (error) =>
      error.code === "ENV_LOCK_CLEANUP_FAILED" &&
      error.committed === false &&
      error.cause?.code === "ENV_LOCK_OWNERSHIP_LOST",
  );
  assert.equal(fs.readFileSync(reclaimPath, "utf8"), replacement);
});

test("withEnvFileLock marks lock cleanup failure after a successful commit", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audiotranslate-env-cleanup-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  const fsImpl = Object.create(fs);
  fsImpl.unlinkSync = (targetPath) => {
    if (targetPath === `${envPath}.lock`) {
      const error = new Error("cleanup rejected");
      error.code = "EACCES";
      throw error;
    }
    return fs.unlinkSync(targetPath);
  };

  await assert.rejects(
    () =>
      withEnvFileLock(
        envPath,
        async () => {
          fs.writeFileSync(envPath, "TOKEN=committed\n");
          return "saved";
        },
        { fsImpl },
      ),
    (error) =>
      error.code === "ENV_LOCK_CLEANUP_FAILED" &&
      error.committed === true &&
      error.cause?.code === "EACCES",
  );
  assert.equal(fs.readFileSync(envPath, "utf8"), "TOKEN=committed\n");
  assert.equal(fs.existsSync(`${envPath}.lock`), true);
});
