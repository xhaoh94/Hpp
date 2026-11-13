import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { buildForegroundScript, getWindowHandleValue, requestWindowsForeground } from "./force-foreground";

const fakeWindow = (buffer?: Buffer) => ({
  isDestroyed: () => false,
  getNativeWindowHandle: () => buffer,
}) as never;

let platformSpy: ReturnType<typeof vi.spyOn>;

describe("windows foreground unlock", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("embeds the native handle and goes through the foreground-unlock calls", () => {
    const script = buildForegroundScript(123456789n);
    // Electron 的 focus() 受前台锁限制，这三个调用是绕过它的关键。
    expect(script).toContain("SwitchToThisWindow");
    expect(script).toContain("AttachThreadInput");
    expect(script).toContain("SetForegroundWindow");
    expect(script).toContain("[IntPtr]::new([Int64]123456789)");
  });

  it("reads 64-bit and 32-bit window handles", () => {
    const handle64 = Buffer.alloc(8);
    handle64.writeBigUInt64LE(987654321n);
    expect(getWindowHandleValue(fakeWindow(handle64))).toBe(987654321n);

    const handle32 = Buffer.alloc(4);
    handle32.writeUInt32LE(42);
    expect(getWindowHandleValue(fakeWindow(handle32))).toBe(42n);

    expect(getWindowHandleValue(fakeWindow(undefined))).toBeUndefined();
    expect(getWindowHandleValue(fakeWindow(Buffer.alloc(0)))).toBeUndefined();
  });

  it("spawns a hidden powershell that runs the script", () => {
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(777n);
    requestWindowsForeground(fakeWindow(handle));

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = execFileMock.mock.calls[0];
    expect(command).toBe("powershell.exe");
    expect(args).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command"]));
    expect(args[args.length - 1]).toContain("SwitchToThisWindow");
    expect(options.windowsHide).toBe(true);
  });

  it("does nothing off Windows", () => {
    platformSpy.mockReturnValue("darwin");
    requestWindowsForeground(fakeWindow(Buffer.alloc(8)));
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
