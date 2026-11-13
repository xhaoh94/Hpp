import { execFile } from "node:child_process";
import type { BrowserWindow } from "electron";

/**
 * Windows 的前台锁会拒绝后台进程的 SetForegroundWindow：Electron 的 focus() 只能把窗口
 * 提到视觉最前，键盘输入仍留在编辑器里。SwitchToThisWindow 不受这条限制；
 * 若仍失败，再用 AttachThreadInput 把本线程挂到前台线程的输入队列上重新抢一次。
 */
export const buildForegroundScript = (hwnd: bigint) => [
  "$sig = @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public class HppForeground {",
  '  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
  '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);',
  '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  "}",
  "'@",
  "Add-Type -TypeDefinition $sig",
  `$h = [IntPtr]::new([Int64]${hwnd.toString()})`,
  "[HppForeground]::SwitchToThisWindow($h, $true)",
  "if ([HppForeground]::GetForegroundWindow() -ne $h) {",
  "  $p = 0",
  "  $t = [HppForeground]::GetWindowThreadProcessId([HppForeground]::GetForegroundWindow(), [ref]$p)",
  "  $m = [HppForeground]::GetCurrentThreadId()",
  "  [void][HppForeground]::AttachThreadInput($m, $t, $true)",
  "  [void][HppForeground]::SetForegroundWindow($h)",
  "  [void][HppForeground]::AttachThreadInput($m, $t, $false)",
  "}",
].join("\r\n");

export const getWindowHandleValue = (window: BrowserWindow): bigint | undefined => {
  const handle = window.getNativeWindowHandle?.();
  if (!handle || handle.length < 4) return undefined;
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
};

/** 异步补一次原生抢前台；失败静默，不影响插入本身。 */
export const requestWindowsForeground = (window: BrowserWindow) => {
  if (process.platform !== "win32" || window.isDestroyed()) return;
  const hwnd = getWindowHandleValue(window);
  if (hwnd === undefined) return;
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", buildForegroundScript(hwnd)],
    { windowsHide: true, timeout: 8000 },
    () => undefined,
  );
};
