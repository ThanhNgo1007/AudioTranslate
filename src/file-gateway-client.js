const crypto = require("node:crypto");
const { WebSocket } = require("ws");
const { PROTOCOL_VERSION, encodeAudioFrame } = require("./protocol");

const INTERNAL_ORIGIN = "audiotranslate://control-center";
const MAX_SOCKET_BUFFER_BYTES = 32 * 1024;
const AUTH_SCHEME = "hmac-sha256-v1";
const clientSecrets = new WeakMap();

function publicGatewayMessage(value, fallback = "File audio gateway failed") {
  const message = typeof value === "string" ? value : fallback;
  return message.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").slice(0, 500) || fallback;
}

function hmacProof(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function secureEqual(left, right) {
  if (typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class FileGatewayClient {
  constructor(config, options = {}) {
    if (config?.host !== "127.0.0.1") {
      throw new Error("File audio gateway must use the exact IPv4 loopback address");
    }
    if (!Number.isInteger(config?.port) || config.port < 1 || config.port > 65_535) {
      throw new Error("File audio gateway port is invalid");
    }
    clientSecrets.set(this, { authToken: String(config.authToken || "") });
    // Deliberate allowlist: the internal transport never needs a provider API key.
    this.config = {
      host: config.host,
      port: config.port,
      sourceLanguage: config.sourceLanguage,
      sourceLanguageCandidates: Array.isArray(config.sourceLanguageCandidates)
        ? [...config.sourceLanguageCandidates]
        : [],
      targetLanguage: config.targetLanguage,
      showSource: config.showSource,
    };
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.onStatus = options.onStatus || (() => {});
    this.socket = null;
    this.ready = false;
    this.startPromise = null;
    this.sequence = 0;
    this.intentionalSockets = new WeakSet();
  }

  start() {
    const openState = this.WebSocketImpl.OPEN ?? WebSocket.OPEN;
    if (this.ready && this.socket?.readyState === openState) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (clientSecrets.get(this).authToken.length < 24) {
      return Promise.reject(new Error("A strong pairing token is required for file audio"));
    }
    this.ready = false;
    const operation = this.#connect();
    this.startPromise = operation;
    return operation.finally(() => {
      if (this.startPromise === operation) this.startPromise = null;
    });
  }

  #connect() {
    return new Promise((resolve, reject) => {
      const { authToken } = clientSecrets.get(this);
      let settled = false;
      const endpoint = `ws://${this.config.host}:${this.config.port}`;
      const socket = new this.WebSocketImpl(endpoint, { origin: INTERNAL_ORIGIN });
      this.socket = socket;
      const timer = setTimeout(() => finish(new Error("File audio gateway handshake timed out")), 15000);
      timer.unref?.();

      const cleanupStart = () => clearTimeout(timer);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanupStart();
        if (error) {
          if (this.socket === socket) {
            this.ready = false;
            this.socket = null;
          }
          try {
            socket.close();
          } catch {
            // The socket may already be closed.
          }
          reject(error);
        } else {
          resolve();
        }
      };

      socket.on("message", (raw, isBinary) => {
        if (isBinary || this.socket !== socket) return;
        let message;
        try {
          message = JSON.parse(String(raw));
        } catch {
          finish(new Error("File audio gateway returned invalid JSON"));
          return;
        }
        if (message.type === "hello") {
          const authentication = message.authentication;
          const nonce = authentication?.nonce;
          const serverProof =
            typeof nonce === "string"
              ? hmacProof(authToken, `ATR1|server|${nonce}`)
              : "";
          if (
            message.protocolVersion !== PROTOCOL_VERSION ||
            message.authRequired !== true ||
            authentication?.scheme !== AUTH_SCHEME ||
            !/^[A-Za-z0-9_-]{24,128}$/.test(nonce || "") ||
            !secureEqual(serverProof, authentication.serverProof)
          ) {
            finish(new Error("File audio gateway authentication is not enabled"));
            return;
          }
          const clientNonce = crypto.randomBytes(24).toString("base64url");
          const clientProof = hmacProof(
            authToken,
            `ATR1|client|${nonce}|${clientNonce}`,
          );
          try {
            socket.send(
              JSON.stringify({
                type: "start",
                protocolVersion: PROTOCOL_VERSION,
                authentication: { scheme: AUTH_SCHEME, clientNonce, clientProof },
                sourceLanguage: this.config.sourceLanguage || "auto",
                sourceLanguageCandidates: this.config.sourceLanguageCandidates || [],
                targetLanguage: this.config.targetLanguage || "vi",
                showSource: this.config.showSource !== false,
                sourceKind: "file",
              }),
            );
          } catch {
            finish(new Error("Unable to authenticate the file audio gateway"));
          }
          return;
        }
        if (message.type === "started") {
          if (this.intentionalSockets.has(socket) || this.socket !== socket) return;
          this.ready = true;
          this.sequence = 0;
          this.onStatus({
            level: "listening",
            message: "Đang nhận PCM từ file đã chọn qua kênh nội bộ đã xác thực",
          });
          finish();
          return;
        }
        if (message.type === "error" && message.fatal) {
          const error = new Error(publicGatewayMessage(message.message, "File audio provider failed"));
          if (!settled) finish(error);
          else {
            if (this.socket === socket) this.ready = false;
            this.onStatus({ level: "error", message: error.message });
            this.intentionalSockets.add(socket);
            try {
              socket.close();
            } catch {
              // The socket is already closing.
            }
          }
        }
      });
      socket.once("error", () => {
        if (!settled) finish(new Error("Unable to connect the file audio gateway"));
        else if (!this.intentionalSockets.has(socket) && this.socket === socket) {
          this.ready = false;
          this.onStatus({ level: "error", message: "Kênh file audio gặp lỗi kết nối" });
        }
      });
      socket.on("close", () => {
        const wasCurrent = this.socket === socket;
        if (wasCurrent) {
          this.socket = null;
          this.ready = false;
        }
        if (wasCurrent && !this.intentionalSockets.has(socket)) {
          this.onStatus({ level: "error", message: "Kênh file audio đã đóng" });
        }
        finish(new Error("File audio gateway closed before it was ready"));
      });
    });
  }

  write(pcm, timing = {}) {
    const openState = this.WebSocketImpl.OPEN ?? WebSocket.OPEN;
    if (!this.ready || !this.socket || this.socket.readyState !== openState) return false;
    const byteLength = pcm?.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) return false;
    if (this.socket.bufferedAmount + byteLength + 16 > MAX_SOCKET_BUFFER_BYTES) return false;
    const capturedAt = Number.isFinite(timing.capturedAt) ? timing.capturedAt : Date.now();
    const suppliedSequence = timing.sequence;
    const sequence = Number.isSafeInteger(suppliedSequence) && suppliedSequence >= 0
      ? suppliedSequence
      : this.sequence;
    this.sequence = Math.max(this.sequence, sequence + 1);
    try {
      this.socket.send(encodeAudioFrame(pcm, { sequence, capturedAt }));
      return true;
    } catch {
      this.ready = false;
      return false;
    }
  }

  async stop() {
    this.ready = false;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    this.intentionalSockets.add(socket);
    const openState = this.WebSocketImpl.OPEN ?? WebSocket.OPEN;
    if (socket.readyState === openState) {
      try {
        socket.send(JSON.stringify({ type: "stop" }));
      } catch {
        // Closing the socket below is sufficient.
      }
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate?.();
        resolve();
      }, 1000);
      timer.unref?.();
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        socket.close();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

module.exports = {
  FileGatewayClient,
  INTERNAL_ORIGIN,
  MAX_SOCKET_BUFFER_BYTES,
  publicGatewayMessage,
};
