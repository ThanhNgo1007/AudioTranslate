const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SecretStore, resolveSecret, resolveSecretStatus } = require("../src/secret-store");

function fakeSafeStorage(backend = "platform") {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, ""),
  };
}

test("SecretStore persists ciphertext and never plaintext", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audio-translate-secrets-"));
  const store = new SecretStore({ safeStorage: fakeSafeStorage(), directory });
  const key = "AIza-test-key-that-must-stay-private";
  const status = store.set("gemini", key);
  assert.equal(status.configured, true);
  assert.equal(status.storage, "encrypted");
  const disk = fs.readFileSync(path.join(directory, "gemini.secret.json"), "utf8");
  assert.equal(disk.includes(key), false);
  assert.equal(store.get("gemini"), key);
  assert.deepEqual(Object.keys(status).sort(), ["backend", "configured", "provider", "storage"]);
});

test("SecretStore refuses persistent basic_text storage on Linux-like backends", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audio-translate-secrets-"));
  const store = new SecretStore({ safeStorage: fakeSafeStorage("basic_text"), directory });
  const status = store.set("gemini", "AIza-session-only-key");
  assert.equal(status.storage, "session-only");
  assert.equal(store.get("gemini"), "AIza-session-only-key");
  assert.equal(fs.existsSync(path.join(directory, "gemini.secret.json")), false);
});

test("SecretStore falls back to session-only when safeStorage probing fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audio-translate-secrets-"));
  const store = new SecretStore({
    safeStorage: {
      isEncryptionAvailable() {
        throw new Error("native backend detail");
      },
    },
    directory,
  });
  const status = store.set("gemini", "AIza-session-fallback-key");
  assert.equal(status.storage, "session-only");
  assert.equal(store.get("gemini"), "AIza-session-fallback-key");
});

test("SecretStore rejects malformed or oversized ciphertext without exposing its contents", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audio-translate-secrets-"));
  const store = new SecretStore({ safeStorage: fakeSafeStorage(), directory });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "gemini.secret.json"),
    JSON.stringify({ version: 1, provider: "gemini", ciphertext: "not base64! private-value" }),
  );
  assert.throws(
    () => store.get("gemini"),
    (error) =>
      error.message === "Unable to decrypt the stored API key" &&
      !error.message.includes("private-value") &&
      error.cause === undefined,
  );
});

test("environment fallback is accepted without being returned in status or overriding safeStorage", () => {
  const fallback = "AIza-environment-fallback-key";
  const unavailableStore = {
    get() {
      throw new Error("credential backend failed");
    },
    status() {
      throw new Error("credential backend failed");
    },
  };
  assert.equal(resolveSecret(unavailableStore, "gemini", fallback), fallback);
  const status = resolveSecretStatus(unavailableStore, "gemini", fallback);
  assert.deepEqual(status, {
    provider: "gemini",
    configured: true,
    storage: "environment",
    backend: "environment",
  });
  assert.doesNotMatch(JSON.stringify(status), new RegExp(fallback));

  const stored = {
    get: () => "AIza-safe-storage-key",
    status: () => ({
      provider: "gemini",
      configured: true,
      storage: "encrypted",
      backend: "platform",
    }),
  };
  assert.equal(resolveSecret(stored, "gemini", fallback), "AIza-safe-storage-key");
  assert.equal(resolveSecretStatus(stored, "gemini", fallback).storage, "encrypted");
});
