import type { BrowserWindow } from "electron";
import type {
  AgentActionCatalogEntry,
  AgentActionListOptions,
  AgentCompactionConfig,
  AgentImagePayload,
  AgentSendOptions as BaseAgentSendOptions,
  AgentUIResponse,
} from "../../src/types/ipc";
import type { AgentSubagentConfig } from "../../shared/agent-subagent";

export interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  supportsImages?: boolean;
  supportedThinkingLevels?: string[];
  /** levels=思考档位下拉；toggle=只有思考开关。 */
  thinkingLevelMode?: "levels" | "toggle";
}

export interface AgentSendOptions extends BaseAgentSendOptions {
  displayMessage?: string;
  /** Hpp-owned policy; adapters must use a native system/developer prompt. */
  hostSystemPrompt?: string;
}

export interface AgentInitOptions {
  /**
   * Hpp-owned policy supplied before the adapter starts its native runtime.
   * This lets CLI adapters use startup-only system-prompt channels without
   * changing the visible user message or persisted conversation history.
   */
  hostSystemPrompt?: string;
  /** 通用 Agent 压缩策略；不支持自定义压缩的适配器可以忽略。 */
  compaction?: AgentCompactionConfig;
  /** Hpp subagent 配置；不支持该能力的适配器可以忽略。 */
  subagent?: AgentSubagentConfig;
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
  init(projectPath: string, existingSessionFilePath?: string, options?: AgentInitOptions): Promise<void>;
  isIdle(): boolean;
  refreshIdle?(): Promise<boolean>;
  sendMessage(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void>;
  sendGuidance?(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void>;
  forkSession?(target: AgentForkTarget): Promise<AgentForkResult>;
  abort(): Promise<void>;
  getModels(): Promise<AgentModel[]>;
  listActions(options?: AgentActionListOptions): Promise<AgentActionCatalogEntry[]>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  /** 热更新通用压缩策略；未实现时在下次初始化读取。 */
  setCompactionConfig?(config: AgentCompactionConfig): Promise<void>;
  sendUIResponse(response: AgentUIResponse): Promise<void>;
  dispose(): void | Promise<void>;
  readonly sessionFilePath: string | null;
}
