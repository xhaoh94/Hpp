import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => process.cwd(), isPackaged: false },
}));

import { cliNeedsCmdWrapper, preferExecutableShim } from "./installers";

/**
 * 回归：Windows 的 `where code` 会把无扩展名的 bin/code（bash 垫片）排在前面，
 * 那个路径 spawn 必 ENOENT —— 线上就是这样报「无法执行编辑器命令行工具」的。
 */
describe("CLI 路径归一", () => {
  it("无扩展名的垫片会换成同目录的 .cmd", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-shim-"));
    try {
      const shim = join(dir, "code");
      writeFileSync(shim, "#!/bin/sh\n", "utf8");
      // 只有垫片、没有 .cmd 时保持原样（后面交给 cmd 执行会给出可读报错）。
      expect(preferExecutableShim(shim, "win32")).toBe(shim);

      writeFileSync(`${shim}.cmd`, "@echo off\n", "utf8");
      const resolved = preferExecutableShim(shim, "win32");
      expect(resolved.endsWith("code.cmd")).toBe(true);
      expect(existsSync(resolved)).toBe(true);
      expect(preferExecutableShim(shim, "linux")).toBe(shim);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("已经是 .cmd / .exe 的路径不动", () => {
    expect(preferExecutableShim("C:/x/code.cmd")).toBe("C:/x/code.cmd");
    expect(preferExecutableShim("C:/x/Code.exe")).toBe("C:/x/Code.exe");
  });
});

/** 回归：.cmd 直接 execFile 会 EINVAL，必须走 cmd 包一层。 */
describe("CLI 调用方式分派", () => {
  it("Windows 下只有 .exe 能直接 execFile", () => {
    expect(cliNeedsCmdWrapper("D:/VS Code/bin/code.cmd", "win32")).toBe(true);
    expect(cliNeedsCmdWrapper("D:/VS Code/bin/code", "win32")).toBe(true);
    expect(cliNeedsCmdWrapper("D:/VS Code/Code.bat", "win32")).toBe(true);
    expect(cliNeedsCmdWrapper("D:/VS Code/Code.exe", "win32")).toBe(false);
  });

  it("非 Windows 一律直接 execFile", () => {
    expect(cliNeedsCmdWrapper("/usr/bin/code", "linux")).toBe(false);
    expect(cliNeedsCmdWrapper("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", "darwin")).toBe(false);
  });
});
