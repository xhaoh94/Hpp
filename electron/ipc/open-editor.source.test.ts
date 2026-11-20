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
    expect(source).toContain('import { listEditorTargets, listInstalledEditors, resolveEditorAppPath, runCli } from "../editor-bridge/installers"');
  });

  it("uses the lightweight probe that skips slow extension-version lookup", () => {
    const installers = readFileSync(new URL("../editor-bridge/installers.ts", import.meta.url), "utf8");
    const start = installers.indexOf("export async function listInstalledEditors");
    expect(start).toBeGreaterThan(-1);
    const end = installers.indexOf("export async function listEditorTargets", start);
    const fn = installers.slice(start, end);
    expect(fn).toContain("resolveCliPath(target)");
    expect(fn).not.toContain("readInstalledVersion");
  });
});
