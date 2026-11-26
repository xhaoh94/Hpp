import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * CodeBuddy / WorkBuddy CLI 的定位与调用方式。
 *
 * 两条发行渠道：
 *  - npm 公开包 @tencent-ai/codebuddy-code（命令 codebuddy / cbc / codebuddy-code）；
 *  - WorkBuddy 桌面端内嵌的定制包（app.asar.unpacked/cli/bin/codebuddy），
 *    只带 lite-wb 产物，必须开 CODEBUDDY_FORCE_LITE_WB_BUNDLE，否则加载
 *    不存在的 ../dist/codebuddy 直接 MODULE_NOT_FOUND。
 */
export const CODEBUDDY_PACKAGE = "@tencent-ai/codebuddy-code";
export const PUBLIC_COMMANDS = ["codebuddy", "cbc", "codebuddy-code"] as const;

export interface ResolvedCodebuddyCli {
  /** 磁盘上的入口文件：npm 的 .cmd/.exe，或 WorkBuddy 内嵌的 node 脚本 */
  scriptPath: string;
  /** 是否 WorkBuddy 内嵌的 lite-wb 定制包 */
  bundled: boolean;
}

export function findOnPath(binName: string, env: Record<string, string | undefined> = process.env): string | null {
  const pathValue = env.PATH || env.Path || "";
  const separator = process.platform === "win32" ? ";" : ":";
  // Windows 的 npm shim 是 .cmd，直接跑 .ps1 会被执行策略拦住，所以只认 cmd/exe。
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of pathValue.split(separator)) {
    const trimmed = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed) continue;
    for (const extension of extensions) {
      const candidate = join(trimmed, `${binName}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** WorkBuddy 桌面端内嵌的 CLI（跨平台默认安装位置）。 */
export function findBundledCli(env: Record<string, string | undefined> = process.env): string | null {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"]].filter((root): root is string => !!root);
    // 用户级安装（非管理员）通常落在 %LOCALAPPDATA%\Programs。
    if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, "Programs"));
    if (env.USERPROFILE) roots.push(join(env.USERPROFILE, "AppData", "Local", "Programs"));
    for (const root of roots) {
      candidates.push(join(root, "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy");
  } else {
    candidates.push("/opt/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy");
  }
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

/**
 * 解析顺序：CODEBUDDY_PATH → PATH 上的公开命令 → WorkBuddy 内嵌包。
 * 内嵌包放最后，因为它的能力面最窄（没有 TUI/ACP，只适合 headless）。
 */
export function resolveCodebuddyCli(env: Record<string, string | undefined> = process.env): ResolvedCodebuddyCli | null {
  const explicit = String(env.CODEBUDDY_PATH || "").trim();
  if (explicit && existsSync(explicit)) {
    return { scriptPath: explicit, bundled: explicit.includes("app.asar.unpacked") };
  }
  for (const command of PUBLIC_COMMANDS) {
    const found = findOnPath(command, env);
    if (found) return { scriptPath: found, bundled: false };
  }
  const bundled = findBundledCli(env);
  return bundled ? { scriptPath: bundled, bundled: true } : null;
}

export function isWindowsShim(scriptPath: string): boolean {
  return /\.(cmd|bat)$/i.test(scriptPath);
}

export function isExecutableBinary(scriptPath: string): boolean {
  return /\.exe$/i.test(scriptPath);
}

/**
 * 从 npm/pnpm 的 `.cmd` shim 找到真实的 JS 入口。
 *
 * `.cmd` 只能通过 cmd.exe 执行，而 cmd 对参数里的引号/`&`/`|` 没有可靠转义：
 * 系统提示里只要出现一个 `"`，后面的内容就可能被当成命令执行。能找到 JS 入口时
 * 直接用 node 跑，动态参数就不再经过 shell。
 */
export function resolveNodeEntryFromShim(scriptPath: string): string | null {
  const dir = dirname(scriptPath);
  const packageDirs = [
    join(dir, "node_modules", "@tencent-ai", "codebuddy-code"),
    join(dir, "..", "@tencent-ai", "codebuddy-code"),
  ];
  for (const packageDir of packageDirs) {
    const entry = readPackageBin(packageDir);
    if (entry) return entry;
  }

  // pnpm / 自定义布局不一定在固定目录：从 shim 内容里提取 %dp0% 后的相对路径。
  // 离线包生成的 shim 用 `%~dp0app\node_modules\...`（%~dp0 与相对路径直接相连），
  // 没有这个分支就会退化成 cmd.exe 拼参数。
  try {
    const text = readFileSync(scriptPath, "utf8");
    const match = text.match(/%dp0%[\\/]+([^"\r\n]*?node_modules[\\/]@tencent-ai[\\/]codebuddy-code[\\/][^"\r\n]*)/i)
      ?? text.match(/%~dp0[\\/]?([^"\r\n]*?node_modules[\\/]@tencent-ai[\\/]codebuddy-code[\\/][^"\r\n]*)/i)
      ?? text.match(/"([^"\r\n]*?node_modules[\\/]@tencent-ai[\\/]codebuddy-code[\\/][^"\r\n]*)"/i);
    if (match?.[1]) {
      const entry = join(dir, match[1].replace(/^[\\/]+/, ""));
      if (isFile(entry)) return entry;
    }
  } catch {
    // shim 不可读：交给 cmd 兜底。
  }
  return null;
}

/** 只有不经过 cmd 的入口才允许把系统提示等复杂参数放进 argv。 */
export function canPassComplexArgs(cli: ResolvedCodebuddyCli): boolean {
  return !isWindowsShim(cli.scriptPath) || resolveNodeEntryFromShim(cli.scriptPath) !== null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readPackageBin(packageDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      bin?: unknown;
    };
    const bin = manifest.bin;
    const candidates: string[] = [];
    if (typeof bin === "string") {
      candidates.push(bin);
    } else if (bin && typeof bin === "object" && !Array.isArray(bin)) {
      const record = bin as Record<string, unknown>;
      if (typeof record.codebuddy === "string") candidates.push(record.codebuddy);
      for (const value of Object.values(record)) {
        if (typeof value === "string") candidates.push(value);
      }
    }
    candidates.push(join("bin", "codebuddy"), join("dist", "codebuddy.js"));
    for (const candidate of candidates) {
      const entry = join(packageDir, candidate);
      if (isFile(entry)) return entry;
    }
  } catch {
    // 包装不上或没有 bin：交给下一个候选。
  }
  return null;
}

/** 跑 node 脚本用的运行时；Electron 作为 node 时必须补 ELECTRON_RUN_AS_NODE。 */
export function resolveNodeRuntime(): { command: string; env: Record<string, string> } {
  const explicit = String(process.env.CODEBUDDY_NODE_PATH || "").trim();
  if (explicit) return { command: explicit, env: {} };
  const execPath = process.execPath;
  const isElectron = /electron(\.exe)?$/i.test(execPath);
  return { command: execPath, env: isElectron ? { ELECTRON_RUN_AS_NODE: "1" } : {} };
}

export interface CodebuddyInvocation {
  command: string;
  args: string[];
  /** 需要额外注入的环境变量（shell 包装 / 内嵌包开关） */
  env: Record<string, string>;
}

/**
 * 把「入口文件 + 参数」翻译成 spawn 能直接用的形式。
 * - .cmd/.bat：只能走 cmd /c，否则 Windows 不认；
 * - .exe：直接执行；
 * - 其它（npm bin 的 node 脚本、WorkBuddy 内嵌脚本）：用 node 运行时。
 */
export function buildCodebuddyInvocation(
  cli: ResolvedCodebuddyCli,
  args: string[],
  env: Record<string, string | undefined> = process.env,
): CodebuddyInvocation {
  const extraEnv: Record<string, string> = {};
  // 内嵌定制包只有 lite-wb 产物，必须显式路由，否则 require('../dist/codebuddy') 失败。
  if (cli.bundled) extraEnv.CODEBUDDY_FORCE_LITE_WB_BUNDLE = "1";
  if (isExecutableBinary(cli.scriptPath)) {
    return { command: cli.scriptPath, args, env: extraEnv };
  }
  if (isWindowsShim(cli.scriptPath)) {
    // 优先绕过 cmd：npm shim 的 JS 入口可以直接用 node 跑，动态参数不经过 shell。
    const nodeEntry = resolveNodeEntryFromShim(cli.scriptPath);
    if (nodeEntry) {
      const runtime = resolveNodeRuntimeSafe();
      return {
        command: runtime.command,
        args: [nodeEntry, ...args],
        env: { ...runtime.env, ...extraEnv },
      };
    }
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
    // 参数由本模块拼装，prompt 一律走 stdin，不做 shell 拼接。
    return { command: comspec, args: ["/d", "/s", "/c", cli.scriptPath, ...args], env: extraEnv };
  }
  const runtime = resolveNodeRuntimeSafe();
  return {
    command: runtime.command,
    args: [cli.scriptPath, ...args],
    env: { ...runtime.env, ...extraEnv },
  };
}

function resolveNodeRuntimeSafe(): { command: string; env: Record<string, string> } {
  try {
    return resolveNodeRuntime();
  } catch {
    return { command: "node", env: {} };
  }
}
