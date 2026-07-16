import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, win32 } from "node:path";
import { spawn } from "node:child_process";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MIN_NODE_VERSION = "22.19.0";
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
    ".exe",
    ".cmd",
    ".bat",
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

const getRuntimeRoot = (context) => join(context.dataDir, "pi-sdk-runtime");
const getPackagePath = (context) => join(
  getRuntimeRoot(context),
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "package.json",
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
  const timeout = setTimeout(() => child.kill(), options.timeout || 15000);
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.on("exit", (code) => {
    clearTimeout(timeout);
    if (code === 0) resolve({ stdout, stderr });
    else reject(new Error((stderr || stdout || `${command} exited with ${code}`).trim()));
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

const getLatestVersion = async () => {
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`);
    if (!response.ok) return undefined;
    const value = await response.json();
    return typeof value.version === "string" ? value.version : undefined;
  } catch {
    return undefined;
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
  const [currentVersion, latestVersion, nodeVersion, npmVersion] = await Promise.all([
    getCurrentVersion(context),
    getLatestVersion(),
    getCommandVersion("node"),
    getCommandVersion("npm"),
  ]);
  const nodeOk = !!nodeVersion && compareVersions(nodeVersion, MIN_NODE_VERSION) >= 0;
  return {
    installed: !!currentVersion,
    currentVersion,
    latestVersion,
    updateAvailable: !!currentVersion && !!latestVersion && compareVersions(currentVersion, latestVersion) < 0,
    canUpdate: !!npmVersion && nodeOk,
    packageRoot: getRuntimeRoot(context),
    nodeVersion,
    nodeOk,
    source: "plugin",
    installedPath: context.pluginDir,
    removable: true,
    error: !nodeVersion
      ? "未检测到 Node.js。"
      : !nodeOk
        ? `Pi SDK 需要 Node.js ${MIN_NODE_VERSION} 或更高版本。`
        : !npmVersion
          ? "未检测到 npm。"
          : undefined,
  };
};

export const update = async (context) => {
  if (updateInProgress) return { success: false, error: "Pi SDK 正在更新中。" };
  updateInProgress = true;
  const runtimeRoot = getRuntimeRoot(context);
  try {
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, "package.json"), `${JSON.stringify({
      name: "hpp-pi-sdk-runtime",
      private: true,
    }, null, 2)}\n`, "utf8");
    await run("npm", ["install", `${PACKAGE_NAME}@latest`, "--save-exact", "--omit=dev"], {
      cwd: runtimeRoot,
      timeout: 180000,
    });
    return { success: true, status: await getStatus(context) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: await getStatus(context),
    };
  } finally {
    updateInProgress = false;
  }
};

export const uninstall = async (context) => {
  if (updateInProgress) return { success: false, error: "Pi SDK 正在更新中，暂时无法卸载。" };
  try {
    await rm(getRuntimeRoot(context), { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};
