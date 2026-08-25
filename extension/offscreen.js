const {
  BoundedPreroll,
  createClientAuthentication,
  isTrustedExtensionPage,
  privacyLabelForProvider,
  sanitizeCaptureSettings,
  sanitizeStatusMessage,
  validateEndpoint,
} = AudioTranslateSecurity;
const PROTOCOL_VERSION = 1;
const AUDIO_MAGIC = 0x31525441;
const AUDIO_HEADER_BYTES = 16;
const MAX_BUFFERED_AUDIO_BYTES = 16 * 1024;
const HANDSHAKE_TIMEOUT_MS = 15000;

let stream = null;
let audioContext = null;
let worklet = null;
let socket = null;
let sequence = 0;
let running = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let activeSettings = null;
let activeProvider = "";
let gatewayReady = false;
let fatalStopping = false;
let handshakeTimer = null;
const preRoll = new BoundedPreroll();
let operationQueue = Promise.resolve();

function notifyBackground(patch) {
  const safePatch = { ...patch };
  const secrets = [activeSettings?.token || ""];
  if ("message" in safePatch) {
    safePatch.message = sanitizeStatusMessage(safePatch.message, secrets);
  }
  if ("privacy" in safePatch) {
    safePatch.privacy = sanitizeStatusMessage(safePatch.privacy, secrets);
  }
  chrome.runtime
    .sendMessage({ target: "background", type: "offscreen:status", ...safePatch })
    .catch(() => {});
}

function startMessage(authentication) {
  return {
    type: "start",
    protocolVersion: PROTOCOL_VERSION,
    authentication,
  };
}

function scheduleReconnect() {
  if (!running || fatalStopping || reconnectTimer) return;
  const delay = Math.min(5000, 500 * 2 ** reconnectAttempt++);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket(true);
  }, delay);
}

function flushPreroll(candidate) {
  preRoll.flush((frame) => {
    if (
      candidate !== socket ||
      candidate.readyState !== WebSocket.OPEN ||
      candidate.bufferedAmount > MAX_BUFFERED_AUDIO_BYTES
    ) {
      return false;
    }
    candidate.send(frame);
    return true;
  });
}

function failCapture(message) {
  if (fatalStopping) return;
  fatalStopping = true;
  running = false;
  gatewayReady = false;
  clearTimeout(reconnectTimer);
  clearTimeout(handshakeTimer);
  reconnectTimer = null;
  handshakeTimer = null;
  const safeMessage = sanitizeStatusMessage(message, [activeSettings?.token || ""]);
  enqueueOperation(async () => {
    await stopCapture(false);
    notifyBackground({
      capturing: false,
      connected: false,
      level: "error",
      message: safeMessage,
      privacy: "Đã dừng capture sau lỗi nghiêm trọng; không còn audio mới được gửi đi.",
    });
  });
}

