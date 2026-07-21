import { app, BrowserWindow } from "electron";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "path";
import AdmZip from "adm-zip";
import { AgentPluginProcess, type PluginHostCapabilities } from "./agent-plugin-process";
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
  AgentPackageStatus,
  AgentPlanModeSupport,
  AgentProviderConfiguration,
  AgentPluginInstallResult,
  AgentPluginManifest,
} from "../../src/types/ipc";
import { isValidVersion, meetsMinimumVersion } from "../../src/lib/version";
import { sanitizeAgentActionCatalog } from "../../shared/agent-actions";
import type {
  AgentBackend,
  AgentForkResult,
  AgentModel,
  AgentSendOptions,
} from "./agent-backend";
export type {
  AgentBackend,
  AgentForkResult,
  AgentForkTarget,
  AgentModel,
  AgentSendOptions,
} from "./agent-backend";
import { asString, getErrorMessage, isRecord } from "../utils/unknown-value";

interface PluginRecord {
  descriptor: AgentDescriptor;
  pluginDir: string;
  entryPath: string;
  process?: AgentPluginProcess;
  processCapabilities?: PluginHostCapabilities;
}

type RawAgentPluginManifest = Omit<AgentPluginManifest, "schemaVersion" | "minHppVersion"> & {
  schemaVersion: number;
  minHppVersion?: string;
};

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
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type CommandError = Error & {
  stdout?: string;
  stderr?: string;
  code?: string | number;
  signal?: string;
  killed?: boolean;
  timeoutMs?: number;
};

const MANIFEST_FILE = "hpp-agent-plugin.json";
const DEFAULT_THINKING_LEVEL = "medium";
const MAX_PLUGIN_EVENT_BYTES = 1024 * 1024;
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const DEFAULT_PLUGIN_CAPABILITIES: AgentCapabilities = {
  planMode: "prompt",
  guidance: false,
  fork: false,
  actions: false,
  configuration: "none",
  providerActivation: "none",
};

function getDataDir() {
  return join(app.getPath("userData"), "hpp-data");
}

