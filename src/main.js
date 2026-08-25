const path = require("node:path");
const {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
} = require("electron");
const { getConfig, loadEnvFile } = require("./config");
const { RealtimeGateway } = require("./gateway");
const { DEMO_LINES } = require("./providers/demo");

loadEnvFile();

let overlayWindow = null;
let tray = null;
let gateway = null;
let clickThrough = true;
let lastStatus = { type: "status", level: "idle", message: "Starting AudioTranslate…" };
let previewTimer = null;
let quitting = false;
let shutdownStarted = false;
let shutdownComplete = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

const appArgOffset = app.isPackaged ? 1 : 2;
const config = getConfig(process.argv.slice(appArgOffset));
clickThrough = config.clickThrough;

function overlayBounds() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const width = Math.min(1100, Math.max(640, area.width - 80));
  const height = 240;
  return {
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height - height - 36),
  };
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    ...overlayBounds(),
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    focusable: !clickThrough,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : undefined);
  overlayWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
  if (process.platform === "darwin") {
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  overlayWindow.loadFile(path.join(__dirname, "overlay", "index.html"));
  overlayWindow.once("ready-to-show", () => {
    if (!overlayWindow) return;
    overlayWindow.showInactive();
    overlayWindow.webContents.send("overlay:interaction", { clickThrough });
    overlayWindow.webContents.send("overlay:status", lastStatus);
  });
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
  overlayWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      overlayWindow?.hide();
    }
  });
}

function makeTrayImage() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <rect x="3" y="5" width="26" height="20" rx="6" fill="#ffffff"/>
      <path d="M8 11h16v3H8zm0 6h10v3H8z" fill="#111827"/>
      <circle cx="24" cy="22" r="5" fill="#22c55e" stroke="#111827" stroke-width="2"/>
    </svg>`;
  const image = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  );
  image.setTemplateImage(process.platform === "darwin");
  return image.resize({ width: 18, height: 18 });
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setToolTip("AudioTranslate Live");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: overlayWindow?.isVisible() ? "Ẩn phụ đề" : "Hiện phụ đề",
        click: toggleOverlay,
      },
      {
        label: clickThrough ? "Bật chế độ kéo cửa sổ" : "Bật click-through",
        click: toggleInteraction,
      },
      { label: "Đưa phụ đề về vị trí mặc định", click: resetOverlayPosition },
      config.authToken
        ? {
            label: "Sao chép pairing token",
            click: () => clipboard.writeText(config.authToken),
          }
        : { label: "Chưa có pairing token — chạy npm run setup", enabled: false },
      { type: "separator" },
      { label: lastStatus.message, enabled: false },
      { type: "separator" },
      {
        label: "Thoát",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function toggleOverlay() {
  if (!overlayWindow) {
    createOverlayWindow();
    return;
  }
  if (overlayWindow.isVisible()) overlayWindow.hide();
  else overlayWindow.showInactive();
  rebuildTrayMenu();
}

function toggleInteraction() {
  if (!overlayWindow) return;
  clickThrough = !clickThrough;
  overlayWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
  overlayWindow.setFocusable(!clickThrough);
  if (!clickThrough) {
    overlayWindow.show();
    overlayWindow.focus();
  } else {
    overlayWindow.showInactive();
  }
  overlayWindow.webContents.send("overlay:interaction", { clickThrough });
  rebuildTrayMenu();
}

function resetOverlayPosition() {
  overlayWindow?.setBounds(overlayBounds(), true);
}

function sendStatus(status) {
  lastStatus = status;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("overlay:status", status);
  }
  rebuildTrayMenu();
}

function sendCaption(caption) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("overlay:caption", caption);
  }
}

function startPreview() {
  let line = 0;
  let isFinal = false;
  previewTimer = setInterval(() => {
    const [transcript, translation] = DEMO_LINES[line % DEMO_LINES.length];
    sendCaption({
      type: "caption",
      sessionId: "preview",
      sequence: line * 2 + (isFinal ? 1 : 0),
      transcript: isFinal ? transcript : transcript.slice(0, Math.ceil(transcript.length * 0.68)),
      translation: isFinal ? translation : translation.slice(0, Math.ceil(translation.length * 0.68)),
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      isFinal,
      showSource: config.showSource,
      emittedAt: Date.now(),
      latencyMs: null,
      synthetic: true,
      provider: "demo",
    });
    if (isFinal) line += 1;
    isFinal = !isFinal;
  }, 1200);
}

async function startApplication() {
  createOverlayWindow();
  tray = new Tray(makeTrayImage());
  tray.on("click", toggleOverlay);
  rebuildTrayMenu();

  gateway = new RealtimeGateway(config);
  gateway.on("status", sendStatus);
  gateway.on("caption", sendCaption);
  gateway.on("error", (error) => {
    sendStatus({ type: "status", level: "error", message: error.message });
  });

  try {
    await gateway.start();
  } catch (error) {
    sendStatus({ type: "status", level: "error", message: error.message });
  }

  const shortcuts = [
    ["CommandOrControl+Alt+S", toggleOverlay],
    ["CommandOrControl+Alt+I", toggleInteraction],
    ["CommandOrControl+Alt+R", resetOverlayPosition],
  ];
  const failedShortcuts = shortcuts
    .filter(([accelerator, callback]) => !globalShortcut.register(accelerator, callback))
    .map(([accelerator]) => accelerator);
  if (failedShortcuts.length > 0) {
    sendStatus({
      type: "status",
      level: "warning",
      message: `Không đăng ký được phím tắt: ${failedShortcuts.join(", ")}; dùng menu tray thay thế`,
    });
  }

  if (config.preview) startPreview();
}

ipcMain.on("overlay:rendered", (_event, metrics) => {
  if (process.env.AUDIOTRANSLATE_DEBUG === "true") {
    process.stderr.write(`${JSON.stringify({ event: "overlay-rendered", ...metrics })}\n`);
  }
});

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!overlayWindow) createOverlayWindow();
    else overlayWindow.showInactive();
  });

  app.whenReady().then(() => {
    if (process.platform === "darwin") app.dock?.hide();
    return startApplication();
  });
}

app.on("activate", () => {
  if (!overlayWindow) createOverlayWindow();
  else overlayWindow.showInactive();
});

// Keeping a listener without calling app.quit() keeps the tray application
// alive on Windows/Linux if the frameless overlay is ever closed.
app.on("window-all-closed", () => {});

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  quitting = true;
  globalShortcut.unregisterAll();
  if (previewTimer) clearInterval(previewTimer);
  Promise.resolve(gateway?.close())
    .catch(() => {})
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});