function connectSocket(isReconnect = false) {
  if (!running || fatalStopping || socket) return;
  let endpoint;
  try {
    endpoint = validateEndpoint(activeSettings.endpoint || "ws://127.0.0.1:43765");
  } catch (error) {
    failCapture(error.message);
    return;
  }

  const candidate = new WebSocket(endpoint);
  let startSent = false;
  let authenticating = false;
  let startedReceived = false;
  candidate.binaryType = "arraybuffer";
  socket = candidate;
  gatewayReady = false;

  const openTimeout = setTimeout(() => {
    if (candidate === socket && candidate.readyState !== WebSocket.OPEN) {
      candidate.close(4001, "Local gateway timeout");
    }
  }, 3000);

  candidate.addEventListener("open", () => {
    clearTimeout(openTimeout);
    if (candidate !== socket || !running) {
      candidate.close();
      return;
    }
    reconnectAttempt = 0;
    clearTimeout(handshakeTimer);
    handshakeTimer = setTimeout(() => {
      if (candidate === socket && !gatewayReady) candidate.close(4001, "Engine handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);
    notifyBackground({
      capturing: true,
      connected: false,
      level: "connecting",
      message: isReconnect
        ? "Đã nối lại local app; đang xác minh provider"
        : "Đã nối local app; đang xác minh provider",
      privacy: "Chưa gửi audio ra provider khi gateway chưa xác nhận phiên.",
    });
  });

  candidate.addEventListener("message", async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "hello") {
      if (startSent || authenticating) return;
      if (
        message.protocolVersion !== PROTOCOL_VERSION ||
        message.authRequired !== true ||
        !message.authentication
      ) {
        failCapture("Local gateway chưa bật xác thực pairing token hoặc sai protocol");
        return;
      }
      authenticating = true;
      activeProvider = String(message.provider || "");
      try {
        const authentication = await createClientAuthentication(
          message.authentication,
          activeSettings.token,
        );
        if (candidate !== socket || !running || fatalStopping) return;
        startSent = true;
        candidate.send(JSON.stringify(startMessage(authentication)));
      } catch (error) {
        failCapture(error.message);
        return;
      } finally {
        authenticating = false;
      }
      notifyBackground({
        capturing: true,
        connected: false,
        level: "connecting",
        message: `Đang khởi động ${message.provider || "translation provider"}`,
        privacy: privacyLabelForProvider(activeProvider, "tab"),
      });
      return;
    }
    if (message.type === "started") {
      if (!startSent || startedReceived || message.provider !== activeProvider) {
        failCapture("Local gateway trả handshake không hợp lệ");
        return;
      }
      startedReceived = true;
      clearTimeout(handshakeTimer);
      gatewayReady = true;
      flushPreroll(candidate);
      notifyBackground({
        capturing: true,
        connected: true,
        level: "listening",
        message: `Đang dịch ${message.sourceLanguage} → ${message.targetLanguage}`,
        privacy: privacyLabelForProvider(message.provider || activeProvider, "tab"),
      });
      return;
    }
    if (message.type === "error") {
      if (message.fatal) {
        failCapture(message.message || "Local translation engine failed");
      } else {
        notifyBackground({
          capturing: true,
          connected: gatewayReady,
          level: "error",
          message: sanitizeStatusMessage(message.message, [activeSettings?.token || ""]),
          privacy: privacyLabelForProvider(activeProvider, "tab"),
        });
      }
      return;
    }
    if (message.type === "language-detected") {
      const latency = Number.isFinite(message.detectionLatencyMs)
        ? ` · ${Math.round(message.detectionLatencyMs)} ms`
        : "";
      notifyBackground({
        capturing: true,
        connected: true,
        level: ["Unknown", "Low"].includes(message.confidence)
          ? "warning"
          : "listening",
        message: `Đã nhận diện ${message.language} (${message.confidence || "Unknown"})${latency}`,
      });
      return;
    }
    if (message.type === "status") {
      notifyBackground({
        capturing: true,
        connected: gatewayReady,
        level: message.level || "connecting",
        message: sanitizeStatusMessage(
          message.message || "Đang khởi động engine",
          [activeSettings?.token || ""],
        ),
        privacy: privacyLabelForProvider(activeProvider, "tab"),
      });
    }
  });

  candidate.addEventListener("error", () => {
    clearTimeout(openTimeout);
  });

  candidate.addEventListener("close", (event) => {
    clearTimeout(openTimeout);
    clearTimeout(handshakeTimer);
    if (candidate !== socket) return;
    socket = null;
    gatewayReady = false;
    if (!running) return;
    if ([1008, 1011, 4001, 4002].includes(event.code)) {
      failCapture(event.reason || "Local translation engine stopped");
      return;
    }
    notifyBackground({
      capturing: true,
      connected: false,
      level: "connecting",
      message: "Mất kết nối; audio vẫn phát và sẽ tự kết nối lại",
      privacy: "Audio mới được giữ tối đa một giây trong bộ nhớ khi chờ nối lại.",
    });
    scheduleReconnect();
  });
}

function encodeFrame(pcmBuffer) {
  const frame = new ArrayBuffer(AUDIO_HEADER_BYTES + pcmBuffer.byteLength);
  const view = new DataView(frame);
  view.setUint32(0, AUDIO_MAGIC, true);
  view.setUint32(4, sequence++ >>> 0, true);
  view.setFloat64(8, Date.now(), true);
  new Uint8Array(frame, AUDIO_HEADER_BYTES).set(new Uint8Array(pcmBuffer));
  return frame;
}

function recycleSocketForBackpressure(frame) {
  const staleSocket = socket;
  socket = null;
  gatewayReady = false;
  preRoll.replaceWithLatest(frame);
  staleSocket?.close(4000, "Audio backlog exceeded realtime budget");
  notifyBackground({
    capturing: true,
    connected: false,
    level: "connecting",
    message: "Đã bỏ audio backlog để giữ phụ đề realtime",
  });
  reconnectAttempt = 0;
  scheduleReconnect();
}

function sendOrQueuePcm(pcmBuffer) {
  const frame = encodeFrame(pcmBuffer);
  if (gatewayReady && socket?.readyState === WebSocket.OPEN) {
    if (socket.bufferedAmount > MAX_BUFFERED_AUDIO_BYTES) {
      recycleSocketForBackpressure(frame);
      return;
    }
    socket.send(frame);
    return;
  }
  preRoll.push(frame);
}

async function startCapture(streamId, settings) {
  const safeSettings = sanitizeCaptureSettings(settings || {});
  if (typeof streamId !== "string" || streamId.length < 1 || streamId.length > 2_048) {
    throw new Error("Tab capture stream ID không hợp lệ");
  }
  await stopCapture(false);
  running = true;
  fatalStopping = false;
  activeSettings = safeSettings;
  activeProvider = "";
  sequence = 0;
  preRoll.clear();

  try {
    // Consume the one-time tabCapture stream ID immediately; Chrome documents
    // that it expires after a few seconds if unused.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    audioContext = new AudioContext({ latencyHint: "interactive" });
    await audioContext.audioWorklet.addModule("audio-worklet.js");
    const source = audioContext.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(audioContext, "pcm16-downsampler", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { targetSampleRate: 16000, chunkSamples: 320 },
    });
    worklet.port.onmessage = (event) => {
      if (running) sendOrQueuePcm(event.data);
    };

    // Passing the captured signal through the worklet preserves normal tab playback.
    source.connect(worklet);
    worklet.connect(audioContext.destination);
    await audioContext.resume();

    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => enqueueOperation(() => stopCapture(true)), {
        once: true,
      });
    }
    notifyBackground({
      capturing: true,
      connected: false,
      level: "connecting",
      message: "Đã capture tab; đang kết nối local app",
      privacy: "Audio mới chỉ được giữ trong bộ nhớ cục bộ khi chờ provider xác nhận.",
    });
    connectSocket(false);
  } catch (error) {
    const safeMessage = sanitizeStatusMessage(error.message, [activeSettings?.token || ""]);
    await stopCapture(false);
    notifyBackground({
      capturing: false,
      connected: false,
      level: "error",
      message: safeMessage,
      privacy: "Đã dừng capture; không còn audio mới được gửi đi.",
    });
    throw new Error(safeMessage);
  }
}

