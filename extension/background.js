importScripts("realtime-security.js", "capture-lifecycle.js");

const {
  isTrustedExtensionPage,
  privacyLabelForProvider,
  sanitizeCaptureSettings,
  sanitizeStatusMessage,
} = AudioTranslateSecurity;
const { prepareThenAttach } = AudioTranslateCaptureLifecycle;
const OFFSCREEN_URL = "offscreen.html";
const DEFAULT_STATE = {
  starting: false,
  capturing: false,
  connected: false,
  tabId: null,
  tabTitle: "",
  level: "idle",
  message: "Chưa bắt đầu",
  privacy:
    "Chỉ capture tab sau khi bạn nhấn Bắt đầu; provider cloud sẽ được ghi rõ khi kết nối.",
};
let creatingOffscreen = null;
let lifecycle = Promise.resolve();
let captureGeneration = 0;

async function getState() {
  const stored = await chrome.storage.session.get("captureState");
  return { ...DEFAULT_STATE, ...(stored.captureState || {}) };
}

async function setState(patch, secrets = []) {
  const safePatch = { ...patch };
  if ("message" in safePatch) {
    safePatch.message = sanitizeStatusMessage(safePatch.message, secrets);
  }
  if ("privacy" in safePatch) {
    safePatch.privacy = sanitizeStatusMessage(safePatch.privacy, secrets);
  }
  const state = { ...(await getState()), ...safePatch, updatedAt: Date.now() };
  await chrome.storage.session.set({ captureState: state });
  await updateBadge(state);
  return state;
}

async function updateBadge(state) {
  if (state.capturing) {
    await chrome.action.setBadgeText({ text: state.connected ? "ON" : "…" });
    await chrome.action.setBadgeBackgroundColor({
      color: state.connected ? "#16a34a" : "#d97706",
    });
  } else {
    await chrome.action.setBadgeText({ text: "" });
  }
}

async function ensureOffscreenDocument() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    const documentUrl = chrome.runtime.getURL(OFFSCREEN_URL);
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [documentUrl],
    });
    if (contexts.length > 0) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
      justification:
        "Capture active tab audio, preserve playback, and stream PCM to the local translator",
    });
  })();
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

function enqueueLifecycle(task) {
  const operation = lifecycle.then(task, task);
  lifecycle = operation.catch(() => {});
  return operation;
}

async function startCapture(settings) {
  const generation = ++captureGeneration;
  const safeSettings = sanitizeCaptureSettings(settings);
  const current = await getState();
  if (current.starting || current.capturing) {
    throw new Error("Một tab đang được capture. Hãy dừng phiên hiện tại trước.");
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Không tìm thấy tab đang hoạt động");

  await setState({
    starting: true,
    capturing: false,
    tabId: tab.id,
    tabTitle: tab.title || "Tab hiện tại",
    level: "connecting",
    message: "Đang khởi động provider trước khi capture tab",
    privacy: "Chưa capture audio; đang xác minh local app và khởi động provider.",
  });
  let response;
  try {
    await ensureOffscreenDocument();
    const lifecycleResult = await prepareThenAttach({
      async prepareLocalSession() {
        const prepared = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "capture:prepare",
          settings: safeSettings,
        });
        if (!prepared?.ok || prepared.connected !== true) {
          throw new Error(prepared?.error || "Provider chưa sẵn sàng");
        }
        return prepared;
      },
      getTabStreamId: () => chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }),
      async attachTabStream(streamId) {
        const attached = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "capture:attach",
          streamId,
        });
        if (!attached?.ok || attached.connected !== true) {
          throw new Error(attached?.error || "Không thể gắn audio stream của tab");
        }
        return attached;
      },
      async cancelPreparedSession() {
        await chrome.runtime.sendMessage({ target: "offscreen", type: "capture:stop" });
      },
    });
    response = lifecycleResult.attachment;
  } catch (error) {
    if (generation !== captureGeneration) return getState();
    await setState({
      starting: false,
      capturing: false,
      connected: false,
      level: "error",
      message: sanitizeStatusMessage(error.message, [safeSettings.token]),
      privacy: "Đã dừng capture; không còn audio mới được gửi đi.",
    }, [safeSettings.token]);
    throw new Error(sanitizeStatusMessage(error.message, [safeSettings.token]));
  }

  if (generation !== captureGeneration) return getState();
  return setState({
    starting: false,
    capturing: true,
    connected: response.connected === true,
    tabId: tab.id,
    tabTitle: tab.title || "Tab hiện tại",
    level: response.connected ? "listening" : "connecting",
    message: response.connected ? "Đang gửi audio" : "Đang kết nối local app",
    privacy:
      response.privacy ||
      "Audio mới chỉ được capture cục bộ; đang chờ provider xác nhận trước khi truyền đi.",
  });
}

async function stopCapture() {
  captureGeneration += 1;
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "capture:stop" });
  } catch {
    // The offscreen document may already have closed.
  }
  const state = await setState({
    starting: false,
    capturing: false,
    connected: false,
    tabId: null,
    tabTitle: "",
    level: "idle",
    message: "Đã dừng",
    privacy: "Đã dừng capture; không còn audio mới được gửi đi.",
  });
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // It is valid for the offscreen document to have already closed.
  }
  return state;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "background") return undefined;

  const task = (async () => {
    const expectedPage = message.type === "offscreen:status" ? OFFSCREEN_URL : "popup.html";
    if (!isTrustedExtensionPage(sender, chrome.runtime.id, expectedPage)) {
      throw new Error("Nguồn yêu cầu extension không được phép");
    }
    switch (message.type) {
      case "capture:start":
        return {
          ok: true,
          state: await enqueueLifecycle(() => startCapture(message.settings || {})),
        };
      case "capture:stop":
        return { ok: true, state: await stopCapture() };
      case "capture:get-state":
        return { ok: true, state: await getState() };
      case "offscreen:status":
        return {
          ok: true,
          state: await setState({
            capturing: message.capturing !== false,
            connected: message.connected === true,
            level: message.level || "idle",
            message: message.message || "",
            privacy: message.privacy || privacyLabelForProvider("", "tab"),
          }),
        };
      default:
        throw new Error(`Unknown message: ${message.type}`);
    }
  })();

  task.then(sendResponse, (error) =>
    sendResponse({
      ok: false,
      error: sanitizeStatusMessage(error.message, [message?.settings?.token || ""]),
    }),
  );
  return true;
});

chrome.tabCapture.onStatusChanged.addListener(async (info) => {
  const state = await getState();
  if (state.tabId === info.tabId && ["stopped", "error"].includes(info.status)) {
    await stopCapture();
  }
});
