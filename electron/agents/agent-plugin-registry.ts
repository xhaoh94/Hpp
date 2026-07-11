import { app, BrowserWindow } from "electron";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "path";
import { homedir } from "os";
import AdmZip from "adm-zip";
import { AgentPluginProcess, type PluginHostCapabilities } from "./agent-plugin-process";
import { getPiSDKStatus, uninstallPiSDK, updatePiSDK } from "../ipc/pi-sdk-handlers";
import {
  commandExists as commandExistsOnPath,
  findCommandsOnPath,
  getCommandEnv,
  getExecFileInvocation,
  getNpmInvocation,
} from "../utils/command-utils";
import { getLatestNpmPackageVersion } from "../utils/npm-registry";
import type {
  AgentCapabilities,
  AgentDescriptor,
  AgentImagePayload,
  AgentPackageStatus,
  AgentPlanModeSupport,
  AgentPluginInstallResult,
  AgentPluginManifest,
  AgentUIResponse,
} from "../../src/types/ipc";

export interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  supportsImages?: boolean;
}

export interface AgentSendOptions {
  planModeEnabled?: boolean;
  displayMessage?: string;
  permissionMode?: "plan" | "full-access";
  clientMessageId?: string;
}

export interface AgentForkTarget {
  newSessionId: string;
  sourceSessionFilePath?: string;
  sourceUserMessageIndex: number;
  rollbackUserMessageCount?: number;
  targetTurnId?: string;
  sourceMessageContent?: string;
  throughMessageId?: string;
}

export interface AgentForkResult {
  supported: boolean;
  success: boolean;
  sessionFilePath?: string;
  nativeEntryId?: string;
  error?: string;
  reason?: string;
}

