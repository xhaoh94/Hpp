export type UnknownRecord = Record<string, unknown>;

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
  clientMessageId?: string;
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
  command?: string;
  filePath?: string;
  detail?: unknown;
  args?: UnknownRecord;
  input?: UnknownRecord;
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
  sessionFilePath?: unknown;
  nativeTurnId?: unknown;
  turnId?: unknown;
  clientUserMessageId?: unknown;
  threadId?: unknown;
  [key: string]: unknown;
}

export const isAgentEvent = (value: unknown): value is AgentEvent =>
  isRecord(value) && typeof value.type === "string" && value.type.trim().length > 0;

export type AgentUIResponse = UnknownRecord;

export type AgentPlanModeSupport = "native" | "prompt" | "none";
export type AgentConfigurationSupport = "openai-compatible" | "none" | false;
export type AgentProviderActivationSupport = "single-active" | "none";
export type AgentSource = "plugin";

export interface AgentCapabilities {
  planMode: AgentPlanModeSupport;
  guidance: boolean;
  fork: boolean;
  configuration: AgentConfigurationSupport;
  providerActivation: AgentProviderActivationSupport;
}

export interface AgentPluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  entry: string;
  runtime?: "cli" | "sdk" | "plugin";
  command?: string;
  packageName?: string;
  capabilities?: Partial<AgentCapabilities>;
}

export interface AgentDescriptor {
  id: string;
  name: string;
  desc?: string;
  description?: string;
  version: string;
  runtime: "cli" | "sdk" | "plugin";
  command?: string;
  packageName?: string;
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
}

export interface OfficialAgentPluginDescriptor {
  id: string;
  name: string;
  version: string;
  description?: string;
  runtime: "cli" | "sdk" | "plugin";
  command?: string;
  packageName?: string;
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