function getPluginInstallDir() {
  return join(getDataDir(), "agent-plugins");
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

function normalizePlanMode(value: unknown): AgentPlanModeSupport {
  if (value === "native" || value === "prompt" || value === "none") return value;
  if (value === false) return "none";
  return DEFAULT_PLUGIN_CAPABILITIES.planMode;
}

function normalizeProviderConfiguration(value: unknown): AgentProviderConfiguration | "none" {
  if (!isRecord(value) || value.type !== "provider" || !Array.isArray(value.endpoints)) return "none";
  const seenEndpoints = new Set<string>();
  const endpoints = value.endpoints.flatMap((rawEndpoint) => {
    if (!isRecord(rawEndpoint)) return [];
    const id = asString(rawEndpoint.id);
    if (!id || seenEndpoints.has(id)) return [];
    seenEndpoints.add(id);
    return [{ id, label: asString(rawEndpoint.label) || id }];
  });
  if (endpoints.length === 0) return "none";

  const defaultEndpoint = asString(value.defaultEndpoint);
  const seenAuthModes = new Set<string>();
  const authModes = Array.isArray(value.authModes)
    ? value.authModes.flatMap((rawAuthMode) => {
        if (!isRecord(rawAuthMode)) return [];
        const id = asString(rawAuthMode.id);
        if ((id !== "bearer" && id !== "x-api-key") || seenAuthModes.has(id)) return [];
        seenAuthModes.add(id);
        return [{ id, label: asString(rawAuthMode.label) || id }];
      })
    : [];
  const defaultAuthMode = asString(value.defaultAuthMode);
  const modelDefaults = isRecord(value.modelDefaults) ? value.modelDefaults : {};
  const modelListMode = value.modelListMode === "configured" || value.modelListMode === "backend"
    ? value.modelListMode
    : "merge";
  const rawBackendModelVisibility = isRecord(value.backendModelVisibility)
    ? value.backendModelVisibility
    : undefined;
  const backendModelVisibility = modelListMode === "merge" && rawBackendModelVisibility
    ? {
        userConfigurable: rawBackendModelVisibility.userConfigurable === true,
        defaultVisible: rawBackendModelVisibility.defaultVisible !== false,
        label: asString(rawBackendModelVisibility.label) || "显示 Agent 内置模型",
        description: asString(rawBackendModelVisibility.description) || undefined,
      }
    : undefined;
  return {
    type: "provider",
    storage: value.storage === "plugin" ? "plugin" : "hpp",
    endpoints,
    defaultEndpoint: endpoints.some((endpoint) => endpoint.id === defaultEndpoint)
      ? defaultEndpoint
      : endpoints[0].id,
    authModes: authModes.length > 0 ? authModes : undefined,
    defaultAuthMode: authModes.some((mode) => mode.id === defaultAuthMode)
      ? defaultAuthMode as "bearer" | "x-api-key"
      : authModes[0]?.id,
    pathLabel: asString(value.pathLabel) || undefined,
    hint: asString(value.hint) || undefined,
    modelDefaults: {
      reasoning: modelDefaults.reasoning === true,
      imageInput: modelDefaults.imageInput === true,
      supportedThinkingLevels: Array.isArray(modelDefaults.supportedThinkingLevels)
        ? modelDefaults.supportedThinkingLevels.filter((level): level is string =>
            typeof level === "string" && VALID_THINKING_LEVELS.has(level))
        : undefined,
    },
    fixedModelCapabilities: value.fixedModelCapabilities === true,
    modelListMode,
    backendModelVisibility,
  };
}

function normalizeCapabilities(value: unknown): AgentCapabilities {
  const input = isRecord(value) ? value : {};
  return {
    planMode: normalizePlanMode(input.planMode),
    guidance: input.guidance === true,
    fork: input.fork === true,
    actions: input.actions === true,
    configuration: normalizeProviderConfiguration(input.configuration),
    providerActivation: input.providerActivation === "single-active" ? "single-active" : "none",
  };
}

function cloneCapabilities(capabilities: AgentCapabilities): AgentCapabilities {
  return {
    ...capabilities,
    configuration: capabilities.configuration === "none"
      ? "none"
      : {
          ...capabilities.configuration,
          endpoints: capabilities.configuration.endpoints.map((endpoint) => ({ ...endpoint })),
          authModes: capabilities.configuration.authModes?.map((authMode) => ({ ...authMode })),
          modelDefaults: {
            ...capabilities.configuration.modelDefaults,
            supportedThinkingLevels: capabilities.configuration.modelDefaults.supportedThinkingLevels
              ? [...capabilities.configuration.modelDefaults.supportedThinkingLevels]
              : undefined,
          },
          backendModelVisibility: capabilities.configuration.backendModelVisibility
            ? { ...capabilities.configuration.backendModelVisibility }
            : undefined,
        },
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
  manifest: RawAgentPluginManifest,
  source: AgentDescriptor["source"],
  installedPath?: string,
  allowLegacySchema = false
): AgentDescriptor {
  const legacySchema = manifest.schemaVersion === 2;
  if (manifest.schemaVersion !== 3 && !(allowLegacySchema && legacySchema)) {
    throw new Error("插件 schemaVersion 必须为 3。");
  }
  const id = asString(manifest.id);
  const name = asString(manifest.name);
  const version = asString(manifest.version);
  const minHppVersion = asString(manifest.minHppVersion) || (legacySchema ? "0.0.0-0" : "");
  const entry = asString(manifest.entry);
  if (!id) throw new Error("插件缺少 id。");
  if (!name) throw new Error(`插件 ${id} 缺少 name。`);
  if (!version) throw new Error(`插件 ${id} 缺少 version。`);
  if (!isValidVersion(version)) throw new Error(`插件 ${id} 的 version 无效：${version || "空"}。`);
  if (!minHppVersion) throw new Error(`插件 ${id} 缺少 minHppVersion。`);
  if (!isValidVersion(minHppVersion)) {
    throw new Error(`插件 ${id} 的 minHppVersion 无效：${minHppVersion}。`);
  }
  if (!entry) throw new Error(`插件 ${id} 缺少 entry。`);
  ensureAgentId(id);
  ensureRelativePath(entry, "entry");

  const currentHppVersion = app.getVersion();
  if (!isValidVersion(currentHppVersion)) throw new Error(`当前 Hpp 版本号无效：${currentHppVersion}。`);
  if (!meetsMinimumVersion(currentHppVersion, minHppVersion)) {
    throw new Error(`插件 ${name} 需要 Hpp v${minHppVersion} 或更高版本，当前为 v${currentHppVersion}。`);
  }

  const description = asString(manifest.description);
  const runtime = manifest.runtime === "cli" || manifest.runtime === "sdk" ? manifest.runtime : "plugin";
  const command = asString(manifest.command) || undefined;
  const packageName = asString(manifest.packageName) || undefined;
  const capabilities = normalizeCapabilities(manifest.capabilities);
  const order = typeof manifest.order === "number" && Number.isFinite(manifest.order) ? manifest.order : 1000;

  return {
    id,
    name,
    desc: description,
    description,
    version,
    minHppVersion,
    runtime,
    command,
    packageName,
    order,
    capabilities,
    source,
    removable: source === "plugin",
    installedPath,
    installHint: asString(manifest.installHint) || (command ? `请安装或配置 ${command}` : source === "plugin" ? "请检查插件安装目录" : undefined),
    updateCommand: asString(manifest.updateCommand) || (packageName ? `npm install -g ${packageName}@latest` : undefined),
    shortName: asString(manifest.shortName) || id.slice(0, 2).toUpperCase(),
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
          commandError.timeoutMs = options.timeout ?? 15000;
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

async function terminateOrphanedWindowsCliProcesses(command: string): Promise<number> {
  if (process.platform !== "win32") return 0;
  const commandName = basename(command).replace(/\.(?:cmd|bat|com|exe)$/i, "");
  if (!/^[a-zA-Z0-9._-]+$/.test(commandName)) return 0;
  const powershell = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!existsSync(powershell)) return 0;

  const script = [
    "& {",
    "param([string]$TargetName)",
    "$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
    "$byId = @{}",
    "foreach ($item in $all) { $byId[[string]$item.ProcessId] = $item }",
    "$stale = @($all | Where-Object {",
    "  if ($_.Name -ine $TargetName) { return $false }",
    "  $parent = $byId[[string]$_.ParentProcessId]",
    "  return $null -eq $parent -or $parent.CreationDate -gt $_.CreationDate",
    "})",
    "foreach ($item in $stale) { Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue }",
    "foreach ($item in $stale) { Wait-Process -Id $item.ProcessId -Timeout 5 -ErrorAction SilentlyContinue }",
    "[pscustomobject]@{ count = $stale.Count; ids = @($stale.ProcessId) } | ConvertTo-Json -Compress",
    "}",
  ].join("\n");

  try {
    const result = await runCommand(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, `${commandName}.exe`],
      { timeout: 15000 },
    );
    const output = result.stdout.trim();
    if (!output) return 0;
    const parsed = JSON.parse(output) as { count?: unknown; ids?: unknown };
    const count = typeof parsed.count === "number" ? parsed.count : 0;
    if (count > 0) {
      console.info(`[agent-runtime] Removed ${count} orphaned ${commandName} process(es).`);
    }
    return count;
  } catch (error) {
    console.warn(`[agent-runtime] Failed to inspect orphaned ${commandName} processes:`, formatError(error));
    return 0;
  }
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
  if (err.killed) {
    return `更新命令执行超过 ${Math.ceil((err.timeoutMs || 0) / 1000)} 秒，已终止。`;
  }
  const output = (err.stderr || err.stdout || "").trim();
  if (output) {
    const lines = output.split(/\r?\n/).filter(Boolean);
    if (lines.length <= 8) return lines.join("\n");
    return [...lines.slice(0, 6), "...", ...lines.slice(-2)].join("\n");
  }
  const code = err.code !== undefined ? `（错误码 ${String(err.code)}）` : "";
  return `${err.message || String(error)}${code}`.trim();
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
  const executableReady = !!versionResult.version;
  const currentVersion = versionResult.version;
  let latestVersion: string | undefined;
  let error = !executableReady
    ? `${descriptor.name} 命令无法执行，请点击安装进行修复。${versionResult.error ? `\n${versionResult.error}` : ""}`
    : undefined;

  if (descriptor.packageName) {
    try {
      latestVersion = await getLatestNpmPackageVersion(descriptor.packageName);
    } catch (err) {
      const latestVersionError = `无法检查 ${descriptor.name} 最新版本：${formatError(err)}`;
      error = error ? `${error}\n${latestVersionError}` : latestVersionError;
    }
  }

  const updateAvailable = !!(
    executableReady &&
    currentVersion &&
    latestVersion &&
    compareVersions(currentVersion, latestVersion) < 0
  );

  return {
    installed: executableReady,
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
    const currentStatus = await getCliAgentStatus(descriptor);
    if (
      currentStatus.installed &&
      currentStatus.currentVersion &&
      currentStatus.latestVersion &&
      compareVersions(currentStatus.currentVersion, currentStatus.latestVersion) >= 0
    ) {
      return { success: true, status: currentStatus };
    }

    await terminateOrphanedWindowsCliProcesses(descriptor.command || descriptor.id);
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

function findZipManifest(zip: AdmZip): { entryName: string; prefix: string; manifest: RawAgentPluginManifest } {
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  const safeNames = entries.map((entry) => getZipSafeName(entry.entryName));
  const rootIndex = safeNames.findIndex((name) => name === MANIFEST_FILE);
  if (rootIndex >= 0) {
    return {
      entryName: entries[rootIndex].entryName,
      prefix: "",
      manifest: JSON.parse(entries[rootIndex].getData().toString("utf8")) as RawAgentPluginManifest,
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
        manifest: JSON.parse(entries[nestedIndex].getData().toString("utf8")) as RawAgentPluginManifest,
      };
    }
  }

  throw new Error(`ZIP 根目录缺少 ${MANIFEST_FILE}。`);
}

export class AgentPluginRegistry {
  private pluginRecords = new Map<string, PluginRecord>();
  private loaded = false;
  private stopping = false;
  private permanentShutdown = false;
  private shutdownPromise: Promise<void> | null = null;

  async ensureLoaded() {
    if (this.loaded) return;
    await this.reload();
  }

  async reload(): Promise<AgentDescriptor[]> {
    await this.shutdown();
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
        return left.order - right.order || left.name.localeCompare(right.name);
      });
    return plugins.map((agent) => ({ ...agent, capabilities: cloneCapabilities(agent.capabilities) }));
  }

  async getDescriptor(agentId: string): Promise<AgentDescriptor | undefined> {
    await this.ensureLoaded();
    const plugin = this.pluginRecords.get(agentId)?.descriptor;
    return plugin ? { ...plugin, capabilities: cloneCapabilities(plugin.capabilities) } : undefined;
  }

  async getCapabilities(agentId: string): Promise<AgentCapabilities> {
    const descriptor = await this.getDescriptor(agentId);
    return descriptor?.capabilities || { ...DEFAULT_PLUGIN_CAPABILITIES };
  }

  async isConfigurable(agentId: string): Promise<boolean> {
    const capabilities = await this.getCapabilities(agentId);
    return capabilities.configuration !== "none";
  }

  async readProviderConfig(agentId: string): Promise<unknown | undefined> {
    await this.ensureLoaded();
    const record = this.pluginRecords.get(agentId);
    if (!record) throw new Error(`未安装 agent 插件：${agentId}`);
    const pluginProcess = await this.getPluginProcess(record);
    if (!record.processCapabilities?.readProviderConfig) return undefined;
    return pluginProcess.call("readProviderConfig");
  }

  async writeProviderConfig(agentId: string, state: unknown): Promise<PluginActivateProviderResult> {
    await this.ensureLoaded();
    const record = this.pluginRecords.get(agentId);
    if (!record) throw new Error(`未安装 agent 插件：${agentId}`);
    const pluginProcess = await this.getPluginProcess(record);
    if (!record.processCapabilities?.writeProviderConfig) {
      throw new Error(`插件 ${record.descriptor.id} 声明了插件配置存储，但未导出 configProvider.write。`);
    }
    return await pluginProcess.call("writeProviderConfig", { state }) as PluginActivateProviderResult || {};
  }

  async activateProvider(
    agentId: string,
    args: PluginActivateProviderArgs
  ): Promise<PluginActivateProviderResult> {
    await this.ensureLoaded();
    const record = this.pluginRecords.get(agentId);
    if (!record) throw new Error(`未安装 agent 插件：${agentId}`);
    if (record.descriptor.capabilities.providerActivation !== "single-active") {
      throw new Error(`${record.descriptor.name} 不支持启用单一渠道。`);
    }

    const pluginProcess = await this.getPluginProcess(record);
    if (!record.processCapabilities?.activateProvider) {
      throw new Error(`插件 ${record.descriptor.id} 声明了 single-active provider，但未导出 configProvider.activateProvider。`);
    }

    return await pluginProcess.call("activateProvider", args) as PluginActivateProviderResult || {};
  }

  async getStatus(agentId: string): Promise<AgentPackageStatus> {
    if (this.stopping || this.permanentShutdown) return this.getStoppedStatus(agentId);
    await this.ensureLoaded();
    if (this.stopping || this.permanentShutdown) return this.getStoppedStatus(agentId);
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
    if (this.stopping || this.permanentShutdown) return this.getStoppedStatus(agentId);
    if (pluginProcess && record.processCapabilities?.getStatus) {
      let status: Partial<AgentPackageStatus>;
      try {
        status = await pluginProcess.call("getStatus") as Partial<AgentPackageStatus>;
      } catch (error) {
        if (this.stopping || this.permanentShutdown) return this.getStoppedStatus(agentId);
        throw error;
      }
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
      let manifest: RawAgentPluginManifest;
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

        const installedRecord = await this.readPluginRecord(stagingDir, false);
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

      const finalRecord = await this.readPluginRecord(targetDir, false);
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
        const pluginProcess = await this.getPluginProcess(record).catch(() => undefined);
        if (pluginProcess && record.processCapabilities?.uninstall) {
          const result = await pluginProcess.call("uninstall") as { success?: boolean; error?: string } | undefined;
          if (result?.success !== true) {
            return { success: false, error: result?.error || `${record.descriptor.name} 运行时卸载失败`, agents: await this.listAgents() };
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

      await record.process?.shutdown();
      record.process = undefined;
      record.processCapabilities = undefined;
      await rm(record.pluginDir, { recursive: true, force: true });
      this.pluginRecords.delete(agentId);
      return { success: true, agents: await this.listAgents() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error), agents: await this.listAgents().catch(() => []) };
    }
  }

  async shutdown(permanent = false): Promise<void> {
    if (permanent) this.permanentShutdown = true;
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    const records = Array.from(this.pluginRecords.values());
    this.shutdownPromise = Promise.allSettled(records.map(async (record) => {
      await record.process?.shutdown();
      record.process = undefined;
      record.processCapabilities = undefined;
    })).then(() => undefined).finally(() => {
      if (!this.permanentShutdown) this.stopping = false;
      this.shutdownPromise = null;
    });
    return this.shutdownPromise;
  }

  private getStoppedStatus(agentId: string): AgentPackageStatus {
    const record = this.pluginRecords.get(agentId);
    if (!record) {
      return {
        installed: false,
        updateAvailable: false,
        canUpdate: false,
        error: `未安装 agent 插件：${agentId}`,
      };
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

  private async readManifestFromDirectory(pluginDir: string): Promise<RawAgentPluginManifest> {
    const manifestPath = join(pluginDir, MANIFEST_FILE);
    const manifest = await readJsonFile<RawAgentPluginManifest>(manifestPath);
    if (!manifest) throw new Error(`插件缺少有效的 ${MANIFEST_FILE}。`);
    return manifest;
  }

  private async readPluginRecord(pluginDir: string, allowLegacySchema = true): Promise<PluginRecord> {
    const manifest = await this.readManifestFromDirectory(pluginDir);
    const descriptor = descriptorFromManifest(manifest, "plugin", pluginDir, allowLegacySchema);
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

  private createHostApi(): AgentHostApi {
    return {
      getCliAgentStatus,
      updateCliAgent,
    };
  }

  private async getPluginProcess(record: PluginRecord): Promise<AgentPluginProcess> {
    if (this.stopping || this.permanentShutdown) throw new Error("Plugin registry is stopping.");
    if (!record.process) {
      const hostApi = this.createHostApi();
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
    }
    if (!record.processCapabilities) {
      record.processCapabilities = await record.process.ensureLoaded();
    }
    return record.process;
  }


  private async createPluginBackend(
    record: PluginRecord,
    sessionId: string,
    options: { window?: BrowserWindow | null; getConfigState?: () => Promise<unknown> }
  ): Promise<AgentBackend> {
    let currentWindow = options.window || null;
    let idle = true;
    const sendEvent = (event: Record<string, unknown>) => {
      const normalizedEvent = normalizePluginEvent(event);
      if (normalizedEvent.type === "message_start" || normalizedEvent.type === "stream_start") {
        idle = false;
      } else if (
        normalizedEvent.type === "stream_end" ||
        normalizedEvent.type === "aborted" ||
        normalizedEvent.type === "agent_disconnected"
      ) {
        idle = true;
      }
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
      async abort() {
        try {
          await pluginProcess.backendCall(backendId, "abort");
        } finally {
          idle = await pluginProcess.backendCall(backendId, "isIdle") as boolean ?? true;
        }
      },
      getModels: () => pluginProcess.backendCall(backendId, "getModels") as Promise<AgentModel[]>,
      listActions: async (listOptions) => capabilities.listActions
        ? sanitizeAgentActionCatalog(await pluginProcess.backendCall(backendId, "listActions", [listOptions]))
        : [],
      setModel: (provider, modelId) => pluginProcess.backendCall(backendId, "setModel", [provider, modelId]) as Promise<void>,
      setThinkingLevel: (level) => pluginProcess.backendCall(backendId, "setThinkingLevel", [level]) as Promise<void>,
      sendUIResponse: (response) => {
        void pluginProcess.backendCall(backendId, "sendUIResponse", [response]).catch((error) => {
          console.error(`[agent-plugin:${record.descriptor.id}] Failed to send UI response:`, error);
        });
      },
      dispose: () => pluginProcess.disposeBackend(backendId),
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
