import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, win32 } from "node:path";
import { spawn } from "node:child_process";

export const PACKAGE_NAME = "@anthropic-ai/claude-agent-sdk";
export const SDK_VERSION = "0.3.215";
export const MIN_NODE_VERSION = "18.0.0";
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
let updateInProgress = false;

const getPathValue = (env) => {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") || "PATH";
  return env[key] || "";
};

const findWindowsCommands = (command, env) => {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? [command] : [];
  }
  const extensions = [...new Set([
    ...(env.PATHEXT || "").split(";").map((value) => value.trim().toLowerCase()).filter(Boolean),
    ".exe", ".cmd", ".bat",
  ])];
  const results = [];
  const seen = new Set();
  for (const directory of getPathValue(env).split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = win32.join(directory, `${command}${extension}`);
      const key = candidate.toLowerCase();
      if (seen.has(key) || !existsSync(candidate)) continue;
      seen.add(key);
      results.push(candidate);
    }
  }
  return results;
};

export const resolveRuntimeCommand = (command, args, env = process.env, platform = process.platform) => {
  if (platform !== "win32") return { command, args };
  const candidates = findWindowsCommands(command, env);
  if (command.toLowerCase() === "npm") {
    for (const npmCommand of candidates) {
      const npmCli = join(dirname(npmCommand), "node_modules", "npm", "bin", "npm-cli.js");
      if (!existsSync(npmCli)) continue;
      const siblingNode = join(dirname(npmCommand), "node.exe");
      const nodeCommand = existsSync(siblingNode)
        ? siblingNode
        : findWindowsCommands("node", env).find((candidate) => candidate.toLowerCase().endsWith(".exe"));
      if (nodeCommand) return { command: nodeCommand, args: [npmCli, ...args] };
    }
    throw new Error("npm is not available as a direct Node.js invocation.");
  }
  const executable = candidates.find((candidate) => candidate.toLowerCase().endsWith(".exe"));
  if (!executable) throw new Error(`${command} executable was not found.`);
  return { command: executable, args };
};

export const getRuntimeRoot = (context) => join(context.dataDir, "claude-agent-sdk-runtime");
const getPackagePath = (context) => join(
  getRuntimeRoot(context), "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json",
);

const isMuslRuntime = () => {
  if (process.platform !== "linux") return false;
  try {
    return !process.report?.getReport?.().header?.glibcVersionRuntime;
  } catch {
    return false;
  }
};

export const getNativePackageName = (
  platform = process.platform,
  arch = process.arch,
  musl = isMuslRuntime(),
) => {
  if (!(["x64", "arm64"].includes(arch))) return undefined;
  if (platform === "win32") return `claude-agent-sdk-win32-${arch}`;
  if (platform === "darwin") return `claude-agent-sdk-darwin-${arch}`;
  if (platform === "linux") return `claude-agent-sdk-linux-${arch}${musl ? "-musl" : ""}`;
  return undefined;
};

const getNativePackagePath = (context, nativePackageName) => join(
  getRuntimeRoot(context), "node_modules", "@anthropic-ai", nativePackageName, "package.json",
);

const getNativeExecutablePath = (context, nativePackageName) => join(
  getRuntimeRoot(context),
  "node_modules",
  "@anthropic-ai",
  nativePackageName,
  process.platform === "win32" ? "claude.exe" : "claude",
);

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  let invocation;
  try {
    invocation = resolveRuntimeCommand(command, args);
  } catch (error) {
    reject(error);
    return;
  }
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timedOut = false;
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) reject(error);
    else resolve(result);
  };
  const timeoutMs = options.timeout || 15000;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", (error) => finish(error));
  child.on("exit", (code, signal) => {
    if (code === 0) {
      finish(undefined, { stdout, stderr });
      return;
    }
    const fallback = timedOut
      ? `${command} 安装超过 ${Math.round(timeoutMs / 60000)} 分钟，已停止本次安装。`
      : signal
        ? `${command} 被系统终止（${signal}）。`
        : `${command} 退出，错误码 ${code ?? "未知"}。`;
    const detail = (stderr || stdout).trim();
    finish(new Error(timedOut || signal
      ? `${fallback}${detail ? `\n${detail}` : ""}`
      : detail || fallback));
  });
});

