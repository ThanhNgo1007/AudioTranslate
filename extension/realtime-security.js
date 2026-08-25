(function exposeRealtimeSecurity(root, factory) {
  const api = Object.freeze(factory());
  if (typeof module === "object" && module.exports) module.exports = api;
  else Object.defineProperty(root, "AudioTranslateSecurity", { value: api });
})(typeof globalThis === "object" ? globalThis : this, () => {
  const MAX_PREROLL_AGE_MS = 1000;
  const MAX_PREROLL_BYTES = 32_000;
  const MAX_STATUS_CHARS = 320;
  const TOKEN_STORAGE_KEY = "audioTranslatePairingToken";
  const AUTH_SCHEME = "hmac-sha256-v1";

  function base64Url(bytes) {
    let binary = "";
    for (const value of bytes) binary += String.fromCharCode(value);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function constantTimeStringEqual(left, right) {
    const a = String(left || "");
    const b = String(right || "");
    let difference = a.length ^ b.length;
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
    }
    return difference === 0;
  }

  async function hmacProof(token, payload, subtle = globalThis.crypto?.subtle) {
    if (!subtle) throw new Error("Trình duyệt không hỗ trợ xác thực HMAC");
    const encoder = new TextEncoder();
    const key = await subtle.importKey(
      "raw",
      encoder.encode(validatePairingToken(token)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await subtle.sign("HMAC", key, encoder.encode(payload));
    return base64Url(new Uint8Array(signature));
  }

  async function verifyServerAuthentication(authentication, token, subtle) {
    if (
      authentication?.scheme !== AUTH_SCHEME ||
      typeof authentication.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{24,128}$/.test(authentication.nonce)
    ) {
      return false;
    }
    const expected = await hmacProof(token, `ATR1|server|${authentication.nonce}`, subtle);
    return constantTimeStringEqual(expected, authentication.serverProof);
  }

  async function createClientAuthentication(authentication, token, cryptoObject = globalThis.crypto) {
    if (!cryptoObject?.getRandomValues) throw new Error("Không thể tạo nonce xác thực");
    if (!(await verifyServerAuthentication(authentication, token, cryptoObject.subtle))) {
      throw new Error("Local app không chứng minh được pairing secret; đã chặn gửi audio");
    }
    const nonceBytes = new Uint8Array(24);
    cryptoObject.getRandomValues(nonceBytes);
    const clientNonce = base64Url(nonceBytes);
    const clientProof = await hmacProof(
      token,
      `ATR1|client|${authentication.nonce}|${clientNonce}`,
      cryptoObject.subtle,
    );
    return Object.freeze({ scheme: AUTH_SCHEME, clientNonce, clientProof });
  }

  function assertPlainObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} không hợp lệ`);
    }
  }

  function assertOnlyKeys(value, allowed, label) {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw new Error(`${label} chứa trường không được hỗ trợ`);
    }
  }

  function validateEndpoint(value) {
    const endpoint = String(value || "ws://127.0.0.1:43765");
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error("Local WebSocket không hợp lệ");
    }
    const port = Number(parsed.port);
    if (
      parsed.protocol !== "ws:" ||
      parsed.hostname !== "127.0.0.1" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error("Endpoint phải là ws://127.0.0.1:<port>");
    }
    return `ws://127.0.0.1:${port}`;
  }

  function validatePairingToken(value, options = {}) {
    const token = String(value || "").trim();
    if (!token && options.allowEmpty === true) return "";
    if (!token) throw new Error("Pairing token là bắt buộc để xác thực local app");
    if (token.length < 16 || token.length > 512 || !/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
      throw new Error("Pairing token không đúng định dạng");
    }
    return token;
  }

  function sanitizeCaptureSettings(input) {
    assertPlainObject(input, "Cấu hình capture");
    assertOnlyKeys(
      input,
      new Set(["endpoint", "token"]),
      "Cấu hình capture",
    );
    return Object.freeze({
      endpoint: validateEndpoint(input.endpoint),
      token: validatePairingToken(input.token),
    });
  }

  function splitSettingsForStorage(settings) {
    const safe = sanitizeCaptureSettings(settings);
    return {
      publicSettings: { endpoint: safe.endpoint },
      sessionSecrets: { [TOKEN_STORAGE_KEY]: safe.token },
    };
  }

  function sanitizeStatusMessage(value, secrets = []) {
    let message = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ");
    const candidates = [...secrets]
      .filter((secret) => typeof secret === "string" && secret.length >= 4)
      .sort((left, right) => right.length - left.length);
    for (const secret of candidates) message = message.split(secret).join("[đã ẩn]");
    message = message
      .replace(
        /\bauthorization\b\s*[:=]?\s*(?:bearer\s+)?\S+/gi,
        "Authorization [đã ẩn]",
      )
      .replace(/\b(api[_ -]?key|pairing[_ -]?token)\b\s*[:=]?\s*\S+/gi, "$1 [đã ẩn]")
      .replace(/\bbearer\s+\S+/gi, "Bearer [đã ẩn]")
      .trim();
    return message.slice(0, MAX_STATUS_CHARS);
  }

  function privacyLabelForProvider(provider, sourceKind = "tab") {
    const source = sourceKind === "file" ? "Audio file" : "Audio tab";
    switch (String(provider || "").toLowerCase()) {
      case "gemini":
        return `${source} được stream tới Google Gemini cloud trong phiên đang chạy; chính sách dữ liệu của Google áp dụng.`;
      case "azure":
        return `${source} được stream tới Azure Speech cloud trong phiên đang chạy; chính sách dữ liệu của Microsoft áp dụng.`;
      case "demo":
        return `Chế độ demo không gửi ${source.toLowerCase()} tới dịch vụ AI cloud.`;
      default:
        return `${source} đi qua ứng dụng cục bộ tới provider đã cấu hình; hãy xác minh provider trước khi bắt đầu.`;
    }
  }

  function isTrustedExtensionPage(sender, runtimeId, pageName) {
    if (!sender || sender.id !== runtimeId || typeof sender.url !== "string") return false;
    return sender.url === `chrome-extension://${runtimeId}/${pageName}`;
  }

  function wipeFrame(frame) {
    try {
      new Uint8Array(frame).fill(0);
    } catch {
      // A detached transfer buffer is already inaccessible to this context.
    }
  }

  class BoundedPreroll {
    constructor(options = {}) {
      this.now = options.now || Date.now;
      this.maxAgeMs = Number(options.maxAgeMs ?? MAX_PREROLL_AGE_MS);
      this.maxBytes = Number(options.maxBytes ?? MAX_PREROLL_BYTES);
      if (
        !Number.isFinite(this.maxAgeMs) ||
        this.maxAgeMs <= 0 ||
        this.maxAgeMs > MAX_PREROLL_AGE_MS
      ) {
        throw new Error("Preroll age must be within the one-second realtime budget");
      }
      if (
        !Number.isInteger(this.maxBytes) ||
        this.maxBytes <= 0 ||
        this.maxBytes > MAX_PREROLL_BYTES
      ) {
        throw new Error("Preroll byte budget is invalid");
      }
      this.entries = [];
      this.bytes = 0;
      this.dropped = 0;
    }

    prune(now = this.now()) {
      while (this.entries.length > 0 && now - this.entries[0].queuedAt > this.maxAgeMs) {
        const stale = this.entries.shift();
        this.bytes -= stale.frame.byteLength;
        this.dropped += 1;
        wipeFrame(stale.frame);
      }
    }

    push(frame, queuedAt = this.now()) {
      if (!(frame instanceof ArrayBuffer) || frame.byteLength === 0) {
        throw new Error("Realtime frame must be a non-empty ArrayBuffer");
      }
      this.prune(queuedAt);
      if (frame.byteLength > this.maxBytes) {
        wipeFrame(frame);
        this.dropped += 1;
        return false;
      }
      this.entries.push({ frame, queuedAt });
      this.bytes += frame.byteLength;
      while (this.bytes > this.maxBytes) {
        const oldest = this.entries.shift();
        this.bytes -= oldest.frame.byteLength;
        this.dropped += 1;
        wipeFrame(oldest.frame);
      }
      return true;
    }

    replaceWithLatest(frame, queuedAt = this.now()) {
      this.clear();
      return this.push(frame, queuedAt);
    }

    flush(send, now = this.now()) {
      if (typeof send !== "function") throw new Error("Preroll sender is required");
      this.prune(now);
      let sent = 0;
      while (this.entries.length > 0) {
        const entry = this.entries[0];
        if (send(entry.frame) === false) break;
        this.entries.shift();
        this.bytes -= entry.frame.byteLength;
        sent += 1;
      }
      return sent;
    }

    clear() {
      for (const entry of this.entries) wipeFrame(entry.frame);
      this.entries = [];
      this.bytes = 0;
    }

    get length() {
      return this.entries.length;
    }
  }

  return {
    AUTH_SCHEME,
    BoundedPreroll,
    MAX_PREROLL_AGE_MS,
    MAX_PREROLL_BYTES,
    TOKEN_STORAGE_KEY,
    createClientAuthentication,
    isTrustedExtensionPage,
    privacyLabelForProvider,
    sanitizeCaptureSettings,
    sanitizeStatusMessage,
    splitSettingsForStorage,
    validateEndpoint,
    validatePairingToken,
    verifyServerAuthentication,
  };
});