async function stopCapture(notify = true) {
  running = false;
  clearTimeout(reconnectTimer);
  clearTimeout(handshakeTimer);
  reconnectTimer = null;
  handshakeTimer = null;
  gatewayReady = false;
  preRoll.clear();
  worklet?.disconnect();
  worklet = null;
  for (const track of stream?.getTracks() || []) track.stop();
  stream = null;
  if (audioContext && audioContext.state !== "closed") await audioContext.close();
  audioContext = null;
  if (socket) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
    try {
      socket.close(1000, "Capture stopped");
    } catch {
      // A socket can still be transitioning from CONNECTING during manual stop.
    }
  }
  socket = null;
  activeProvider = "";
  activeSettings = null;
  fatalStopping = false;
  if (notify) {
    notifyBackground({
      capturing: false,
      connected: false,
      level: "idle",
      message: "Đã dừng capture",
      privacy: "Đã dừng capture; không còn audio mới được gửi đi.",
    });
  }
}

function enqueueOperation(task) {
  const operation = operationQueue.then(task, task);
  operationQueue = operation.catch(() => {});
  return operation;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return undefined;
  if (!isTrustedExtensionPage(sender, chrome.runtime.id, "background.js")) {
    sendResponse({ ok: false, error: "Nguồn yêu cầu capture không được phép" });
    return false;
  }
  const task = enqueueOperation(() =>
    message.type === "capture:start"
      ? startCapture(message.streamId, message.settings).then(() => ({
          ok: true,
          connected: gatewayReady,
          privacy: privacyLabelForProvider(activeProvider, "tab"),
        }))
      : message.type === "capture:stop"
        ? stopCapture(true).then(() => ({ ok: true }))
        : Promise.reject(new Error(`Unknown message: ${message.type}`)),
  );
  task.then(sendResponse, (error) =>
    sendResponse({
      ok: false,
      error: sanitizeStatusMessage(error.message, [message?.settings?.token || ""]),
    }),
  );
  return true;
});