const getCommandVersion = async (command) => {
  try {
    const result = await run(command, ["--version"]);
    return `${result.stdout}\n${result.stderr}`.match(/(\d+\.\d+\.\d+)/)?.[1];
  } catch {
    return undefined;
  }
};

const getCurrentVersion = async (context) => {
  try {
    const value = JSON.parse(await readFile(getPackagePath(context), "utf8"));
    return typeof value.version === "string" ? value.version : undefined;
  } catch {
    return undefined;
  }
};

const getNativeRuntimeStatus = async (context) => {
  const packageName = getNativePackageName();
  if (!packageName) return { packageName: undefined, version: undefined, complete: false };
  try {
    const value = JSON.parse(await readFile(getNativePackagePath(context, packageName), "utf8"));
    const version = typeof value.version === "string" ? value.version : undefined;
    return {
      packageName,
      version,
      complete: version === SDK_VERSION && existsSync(getNativeExecutablePath(context, packageName)),
    };
  } catch {
    return { packageName, version: undefined, complete: false };
  }
};

const compareVersions = (left, right) => {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export const getStatus = async (context) => {
  const [currentVersion, nativeRuntime, nodeVersion, npmVersion] = await Promise.all([
    getCurrentVersion(context), getNativeRuntimeStatus(context), getCommandVersion("node"), getCommandVersion("npm"),
  ]);
  const nodeOk = !!nodeVersion && compareVersions(nodeVersion, MIN_NODE_VERSION) >= 0;
  const installed = currentVersion === SDK_VERSION && nativeRuntime.complete;
  return {
    installed,
    currentVersion,
    latestVersion: SDK_VERSION,
    updateAvailable: !!currentVersion && !installed,
    canUpdate: !!npmVersion && nodeOk,
    packageRoot: getRuntimeRoot(context),
    nodeVersion,
    nodeOk,
    source: "plugin",
    installedPath: context.pluginDir,
    removable: true,
    error: !nativeRuntime.packageName
      ? `Claude Agent SDK 暂不支持当前平台：${process.platform}-${process.arch}。`
      : currentVersion && !nativeRuntime.complete
        ? "Claude Agent SDK 原生运行组件未安装完整，请重新安装。"
        : !nodeVersion
      ? "未检测到 Node.js。"
      : !nodeOk
        ? `Claude Agent SDK 需要 Node.js ${MIN_NODE_VERSION} 或更高版本。`
        : !npmVersion ? "未检测到 npm。" : undefined,
  };
};

export const update = async (context) => {
  if (updateInProgress) return { success: false, error: "Claude Agent SDK 正在安装中。" };
  updateInProgress = true;
  const runtimeRoot = getRuntimeRoot(context);
  try {
    const currentStatus = await getStatus(context);
    if (currentStatus.installed && currentStatus.currentVersion === SDK_VERSION) {
      return { success: true, status: currentStatus };
    }
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, "package.json"), `${JSON.stringify({
      name: "hpp-claude-agent-sdk-runtime", private: true,
    }, null, 2)}\n`, "utf8");
    await run("npm", ["install", `${PACKAGE_NAME}@${SDK_VERSION}`, "--save-exact", "--omit=dev"], {
      cwd: runtimeRoot,
      timeout: INSTALL_TIMEOUT_MS,
    });
    return { success: true, status: await getStatus(context) };
  } catch (error) {
    const status = await getStatus(context);
    if (status.installed && status.currentVersion === SDK_VERSION) {
      return { success: true, status };
    }
    return { success: false, error: error instanceof Error ? error.message : String(error), status: await getStatus(context) };
  } finally {
    updateInProgress = false;
  }
};

export const uninstall = async (context) => {
  if (updateInProgress) return { success: false, error: "Claude Agent SDK 正在安装中，暂时无法卸载。" };
  try {
    await rm(getRuntimeRoot(context), { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};
