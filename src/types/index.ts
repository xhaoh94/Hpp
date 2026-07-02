export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: FileEntry[];
}

export interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
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
  args?: Record<string, unknown>;
  input?: Record<string, unknown>;
  questions?: unknown;
  question?: unknown;
  prompt?: unknown;
  message?: unknown;
  files?: unknown;
  diffs?: unknown;
  patch?: unknown;
  additions?: unknown;
  deletions?: unknown;
  outputText?: unknown;
  errorText?: unknown;
  isError?: boolean;
  sessionFilePath?: unknown;
  [key: string]: unknown;
}

export type AgentUIResponse = Record<string, unknown>;

export interface AgentPackageStatus {
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

export type PiSDKStatus = AgentPackageStatus;

export interface ElectronAPI {
  // Window controls
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  platform: string;

  // File system
  readDirectory: (dirPath: string) => Promise<FileEntry[]>;
  readFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
  fileExists: (filePath: string) => Promise<boolean>;
  searchFiles: (dirPath: string, query: string) => Promise<FileEntry[]>;
  openDirectory: () => Promise<{ canceled: boolean; path: string }>;
  getHomeDir: () => Promise<string>;
  isCommandAvailable: (command: string) => Promise<boolean>;
  piSDKGetStatus: () => Promise<PiSDKStatus>;
  piSDKUpdate: () => Promise<{ success: boolean; error?: string; status?: PiSDKStatus }>;
  agentGetStatus: (agentId: string) => Promise<AgentPackageStatus>;
  agentUpdate: (agentId: string) => Promise<{ success: boolean; error?: string; status?: AgentPackageStatus }>;

  // Data persistence
  loadData: (key: string) => Promise<unknown>;
  saveData: (key: string, data: unknown) => Promise<{ success: boolean; error?: string }>;

  // Clipboard
  writeImageToClipboard: (imageDataUrl: string) => Promise<{ success: boolean; error?: string }>;

  // Agent
  agentCreateSession: (agentId: string, projectPath: string, sessionId?: string, sessionFilePath?: string) => Promise<{ success: boolean; error?: string; sessionFilePath?: string; models?: AgentModel[] }>;
  agentSwitchSession: (sessionId: string) => Promise<{ success: boolean }>;
  agentRemoveSession: (sessionId: string) => Promise<{ success: boolean }>;
  agentSendMessage: (message: string, images?: Array<{ type: string; data: string; mimeType: string }>, sessionId?: string, options?: { planModeEnabled?: boolean }) => Promise<{ success: boolean; error?: string }>;
  agentAbort: (sessionId?: string) => Promise<{ success: boolean }>;
  agentGetModels: (sessionId?: string) => Promise<AgentModel[]>;
  agentSetModel: (provider: string, modelId: string) => Promise<{ success: boolean }>;
  agentSetThinkingLevel: (level: string) => Promise<{ success: boolean }>;
  agentSendUIResponse: (response: AgentUIResponse) => Promise<{ success: boolean }>;

  // Agent events
  onAgentEvent: (callback: (event: AgentEvent) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
