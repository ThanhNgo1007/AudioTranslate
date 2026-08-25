const {
  TOKEN_STORAGE_KEY,
  sanitizeStatusMessage,
  splitSettingsForStorage,
  validatePairingToken,
} = AudioTranslateSecurity;
const SETTINGS_KEY = "audioTranslateSettings";
const DEFAULT_SETTINGS = {
  endpoint: "ws://127.0.0.1:43765",
  token: "",
};

const endpoint = document.getElementById("endpoint");
const pairingToken = document.getElementById("pairing-token");
const startButton = document.getElementById("start-button");
const stopButton = document.getElementById("stop-button");
const status = document.getElementById("status");
const statusTitle = document.getElementById("status-title");
const statusDetail = document.getElementById("status-detail");
const privacyDetail = document.getElementById("privacy-detail");

function currentSettings() {
  return {
    endpoint: endpoint.value.trim(),
    token: pairingToken.value.trim(),
  };
}

async function saveSettings() {
  const { publicSettings, sessionSecrets } = splitSettingsForStorage(currentSettings());
  await Promise.all([
    chrome.storage.local.set({ [SETTINGS_KEY]: publicSettings }),
    chrome.storage.session.set(sessionSecrets),
  ]);
}

function renderState(state) {
  const capturing = state?.capturing === true;
  status.dataset.level = state?.level || "idle";
  statusTitle.textContent = capturing ? state.tabTitle || "Đang capture" : "Chưa bắt đầu";
  statusDetail.textContent = state?.message || "Mở một video rồi nhấn Bắt đầu";
  privacyDetail.textContent =
    state?.privacy ||
    "Chỉ capture tab sau khi bạn nhấn Bắt đầu. Audio chỉ rời máy sau khi local app được xác thực và provider cloud xác nhận phiên.";
  startButton.classList.toggle("hidden", capturing);
  stopButton.classList.toggle("hidden", !capturing);
}

async function request(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ target: "background", type, ...extra });
  if (!response?.ok) throw new Error(response?.error || "Extension request failed");
  return response;
}

async function refreshState() {
  try {
    const response = await request("capture:get-state");
    renderState(response.state);
  } catch (error) {
    status.dataset.level = "error";
    statusTitle.textContent = "Lỗi extension";
    statusDetail.textContent = sanitizeStatusMessage(error.message, [pairingToken.value]);
  }
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  status.dataset.level = "connecting";
  statusTitle.textContent = "Đang kết nối…";
  statusDetail.textContent = "Đang mở audio stream của tab";
  try {
    const settings = currentSettings();
    await saveSettings();
    const response = await request("capture:start", { settings });
    renderState(response.state);
  } catch (error) {
    status.dataset.level = "error";
    statusTitle.textContent = "Không thể bắt đầu";
    statusDetail.textContent = sanitizeStatusMessage(error.message, [pairingToken.value]);
  } finally {
    startButton.disabled = false;
  }
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  try {
    const response = await request("capture:stop");
    renderState(response.state);
  } catch (error) {
    status.dataset.level = "error";
    statusDetail.textContent = sanitizeStatusMessage(error.message, [pairingToken.value]);
  } finally {
    stopButton.disabled = false;
  }
});

async function initialize() {
  const [stored, session] = await Promise.all([
    chrome.storage.local.get(SETTINGS_KEY),
    chrome.storage.session.get(TOKEN_STORAGE_KEY),
  ]);
  const persisted = stored[SETTINGS_KEY] || {};
  const legacyToken = typeof persisted.token === "string" ? persisted.token : "";
  let token = "";
  try {
    token = validatePairingToken(session[TOKEN_STORAGE_KEY] || legacyToken || "", {
      allowEmpty: true,
    });
  } catch {
    // Discard malformed legacy/session values without ever rendering their contents.
  }
  const publicSettings = {
    endpoint:
      typeof persisted.endpoint === "string" ? persisted.endpoint : DEFAULT_SETTINGS.endpoint,
  };
  const settings = { ...DEFAULT_SETTINGS, ...publicSettings, token };
  const hasLegacyFields = Object.keys(persisted).some((key) => key !== "endpoint");
  if (Object.hasOwn(persisted, "token") || hasLegacyFields) {
    await Promise.all([
      chrome.storage.local.set({ [SETTINGS_KEY]: publicSettings }),
      session[TOKEN_STORAGE_KEY]
        ? Promise.resolve()
        : chrome.storage.session.set({ [TOKEN_STORAGE_KEY]: token }),
    ]);
  }
  endpoint.value = settings.endpoint;
  pairingToken.value = token;
  await refreshState();
}

initialize().catch((error) => {
  status.dataset.level = "error";
  statusTitle.textContent = "Không thể tải cấu hình";
  statusDetail.textContent = sanitizeStatusMessage(error.message);
});
const refreshTimer = setInterval(refreshState, 750);
window.addEventListener("unload", () => clearInterval(refreshTimer));
