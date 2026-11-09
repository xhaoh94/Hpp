import { exec, execFile } from "child_process";
import AdmZip from "adm-zip";
import { app } from "electron";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";

import type {
  EditorBridgeInstallResult,
  EditorBridgeTargetId,
  EditorBridgeTargetInfo,
} from "../../shared/editor-bridge-protocol";
import { isZedConfigured, isZedInstalled } from "./zed";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const EXTENSION_ID = "xhaoh94.hpp-bridge";
const VSIX_FILENAME = "hpp-bridge.vsix";

type EditorTarget = {
  id: EditorBridgeTargetId;
  label: string;
  /** PATH 查找用的命令名；Windows 下要带上 .cmd，否则查不到垫片。 */
  commands: string[];
  cliCandidates: () => string[];
  appCandidates: () => string[];
};

const isWindows = () => process.platform === "win32";
const localAppData = () => process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const programFiles = () => process.env.ProgramFiles || "C:\\Program Files";
const programFilesX86 = () => process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

/**
 * 探测顺序是先绝对路径、再 PATH。编辑器装好但 CLI 没进 PATH 太常见
 * （macOS 默认就没有 code），所以绝对路径必须是第一等公民。
 */
const EDITOR_TARGETS: EditorTarget[] = [
  {
    id: "vscode",
    label: "Visual Studio Code",
    commands: ["code", "code.cmd"],
    cliCandidates: () => (isWindows()
      ? [
          join(localAppData(), "Programs", "Microsoft VS Code", "bin", "code.cmd"),
          join(programFiles(), "Microsoft VS Code", "bin", "code.cmd"),
          join(programFilesX86(), "Microsoft VS Code", "bin", "code.cmd"),
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            join(homedir(), "Applications", "Visual Studio Code.app/Contents/Resources/app/bin/code"),
          ]
        : ["/usr/bin/code", "/usr/share/code/bin/code", "/snap/bin/code", join(homedir(), ".local", "bin", "code")]),
    appCandidates: () => (isWindows()
      ? [
          join(localAppData(), "Programs", "Microsoft VS Code", "Code.exe"),
          join(programFiles(), "Microsoft VS Code", "Code.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Visual Studio Code.app"]
        : ["/usr/share/code", "/usr/bin/code", "/snap/bin/code"]),
  },
  {
    id: "vscodium",
    label: "VSCodium",
    commands: ["codium", "codium.cmd"],
    cliCandidates: () => (isWindows()
      ? [join(programFiles(), "VSCodium", "bin", "codium.cmd"), join(localAppData(), "Programs", "VSCodium", "bin", "codium.cmd")]
      : process.platform === "darwin"
        ? ["/Applications/VSCodium.app/Contents/Resources/app/bin/codium"]
        : ["/usr/bin/codium", "/snap/bin/codium"]),
    appCandidates: () => (isWindows()
      ? [join(programFiles(), "VSCodium", "VSCodium.exe"), join(localAppData(), "Programs", "VSCodium", "VSCodium.exe")]
      : process.platform === "darwin" ? ["/Applications/VSCodium.app"] : ["/usr/share/codium", "/usr/bin/codium"]),
  },
  {
    id: "cursor",
    label: "Cursor",
    commands: ["cursor", "cursor.cmd"],
    cliCandidates: () => (isWindows()
      ? [join(localAppData(), "Programs", "cursor", "resources", "app", "bin", "cursor.cmd")]
      : process.platform === "darwin"
        ? ["/Applications/Cursor.app/Contents/Resources/app/bin/cursor"]
        : ["/usr/bin/cursor", join(homedir(), ".local", "bin", "cursor")]),
    appCandidates: () => (isWindows()
      ? [join(localAppData(), "Programs", "cursor", "Cursor.exe")]
      : process.platform === "darwin" ? ["/Applications/Cursor.app"] : ["/usr/share/cursor", "/opt/Cursor"]),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    commands: ["windsurf", "windsurf.cmd"],
    cliCandidates: () => (isWindows()
      ? [join(localAppData(), "Programs", "Windsurf", "bin", "windsurf.cmd")]
      : process.platform === "darwin"
        ? ["/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"]
        : ["/usr/bin/windsurf"]),
    appCandidates: () => (isWindows()
      ? [join(localAppData(), "Programs", "Windsurf", "Windsurf.exe")]
      : process.platform === "darwin" ? ["/Applications/Windsurf.app"] : ["/opt/Windsurf"]),
  },
];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Windows 上 .cmd/.bat/无扩展名垫片不能直接 execFile（EINVAL/ENOENT），必须走 cmd。 */
export function cliNeedsCmdWrapper(command: string, platform = process.platform): boolean {
  return platform === "win32" && !/\.exe$/i.test(command);
}

/** 路径含空格时逐段加引号，外层引号由 exec 自己补，别用 shell: true。 */
async function runCli(command: string, args: string[], timeout: number) {
  if (!cliNeedsCmdWrapper(command)) {
    return execFileAsync(command, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 });
  }
  const commandLine = [command, ...args].map((part) => `"${part}"`).join(" ");
  const { stdout, stderr } = await execAsync(commandLine, {
    windowsHide: true,
    timeout,
    maxBuffer: 1024 * 1024,
    encoding: "buffer",
  });
  return { stdout: decodeCliOutput(stdout), stderr: decodeCliOutput(stderr) };
}

