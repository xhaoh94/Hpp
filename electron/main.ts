import { app, BrowserWindow, ipcMain, Menu, nativeImage } from "electron";
import { join } from "path";
import { is } from "@electron-toolkit/utils";
import { registerFileHandlers } from "./ipc/file-handlers";
import { registerStoreHandlers } from "./ipc/store-handlers";
import { registerAgentHandlers } from "./agents/agent-manager";

// Set app name
app.setName("hpp");

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  // Remove default menu bar
  Menu.setApplicationMenu(null);

  // Load app icon for taskbar
  const iconPath = join(__dirname, "../renderer/icon.png");

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
    },
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  // Register IPC handlers
  registerFileHandlers();
  registerStoreHandlers();
  registerAgentHandlers(() => mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
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