export interface AgentBackend {
  setWindow(win: BrowserWindow): void;
  init(projectPath: string, existingSessionFilePath?: string): Promise<void>;
  isIdle(): boolean;
  sendMessage(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void>;
  sendGuidance?(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void>;
  forkSession?(target: AgentForkTarget): Promise<AgentForkResult>;
  abort(): Promise<void>;
  getModels(): Promise<AgentModel[]>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  sendUIResponse(response: AgentUIResponse): void;
  dispose(): void;
  readonly sessionFilePath: string | null;
}

interface PluginRecord {
  descriptor: AgentDescriptor;
  pluginDir: string;
  entryPath: string;
  process?: AgentPluginProcess;
  processCapabilities?: PluginHostCapabilities;
}

interface InstallOptions {
  canReplace?: (agentId: string) => boolean | Promise<boolean>;
  expectedAgentId?: string;
}

interface PluginActivateProviderArgs {
  providerId: string;
  provider: unknown;
  state: unknown;
}

interface PluginActivateProviderResult {
  snapshots?: unknown[];
}

interface AgentHostApi {
  getCliAgentStatus(descriptor: AgentDescriptor): Promise<AgentPackageStatus>;
  updateCliAgent(descriptor: AgentDescriptor): Promise<{ success: boolean; status?: AgentPackageStatus; error?: string }>;
  getPiSDKStatus(pluginDir?: string): Promise<AgentPackageStatus>;
  updatePiSDK(): Promise<{ success: boolean; error?: string; status?: AgentPackageStatus }>;
  getCodexDefaultThinkingLevel(): Promise<string>;
  writeCodexNativeProviderConfig?(args: { state: unknown; provider: unknown }): Promise<PluginActivateProviderResult>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type CommandError = Error & {
  stdout?: string;
  stderr?: string;
};

const MANIFEST_FILE = "hpp-agent-plugin.json";
const DEFAULT_THINKING_LEVEL = "medium";
const MAX_PLUGIN_EVENT_BYTES = 1024 * 1024;
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const DEFAULT_AGENT_ORDER = ["codex", "pi", "opencode", "droid"];

const DEFAULT_PLUGIN_CAPABILITIES: AgentCapabilities = {
  planMode: "prompt",
  guidance: false,
  fork: false,
  configuration: "none",
  providerActivation: "none",
};

function getDataDir() {
  return join(app.getPath("userData"), "hpp-data");
}

function getPluginInstallDir() {
  return join(getDataDir(), "agent-plugins");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePluginEvent(event: unknown): Record<string, unknown> {
  if (!isRecord(event) || typeof event.type !== "string" || !event.type.trim()) {
    throw new Error("Plugin events must include a non-empty type.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(event);
  } catch {
    throw new Error("Plugin event must be JSON serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PLUGIN_EVENT_BYTES) {
    throw new Error("Plugin event exceeds the 1 MB size limit.");
  }
  return event;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePlanMode(value: unknown): AgentPlanModeSupport {
  if (value === "native" || value === "prompt" || value === "none") return value;
  if (value === false) return "none";
  return DEFAULT_PLUGIN_CAPABILITIES.planMode;
}

function normalizeCapabilities(value: unknown): AgentCapabilities {
  const input = isRecord(value) ? value : {};
  const configuration = input.configuration === "openai-compatible"
    ? "openai-compatible"
    : "none";
  return {
    planMode: normalizePlanMode(input.planMode),
    guidance: input.guidance === true,
    fork: input.fork === true,
    configuration,
    providerActivation: input.providerActivation === "single-active" ? "single-active" : "none",
  };
}

function ensureAgentId(id: string) {
  if (!/^[a-zA-Z0-9._:-]+$/.test(id)) {
    throw new Error("Agent ID 只能包含字母、数字、点、下划线、冒号和短横线。");
  }
}

function ensureRelativePath(value: string, label: string) {
  const normalized = value.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`${label} 必须是相对路径。`);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) {
    throw new Error(`${label} 不能包含上级目录。`);
  }
  return parts.join("/");
}

function assertInside(root: string, target: string) {
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("插件路径不能指向安装目录外部。");
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
}

function descriptorFromManifest(
  manifest: AgentPluginManifest,
  source: AgentDescriptor["source"],
  installedPath?: string
): AgentDescriptor {
  if (manifest.schemaVersion !== 1) throw new Error("插件 schemaVersion 必须为 1。");
  const id = asString(manifest.id);
  const name = asString(manifest.name);
  const version = asString(manifest.version);
  const entry = asString(manifest.entry);
  if (!id) throw new Error("插件缺少 id。");
  if (!name) throw new Error(`插件 ${id} 缺少 name。`);
  if (!version) throw new Error(`插件 ${id} 缺少 version。`);
  if (!entry) throw new Error(`插件 ${id} 缺少 entry。`);
  ensureAgentId(id);
  ensureRelativePath(entry, "entry");

  const description = asString(manifest.description);
  const runtime = manifest.runtime === "cli" || manifest.runtime === "sdk" ? manifest.runtime : "plugin";
  const command = asString(manifest.command) || undefined;
  const packageName = asString(manifest.packageName) || undefined;
  const capabilities = normalizeCapabilities(manifest.capabilities);

  return {
    id,
    name,
    desc: description,
    description,
    version,
    runtime,
    command,
    packageName,
    capabilities,
    source,
    removable: source === "plugin",
    installedPath,
    installHint: command ? `请安装或配置 ${command}` : source === "plugin" ? "请检查插件安装目录" : undefined,
    updateCommand: packageName ? `npm install -g ${packageName}@latest` : undefined,
    shortName: id.slice(0, 2).toUpperCase(),
  };
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
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
        resolvePromise({ stdout, stderr });
      }
    );
  });
}

function runNpmCommand(args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<CommandResult> {
  const env = getCommandEnv();
  const invocation = getNpmInvocation(args, env);
  if (!invocation) return Promise.reject(new Error("未找到可用的 npm CLI，请重新安装 Node.js"));
  return runCommand(invocation.command, invocation.args, options);
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

async function getCommandVersion(command: string): Promise<{ version?: string; error?: string }> {
  const candidates = findCommandsOnPath(command);
  const commandsToTry = candidates.length > 0 ? candidates : [command];
  let lastError: string | undefined;

  for (const candidate of commandsToTry) {
    try {
      const { stdout, stderr } = await runCommand(candidate, ["--version"], { timeout: 5000 });
      const output = `${stdout}\n${stderr}`;
      const version = extractVersion(output);
      if (version) return { version };
      lastError = `无法解析版本输出：${output.trim().split(/\r?\n/).slice(-1)[0] || "(empty)"}`;
    } catch (err) {
      lastError = formatError(err);
    }
  }

  return { error: lastError };
}

async function getInstalledPackageVersion(packageName: string): Promise<string | undefined> {
  try {
    const { stdout } = await runNpmCommand(["root", "-g"], { timeout: 10000 });
    const packageRoot = stdout.trim();
    if (!packageRoot) return undefined;
    const packageJson = await readFile(join(packageRoot, ...packageName.split("/"), "package.json"), "utf8");
    const parsed = JSON.parse(packageJson) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

async function getNodeRuntimeStatus(): Promise<{ nodeVersion?: string; nodeOk: boolean; error?: string }> {
  if (!(await commandExists("node"))) {
    return { nodeOk: false, error: "未检测到 Node.js，请先安装 Node.js 后再安装 Agent" };
  }
  const versionResult = await getCommandVersion("node");
  return {
    nodeVersion: versionResult.version,
    nodeOk: !!versionResult.version,
    error: versionResult.version ? undefined : `无法检测 Node.js 版本：${versionResult.error || "未知错误"}`,
  };
}

async function getCliAgentStatus(descriptor: AgentDescriptor): Promise<AgentPackageStatus> {
  const command = descriptor.command || descriptor.id;
  const installed = await commandExists(command);
  const nodeStatus = await getNodeRuntimeStatus();
  const npmAvailable = await commandExists("npm");
  if (!installed) {
    return {
      installed: false,
      updateAvailable: false,
      canUpdate: npmAvailable && nodeStatus.nodeOk,
      nodeVersion: nodeStatus.nodeVersion,
      nodeOk: nodeStatus.nodeOk,
      error: nodeStatus.error || (npmAvailable ? undefined : "未检测到 npm，请重新安装包含 npm 的 Node.js"),
      source: descriptor.source,
      installedPath: descriptor.installedPath,
      removable: descriptor.removable,
    };
  }

  const versionResult = await getCommandVersion(command);
  const packageVersion = !versionResult.version && descriptor.packageName
    ? await getInstalledPackageVersion(descriptor.packageName)
    : undefined;
  const currentVersion = versionResult.version || packageVersion;
  let latestVersion: string | undefined;
  let error = packageVersion && versionResult.error
    ? `${descriptor.name} 命令无法执行或无法返回版本：${versionResult.error}`
    : undefined;

  if (descriptor.packageName) {
    try {
      latestVersion = await getLatestNpmPackageVersion(descriptor.packageName);
    } catch (err) {
      error = `无法检查 ${descriptor.name} 最新版本：${formatError(err)}`;
    }
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
    canUpdate: !!descriptor.packageName && npmAvailable && nodeStatus.nodeOk,
    nodeVersion: nodeStatus.nodeVersion,
    nodeOk: nodeStatus.nodeOk,
    source: descriptor.source,
    installedPath: descriptor.installedPath,
    removable: descriptor.removable,
    error,
  };
}

async function updateCliAgent(descriptor: AgentDescriptor): Promise<{ success: boolean; status?: AgentPackageStatus; error?: string }> {
  if (!descriptor.packageName) {
    return { success: false, error: `${descriptor.name} 不支持自动更新`, status: await getCliAgentStatus(descriptor) };
  }
  const nodeStatus = await getNodeRuntimeStatus();
  if (!nodeStatus.nodeOk) {
    return {
      success: false,
      error: nodeStatus.error || "未检测到可用的 Node.js",
      status: await getCliAgentStatus(descriptor),
    };
  }
  if (!(await commandExists("npm"))) {
    return {
      success: false,
      error: "未找到 npm，无法自动更新 CLI agent",
      status: await getCliAgentStatus(descriptor),
    };
  }

  try {
    await runNpmCommand(["install", "-g", `${descriptor.packageName}@latest`], { timeout: 180000 });
    return { success: true, status: await getCliAgentStatus(descriptor) };
  } catch (err) {
    return { success: false, error: formatError(err), status: await getCliAgentStatus(descriptor) };
  }
}

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

function getZipSafeName(entryName: string) {
  const normalized = entryName.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`ZIP 包含非法路径：${entryName}`);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) {
    throw new Error(`ZIP 包含路径穿越条目：${entryName}`);
  }
  return normalized.endsWith("/") ? `${parts.join("/")}/` : parts.join("/");
}

function findZipManifest(zip: AdmZip): { entryName: string; prefix: string; manifest: AgentPluginManifest } {
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  const safeNames = entries.map((entry) => getZipSafeName(entry.entryName));
  const rootIndex = safeNames.findIndex((name) => name === MANIFEST_FILE);
  if (rootIndex >= 0) {
    return {
      entryName: entries[rootIndex].entryName,
      prefix: "",
      manifest: JSON.parse(entries[rootIndex].getData().toString("utf8")) as AgentPluginManifest,
    };
  }

  const topLevels = new Set(safeNames.map((name) => name.split("/")[0]).filter(Boolean));
  if (topLevels.size === 1) {
    const prefix = `${Array.from(topLevels)[0]}/`;
    const nestedIndex = safeNames.findIndex((name) => name === `${prefix}${MANIFEST_FILE}`);
    if (nestedIndex >= 0) {
      return {
        entryName: entries[nestedIndex].entryName,
        prefix,
        manifest: JSON.parse(entries[nestedIndex].getData().toString("utf8")) as AgentPluginManifest,
      };
    }
  }

  throw new Error(`ZIP 根目录缺少 ${MANIFEST_FILE}。`);
}

export class AgentPluginRegistry {
  private pluginRecords = new Map<string, PluginRecord>();
  private loaded = false;

  async ensureLoaded() {
    if (this.loaded) return;
    await this.reload();
  }

  async reload(): Promise<AgentDescriptor[]> {
    for (const record of this.pluginRecords.values()) record.process?.dispose();
    this.pluginRecords.clear();
    await mkdir(getPluginInstallDir(), { recursive: true });

    let entries: string[] = [];
    try {
      entries = await readdir(getPluginInstallDir());
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      const pluginDir = join(getPluginInstallDir(), entry);
      try {
        const info = await stat(pluginDir);
        if (!info.isDirectory()) continue;
        const record = await this.readPluginRecord(pluginDir);
        this.pluginRecords.set(record.descriptor.id, record);
      } catch (error) {
        console.warn("[agent-plugin-registry] skip invalid plugin", pluginDir, getErrorMessage(error));
      }
    }

    this.loaded = true;
    return this.listAgents();
  }

  async listAgents(): Promise<AgentDescriptor[]> {
    await this.ensureLoaded();
    const plugins = Array.from(this.pluginRecords.values())
      .map((record) => record.descriptor)
      .sort((left, right) => {
        const leftIndex = DEFAULT_AGENT_ORDER.indexOf(left.id);
        const rightIndex = DEFAULT_AGENT_ORDER.indexOf(right.id);
        if (leftIndex !== -1 || rightIndex !== -1) {
          return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
            - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
        }
        return left.name.localeCompare(right.name);
      });
    return plugins.map((agent) => ({ ...agent, capabilities: { ...agent.capabilities } }));
  }

  async getDescriptor(agentId: string): Promise<AgentDescriptor | undefined> {
    await this.ensureLoaded();
    const plugin = this.pluginRecords.get(agentId)?.descriptor;
    return plugin ? { ...plugin, capabilities: { ...plugin.capabilities } } : undefined;
  }

  async getCapabilities(agentId: string): Promise<AgentCapabilities> {
    const descriptor = await this.getDescriptor(agentId);
    return descriptor?.capabilities || { ...DEFAULT_PLUGIN_CAPABILITIES };
  }

  async isConfigurable(agentId: string): Promise<boolean> {
    const capabilities = await this.getCapabilities(agentId);
    return capabilities.configuration === "openai-compatible";
  }

  async activateProvider(
    agentId: string,
    args: PluginActivateProviderArgs,
    hostOverrides: Partial<AgentHostApi> = {}
  ): Promise<PluginActivateProviderResult> {
    await this.ensureLoaded();
    const record = this.pluginRecords.get(agentId);
    if (!record) throw new Error(`未安装 agent 插件：${agentId}`);
    if (record.descriptor.capabilities.providerActivation !== "single-active") {
      throw new Error(`${record.descriptor.name} 不支持启用单一渠道。`);
    }

    const pluginProcess = await this.getPluginProcess(record, hostOverrides);
    if (!record.processCapabilities?.activateProvider) {
      throw new Error(`插件 ${record.descriptor.id} 声明了 single-active provider，但未导出 configProvider.activateProvider。`);
    }

    return await pluginProcess.call("activateProvider", args) as PluginActivateProviderResult || {};
  }

  async getStatus(agentId: string): Promise<AgentPackageStatus> {
    await this.ensureLoaded();
    const record = this.pluginRecords.get(agentId);
    if (!record) {
      return {
        installed: false,
        updateAvailable: false,
        canUpdate: false,
        error: `未安装 agent 插件：${agentId}`,
      };
    }

    const pluginProcess = await this.getPluginProcess(record).catch(() => undefined);
    if (pluginProcess && record.processCapabilities?.getStatus) {
      const status = await pluginProcess.call("getStatus") as Partial<AgentPackageStatus>;
      return {
        installed: status.installed !== false,
        updateAvailable: status.updateAvailable === true,
        canUpdate: status.canUpdate === true,
        currentVersion: status.currentVersion || record.descriptor.version,
        latestVersion: status.latestVersion,
        error: status.error,
        source: "plugin",
        installedPath: record.pluginDir,
        removable: true,
      };
    }

    if (record.descriptor.command) {
      return getCliAgentStatus(record.descriptor);
    }

    return {
      installed: true,
      currentVersion: record.descriptor.version,
      updateAvailable: false,
      canUpdate: false,
      source: "plugin",
      installedPath: record.pluginDir,
      removable: true,
    };
  }

  async updateAgent(agentId: string): Promise<{ success: boolean; error?: string; status?: AgentPackageStatus }> {
    await this.ensureLoaded();
    const record = this.pluginRecords.get(agentId);
    if (!record) return { success: false, error: `未安装 agent 插件：${agentId}` };
    const pluginProcess = await this.getPluginProcess(record).catch(() => undefined);
    if (pluginProcess && record.processCapabilities?.update) {
      return pluginProcess.call("update") as Promise<{ success: boolean; error?: string; status?: AgentPackageStatus }>;
    }
    return {
      success: false,
      error: "外部插件请通过重新安装本地目录或 ZIP 进行更新。",
      status: await this.getStatus(agentId),
    };
  }

  async getDefaultThinkingLevel(agentId: string): Promise<string> {
    await this.ensureLoaded();
    const record = this.pluginRecords.get(agentId);
    if (!record) return DEFAULT_THINKING_LEVEL;
    const pluginProcess = await this.getPluginProcess(record).catch(() => undefined);
    if (pluginProcess && record.processCapabilities?.getDefaultThinkingLevel) {
      return normalizeThinkingLevel(await pluginProcess.call("getDefaultThinkingLevel"))
        || DEFAULT_THINKING_LEVEL;
    }
    return DEFAULT_THINKING_LEVEL;
  }

  async createBackend(
    agentId: string,
    sessionId: string,
    options: { window?: BrowserWindow | null; getConfigState?: () => Promise<unknown> } = {}
  ): Promise<AgentBackend> {
    await this.ensureLoaded();
    const record = this.pluginRecords.get(agentId);
    if (!record) throw new Error(`Agent 插件未安装：${agentId}`);
    return this.createPluginBackend(record, sessionId, options);
  }

  async installFromPath(pluginPath: string, options: InstallOptions = {}): Promise<AgentPluginInstallResult> {
    let stagingDir = "";
    let backupDir = "";
    let targetDir = "";
    try {
      const sourcePath = resolve(pluginPath);
      const info = await stat(sourcePath);
      const installDir = getPluginInstallDir();
      await mkdir(installDir, { recursive: true });

      const operationId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      stagingDir = join(installDir, `.install-${operationId}`);
      let manifest: AgentPluginManifest;
      let descriptor: AgentDescriptor;

      if (info.isDirectory()) {
        manifest = await this.readManifestFromDirectory(sourcePath);
        descriptor = descriptorFromManifest(manifest, "plugin");
        await this.assertCanInstallDescriptor(descriptor, options);
        await rm(stagingDir, { recursive: true, force: true });
        await cp(sourcePath, stagingDir, { recursive: true });
      } else if (info.isFile() && extname(sourcePath).toLowerCase() === ".zip") {
        const zip = new AdmZip(sourcePath);
        const manifestInfo = findZipManifest(zip);
        manifest = manifestInfo.manifest;
        descriptor = descriptorFromManifest(manifest, "plugin");
        await this.assertCanInstallDescriptor(descriptor, options);
        await rm(stagingDir, { recursive: true, force: true });
        await this.extractZipToDirectory(zip, manifestInfo.prefix, stagingDir);
      } else {
        throw new Error("请选择插件目录或 .zip 文件。");
      }

      const installedRecord = await this.readPluginRecord(stagingDir);
      if (installedRecord.descriptor.id !== descriptor.id) {
        throw new Error("插件安装校验失败：复制后的 manifest ID 不一致。");
      }

      targetDir = join(installDir, descriptor.id);
      const replaced = this.pluginRecords.has(descriptor.id) || existsSync(targetDir);
      if (existsSync(targetDir)) {
        backupDir = join(installDir, `.backup-${descriptor.id}-${operationId}`);
        await rename(targetDir, backupDir);
      }
      try {
        await rename(stagingDir, targetDir);
        stagingDir = "";
      } catch (error) {
        if (backupDir && existsSync(backupDir) && !existsSync(targetDir)) {
          await rename(backupDir, targetDir).catch(() => undefined);
          backupDir = "";
        }
        throw error;
      }

      const finalRecord = await this.readPluginRecord(targetDir);
      this.pluginRecords.set(finalRecord.descriptor.id, finalRecord);
      if (backupDir) {
        await rm(backupDir, { recursive: true, force: true });
        backupDir = "";
      }
      this.loaded = true;
      return {
        success: true,
        agent: finalRecord.descriptor,
        agents: await this.listAgents(),
        installedPath: targetDir,
        replaced,
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error), agents: await this.listAgents().catch(() => []) };
    } finally {
      if (stagingDir) await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      if (backupDir && targetDir && !existsSync(targetDir) && existsSync(backupDir)) {
        await rename(backupDir, targetDir).catch(() => undefined);
      }
      if (backupDir && existsSync(backupDir) && existsSync(targetDir)) {
        await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async removePlugin(agentId: string, removeRuntime = false): Promise<AgentPluginInstallResult> {
    try {
      await this.ensureLoaded();
      const record = this.pluginRecords.get(agentId);
      if (!record) {
        return { success: false, error: `未安装 agent 插件：${agentId}`, agents: await this.listAgents() };
      }

      if (removeRuntime) {
        if (agentId === "pi") {
          const result = await uninstallPiSDK();
          if (!result.success) {
            return { success: false, error: result.error || "Pi SDK 卸载失败", agents: await this.listAgents() };
          }
        } else if (record.descriptor.packageName) {
          if (!(await commandExists("npm"))) {
            return { success: false, error: "未找到 npm，无法卸载本地 Agent", agents: await this.listAgents() };
          }
          try {
            await runNpmCommand(["uninstall", "-g", record.descriptor.packageName], { timeout: 180000 });
          } catch (error) {
            return { success: false, error: formatError(error), agents: await this.listAgents() };
          }
        }
      }

      record.process?.dispose();
      record.process = undefined;
      record.processCapabilities = undefined;
      await rm(record.pluginDir, { recursive: true, force: true });
      this.pluginRecords.delete(agentId);
      return { success: true, agents: await this.listAgents() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error), agents: await this.listAgents().catch(() => []) };
    }
  }

  private async assertCanInstallDescriptor(descriptor: AgentDescriptor, options: InstallOptions) {
    await this.ensureLoaded();
    if (options.expectedAgentId && descriptor.id !== options.expectedAgentId) {
      throw new Error(`插件 ID 与预期不匹配：期望 ${options.expectedAgentId}，实际 ${descriptor.id}。`);
    }
    if (this.pluginRecords.has(descriptor.id) && options.canReplace) {
      const allowed = await options.canReplace(descriptor.id);
      if (!allowed) {
        throw new Error(`Agent ${descriptor.id} 仍有会话在运行，请先关闭相关会话后再更新插件。`);
      }
    }
  }

  private async readManifestFromDirectory(pluginDir: string): Promise<AgentPluginManifest> {
    const manifestPath = join(pluginDir, MANIFEST_FILE);
    const manifest = await readJsonFile<AgentPluginManifest>(manifestPath);
    if (!manifest) throw new Error(`插件缺少有效的 ${MANIFEST_FILE}。`);
    return manifest;
  }

  private async readPluginRecord(pluginDir: string): Promise<PluginRecord> {
    const manifest = await this.readManifestFromDirectory(pluginDir);
    const descriptor = descriptorFromManifest(manifest, "plugin", pluginDir);
    const entry = ensureRelativePath(manifest.entry, "entry");
    const entryPath = resolve(pluginDir, entry.split("/").join(sep));
    assertInside(pluginDir, entryPath);
    const entryInfo = await stat(entryPath).catch(() => null);
    if (!entryInfo?.isFile()) throw new Error(`插件 ${descriptor.id} 的 entry 文件不存在。`);
    return { descriptor, pluginDir, entryPath };
  }

  private async extractZipToDirectory(zip: AdmZip, prefix: string, targetDir: string) {
    await mkdir(targetDir, { recursive: true });
    for (const entry of zip.getEntries()) {
      const safeName = getZipSafeName(entry.entryName);
      if (prefix && !safeName.startsWith(prefix)) continue;
      const relativeName = prefix ? safeName.slice(prefix.length) : safeName;
      if (!relativeName) continue;
      const normalizedRelative = ensureRelativePath(relativeName, "ZIP 条目");
      const targetPath = resolve(targetDir, normalizedRelative.split("/").join(sep));
      assertInside(targetDir, targetPath);
      if (entry.isDirectory) {
        await mkdir(targetPath, { recursive: true });
      } else {
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, entry.getData());
      }
    }
  }

  private createHostApi(overrides: Partial<AgentHostApi> = {}): AgentHostApi {
    return {
      getCliAgentStatus,
      updateCliAgent,
      getPiSDKStatus: async (pluginDir?: string) => ({
        ...await getPiSDKStatus(),
        source: "plugin",
        installedPath: pluginDir,
        removable: true,
      }),
      updatePiSDK,
      getCodexDefaultThinkingLevel,
      ...overrides,
    };
  }

  private async getPluginProcess(
    record: PluginRecord,
    hostOverrides: Partial<AgentHostApi> = {},
  ): Promise<AgentPluginProcess> {
    if (!record.process) {
      const hostApi = this.createHostApi(hostOverrides);
      record.process = new AgentPluginProcess(
        record.entryPath,
        {
          agentId: record.descriptor.id,
          pluginDir: record.pluginDir,
          dataDir: getDataDir(),
          appVersion: app.getVersion(),
        },
        hostApi as unknown as Record<string, (...args: unknown[]) => unknown>,
      );
      record.processCapabilities = await record.process.ensureLoaded();
    } else if (Object.keys(hostOverrides).length > 0) {
      record.process.updateHostMethods(
        this.createHostApi(hostOverrides) as unknown as Record<string, (...args: unknown[]) => unknown>,
      );
    }
    return record.process;
  }


  private async createPluginBackend(
    record: PluginRecord,
    sessionId: string,
    options: { window?: BrowserWindow | null; getConfigState?: () => Promise<unknown> }
  ): Promise<AgentBackend> {
    let currentWindow = options.window || null;
    const sendEvent = (event: Record<string, unknown>) => {
      const normalizedEvent = normalizePluginEvent(event);
      currentWindow?.webContents.send("agent:event", {
        ...normalizedEvent,
        sessionId,
        agentId: record.descriptor.id,
      });
    };
    const pluginProcess = await this.getPluginProcess(record);
    const { backendId, capabilities } = await pluginProcess.createBackend(
      sessionId,
      (event) => sendEvent(event as Record<string, unknown>),
      options.getConfigState,
    );
    let sessionFilePath: string | null = null;
    let idle = true;

    const wrapped: AgentBackend = {
      setWindow(win: BrowserWindow) {
        currentWindow = win;
      },
      async init(projectPath, existingSessionFilePath) {
        await pluginProcess.backendCall(backendId, "init", [projectPath, existingSessionFilePath]);
        sessionFilePath = await pluginProcess.backendCall(backendId, "sessionFilePath") as string | null;
        idle = await pluginProcess.backendCall(backendId, "isIdle") as boolean ?? true;
      },
      isIdle: () => idle,
      async sendMessage(message, images, sendOptions) {
        idle = false;
        try { await pluginProcess.backendCall(backendId, "sendMessage", [message, images, sendOptions]); }
        finally { idle = await pluginProcess.backendCall(backendId, "isIdle") as boolean ?? true; }
      },
      abort: () => pluginProcess.backendCall(backendId, "abort") as Promise<void>,
      getModels: () => pluginProcess.backendCall(backendId, "getModels") as Promise<AgentModel[]>,
      setModel: (provider, modelId) => pluginProcess.backendCall(backendId, "setModel", [provider, modelId]) as Promise<void>,
      setThinkingLevel: (level) => pluginProcess.backendCall(backendId, "setThinkingLevel", [level]) as Promise<void>,
      sendUIResponse: (response) => { void pluginProcess.backendCall(backendId, "sendUIResponse", [response]); },
      dispose: () => { void pluginProcess.disposeBackend(backendId); },
      get sessionFilePath() {
        return sessionFilePath;
      },
    };

    if (capabilities.sendGuidance) {
      wrapped.sendGuidance = (message, images, sendOptions) => pluginProcess.backendCall(backendId, "sendGuidance", [message, images, sendOptions]) as Promise<void>;
    }
    if (capabilities.forkSession) {
      wrapped.forkSession = async (target) => {
        const result = await pluginProcess.backendCall(backendId, "forkSession", [target]) as AgentForkResult;
        sessionFilePath = await pluginProcess.backendCall(backendId, "sessionFilePath") as string | null;
        return result;
      };
    }

    return wrapped;
  }

}

const registry = new AgentPluginRegistry();

export function getAgentPluginRegistry() {
  return registry;
}
