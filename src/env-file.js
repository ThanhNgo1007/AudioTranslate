const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;
const documentState = new WeakMap();

function assertContents(contents) {
  if (typeof contents !== "string") throw new TypeError("Environment contents must be a string");
  return contents;
}

function findCommentIndex(value) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      if (quote === character) quote = null;
      else if (!quote) quote = character;
      continue;
    }
    if (!quote && character === "#") return index;
  }
  return -1;
}

function parseLine(raw, lineNumber) {
  if (/^\s*$/.test(raw)) return { type: "blank", lineNumber, raw };
  if (/^\s*#/.test(raw)) return { type: "comment", lineNumber, raw };

  const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/.exec(raw);
  if (!match) return { type: "unknown", lineNumber, raw };

  const commentIndex = findCommentIndex(match[4]);
  const beforeComment = commentIndex === -1 ? match[4] : match[4].slice(0, commentIndex);
  const trailingWhitespace = /\s*$/.exec(beforeComment)?.[0] || "";
  return {
    type: "assignment",
    lineNumber,
    raw,
    key: match[2],
    prefix: `${match[1]}${match[2]}${match[3]}`,
    comment:
      commentIndex === -1 ? "" : `${trailingWhitespace}${match[4].slice(commentIndex)}`,
  };
}

/**
 * Parses an env document without exposing assignment values on the returned object.
 * The original text is held in a WeakMap so JSON/logging the document is safe.
 */
function parseEnvDocument(contents) {
  const source = assertContents(contents);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = source.endsWith("\n");
  const rawLines = source === "" ? [] : source.split(/\r?\n/);
  if (trailingNewline) rawLines.pop();
  const lines = rawLines.map((raw, index) => parseLine(raw, index + 1));

  const publicEntries = lines.map((line) =>
    Object.freeze(
      line.type === "assignment"
        ? { type: line.type, lineNumber: line.lineNumber, key: line.key }
        : { type: line.type, lineNumber: line.lineNumber },
    ),
  );
  const document = Object.freeze({
    newline,
    trailingNewline,
    lineCount: lines.length,
    entries: Object.freeze(publicEntries),
    keys: Object.freeze(
      lines.filter((line) => line.type === "assignment").map((line) => line.key),
    ),
  });
  documentState.set(document, { source, lines });
  return document;
}

function documentFrom(value) {
  if (typeof value === "string") {
    const document = parseEnvDocument(value);
    return { document, ...documentState.get(document) };
  }
  const state = documentState.get(value);
  if (!state) throw new TypeError("Expected env contents or a document from parseEnvDocument()");
  return { document: value, ...state };
}

function validateKey(rawKey) {
  const key = String(rawKey);
  if (!ENV_KEY_PATTERN.test(key)) throw new Error(`Invalid environment key: ${key}`);
  return key;
}

function normalizeUpdates(rawUpdates) {
  if (rawUpdates === undefined || rawUpdates === null) return new Map();
  const entries = rawUpdates instanceof Map ? [...rawUpdates.entries()] : Object.entries(rawUpdates);
  const updates = new Map();
  for (const [rawKey, rawValue] of entries) {
    const key = validateKey(rawKey);
    if (rawValue === undefined) continue;
    updates.set(key, rawValue);
  }
  return updates;
}

function normalizeRemovals(options, updates) {
  const raw = options.removeKeys ?? options.remove ?? [];
  const values = typeof raw === "string" ? [raw] : [...raw];
  const removals = new Set(values.map(validateKey));
  for (const [key, value] of updates) {
    if (value === null) {
      removals.add(key);
      updates.delete(key);
    }
  }
  return removals;
}

function serializeValue(rawValue) {
  const value = String(rawValue);
  if (/[\u0000\r\n]/.test(value)) {
    throw new Error("Environment values must not contain NUL or newline characters");
  }
  if (value === "") return "";
  if (/^[^\s#'"`]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function joinLines(lines, newline, trailingNewline) {
  const joined = lines.join(newline);
  return trailingNewline && lines.length > 0 ? `${joined}${newline}` : joined;
}

/** Returns a printable env document with every parsed assignment value redacted. */
function redactEnv(contents, replacement = "[REDACTED]") {
  const { document, lines } = documentFrom(contents);
  const safeReplacement = String(replacement);
  if (/[\u0000\r\n]/.test(safeReplacement)) {
    throw new Error("Redaction marker must be a single line");
  }
  const redacted = lines.map((line) => {
    if (line.type !== "assignment") return line.raw;
    return `${line.prefix}${safeReplacement}${line.comment}`;
  });
  return joinLines(redacted, document.newline, document.trailingNewline);
}

/**
 * Updates exact assignment keys and optionally removes keys while preserving all
 * comments, unknown lines, ordering, newline style, and inline comments.
 * A null update is treated as a removal; undefined is ignored.
 */
function upsertEnvContents(contents, rawUpdates = {}, options = {}) {
  const { document, lines } = documentFrom(contents);
  const updates = normalizeUpdates(rawUpdates);
  const removals = normalizeRemovals(options, updates);
  const seen = new Set();
  const output = [];

  for (const line of lines) {
    if (line.type !== "assignment") {
      output.push(line.raw);
      continue;
    }
    if (removals.has(line.key)) continue;
    if (!updates.has(line.key)) {
      output.push(line.raw);
      continue;
    }
    output.push(`${line.prefix}${serializeValue(updates.get(line.key))}${line.comment}`);
    seen.add(line.key);
  }

  for (const [key, value] of updates) {
    if (!seen.has(key) && !removals.has(key)) output.push(`${key}=${serializeValue(value)}`);
  }

  return joinLines(output, document.newline, document.trailingNewline);
}

function temporaryPathFor(filePath, randomBytes = crypto.randomBytes) {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const nonce = randomBytes(8).toString("hex");
  return path.join(directory, `.${basename}.${process.pid}.${nonce}.tmp`);
}

function hashContents(contents) {
  return crypto.createHash("sha256").update(assertContents(contents), "utf8").digest("hex");
}

function fileIdentity(stats) {
  if (!stats) return null;
  const device = stats.dev;
  const inode = stats.ino;
  if (device === undefined || inode === undefined || String(inode) === "0") return null;
  return `${String(device)}:${String(inode)}`;
}

function createEnvFileVersion(contents, options = {}) {
  const source = assertContents(contents);
  const exists = options.exists === true ? true : options.exists === false ? false : null;
  return Object.freeze({
    version: 1,
    exists,
    bytes: Buffer.byteLength(source),
    sha256: hashContents(source),
    identity: options.identity || null,
    modifiedAtMs: Number.isFinite(options.modifiedAtMs) ? options.modifiedAtMs : null,
  });
}

/** Reads contents and an opaque comparison version without exposing contents in the version. */
function readEnvFileState(filePath, options = {}) {
  const targetPath = path.resolve(String(filePath));
  const fsImpl = options.fsImpl || fs;
  let descriptor;
  try {
    descriptor = fsImpl.openSync(targetPath, "r");
    const contents = fsImpl.readFileSync(descriptor, { encoding: "utf8" });
    const stats = fsImpl.fstatSync(descriptor);
    return Object.freeze({
      contents,
      version: createEnvFileVersion(contents, {
        exists: true,
        identity: fileIdentity(stats),
        modifiedAtMs: stats.mtimeMs,
      }),
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return Object.freeze({
      contents: "",
      version: createEnvFileVersion("", { exists: false }),
    });
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

function assertExpectedVersion(targetPath, expectedVersion, fsImpl) {
  if (!expectedVersion || typeof expectedVersion !== "object") {
    throw new TypeError("expectedVersion must be an environment file version");
  }
  const current = readEnvFileState(targetPath, { fsImpl }).version;
  const existenceChanged =
    typeof expectedVersion.exists === "boolean" && current.exists !== expectedVersion.exists;
  const identityChanged =
    expectedVersion.identity && current.identity && expectedVersion.identity !== current.identity;
  const contentsChanged =
    expectedVersion.sha256 !== current.sha256 || expectedVersion.bytes !== current.bytes;
  if (!existenceChanged && !identityChanged && !contentsChanged) return;

  const error = new Error(
    ".env đã được chương trình khác thay đổi trong lúc setup; không ghi đè thay đổi bên ngoài.",
  );
  error.code = "ENV_FILE_CONFLICT";
  error.committed = false;
  throw error;
}

function versionsEqual(first, second) {
  if (!first || !second || first.exists !== second.exists) return false;
  if (first.sha256 !== second.sha256 || first.bytes !== second.bytes) return false;
  if (first.identity && second.identity && first.identity !== second.identity) return false;
  return true;
}

function parseLockOwner(contents) {
  const fields = new Map();
  for (const line of String(contents).split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const rawPid = Number(fields.get("pid"));
  const startedAtMs = Date.parse(fields.get("startedAt") || "");
  return {
    pid: Number.isSafeInteger(rawPid) && rawPid > 0 ? rawPid : null,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    hostname: fields.get("hostname") || null,
    nonce: fields.get("nonce") || null,
  };
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    return null;
  }
}

function lockIsStale(state, options) {
  const owner = parseLockOwner(state.contents);
  const nowMs = options.now();
  const timestamp = owner.startedAtMs ?? state.version.modifiedAtMs;
  const ageMs = Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : 0;
  if (owner.hostname && owner.hostname !== options.hostname) return false;
  const sameHost = !owner.hostname || owner.hostname === options.hostname;
  const alive = owner.pid && sameHost ? options.isProcessAlive(owner.pid) : null;
  if (alive === true) return false;
  if (alive === false) return true;
  return ageMs >= options.staleLockMs;
}

function lockError() {
  const error = new Error(
    "Một phiên setup khác đang cập nhật .env. Hãy hoàn tất hoặc đóng phiên đó rồi thử lại.",
  );
  error.code = "ENV_FILE_LOCKED";
  error.committed = false;
  return error;
}

function cleanupFailure(cause, committed) {
  const error = new Error(
    committed
      ? "Cấu hình đã được lưu nhưng không thể xóa file lock; hãy kiểm tra .env.lock trước lần setup tiếp theo."
      : "Không thể dọn file lock của setup.",
    { cause },
  );
  error.code = "ENV_LOCK_CLEANUP_FAILED";
  error.committed = committed;
  return error;
}

function readLockState(lockPath, fsImpl) {
  return readEnvFileState(lockPath, { fsImpl });
}

function tryRemoveStaleGuard(reclaimPath, options) {
  const candidate = readLockState(reclaimPath, options.fsImpl);
  if (!candidate.version.exists) return true;
  if (!lockIsStale(candidate, options)) return false;

  const candidateOwner = parseLockOwner(candidate.contents);
  const current = readLockState(reclaimPath, options.fsImpl);
  if (!current.version.exists) return true;
  const currentOwner = parseLockOwner(current.contents);
  if (
    !versionsEqual(candidate.version, current.version) ||
    (candidateOwner.nonce && candidateOwner.nonce !== currentOwner.nonce)
  ) {
    return false;
  }
  options.fsImpl.unlinkSync(reclaimPath);
  return true;
}

function acquireReclaimGuard(reclaimPath, options) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return options.fsImpl.openSync(reclaimPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (!tryRemoveStaleGuard(reclaimPath, options)) return undefined;
    }
  }
  return undefined;
}

function tryReclaimStaleLock(lockPath, options) {
  const reclaimPath = `${lockPath}.reclaim`;
  let reclaimDescriptor = acquireReclaimGuard(reclaimPath, options);
  if (reclaimDescriptor === undefined) return false;

  let reclaimError;
  let reclaimed = false;
  try {
    options.fsImpl.writeFileSync(
      reclaimDescriptor,
      `pid=${process.pid}\nstartedAt=${new Date(options.now()).toISOString()}\n` +
        `hostname=${options.hostname}\nnonce=${options.nonce}\n`,
      { encoding: "utf8" },
    );
    const candidate = readLockState(lockPath, options.fsImpl);
    if (!candidate.version.exists) {
      reclaimed = true;
    } else if (lockIsStale(candidate, options)) {
      const current = readLockState(lockPath, options.fsImpl);
      if (versionsEqual(candidate.version, current.version)) {
        options.fsImpl.unlinkSync(lockPath);
        reclaimed = true;
      }
    }
  } catch (error) {
    reclaimError = error;
  }

  let cleanupError;
  try {
    options.fsImpl.closeSync(reclaimDescriptor);
    reclaimDescriptor = undefined;
  } catch (error) {
    cleanupError = error;
  }
  try {
    unlinkOwnedLock(reclaimPath, options.nonce, options.fsImpl);
  } catch (error) {
    if (!cleanupError) cleanupError = error;
  }
  if (reclaimDescriptor !== undefined) {
    try {
      options.fsImpl.closeSync(reclaimDescriptor);
    } catch {
      // Preserve the first recovery/cleanup error.
    }
  }
  if (reclaimError) throw reclaimError;
  if (cleanupError) throw cleanupFailure(cleanupError, false);
  return reclaimed;
}

function unlinkOwnedLock(lockPath, nonce, fsImpl) {
  const state = readLockState(lockPath, fsImpl);
  if (!state.version.exists || parseLockOwner(state.contents).nonce !== nonce) {
    const error = new Error("Quyền sở hữu .env.lock đã thay đổi; lock mới không bị xóa.");
    error.code = "ENV_LOCK_OWNERSHIP_LOST";
    throw error;
  }
  fsImpl.unlinkSync(lockPath);
}

async function withEnvFileLock(filePath, operation, options = {}) {
  if (typeof operation !== "function") throw new TypeError("Environment lock requires an operation");
  const targetPath = path.resolve(String(filePath));
  const lockPath = `${targetPath}.lock`;
  const fsImpl = options.fsImpl || fs;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const nonce = randomBytes(16).toString("hex");
  const now = options.now || Date.now;
  const lockOptions = {
    fsImpl,
    hostname: options.hostname || os.hostname(),
    isProcessAlive: options.isProcessAlive || defaultIsProcessAlive,
    nonce,
    now,
    staleLockMs: options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
  };
  if (!Number.isFinite(lockOptions.staleLockMs) || lockOptions.staleLockMs < 0) {
    throw new TypeError("staleLockMs must be a non-negative finite number");
  }
  let descriptor;
  for (let attempt = 0; attempt < 3 && descriptor === undefined; attempt += 1) {
    try {
      descriptor = fsImpl.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (!tryReclaimStaleLock(lockPath, lockOptions)) throw lockError();
    }
  }
  if (descriptor === undefined) throw lockError();

  let result;
  let operationError;
  try {
    fsImpl.writeFileSync(
      descriptor,
      `pid=${process.pid}\nstartedAt=${new Date(now()).toISOString()}\n` +
        `hostname=${lockOptions.hostname}\nnonce=${nonce}\n`,
      { encoding: "utf8" },
    );
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  let cleanupError;
  try {
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    cleanupError = error;
  }
  try {
    unlinkOwnedLock(lockPath, nonce, fsImpl);
  } catch (error) {
    if (!cleanupError) cleanupError = error;
  }
  if (descriptor !== undefined) {
    try {
      fsImpl.closeSync(descriptor);
    } catch {
      // Preserve the operation or cleanup error below.
    }
  }

  if (operationError) throw operationError;
  if (cleanupError) throw cleanupFailure(cleanupError, true);
  return result;
}

/** Atomically replaces a file using a mode-0600 temporary file in the same directory. */
function writeEnvAtomic(filePath, contents, options = {}) {
  const targetPath = path.resolve(String(filePath));
  const safeContents = assertContents(contents);
  const fsImpl = options.fsImpl || fs;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  let tempPath;
  let descriptor;

  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      tempPath = temporaryPathFor(targetPath, randomBytes);
      try {
        descriptor = fsImpl.openSync(tempPath, "wx", 0o600);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST" || attempt === 7) throw error;
      }
    }
    fsImpl.writeFileSync(descriptor, safeContents, { encoding: "utf8" });
    fsImpl.fsyncSync?.(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    try {
      fsImpl.chmodSync(tempPath, 0o600);
    } catch {
      // Windows and some filesystems do not implement POSIX modes.
    }
    if (options.expectedVersion !== undefined) {
      assertExpectedVersion(targetPath, options.expectedVersion, fsImpl);
    }
    fsImpl.renameSync(tempPath, targetPath);
    tempPath = undefined;
    try {
      fsImpl.chmodSync(targetPath, 0o600);
    } catch {
      // Best effort after the atomic replace as well.
    }
    return Object.freeze({ path: targetPath, bytesWritten: Buffer.byteLength(safeContents) });
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fsImpl.closeSync(descriptor);
      } catch {
        // Continue cleanup and preserve the original failure.
      }
    }
    if (tempPath) {
      try {
        fsImpl.unlinkSync(tempPath);
      } catch {
        // Only a private temporary file is eligible for cleanup.
      }
    }
    throw error;
  }
}

module.exports = {
  createEnvFileVersion,
  parseEnvDocument,
  readEnvFileState,
  redactEnv,
  upsertEnvContents,
  withEnvFileLock,
  writeEnvAtomic,
};
