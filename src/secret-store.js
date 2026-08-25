const fs = require("node:fs");
const path = require("node:path");

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const MAX_SECRET_LENGTH = 16_384;
const MAX_CIPHERTEXT_LENGTH = 64 * 1024;

function validateProvider(provider) {
  const value = String(provider || "").toLowerCase();
  if (!PROVIDER_PATTERN.test(value)) throw new Error("Invalid secret provider id");
  return value;
}

function validateSecret(secret) {
  const value = String(secret || "");
  if (value.length < 8 || value.length > MAX_SECRET_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("API key is empty or invalid");
  }
  return value;
}

function decodeCiphertext(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CIPHERTEXT_LENGTH ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error("Stored secret ciphertext is invalid");
  }
  return Buffer.from(value, "base64");
}

class SecretStore {
  constructor(options) {
    if (!options?.safeStorage) throw new TypeError("safeStorage is required");
    if (!options?.directory) throw new TypeError("secret directory is required");
    this.safeStorage = options.safeStorage;
    this.directory = options.directory;
    this.fs = options.fs || fs;
    this.sessionSecrets = new Map();
  }

  backend() {
    try {
      if (!this.safeStorage.isEncryptionAvailable()) return "unavailable";
      const backend = String(this.safeStorage.getSelectedStorageBackend?.() || "platform");
      return backend.length <= 64 ? backend : "unknown";
    } catch {
      return "unavailable";
    }
  }

  canPersist() {
    const backend = this.backend();
    return backend !== "unavailable" && backend !== "basic_text";
  }

  secretPath(provider) {
    return path.join(this.directory, `${validateProvider(provider)}.secret.json`);
  }

  set(provider, candidate) {
    const id = validateProvider(provider);
    const secret = validateSecret(candidate);
    if (!this.canPersist()) {
      this.sessionSecrets.set(id, secret);
      return this.status(id);
    }

    const ciphertext = this.safeStorage.encryptString(secret);
    if (!Buffer.isBuffer(ciphertext) && !ArrayBuffer.isView(ciphertext)) {
      throw new Error("Unable to encrypt the API key");
    }
    if (ciphertext.byteLength <= 0 || ciphertext.byteLength > MAX_CIPHERTEXT_LENGTH / 2) {
      throw new Error("Encrypted API key has an invalid size");
    }
    const record = {
      version: 1,
      provider: id,
      ciphertext: Buffer.from(ciphertext).toString("base64"),
      updatedAt: new Date().toISOString(),
    };
    this.fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.secretPath(id);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    try {
      this.fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      this.fs.renameSync(temporary, destination);
      try {
        this.fs.chmodSync(destination, 0o600);
      } catch {
        // POSIX modes are best effort on Windows.
      }
    } catch (error) {
      try {
        this.fs.unlinkSync(temporary);
      } catch {
        // Nothing to clean up.
      }
      throw error;
    }
    this.sessionSecrets.delete(id);
    return this.status(id);
  }

  get(provider) {
    const id = validateProvider(provider);
    const inMemory = this.sessionSecrets.get(id);
    if (inMemory) return inMemory;
    if (!this.canPersist()) return "";
    try {
      const serialized = this.fs.readFileSync(this.secretPath(id), "utf8");
      if (serialized.length > MAX_CIPHERTEXT_LENGTH) {
        throw new Error("Stored secret record is too large");
      }
      const record = JSON.parse(serialized);
      if (record?.version !== 1 || record?.provider !== id || typeof record.ciphertext !== "string") {
        throw new Error("Stored secret record is invalid");
      }
      return validateSecret(this.safeStorage.decryptString(decodeCiphertext(record.ciphertext)));
    } catch (error) {
      if (error.code === "ENOENT") return "";
      // Do not attach the platform error as a cause: some credential backends include
      // sensitive context in their native error objects.
      throw new Error("Unable to decrypt the stored API key");
    }
  }

  has(provider) {
    try {
      return Boolean(this.get(provider));
    } catch {
      return false;
    }
  }

  delete(provider) {
    const id = validateProvider(provider);
    this.sessionSecrets.delete(id);
    try {
      this.fs.unlinkSync(this.secretPath(id));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this.status(id);
  }

  status(provider) {
    const id = validateProvider(provider);
    return {
      provider: id,
      configured: this.has(id),
      storage: this.canPersist() ? "encrypted" : "session-only",
      backend: this.backend(),
    };
  }
}

function validFallbackSecret(candidate) {
  try {
    return validateSecret(candidate);
  } catch {
    return "";
  }
}

function resolveSecret(store, provider, fallbackCandidate = "") {
  const fallback = validFallbackSecret(fallbackCandidate);
  try {
    return store?.get(provider) || fallback;
  } catch {
    return fallback;
  }
}

function resolveSecretStatus(store, provider, fallbackCandidate = "") {
  const id = validateProvider(provider);
  const unavailable = {
    provider: id,
    configured: false,
    storage: "unavailable",
    backend: "unavailable",
  };
  let stored = unavailable;
  try {
    if (store) stored = store.status(id);
  } catch {
    stored = unavailable;
  }
  if (stored.configured || !validFallbackSecret(fallbackCandidate)) return stored;
  return {
    provider: id,
    configured: true,
    storage: "environment",
    backend: "environment",
  };
}

module.exports = {
  SecretStore,
  resolveSecret,
  resolveSecretStatus,
  validateProvider,
  validateSecret,
};
