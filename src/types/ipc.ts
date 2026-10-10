export type UnknownRecord = Record<string, unknown>;

export interface FileSystemChange {
  path: string;
  eventType: "rename" | "change";
}

import type { AgentActionInvocation } from "@shared/agent-actions";
import type { AgentPermissionMode } from "@shared/agent-permissions";
import type { AgentSubagentCapabilities } from "@shared/agent-subagent";
export type { AgentCompactionConfig } from "@shared/agent-compaction";
export type {
  AgentSubagentCapabilities,
  AgentSubagentConfig,
  AgentSubagentModelMode,
  AgentSubagentProfileConfig,
  AgentSubagentProfileDescriptor,
} from "@shared/agent-subagent";
export type { AgentPermissionMode } from "@shared/agent-permissions";
export type {
  AgentActionCatalogEntry,
  AgentActionInvocation,
  AgentActionKind,
  AgentActionListOptions,
} from "@shared/agent-actions";

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface AgentImagePayloadItem {
  type: string;
  data: string;
  mimeType: string;
}

export type AgentImagePayload = AgentImagePayloadItem[];

export interface AgentSendOptions {
  planModeEnabled?: boolean;
  permissionMode?: AgentPermissionMode;
  clientMessageId?: string;
  action?: AgentActionInvocation;
}

export interface AgentCompactionConfigResult {
  success: boolean;
  error?: string;
  appliedSessionIds?: string[];
}

export interface AgentSubagentConfigResult {
  success: boolean;
  error?: string;
  appliedSessionIds?: string[];
}

export interface AgentEvent {
  type: string;
  sessionId?: string;
  agentId?: string;
  content?: string;
  delta?: string;
  force?: boolean;
  toolCallId?: string;
  callId?: string;
  itemId?: string;
  id?: string;
  requestId?: string;
  toolName?: string;
  name?: string;
  tool?: string;
  toolKind?: string;
  kind?: string;
  mode?: string;
  method?: string;
  entryType?: string;
  title?: string;
  state?: string;
  status?: string;
  stopReason?: string;
  phase?: string;
  expanded?: boolean;
  command?: string;
  filePath?: string;
  detail?: unknown;
  args?: UnknownRecord;
  input?: UnknownRecord;
  result?: unknown;
  output?: unknown;
  details?: unknown;
  toolResult?: unknown;
  questions?: unknown;
  question?: unknown;
  prompt?: unknown;
  message?: unknown;
  files?: unknown;
  diffs?: unknown;
  steps?: unknown;
  patch?: unknown;
  additions?: unknown;
  deletions?: unknown;
  outputText?: unknown;
  errorText?: unknown;
  isError?: boolean;
  exitCode?: number;
  sessionFilePath?: unknown;
  nativeTurnId?: unknown;
  turnId?: unknown;
  turnRevision?: unknown;
  lifecycleRevision?: unknown;
  /** 压缩是否发生在本轮对话结束之后（收尾型）：此时压缩期间的消息无法再作为引导注入。 */
  postTurn?: boolean;
  /** 最近一次请求实际携带的上下文 token 数；不同后端精度可能不同。 */
  contextTokens?: number;
  /** 产生该用量时的模型上下文窗口。 */
  contextWindow?: number;
  /** 上下文用量精度：exact=后端专用接口，official=官方上报计数，estimated=按请求计数或分类求和借位。 */
  contextPrecision?: "exact" | "official" | "estimated";
  /** 旧版精度标记（false 即精确）：只为历史事件保留，新代码一律发 contextPrecision。 */
  contextEstimated?: boolean;
  /** 上下文构成明细；pi / claude / droid 能提供。 */
  contextBreakdown?: Array<{ id: string; label: string; tokens: number }>;
  pendingUIRevision?: unknown;
  clientUserMessageId?: unknown;
  threadId?: unknown;
  [key: string]: unknown;
}

export const isAgentEvent = (value: unknown): value is AgentEvent =>
  isRecord(value) && typeof value.type === "string" && value.type.trim().length > 0;

export type AgentUIResponse = UnknownRecord;

export interface AgentPendingUIEventSnapshot {
  revision: number;
  requests: AgentEvent[];
}

export type AgentPlanModeSupport = "native" | "prompt" | "none";
export type AgentProviderActivationSupport = "single-active" | "none";
export type AgentSource = "plugin";

export interface AgentProviderEndpointOption {
  id: string;
  label: string;
}

export type AgentProviderAuthMode = "bearer" | "x-api-key";

export interface AgentProviderAuthOption {
  id: AgentProviderAuthMode;
  label: string;
}

export interface AgentBackendModelVisibility {
  userConfigurable: boolean;
  defaultVisible: boolean;
  label: string;
  description?: string;
}

