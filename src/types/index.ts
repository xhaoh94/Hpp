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
  [key: string]: unknown;
}

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

  // Data persistence
  loadData: (key: string) => Promise<unknown>;
  saveData: (key: string, data: unknown) => Promise<{ success: boolean; error?: string }>;

  // Agent
  agentCreateSession: (agentId: string, projectPath: string, sessionId?: string, sessionFilePath?: string) => Promise<{ success: boolean; error?: string; sessionFilePath?: string }>;
  agentSwitchSession: (sessionId: string) => Promise<{ success: boolean }>;
  agentRemoveSession: (sessionId: string) => Promise<{ success: boolean }>;
  agentSendMessage: (message: string, images?: Array<{ type: string; data: string; mimeType: string }>) => Promise<{ success: boolean; error?: string }>;
  agentAbort: () => Promise<{ success: boolean }>;
  agentGetModels: () => Promise<AgentModel[]>;
  agentSetModel: (provider: string, modelId: string) => Promise<{ success: boolean }>;
  agentSetThinkingLevel: (level: string) => Promise<{ success: boolean }>;

  // Agent events
  onAgentEvent: (callback: (event: AgentEvent) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
