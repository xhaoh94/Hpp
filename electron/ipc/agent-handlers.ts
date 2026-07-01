import { app, ipcMain } from "electron";
import { execFile, exec } from "child_process";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

export interface AgentStatus {
  installed: boolean;
  currentVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  canUpdate: boolean;
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

interface CliAgentConfig {
  command: string;
  packageName: string;
  displayName: string;
}

interface SDKAgentConfig {
  packageName: string;
  displayName: string;
  packagePath: string[];
}

const CLI_AGENTS: Record<string, CliAgentConfig> = {
  opencode: {
    command: "opencode",
    packageName: "opencode-ai",
    displayName: "OpenCode",
  },
  droid: {
    command: "droid",
    packageName: "droid",
    displayName: "Factory Droid",
  },
};

const SDK_AGENTS: Record<string, SDKAgentConfig> = {
  codex: {
    packageName: "@openai/codex-sdk",
    displayName: "Codex SDK",
    packagePath: ["@openai", "codex-sdk"],
  },
};

const updateInProgress = new Set<string>();

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
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

function runShellCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
): Promise<CommandResult> {
  // Join command and args into a single shell string.
  // Using exec() ensures proper PATH resolution and shell semantics on all platforms.
  const parts = [command, ...args].map((a) => {
    // Quote arguments containing spaces
    if (/[\s"]/.test(a)) {
      return JSON.stringify(a);
    }
    return a;
  });
  const fullCommand = parts.join(" ");

  return new Promise((resolve, reject) => {
    exec(
      fullCommand,
      {
        cwd: options.cwd,
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

function runNpmCommand(
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
): Promise<CommandResult> {
  return runShellCommand("npm", args, options);
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

function extractVersion(output: string): string | undefined {
  return output.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1];
}

function splitCommandPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function findProjectPackageRoot(packageName: string): Promise<string | undefined> {
  const candidates = Array.from(new Set([
    process.cwd(),
    app.getAppPath(),
  ]));

  for (const candidate of candidates) {
    const packageJsonPath = join(candidate, "package.json");
    if (!existsSync(packageJsonPath)) continue;

    const packageJson = await readJsonFile<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(packageJsonPath);

    if (packageJson?.dependencies?.[packageName] || packageJson?.devDependencies?.[packageName]) {
      return candidate;
    }
  }

  return undefined;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    const lookupCommand = process.platform === "win32" ? "where.exe" : "which";
    const lookupArgs = process.platform === "win32" ? [command] : ["-a", command];
    const { stdout } = await runCommand(lookupCommand, lookupArgs, { timeout: 5000 });
    return splitCommandPaths(stdout).some((path) => !path.includes("node_modules"));
  } catch {
    return false;
  }
}

async function getCommandVersion(command: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await runShellCommand(command, ["--version"], { timeout: 5000 });
    return extractVersion(`${stdout}\n${stderr}`);
  } catch {
    return undefined;
  }
}

async function getLatestPackageVersion(packageName: string): Promise<string | undefined> {
  const { stdout } = await runNpmCommand(["view", packageName, "version", "--json"], {
    timeout: 15000,
  });
  const raw = stdout.trim();
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return raw.replace(/^"|"$/g, "");
  }
}

async function getCliAgentStatus(config: CliAgentConfig): Promise<AgentStatus> {
  const installed = await commandExists(config.command);
  if (!installed) {
    return {
      installed: false,
      updateAvailable: false,
      canUpdate: false,
    };
  }

  const currentVersion = await getCommandVersion(config.command);
  let latestVersion: string | undefined;
  let error: string | undefined;

  try {
    latestVersion = await getLatestPackageVersion(config.packageName);
  } catch (err) {
    error = `无法检查 ${config.displayName} 最新版本：${formatError(err)}`;
  }

  const canUpdate = await commandExists("npm");
  const updateAvailable = !!(
    currentVersion &&
    latestVersion &&
    compareVersions(currentVersion, latestVersion) < 0
  );

  return {
    installed: true,
    currentVersion,
    latestVersion,
    updateAvailable,
    canUpdate,
    error,
  };
}

async function getSDKAgentStatus(config: SDKAgentConfig): Promise<AgentStatus> {
  const packageRoot = await findProjectPackageRoot(config.packageName);
  const packageJsonPath = packageRoot
    ? join(packageRoot, "node_modules", ...config.packagePath, "package.json")
    : undefined;
  const packageJson = packageJsonPath
    ? await readJsonFile<{ version?: string }>(packageJsonPath)
    : null;
  const currentVersion = packageJson?.version;

  let latestVersion: string | undefined;
  let error: string | undefined;
  try {
    latestVersion = await getLatestPackageVersion(config.packageName);
  } catch (err) {
    error = `无法检查 ${config.displayName} 最新版本：${formatError(err)}`;
  }

  const updateAvailable = !!(
    currentVersion &&
    latestVersion &&
    compareVersions(currentVersion, latestVersion) < 0
  );

  return {
    installed: !!currentVersion,
    currentVersion,
    latestVersion,
    updateAvailable,
    canUpdate: !!packageRoot && !app.isPackaged,
    error,
  };
}

async function getAgentStatus(agentId: string): Promise<AgentStatus> {
  const sdkConfig = SDK_AGENTS[agentId];
  if (sdkConfig) return getSDKAgentStatus(sdkConfig);

  const config = CLI_AGENTS[agentId];
  if (!config) {
    return {
      installed: false,
      updateAvailable: false,
      canUpdate: false,
      error: `不支持的 agent: ${agentId}`,
    };
  }

  return getCliAgentStatus(config);
}

async function updateAgent(agentId: string): Promise<{ success: boolean; status?: AgentStatus; error?: string }> {
  const sdkConfig = SDK_AGENTS[agentId];
  if (sdkConfig) {
    if (updateInProgress.has(agentId)) {
      return { success: false, error: `${sdkConfig.displayName} 正在更新中` };
    }

    const packageRoot = await findProjectPackageRoot(sdkConfig.packageName);
    if (!packageRoot) {
      return { success: false, error: `未找到包含 ${sdkConfig.packageName} 的 package.json` };
    }
    if (app.isPackaged) {
      return { success: false, error: `打包版暂不支持自动更新 ${sdkConfig.displayName}` };
    }

    updateInProgress.add(agentId);
    try {
      await runNpmCommand(["install", `${sdkConfig.packageName}@latest`], {
        cwd: packageRoot,
        timeout: 180000,
      });
      return { success: true, status: await getAgentStatus(agentId) };
    } catch (err) {
      return { success: false, error: formatError(err), status: await getAgentStatus(agentId) };
    } finally {
      updateInProgress.delete(agentId);
    }
  }

  const config = CLI_AGENTS[agentId];
  if (!config) {
    return { success: false, error: `不支持的 agent: ${agentId}` };
  }

  if (updateInProgress.has(agentId)) {
    return { success: false, error: `${config.displayName} 正在更新中` };
  }

  if (!(await commandExists("npm"))) {
    return {
      success: false,
      error: "未找到 npm，无法自动更新 CLI agent",
      status: await getAgentStatus(agentId),
    };
  }

  updateInProgress.add(agentId);
  try {
    await runNpmCommand(["install", "-g", `${config.packageName}@latest`], {
      timeout: 180000,
    });
    return { success: true, status: await getAgentStatus(agentId) };
  } catch (err) {
    return { success: false, error: formatError(err), status: await getAgentStatus(agentId) };
  } finally {
    updateInProgress.delete(agentId);
  }
}

export function registerAgentStatusHandlers() {
  ipcMain.handle("agent:getStatus", async (_event, agentId: string) => {
    return getAgentStatus(agentId);
  });

  ipcMain.handle("agent:update", async (_event, agentId: string) => {
    return updateAgent(agentId);
  });
}
