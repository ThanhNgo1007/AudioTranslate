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
let pendingPreparation = null;
let activeProviderPrepareMs = null;
const preRoll = new BoundedPreroll();
let operationQueue = Promise.resolve();

function createPreparationPromise() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  pendingPreparation = { resolve, reject, settled: false };
  return promise;
}

function resolvePreparation(value) {
  const pending = pendingPreparation;
  if (!pending || pending.settled) return;
  pending.settled = true;
  pendingPreparation = null;
  pending.resolve(value);
}

function rejectPreparation(error) {
  const pending = pendingPreparation;
  if (!pending || pending.settled) return;
  pending.settled = true;
  pendingPreparation = null;
  pending.reject(error instanceof Error ? error : new Error(String(error)));
}

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
  rejectPreparation(new Error(safeMessage));
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

  let candidate;
  try {
    candidate = new WebSocket(endpoint);
  } catch (error) {
    failCapture(error.message);
    return;
  }
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
      capturing: stream !== null,
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
        capturing: stream !== null,
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
      activeProviderPrepareMs = Number.isFinite(message.providerPrepareMs)
        ? Math.max(0, Math.round(message.providerPrepareMs))
        : null;
      flushPreroll(candidate);
      const privacy = privacyLabelForProvider(message.provider || activeProvider, "tab");
      resolvePreparation({
        connected: true,
        provider: message.provider || activeProvider,
        providerPrepareMs: activeProviderPrepareMs,
        privacy,
      });
      notifyBackground({
        capturing: stream !== null,
        connected: true,
        level: "listening",
        message: stream
          ? `Đang dịch ${message.sourceLanguage} → ${message.targetLanguage}`
          : "Provider đã sẵn sàng; đang chờ gắn audio tab",
        privacy,
      });
      return;
    }
    if (message.type === "error") {
      if (message.fatal) {
        failCapture(message.message || "Local translation engine failed");
      } else {
        notifyBackground({
          capturing: stream !== null,
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
        capturing: stream !== null,
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
        capturing: stream !== null,
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
      capturing: stream !== null,
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

async function prepareCapture(settings) {
  const safeSettings = sanitizeCaptureSettings(settings || {});
  await stopCapture(false);
  running = true;
  fatalStopping = false;
  activeSettings = safeSettings;
  activeProvider = "";
  activeProviderPrepareMs = null;
  sequence = 0;
  preRoll.clear();
  const preparation = createPreparationPromise();

  notifyBackground({
    capturing: false,
    connected: false,
    level: "connecting",
    message: "Đang xác thực local app và khởi động provider",
    privacy: "Chưa capture audio tab; pairing token chỉ dùng với local app.",
  });
  connectSocket(false);
  return preparation;
}

async function attachCapture(streamId) {
  if (typeof streamId !== "string" || streamId.length < 1 || streamId.length > 2_048) {
    throw new Error("Tab capture stream ID không hợp lệ");
  }
  if (!running || !gatewayReady || !activeSettings || !socket) {
    throw new Error("Provider chưa sẵn sàng để nhận audio tab");
  }
  if (stream) throw new Error("Audio tab đã được gắn vào phiên hiện tại");

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
      connected: true,
      level: "listening",
      message: "Đang gửi audio tab tới provider đã sẵn sàng",
      privacy: privacyLabelForProvider(activeProvider, "tab"),
    });
    return {
      connected: true,
      provider: activeProvider,
      providerPrepareMs: activeProviderPrepareMs,
      privacy: privacyLabelForProvider(activeProvider, "tab"),
    };
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

async function startCapture(streamId, settings) {
  await prepareCapture(settings);
  return attachCapture(streamId);
}

async function stopCapture(notify = true) {
  rejectPreparation(new Error("Đã dừng trước khi provider sẵn sàng"));
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
  activeProviderPrepareMs = null;
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
  let task;
  switch (message.type) {
    case "capture:prepare":
      task = enqueueOperation(() =>
        prepareCapture(message.settings).then((prepared) => ({ ok: true, ...prepared })),
      );
      break;
    case "capture:attach":
      task = enqueueOperation(() =>
        attachCapture(message.streamId).then((attached) => ({ ok: true, ...attached })),
      );
      break;
    case "capture:start":
      task = enqueueOperation(() =>
        startCapture(message.streamId, message.settings).then((attached) => ({
          ok: true,
          ...attached,
        })),
      );
      break;
    case "capture:stop":
      rejectPreparation(new Error("Người dùng đã dừng khi provider đang khởi động"));
      task = enqueueOperation(() => stopCapture(true).then(() => ({ ok: true })));
      break;
    default:
      task = Promise.reject(new Error(`Unknown message: ${message.type}`));
  }
  task.then(sendResponse, (error) =>
    sendResponse({
      ok: false,
      error: sanitizeStatusMessage(error.message, [message?.settings?.token || ""]),
    }),
  );
  return true;
});
