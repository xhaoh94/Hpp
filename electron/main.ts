import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, Notification, Tray } from "electron";
import { readFile } from "fs/promises";
import { join } from "path";
import { is } from "@electron-toolkit/utils";
import { autoUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";
import { registerFileHandlers } from "./ipc/file-handlers";
import { registerStoreHandlers } from "./ipc/store-handlers";
import { registerPiSDKHandlers } from "./ipc/pi-sdk-handlers";
import { registerAgentStatusHandlers } from "./ipc/agent-handlers";
import { registerAgentHandlers, shutdownAgentRuntime } from "./agents/agent-manager";
import { remoteAccessServer } from "./remote/remote-server";
import type { AppUpdateState, AppUpdateStatus } from "../src/types/ipc";
import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  shouldRunPeriodicAppUpdateCheck,
  shouldStopAppUpdatePolling,
} from "./app-update-polling";

// Enable IME support on Linux Wayland
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-wayland-ime");
  app.commandLine.appendSwitch("wayland-text-input-version", "3");
}

// Set app name
app.setName("hpp");
if (process.platform === "win32") {
  app.setAppUserModelId("com.hpp.app");
}

const DEFAULT_CLOSE_TO_TRAY = true;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let closeToTray = DEFAULT_CLOSE_TO_TRAY;
let isQuitting = false;
let updaterInitialized = false;
let updateCheckTimer: ReturnType<typeof setInterval> | null = null;
let agentShutdownStarted = false;
let updateStatus: AppUpdateStatus = {
  state: "idle",
  currentVersion: app.getVersion(),
  canCheck: false,
  canDownload: false,
  canInstall: false,
};
const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function getIconPath() {
  return is.dev
    ? join(process.cwd(), "public/icon.png")
    : join(__dirname, "../renderer/icon.png");
}

async function loadCloseToTraySetting() {
  try {
    const settingsPath = join(app.getPath("userData"), "hpp-data", "settings.json");
    const content = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(content) as { general?: { closeToTray?: unknown } };
    closeToTray = typeof settings.general?.closeToTray === "boolean"
      ? settings.general.closeToTray
      : DEFAULT_CLOSE_TO_TRAY;
  } catch {
    closeToTray = DEFAULT_CLOSE_TO_TRAY;
  }
}

function createTray() {
  if (tray) return;

  const trayIcon = nativeImage.createFromPath(getIconPath());
  tray = new Tray(trayIcon.isEmpty() ? getIconPath() : trayIcon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Hpp");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示 Hpp", click: focusMainWindow },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on("click", focusMainWindow);
}

function getUpdateFeedLabel() {
  const explicitUrl = process.env.HPP_UPDATE_URL?.trim();
  if (explicitUrl) return explicitUrl;
  return "github:xhaoh94/Hpp";
}

function updateStatusPatch(patch: Partial<AppUpdateStatus>) {
  const nextState = patch.state ?? updateStatus.state;
  updateStatus = {
    ...updateStatus,
    currentVersion: app.getVersion(),
    feedUrl: getUpdateFeedLabel(),
    canCheck: app.isPackaged,
    canDownload: nextState === "available",
    canInstall: nextState === "downloaded",
    ...patch,
  };
  mainWindow?.webContents.send("app:update-status", updateStatus);
  if (shouldStopAppUpdatePolling(updateStatus.state)) stopPeriodicUpdateChecks();
}

function stopPeriodicUpdateChecks() {
  if (!updateCheckTimer) return;
  clearInterval(updateCheckTimer);
  updateCheckTimer = null;
}

function startPeriodicUpdateChecks() {
  if (!app.isPackaged || updateCheckTimer || shouldStopAppUpdatePolling(updateStatus.state)) return;
  updateCheckTimer = setInterval(() => {
    if (!shouldRunPeriodicAppUpdateCheck(updateStatus.state)) return;
    void checkForAppUpdates();
  }, APP_UPDATE_CHECK_INTERVAL_MS);
}

function getReleaseNotes(info: UpdateInfo) {
  const notes = info.releaseNotes;
  if (typeof notes === "string") return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "note" in item) return String(item.note || "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return undefined;
}

function updateStatusFromInfo(state: AppUpdateState, info?: UpdateInfo, extra?: Partial<AppUpdateStatus>) {
  updateStatusPatch({
    state,
    version: info?.version || updateStatus.version,
    releaseDate: info?.releaseDate || updateStatus.releaseDate,
    releaseName: info?.releaseName || updateStatus.releaseName,
    releaseNotes: info ? getReleaseNotes(info) : updateStatus.releaseNotes,
    error: undefined,
    ...extra,
  });
}

function shouldShowSystemNotification() {
  if (!mainWindow || mainWindow.isDestroyed()) return true;
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) return true;
  return !mainWindow.isFocused() && BrowserWindow.getFocusedWindow() !== mainWindow;
}

function showSystemNotification(title: string, body: string) {
  if (!Notification.isSupported()) {
    return { success: false, error: "System notifications are not supported on this platform." };
  }
  if (!shouldShowSystemNotification()) {
    return { success: true };
  }
  const notification = new Notification({ title, body, icon: getIconPath() });
  notification.on("click", focusMainWindow);
  notification.show();
  return { success: true };
}

function notifyUpdate(title: string, body: string) {
  showSystemNotification(title, body);
}

