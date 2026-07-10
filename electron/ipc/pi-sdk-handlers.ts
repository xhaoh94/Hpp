import { app, ipcMain } from "electron";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { commandExists, getCommandEnv, getExecFileInvocation, getNodeExecutable } from "../utils/command-utils";
import { getLatestNpmPackageVersion } from "../utils/npm-registry";
import { getPiSDKPackageJsonPath, getPiSDKUserRuntimeRoot, PI_SDK_PACKAGE } from "../utils/pi-sdk-runtime";

const MIN_NODE_VERSION = "22.19.0";

export interface PiSDKStatus {
  installed: boolean;
  currentVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  canUpdate: boolean;
  packageRoot?: string;
  nodeVersion?: string;
  nodeOk?: boolean;
  error?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type CommandError = Error & {
  stdout?: string;
  stderr?: string;
};

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const env = getCommandEnv();
    const invocation = getExecFileInvocation(command, args, env);
    execFile(
      invocation.command,
      invocation.args,
      {
        cwd: options.cwd,
        env,
        encoding: "utf8",
        timeout: options.timeout ?? 15000,
        maxBuffer: 1024 * 1024 * 4,
      },
      (error, stdout, stderr) => {
        if (error) {
          const commandError = error as CommandError;
          commandError.stdout = stdout;
          commandError.stderr = stderr;
          reject(commandError);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function nodeCommand(): string {
  return getNodeExecutable(["PI_NODE_PATH"]);
}

function runNpmCommand(
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
): Promise<CommandResult> {
  return runCommand("npm", args, options);
}

function parseVersion(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function formatError(error: unknown): string {
  const err = error as CommandError;
  const detail = (err.stderr || err.stdout || err.message || String(error)).trim();
  return detail.split(/\r?\n/).filter(Boolean).slice(-3).join("\n");
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function findBundledPackageRoot(): Promise<string | undefined> {
  const candidates = Array.from(new Set([
    process.cwd(),
    app.getAppPath(),
  ]));

  for (const candidate of candidates) {
    const packageJsonPath = join(candidate, "package.json");
    if (!existsSync(packageJsonPath)) continue;

    const packageJson = await readJsonFile<{
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(packageJsonPath);

    if (
      packageJson?.name === "hpp" ||
      packageJson?.dependencies?.[PI_SDK_PACKAGE] ||
      packageJson?.devDependencies?.[PI_SDK_PACKAGE]
    ) {
      return candidate;
    }
  }

  return undefined;
}

async function getInstalledVersion(packageRoot: string): Promise<string | undefined> {
  const packageJson = await readJsonFile<{ version?: string }>(
    getPiSDKPackageJsonPath(packageRoot)
  );
  return packageJson?.version;
}

async function getActivePackageRoot(): Promise<string | undefined> {
  const userRuntimeRoot = getPiSDKUserRuntimeRoot();
  if (await getInstalledVersion(userRuntimeRoot)) return userRuntimeRoot;
  return app.isPackaged ? undefined : findBundledPackageRoot();
}

async function getLatestVersion(): Promise<string | undefined> {
  return getLatestNpmPackageVersion(PI_SDK_PACKAGE);
}

async function getNodeStatus(): Promise<Pick<PiSDKStatus, "nodeVersion" | "nodeOk">> {
  try {
    const { stdout } = await runCommand(nodeCommand(), ["-v"], { timeout: 5000 });
    const nodeVersion = stdout.trim().replace(/^v/, "");
    return {
      nodeVersion,
      nodeOk: compareVersions(nodeVersion, MIN_NODE_VERSION) >= 0,
    };
  } catch {
    return { nodeOk: false };
  }
}

export async function getPiSDKStatus(): Promise<PiSDKStatus> {
  const packageRoot = await getActivePackageRoot();
  const currentVersion = packageRoot ? await getInstalledVersion(packageRoot) : undefined;
  const nodeStatus = await getNodeStatus();
  let latestVersion: string | undefined;
  let error: string | undefined;

  try {
    latestVersion = await getLatestVersion();
  } catch (err) {
    error = `无法检查最新版本：${formatError(err)}`;
  }

  const updateAvailable = !!(
    currentVersion &&
    latestVersion &&
    compareVersions(currentVersion, latestVersion) < 0
  );
  const environmentError = !nodeStatus.nodeOk
    ? `Pi SDK 需要 Node.js >= ${MIN_NODE_VERSION}${nodeStatus.nodeVersion ? `，当前版本为 ${nodeStatus.nodeVersion}` : ""}`
    : commandExists("npm")
      ? undefined
      : "未检测到 npm，请重新安装包含 npm 的 Node.js";

  return {
    installed: !!currentVersion,
    currentVersion,
    latestVersion,
    updateAvailable,
    canUpdate: commandExists("npm") && nodeStatus.nodeOk === true,
    packageRoot,
    ...nodeStatus,
    error: error || environmentError,
  };
}

let updateInProgress = false;

export async function updatePiSDK(): Promise<{ success: boolean; error?: string; status?: PiSDKStatus }> {
  if (updateInProgress) {
    return { success: false, error: "Pi SDK 正在更新中" };
  }

  const packageRoot = app.isPackaged ? getPiSDKUserRuntimeRoot() : await findBundledPackageRoot();
  if (!packageRoot) return { success: false, error: "未找到 Pi SDK 安装目录" };

  updateInProgress = true;
  try {
    if (app.isPackaged) {
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
        name: "hpp-pi-sdk-runtime",
        private: true,
      }, null, 2)}\n`, "utf8");
    }
    await runNpmCommand(
      ["install", `${PI_SDK_PACKAGE}@latest`, "--save-exact", "--omit=dev"],
      { cwd: packageRoot, timeout: 180000 }
    );
    return { success: true, status: await getPiSDKStatus() };
  } catch (err) {
    return { success: false, error: formatError(err), status: await getPiSDKStatus() };
  } finally {
    updateInProgress = false;
  }
}

export async function uninstallPiSDK(): Promise<{ success: boolean; error?: string }> {
  if (updateInProgress) return { success: false, error: "Pi SDK 正在更新中，暂时无法卸载" };
  try {
    await rm(getPiSDKUserRuntimeRoot(), { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: formatError(error) };
  }
}

export function registerPiSDKHandlers() {
  ipcMain.handle("pi-sdk:getStatus", async () => getPiSDKStatus());

  ipcMain.handle("pi-sdk:update", async () => updatePiSDK());
}
