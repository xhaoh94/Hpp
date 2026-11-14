import { BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import { is } from "@electron-toolkit/utils";
import { isNativeWaylandSession } from "./linux-desktop";
import {
  DEFAULT_GLOBAL_QUICK_ASK,
  pickQuickAskTarget,
  toElectronAccelerator,
  type QuickAskRegisterResult,
  type QuickAskSubmitPayload,
  type QuickAskTarget,
} from "../shared/quick-ask";

const QUICK_ASK_WIDTH = 760;
const QUICK_ASK_HEIGHT = 150;

let quickAskWindow: BrowserWindow | null = null;
let mainWindowRef: BrowserWindow | null = null;
let registeredAccelerator: string | null = null;

export function setQuickAskMainWindow(win: BrowserWindow | null) {
  mainWindowRef = win;
}

function createQuickAskWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: QUICK_ASK_WIDTH,
    height: QUICK_ASK_HEIGHT,
    // 标题是给 Wayland 合成器做窗口规则匹配用的（niri/sway 按 title 判定浮动）。
    title: "Hpp Quick Ask",
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, "floating");
  if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 失焦即收起；开着 devtools 时不收，否则没法调试。
  win.on("blur", () => {
    if (quickAskWindow && !quickAskWindow.isDestroyed() && !quickAskWindow.webContents.isDevToolsOpened()) {
      quickAskWindow.hide();
    }
  });
  win.on("closed", () => {
    if (quickAskWindow === win) quickAskWindow = null;
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?quick=1`);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"), { query: { quick: "1" } });
  }
  return win;
}

function positionQuickAskWindow(win: BrowserWindow) {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = display.workArea;
  win.setBounds({
    x: Math.round(x + (width - QUICK_ASK_WIDTH) / 2),
    y: Math.round(y + height * 0.18),
    width: QUICK_ASK_WIDTH,
    height: QUICK_ASK_HEIGHT,
  });
}

function showQuickAskWindow() {
  if (!quickAskWindow || quickAskWindow.isDestroyed()) quickAskWindow = createQuickAskWindow();
  const win = quickAskWindow;
  positionQuickAskWindow(win);

  const reveal = () => {
    if (win.isDestroyed()) return;
    positionQuickAskWindow(win);
    win.show();
    win.focus();
    win.webContents.send("quick:focus");
  };
  // 首次唤起时渲染进程还没加载完，先显示会闪一块空白；等首帧再露出来。
  if (win.webContents.isLoading()) {
    win.once("ready-to-show", reveal);
    return;
  }
  reveal();
}

function hideQuickAskWindow() {
  if (quickAskWindow && !quickAskWindow.isDestroyed()) quickAskWindow.hide();
}

function toggleQuickAskWindow() {
  if (quickAskWindow && !quickAskWindow.isDestroyed() && quickAskWindow.isVisible()) {
    hideQuickAskWindow();
    return;
  }
  showQuickAskWindow();
}

/**
 * 供外部启动器调用（Wayland 合成器的 keybind 就是靠二次启动带 --quick-ask 进来的）。
 * 主窗口可能没显示，这里只负责把输入条弹出来。
 */
export function showQuickAsk() {
  showQuickAskWindow();
}

/**
 * 注册系统级唤起快捷键。传空串表示禁用。
 *
 * 注册失败通常是被其它程序占用；必须把错误回给设置页，静默失败会让用户以为功能坏了。
 */
export function applyGlobalQuickAsk(displayShortcut: string): QuickAskRegisterResult {
  if (registeredAccelerator) {
    globalShortcut.unregister(registeredAccelerator);
    registeredAccelerator = null;
  }
  const shortcut = displayShortcut.trim();
  if (!shortcut) return { ok: true };

  const accelerator = toElectronAccelerator(shortcut);
  if (!accelerator) return { ok: false, error: "快捷键格式无效，需要至少一个修饰键加一个按键。" };

  try {
    const ok = globalShortcut.register(accelerator, () => toggleQuickAskWindow());
    if (!ok) {
      return {
        ok: false,
        error: isNativeWaylandSession()
          ? "当前 Wayland 桌面不支持系统级快捷键，请在合成器里绑定 `--quick-ask`（README 有 niri 示例）。"
          : "该快捷键已被其它程序占用。",
      };
    }
    registeredAccelerator = accelerator;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function destroyQuickAskWindow() {
  if (quickAskWindow && !quickAskWindow.isDestroyed()) quickAskWindow.destroy();
  quickAskWindow = null;
}

export function disposeGlobalQuickAsk() {
  if (registeredAccelerator) {
    globalShortcut.unregister(registeredAccelerator);
    registeredAccelerator = null;
  }
  destroyQuickAskWindow();
}

async function readQuickAskTarget(): Promise<QuickAskTarget | null> {
  const dataDir = (process.env.HPP_DATA_DIR || "").trim();
  if (!dataDir) return null;
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, "projects.json"), "utf-8"));
    return pickQuickAskTarget(parsed);
  } catch {
    return null;
  }
}

export async function loadGlobalQuickAskFromSettings(settingsPath: string): Promise<QuickAskRegisterResult> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf-8")) as { shortcuts?: { globalQuickAsk?: unknown } };
    const configured = parsed.shortcuts?.globalQuickAsk;
    // 没配过时用默认值；显式空串是「禁用」，不能回退默认。
    const shortcut = typeof configured === "string" ? configured : DEFAULT_GLOBAL_QUICK_ASK;
    return applyGlobalQuickAsk(shortcut);
  } catch {
    return applyGlobalQuickAsk(DEFAULT_GLOBAL_QUICK_ASK);
  }
}

export function registerQuickAskIpc() {
  ipcMain.handle("quick:setShortcut", (_event, shortcut: unknown) =>
    applyGlobalQuickAsk(typeof shortcut === "string" ? shortcut : ""));

  ipcMain.handle("quick:getTarget", () => readQuickAskTarget());

  ipcMain.handle("quick:hide", () => {
    hideQuickAskWindow();
    return { ok: true };
  });

  // 应用内兜底：Wayland 下系统快捷键注册不上，靠窗口内的同一个组合键唤出。
  ipcMain.handle("quick:show", () => {
    showQuickAskWindow();
    return { ok: true };
  });

  ipcMain.handle("quick:getStatus", () => ({ supported: registeredAccelerator !== null }));

  ipcMain.handle("quick:submit", (_event, payload: QuickAskSubmitPayload) => {
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    const content = typeof payload?.content === "string" ? payload.content.trim() : "";
    if (!sessionId || !content) return { ok: false, error: "消息为空。" };

    const main = mainWindowRef;
    if (!main || main.isDestroyed()) return { ok: false, error: "主窗口不可用。" };

    hideQuickAskWindow();
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    main.webContents.send("app:quick-submit", {
      sessionId,
      content,
      clientMessageId: typeof payload.clientMessageId === "string" && payload.clientMessageId
        ? payload.clientMessageId
        : randomUUID(),
    } satisfies QuickAskSubmitPayload);
    return { ok: true };
  });
}
