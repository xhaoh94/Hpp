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
  [key: string]: unknown;
}

export const isAgentEvent = (value: unknown): value is AgentEvent =>
  isRecord(value) && typeof value.type === "string" && value.type.trim().length > 0;

export type AgentUIResponse = UnknownRecord;

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
