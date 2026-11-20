import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./file-handlers.ts", import.meta.url), "utf8");

/**
 * Windows 上 VSCode 的 CLI 是 code.cmd。用 execFile + getExecFileInvocation 会在
 * execFile 自动补的 cmd.exe /d /s /c 外层引号里再嵌一层手工引用，路径被引坏，
 * 界面弹「Command failed: cmd.exe /d /s /c chcp 65001>nul & call "...code.cmd" ...」，
 * 中文路径还会变成一屏方块。必须走 installers.runCli（exec 逐段引用 + GBK 解码）。
 */
describe("从外部编辑器打开项目", () => {
  it("uses runCli instead of execFile + getExecFileInvocation", () => {
    const start = source.indexOf('ipcMain.handle("fs:openProjectInEditor"');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("ipcMain.handle(", start + 10);
    const handler = source.slice(start, end > 0 ? end : undefined);

    expect(handler).toContain("runCli(target.cliPath");
    expect(handler).not.toContain("execFile(");
    expect(handler).not.toContain("getExecFileInvocation");
  });

  it("imports runCli and icon resolver from the editor bridge installers", () => {
    expect(source).toContain('import { listInstalledEditors, resolveEditorAppPath, runCli } from "../editor-bridge/installers"');
    expect(source).toContain('import { findDesktopIconPath } from "../editor-bridge/desktop-icon"');
  });

  it("open handler uses the same lightweight probe as the menu (no slow version lookup)", () => {
    const start = source.indexOf('ipcMain.handle("fs:openProjectInEditor"');
    const end = source.indexOf("ipcMain.handle(", start + 10);
    const handler = source.slice(start, end > 0 ? end : undefined);
    expect(handler).toContain("listInstalledEditors()");
    expect(handler).not.toContain("listEditorTargets()");
  });

  it("uses the lightweight probe that skips slow extension-version lookup and includes Zed", () => {
    const installers = readFileSync(new URL("../editor-bridge/installers.ts", import.meta.url), "utf8");
    const start = installers.indexOf("export async function listInstalledEditors");
    expect(start).toBeGreaterThan(-1);
    const end = installers.indexOf("export async function listEditorTargets", start);
    const fn = installers.slice(start, end);
    expect(fn).toContain("resolveCliPath(target)");
    expect(fn).not.toContain("readInstalledVersion");
    // Zed 不在 EDITOR_TARGETS（config 类），要单独探一次才能出现在菜单里。
    expect(fn).toContain("resolveZedCliForLaunch()");
  });

  it("falls back to .desktop icon lookup on Linux", () => {
    const start = source.indexOf('ipcMain.handle("fs:getEditorIcon"');
    const end = source.indexOf("ipcMain.handle(", start + 10);
    const handler = source.slice(start, end > 0 ? end : undefined);
    expect(handler).toContain('process.platform === "linux"');
    expect(handler).toContain("findDesktopIconPath(editorId)");
    expect(handler).toContain("nativeImage.createFromPath");
  });
});