export interface AgentProviderConfiguration {
  type: "provider";
  storage: "hpp" | "plugin";
  endpoints: AgentProviderEndpointOption[];
  defaultEndpoint: string;
  authModes?: AgentProviderAuthOption[];
  defaultAuthMode?: AgentProviderAuthMode;
  pathLabel?: string;
  hint?: string;
  modelDefaults: {
    reasoning: boolean;
    imageInput: boolean;
    supportedThinkingLevels?: string[];
  };
  fixedModelCapabilities: boolean;
  modelListMode: "configured" | "backend" | "merge";
  backendModelVisibility?: AgentBackendModelVisibility;
}

export type AgentConfigurationSupport = AgentProviderConfiguration | "none";

export interface AgentCompactionCapabilities {
  customModel: boolean;
  thinkingLevel: boolean;
  /** 插件支持「启用/关闭上下文压缩」开关（后端能真正取消压缩）。 */
  toggle?: boolean;
  /** 压缩模型可直接从已配置渠道选择（`providerId/modelId`）。 */
  channelModel?: boolean;
}

export type AgentCompactionSupport = AgentCompactionCapabilities | "none";
export type AgentSubagentSupport = AgentSubagentCapabilities | "none";

/**
 * Agent 上游自带的可选内置扩展。宿主不会自动加载它们（那需要走 agent CLI 的
 * 启动路径），必须由用户显式开启，并按id 逐个下发到运行中的后端。
 */
export interface AgentBuiltinExtensionOption {
  id: string;
  label: string;
  description?: string;
  /** 旧版后端不支持热切换时置false，UI 需提示「重启后生效」。 */
  hotReload?: boolean;
}

export interface AgentBuiltinExtensionCapabilities {
  userConfigurable: boolean;
  defaultEnabled: string[];
  options: AgentBuiltinExtensionOption[];
}

export type AgentBuiltinExtensionSupport = AgentBuiltinExtensionCapabilities | "none";

/** MCP 配置的作用域。global 是 `~/.pi/agent/mcp.json`，project 是 `<项目>/.pi/mcp.json`。 */
export type McpConfigScope = "global" | "project";

/**
 * 一个 MCP server 的连接配置，字段与 pi 的 `validateMcpServerConfig` 一致。
 * stdio 用 command/args/env/cwd；http 用 url/headers/auth。
 */
export interface McpServerConfig {
  type?: "stdio" | "http" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: { provider: string };
  timeout?: number;
  description?: string;
  enabled?: boolean;
  exposure?: "codemode" | "deferred" | "direct" | "hidden";
  toolExposure?: Record<string, "codemode" | "deferred" | "direct" | "hidden">;
}

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  scope: McpConfigScope;
  /** 项目级覆盖条目（只有 enabled/exposure/toolExposure，没有连接信息）。 */
  isOverride: boolean;
  /** 覆盖条目缺少同名全局 server —— pi 会拒绝加载，UI 需标出来。 */
  overrideMissing: boolean;
}

export interface McpConfigSnapshot {
  scope: McpConfigScope;
  /** 该作用域的配置文件绝对路径。文件不存在时 exists 为 false。 */
  filePath: string;
  exists: boolean;
  servers: McpServerEntry[];
  /** mcp.json 顶层的 autoEnableCodemode（缺省 true，不落盘）。 */
  autoEnableCodemode?: boolean;
  /** 语法/字段错误，来自与 pi 相同的校验规则。 */
  errors: string[];
  /** 可编辑的项目路径；scope 为 global 时为空。 */
  projectPath?: string;
}

export interface McpConfigResult {
  success: boolean;
  error?: string;
  snapshot?: McpConfigSnapshot;
  /** MCP server 重连是否已触发；未触发时 UI 应提示「重启会话后生效」。 */
  reconnected?: boolean;
}

/**
 * codemode 扩展的配置。存pi 自己的 `~/.pi/agent/settings.json` 的 `codemode` 字段
 * （扩展侧 `readMode` / `readInlineBudget` 读的就是它）。
 */
export interface AgentCodemodeConfig {
  /**
   * `on`：脚本能调所有工具。
   * `only`：脚本只调非 direct 的工具（codemode / deferred 档），
   * 把 read/write/bash 这些从脚本可见范围里剔除。
   */
  mode: "on" | "only";
  /** 写进 codemode 工具描述里的工具说明预算上限（estimated tokens）。 */
  inlineBudget: number;
}

export interface AgentCodemodeConfigResult {
  success: boolean;
  error?: string;
  config?: AgentCodemodeConfig;
  /** settings.json 里是否已存在 codemode 字段；false 表示本次是首次写入。 */
  stored?: boolean;
  /** 是否真的重载了运行中的会话（没开会话时为 false，改动要等下次 init）。 */
  reconnected?: boolean;
}