function initAutoUpdater() {
  if (updaterInitialized) return;
  updaterInitialized = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  const explicitUrl = process.env.HPP_UPDATE_URL?.trim();
  if (explicitUrl) {
    autoUpdater.setFeedURL({ provider: "generic", url: explicitUrl });
  }

  autoUpdater.on("checking-for-update", () => {
    updateStatusPatch({
      state: "checking",
      error: undefined,
      percent: undefined,
      bytesPerSecond: undefined,
      transferred: undefined,
      total: undefined,
    });
  });

  autoUpdater.on("update-available", (info) => {
    updateStatusFromInfo("available", info);
    notifyUpdate("Hpp 有新版本", `v${info.version} 可下载`);
  });

  autoUpdater.on("update-not-available", (info) => {
    updateStatusFromInfo("not-available", info, {
      version: app.getVersion(),
    });
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    updateStatusPatch({
      state: "downloading",
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
      error: undefined,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    updateStatusFromInfo("downloaded", info, {
      percent: 100,
    });
    notifyUpdate("Hpp 更新已下载", "重启应用即可安装新版本");
  });

  autoUpdater.on("error", (error) => {
    updateStatusPatch({
      state: "error",
      error: error?.message || String(error),
    });
  });

  updateStatusPatch({
    state: "idle",
    error: undefined,
  });
}

async function checkForAppUpdates() {
  if (!app.isPackaged) {
    updateStatusPatch({
      state: "idle",
      error: "自动更新仅在打包后的应用中可用。",
      canCheck: false,
    });
    return { success: false, error: updateStatus.error, status: updateStatus };
  }

  try {
    initAutoUpdater();
    updateStatusPatch({ state: "checking", error: undefined });
    await autoUpdater.checkForUpdates();
    return { success: true, status: updateStatus };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateStatusPatch({ state: "error", error: message });
    return { success: false, error: message, status: updateStatus };
  }
}

async function downloadAppUpdate() {
  if (!app.isPackaged) {
    return { success: false, error: "自动更新仅在打包后的应用中可用。", status: updateStatus };
  }
  if (updateStatus.state !== "available") {
    return { success: false, error: "当前没有可下载的更新。", status: updateStatus };
  }

  try {
    initAutoUpdater();
    await autoUpdater.downloadUpdate();
    return { success: true, status: updateStatus };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateStatusPatch({ state: "error", error: message });
    return { success: false, error: message, status: updateStatus };
  }
}

function installAppUpdate() {
  if (updateStatus.state !== "downloaded") {
    return { success: false, error: "更新尚未下载完成。", status: updateStatus };
  }
  isQuitting = true;
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { success: true, status: updateStatus };
}

function createWindow() {
  // Remove default menu bar
  Menu.setApplicationMenu(null);

  // Load app icon for taskbar
  const iconPath = getIconPath();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#1e1e1e",
    title: "Hpp",
    icon: iconPath,
    frame: false,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.on("close", (event) => {
    if (isQuitting || !closeToTray) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

if (singleInstanceLock) {
  app.whenReady().then(async () => {
    await loadCloseToTraySetting();
    await remoteAccessServer.initialize(() => mainWindow);
    createWindow();
    createTray();

    // Register IPC handlers
    registerFileHandlers();
    registerStoreHandlers();
    registerPiSDKHandlers();
    registerAgentStatusHandlers();
    registerAgentHandlers(() => mainWindow);
    updateStatusPatch({
      state: "idle",
      canCheck: app.isPackaged,
      error: app.isPackaged ? undefined : "自动更新仅在打包后的应用中可用。",
    });
    if (app.isPackaged) {
      initAutoUpdater();
      startPeriodicUpdateChecks();
      setTimeout(() => {
        void checkForAppUpdates();
      }, 3000);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("second-instance", () => {
    focusMainWindow();
  });
}

app.on("before-quit", (event) => {
  isQuitting = true;
  stopPeriodicUpdateChecks();
  if (agentShutdownStarted) return;
  agentShutdownStarted = true;
  event.preventDefault();
  void Promise.allSettled([
    shutdownAgentRuntime(),
    remoteAccessServer.shutdown(),
  ]).finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Window control IPC
ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:maximize", () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on("window:close", () => mainWindow?.close());

ipcMain.handle("app:getVersion", () => app.getVersion());
ipcMain.handle("app:update:getStatus", () => updateStatus);
ipcMain.handle("app:update:check", () => checkForAppUpdates());
ipcMain.handle("app:update:download", () => downloadAppUpdate());
ipcMain.handle("app:update:install", () => installAppUpdate());
ipcMain.handle("app:getCloseToTray", () => closeToTray);
ipcMain.handle("app:setCloseToTray", (_event, enabled: boolean) => {
  closeToTray = enabled;
  return { success: true };
});
ipcMain.handle("app:showNotification", (_event, options: { title?: string; body?: string }) => {
  return showSystemNotification(options.title || "Hpp", options.body || "");
});

ipcMain.handle("clipboard:writeImage", async (_event, imageDataUrl: string) => {
  if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
    return { success: false, error: "Invalid image data" };
  }

  const image = nativeImage.createFromDataURL(imageDataUrl);
  if (image.isEmpty()) {
    return { success: false, error: "Invalid image data" };
  }

  clipboard.writeImage(image);
  return { success: true };
});
