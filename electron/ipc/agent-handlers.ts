import { ipcMain } from "electron";
import { exec, execFile } from "child_process";
import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import {
  commandExists as commandExistsOnPath,
  getCommandEnv,
  isWindowsShellShim,
  resolveCommand,
} from "../utils/command-utils";
import { getLatestNpmPackageVersion } from "../utils/npm-registry";

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

const CLI_AGENTS: Record<string, CliAgentConfig> = {
  codex: {
    command: "codex",
    packageName: "@openai/codex",
    displayName: "Codex CLI",
  },
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

const DEFAULT_THINKING_LEVEL = "medium";
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const updateInProgress = new Set<string>();

function normalizeThinkingLevel(value: unknown): string | undefined {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "none") return "off";
  return VALID_THINKING_LEVELS.has(normalized) ? normalized : undefined;
}

function extractTopLevelConfigValue(content: string, key: string): string | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) break;

    const match = line.match(new RegExp(`^${key}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s#]+))`));
    if (match) return match[1] || match[2] || match[3];
  }
  return undefined;
}

function getCodexConfigPath(): string {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
}

async function getCodexDefaultThinkingLevel(): Promise<string> {
  try {
    const content = await readFile(getCodexConfigPath(), "utf8");
    return normalizeThinkingLevel(extractTopLevelConfigValue(content, "model_reasoning_effort")) || DEFAULT_THINKING_LEVEL;
  } catch {
    return DEFAULT_THINKING_LEVEL;
  }
}

async function getDefaultThinkingLevel(agentId: string): Promise<string> {
  if (agentId === "codex") return getCodexDefaultThinkingLevel();
  return DEFAULT_THINKING_LEVEL;
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const resolvedCommand = resolveCommand(command);
    execFile(
      resolvedCommand,
      args,
      {
        cwd: options.cwd,
        env: getCommandEnv(),
        shell: isWindowsShellShim(resolvedCommand),
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
  const parts = [command, ...args].map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg));
  const fullCommand = parts.join(" ");

  return new Promise((resolve, reject) => {
    exec(
      fullCommand,
      {
        cwd: options.cwd,
        env: getCommandEnv(),
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

function runNpmCommand(args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<CommandResult> {
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

async function commandExists(command: string): Promise<boolean> {
  return commandExistsOnPath(command, { excludeNodeModules: true });
}

async function getCommandVersion(command: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await runCommand(command, ["--version"], { timeout: 5000 });
    return extractVersion(`${stdout}\n${stderr}`);
  } catch {
    return undefined;
  }
}

async function getLatestPackageVersion(packageName: string): Promise<string | undefined> {
  return getLatestNpmPackageVersion(packageName);
}

async function getCliAgentStatus(config: CliAgentConfig): Promise<AgentStatus> {
  const installed = await commandExists(config.command);
  if (!installed) {
    return {
      installed: false,
      updateAvailable: false,
      canUpdate: await commandExists("npm"),
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
    canUpdate: await commandExists("npm"),
    error,
  };
}

async function getAgentStatus(agentId: string): Promise<AgentStatus> {
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

  ipcMain.handle("agent:getDefaultThinkingLevel", async (_event, agentId: string) => {
    return getDefaultThinkingLevel(agentId);
  });
}