export interface AgentCapabilities {
  planMode: AgentPlanModeSupport;
  permissions: boolean;
  guidance: boolean;
  fork: boolean;
  actions: boolean;
  configuration: AgentConfigurationSupport;
  providerActivation: AgentProviderActivationSupport;
  compaction?: AgentCompactionSupport;
  subagent?: AgentSubagentSupport;
  builtinExtensions?: AgentBuiltinExtensionSupport;
}

export interface SessionDataPurgeRequest {
  sessionIds?: string[];
  projectIds?: string[];
  validSessionIds?: string[];
  validProjectIds?: string[];
}

export type DiskUsageCategoryId =
  | "conversations"
  | "configuration"
  | "agentPlugins"
  | "agentRuntimes"
  | "browserCache"
  | "browserStorage"
  | "other";

export interface DiskUsageCategory {
  id: DiskUsageCategoryId;
  sizeBytes: number;
  fileCount: number;
}

export interface DiskUsageStats {
  totalSizeBytes: number;
  totalFileCount: number;
  dataPath: string;
  categories: DiskUsageCategory[];
  measuredAt: number;
}

export interface DiskCleanupResult {
  reclaimedBytes: number;
  removedFileCount: number;
  stats: DiskUsageStats;
}

export interface AgentPluginManifest {
  schemaVersion: 3;
  id: string;
  name: string;
  version: string;
  minHppVersion: string;
  description?: string;
  entry: string;
  runtime?: "cli" | "sdk" | "plugin";
  command?: string;
  packageName?: string;
  order?: number;
  installHint?: string;
  updateCommand?: string;
  shortName?: string;
  capabilities?: Partial<AgentCapabilities>;
}

export interface AgentDescriptor {
  id: string;
  name: string;
  desc?: string;
  description?: string;
  version: string;
  minHppVersion: string;
  runtime: "cli" | "sdk" | "plugin";
  command?: string;
  packageName?: string;
  order: number;
  capabilities: AgentCapabilities;
  source: AgentSource;
  removable: boolean;
  installedPath?: string;
  installHint?: string;
  updateCommand?: string;
  shortName?: string;
}

export interface AgentPluginInstallResult {
  success: boolean;
  error?: string;
  agent?: AgentDescriptor;
  agents?: AgentDescriptor[];
  installedPath?: string;
  replaced?: boolean;
  detachedSessionIds?: string[];
}

export interface OfficialAgentPluginDescriptor {
  id: string;
  name: string;
  version: string;
  minHppVersion: string;
  compatible: boolean;
  compatibilityError?: string;
  description?: string;
  runtime: "cli" | "sdk" | "plugin";
  command?: string;
  packageName?: string;
  order: number;
  installHint?: string;
  updateCommand?: string;
  shortName?: string;
  capabilities: AgentCapabilities;
  zipFile: string;
  downloadUrl: string;
}

export interface OfficialAgentPluginCatalogResult {
  success: boolean;
  error?: string;
  plugins: OfficialAgentPluginDescriptor[];
  sourceUrl?: string;
  fetchedAt?: string;
}

export interface AgentPackageStatus {
  installed: boolean;
  currentVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  canUpdate: boolean;
  packageRoot?: string;
  nodeVersion?: string;
  nodeOk?: boolean;
  source?: AgentSource;
  installedPath?: string;
  removable?: boolean;
  rollbackVersion?: string;
  canRollback?: boolean;
  error?: string;
}

export interface AgentPackageVersions {
  packageName: string;
  latestVersion?: string;
  distTags: Record<string, string>;
  versions: string[];
  error?: string;
}

export const APP_UPDATE_STATES = [
  "idle",
  "checking",
  "available",
  "not-available",
  "downloading",
  "downloaded",
  "error",
] as const;

export type AppUpdateState = typeof APP_UPDATE_STATES[number];

export interface AppUpdateStatus {
  state: AppUpdateState;
  currentVersion: string;
  version?: string;
  releaseDate?: string;
  releaseName?: string;
  releaseNotes?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  error?: string;
  feedUrl?: string;
  canCheck: boolean;
  canDownload: boolean;
  canInstall: boolean;
}

export interface AppUpdateResult {
  success: boolean;
  error?: string;
  status?: AppUpdateStatus;
}

export const isAppUpdateState = (value: unknown): value is AppUpdateState =>
  typeof value === "string" && APP_UPDATE_STATES.includes(value as AppUpdateState);

export const isAppUpdateStatus = (value: unknown): value is AppUpdateStatus => {
  if (!isRecord(value) || !isAppUpdateState(value.state)) return false;
  return (
    typeof value.currentVersion === "string" &&
    typeof value.canCheck === "boolean" &&
    typeof value.canDownload === "boolean" &&
    typeof value.canInstall === "boolean"
  );
};