/** cmd 和 VSCode 的 CLI 在中文 Windows 上输出 GBK，按 UTF-8 解会变成一屏方块。 */
function decodeCliOutput(value: Buffer | string): string {
  if (typeof value === "string") return value;
  const utf8 = new TextDecoder("utf-8").decode(value);
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gbk").decode(value);
  } catch {
    return utf8;
  }
}

/** exec 的 message 会把整条命令行带上，界面上没法看；优先取 stderr 前几行。 */
function cliFailureMessage(error: unknown, command: string): string {
  const stderr = (error as { stderr?: Buffer | string } | null)?.stderr;
  const detail = stderr ? decodeCliOutput(stderr).trim() : "";
  if (detail) return detail.split(/\r?\n/).filter(Boolean).slice(0, 3).join("\n");
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "number") return `安装命令退出码 ${code}。`;
  // 带上路径：ENOENT 基本都是「找到的路径根本执行不了」，不写出来没法排查。
  if (typeof code === "string") return `无法执行 ${command}（${code}）。`;
  return errorMessage(error);
}

/**
 * Windows 的 `where code` 会**先**返回无扩展名的 `bin/code`（bash 垫片），
 * 那个东西 spawn 不了（ENOENT）。找到这种路径时换成同目录的 .cmd。
 */
export function preferExecutableShim(path: string): string {
  if (!isWindows() || /\.(exe|cmd|bat)$/i.test(path)) return path;
  for (const suffix of [".cmd", ".bat", ".exe"]) {
    if (existsSync(path + suffix)) return path + suffix;
  }
  return path;
}

async function resolveCliPath(target: EditorTarget): Promise<string | null> {
  for (const candidate of target.cliCandidates()) {
    if (existsSync(candidate)) return preferExecutableShim(candidate);
  }
  const lookup = isWindows() ? "where" : "which";
  for (const command of target.commands) {
    try {
      const { stdout } = await execFileAsync(lookup, [command], { windowsHide: true, timeout: 5000 });
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      // 优先挑真的能执行的那个后缀，别被排在前面的垫片/脚本骗到。
      const executable = lines.find((line) => /\.(exe|cmd|bat)$/i.test(line) && existsSync(line));
      if (executable) return executable;
      const first = lines.find((line) => existsSync(line));
      if (first) return preferExecutableShim(first);
    } catch {
      // 不在 PATH 里，试下一个命令名。
    }
  }
  return null;
}

async function readInstalledVersion(cliPath: string, extensionId: string): Promise<string | null> {
  try {
    const { stdout } = await runCli(cliPath, ["--list-extensions", "--show-versions"], 15000);
    for (const line of stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      const separator = line.lastIndexOf("@");
      if (separator <= 0) continue;
      if (line.slice(0, separator).toLowerCase() === extensionId.toLowerCase()) {
        return line.slice(separator + 1);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveVsixPath(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "editors", VSIX_FILENAME)]
    : [join(app.getAppPath(), "resources", "editors", VSIX_FILENAME)];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** 版本号只从 vsix 里的 extension/package.json 读，不再维护第二份。 */
export function getBundledExtensionVersion(): string | null {
  // 不缓存：vsix 只有几 KB，解压一次的开销远小于「重新打包了但面板还显示旧版本」的代价。
  const vsixPath = resolveVsixPath();
  if (!vsixPath) return null;
  try {
    const entry = new AdmZip(vsixPath).getEntry("extension/package.json");
    if (!entry) return null;
    const parsed = JSON.parse(entry.getData().toString("utf8"));
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export async function listEditorTargets(): Promise<EditorBridgeTargetInfo[]> {
  const bundledVersion = getBundledExtensionVersion();
  const editors: EditorBridgeTargetInfo[] = await Promise.all(EDITOR_TARGETS.map(async (target) => {
    const cliPath = await resolveCliPath(target);
    const installedVersion = cliPath ? await readInstalledVersion(cliPath, EXTENSION_ID) : null;
    return {
      id: target.id,
      label: target.label,
      kind: "extension" as const,
      appInstalled: cliPath !== null || target.appCandidates().some((candidate) => existsSync(candidate)),
      cliPath,
      configured: installedVersion !== null,
      installedVersion,
      bundledVersion,
    };
  }));
  // Zed 不走 vsix：接入方式是往它自己的 tasks.json 里写一条任务。
  editors.push({
    id: "zed",
    label: "Zed",
    kind: "config",
    appInstalled: isZedInstalled(),
    cliPath: null,
    configured: isZedConfigured(),
    installedVersion: null,
    bundledVersion: null,
  });
  return editors;
}

export async function installEditorExtension(targetId: string): Promise<EditorBridgeInstallResult> {
  const target = EDITOR_TARGETS.find((item) => item.id === targetId);
  if (!target) return { success: false, error: "未知的编辑器。" };

  const cliPath = await resolveCliPath(target);
  if (!cliPath) {
    return { success: false, error: `没有找到 ${target.label} 的命令行工具，无法自动安装。` };
  }
  const vsixPath = resolveVsixPath();
  if (!vsixPath) {
    return { success: false, error: "安装目录里缺少 hpp-bridge.vsix，请重新安装 Hpp。" };
  }

  try {
    const { stdout, stderr } = await runCli(
      cliPath,
      ["--install-extension", vsixPath, "--force"],
      120000,
    );
    return { success: true, output: (stdout || stderr || "").trim() || undefined };
  } catch (error) {
    return { success: false, error: cliFailureMessage(error, cliPath) };
  }
}

export { EXTENSION_ID };
