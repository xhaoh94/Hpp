import type { BrowserWindow } from "electron";
import type {
  AgentActionCatalogEntry,
  AgentActionListOptions,
  AgentImagePayload,
  AgentSendOptions as BaseAgentSendOptions,
  AgentUIResponse,
} from "../../src/types/ipc";

export interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  supportsImages?: boolean;
  supportedThinkingLevels?: string[];
}

export interface AgentSendOptions extends BaseAgentSendOptions {
  displayMessage?: string;
  permissionMode?: "plan" | "full-access";
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
  listActions(options?: AgentActionListOptions): Promise<AgentActionCatalogEntry[]>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  sendUIResponse(response: AgentUIResponse): void;
  dispose(): void | Promise<void>;
  readonly sessionFilePath: string | null;
}
