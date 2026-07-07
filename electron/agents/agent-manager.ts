import { ipcMain, BrowserWindow, app } from "electron";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { OpenCodeAgent } from "./opencode-agent";
import { DroidAgent } from "./droid-agent";
import { PiSDKAgent } from "./pi-sdk-agent";
import { CodexAgent } from "./codex-agent";
import {
  deleteAgentProviderConfig,
  getConfiguredAgentModels,
  listAgentConfig,
  restoreNativeConfigSnapshots,
  saveAgentProviderConfig,
  setActiveAgentProviderConfig,
  writeNativeAgentProviderConfig,
} from "./agent-config";

interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  supportsImages?: boolean;
}

/** Common interface for all agent backends */
interface AgentBackend {
  setWindow(win: BrowserWindow): void;
  init(projectPath: string, existingSessionFilePath?: string): Promise<void>;
  isIdle(): boolean;
  sendMessage(message: string, images?: Array<{ type: string; data: string; mimeType: string }>, options?: AgentSendOptions): Promise<void>;
  sendGuidance?(message: string, images?: Array<{ type: string; data: string; mimeType: string }>, options?: AgentSendOptions): Promise<void>;
  forkSession?(target: AgentForkTarget): Promise<AgentForkResult>;
  abort(): Promise<void>;
  getModels(): Promise<AgentModel[]>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  sendUIResponse(response: any): void;
  dispose(): void;
  readonly sessionFilePath: string | null;
}

interface AgentSendOptions {
  planModeEnabled?: boolean;
  displayMessage?: string;
  permissionMode?: "plan" | "full-access";
  clientMessageId?: string;
}

interface AgentForkTarget {
  newSessionId: string;
  sourceSessionFilePath?: string;
  sourceUserMessageIndex: number;
  rollbackUserMessageCount?: number;
  sourceMessageContent?: string;
  throughMessageId?: string;
}

interface AgentForkResult {
  supported: boolean;
  success: boolean;
  sessionFilePath?: string;
  nativeEntryId?: string;
  error?: string;
  reason?: string;
}

interface AgentReloadConfigResult {
  success: boolean;
  error?: string;
  models?: AgentModel[];
  reloadedSessionIds?: string[];
}

// ============================================================
// Local models.json config support
// ============================================================

interface LocalModelsConfig {
  providers?: Record<string, {
    models?: Array<{ id: string; name?: string; reasoning?: boolean; input?: string[] }>;
  }>;
}

let _localModelsConfig: LocalModelsConfig | null = null;
let _localModelsConfigMtime = 0;

/** Read ~/.pi/agent/models.json, cached with mtime check */
function readLocalModelsConfig(): LocalModelsConfig {
  const configPath = join(homedir(), ".pi", "agent", "models.json");
  try {
    const stat = existsSync(configPath) ? statSync(configPath) : null;
    const mtime = stat ? stat.mtimeMs : 0;
    if (_localModelsConfig && mtime <= _localModelsConfigMtime) {
      return _localModelsConfig;
    }
    const content = readFileSync(configPath, "utf-8");
    _localModelsConfig = JSON.parse(content) as LocalModelsConfig;
    _localModelsConfigMtime = mtime;
  } catch {
    _localModelsConfig = {};
    _localModelsConfigMtime = Date.now();
  }
  return _localModelsConfig!;
}

/**
 * Filter fetched models against the local models.json config.
 * If the provider (vendor) is defined in models.json.providers,
 * only return the models whose IDs are listed in that provider's models array.
 * If the provider is NOT configured, return all models for that provider unchanged.
 */
function filterModelsByLocalConfig(models: AgentModel[]): AgentModel[] {
  const config = readLocalModelsConfig();
  if (!config?.providers) return models;

  const result: AgentModel[] = [];
  for (const model of models) {
    const providerConfig = config.providers[model.provider];
    if (!providerConfig?.models) {
      // Provider not configured — keep all models
      result.push(model);
    } else {
      // Provider is configured — only include models whose id matches
      const configuredIds = new Set(providerConfig.models.map((m: any) => m.id));
      if (configuredIds.has(model.id)) {
        // Use the config's model info as-is (id, name, reasoning) to respect custom overrides
        const configuredModel = providerConfig.models.find((m: any) => m.id === model.id);
        result.push({
          ...model,
          name: configuredModel?.name ?? model.name,
          reasoning: configuredModel?.reasoning ?? model.reasoning,
          supportsImages: Array.isArray(configuredModel?.input)
            ? configuredModel.input.includes("image")
            : model.supportsImages,
        });
      }
    }
  }
  return result;
}

async function mergeModelsWithConfiguredAgentModels(agentId: string | undefined, models: AgentModel[]): Promise<AgentModel[]> {
  if (!agentId) return models;
  const configuredModels = await getConfiguredAgentModels(agentId).catch(() => []);
  if (configuredModels.length === 0) return models;
  if (agentId === "codex") return configuredModels;

  const merged = new Map<string, AgentModel>();
  for (const model of models) {
    merged.set(`${model.provider}:${model.id}`, model);
  }
  for (const model of configuredModels) {
    merged.set(`${model.provider}:${model.id}`, model);
  }
  return Array.from(merged.values());
}

function resetLocalModelsConfigCache() {
  _localModelsConfig = null;
  _localModelsConfigMtime = 0;
}

function supportsNativePlanMode(agentId?: string): boolean {
  return agentId === "codex" || agentId === "opencode" || agentId === "droid";
}

function supportsGuidance(agentId?: string): boolean {
  return agentId === "pi" || agentId === "codex";
}

function withPromptPlanMode(message: string): string {
  return [
    "<plan_mode>",
    "Plan mode is enabled for this turn.",
    "Before changing files, running commands, or using tools that modify state, first respond with a concise implementation plan and wait for the user to explicitly confirm.",
    "You may inspect context that is necessary to make the plan. If the user has already explicitly approved a previous plan in this conversation, proceed with the approved implementation.",
    "</plan_mode>",
    "",
    message,
  ].join("\n");
}

// ============================================================
// Agent Manager - supports Pi SDK, OpenCode, and Droid per session
// ============================================================
class AgentManager {
  private sessionAgents = new Map<string, AgentBackend>();
  private sessionAgentTypes = new Map<string, string>(); // sessionId -> agentId ("pi" | "opencode")
  private sessionFilePaths = new Map<string, string>();
  private sessionProjectPaths = new Map<string, string>();
  private activeSessionId: string | null = null;
  private window: BrowserWindow | null = null;

  setWindow(win: BrowserWindow) { this.window = win; }

  private createAgentBackend(agentId: string, sessionId: string): AgentBackend {
    if (agentId === "codex") return new CodexAgent(sessionId);
    if (agentId === "opencode") return new OpenCodeAgent(sessionId);
    if (agentId === "droid") return new DroidAgent(sessionId);
    return new PiSDKAgent(sessionId); // default
  }

  /** Create or resume a session */
  async createSession(
    sessionId: string, agentId: string, projectPath: string,
    existingSessionFilePath?: string
  ): Promise<void> {
    console.log("[agent-manager] createSession:", sessionId, "agent:", agentId, "existingSessionFilePath:", existingSessionFilePath);
    let agent = this.sessionAgents.get(sessionId);
    if (!agent) {
      agent = this.createAgentBackend(agentId, sessionId);
      this.sessionAgents.set(sessionId, agent);
      this.sessionAgentTypes.set(sessionId, agentId);
      console.log("[agent-manager] Created new agent:", agent.constructor.name);
    } else {
      console.log("[agent-manager] Reusing existing agent:", agent.constructor.name);
    }
    this.sessionProjectPaths.set(sessionId, projectPath);
    if (this.window) agent.setWindow(this.window);
    await agent.init(projectPath, existingSessionFilePath);

    const fp = agent.sessionFilePath;
    console.log("[agent-manager] After init, sessionFilePath:", fp);
    if (fp) this.sessionFilePaths.set(sessionId, fp);

    this.activeSessionId = sessionId;
  }

  getSessionFilePath(sessionId: string): string | undefined {
    return this.sessionFilePaths.get(sessionId);
  }

  getSessionAgentType(sessionId: string): string | undefined {
    return this.sessionAgentTypes.get(sessionId);
  }

  switchSession(sessionId: string) {
    if (this.sessionAgents.has(sessionId)) {
      this.activeSessionId = sessionId;
    }
  }

  getActiveAgent(): AgentBackend | null {
    if (!this.activeSessionId) return null;
    return this.sessionAgents.get(this.activeSessionId) || null;
  }
  getAgentBySessionId(sessionId: string): AgentBackend | null {
    return this.sessionAgents.get(sessionId) || null;
  }

  getAgentForSession(sessionId?: string): AgentBackend | null {
    return sessionId ? this.getAgentBySessionId(sessionId) : this.getActiveAgent();
  }

  getActiveAgentType(): string | undefined {
    return this.activeSessionId ? this.sessionAgentTypes.get(this.activeSessionId) : undefined;
  }

  canReloadConfig(agentId: string, sessionId?: string): AgentReloadConfigResult {
    const entries = Array.from(this.sessionAgents.entries());
    const targetEntries = sessionId
      ? entries.filter(([sid]) => sid === sessionId)
      : entries.filter(([sid]) => this.sessionAgentTypes.get(sid) === agentId);

    if (sessionId && targetEntries.length === 0) {
      return { success: false, error: "目标 Agent 会话尚未初始化。", reloadedSessionIds: [] };
    }

    for (const [sid] of targetEntries) {
      if (this.sessionAgentTypes.get(sid) !== agentId) {
        return { success: false, error: "目标会话不是指定 Agent。", reloadedSessionIds: [] };
      }
    }

    const busySession = targetEntries.find(([, agent]) => !agent.isIdle());
    if (busySession) {
      return {
        success: false,
        error: "当前 Agent 会话正在运行，请等待空闲后再重载配置。",
        reloadedSessionIds: [],
      };
    }

    return { success: true, reloadedSessionIds: targetEntries.map(([sid]) => sid) };
  }

  async getModelsBySessionId(sessionId: string): Promise<AgentModel[]> {
    const agent = this.sessionAgents.get(sessionId);
    if (!agent) return [];
    const models = await agent.getModels();
    const agentType = this.sessionAgentTypes.get(sessionId);
    const filteredModels = agentType === "pi" ? filterModelsByLocalConfig(models) : models;
    return mergeModelsWithConfiguredAgentModels(agentType, filteredModels);
  }

  sendUIResponse(response: any) {
    const agent = response?.sessionId
      ? this.getAgentBySessionId(response.sessionId)
      : this.getActiveAgent();
    if (!agent) return;
    agent.sendUIResponse(response);
  }

  async sendGuidance(sessionId: string | undefined, message: string, images?: Array<{ type: string; data: string; mimeType: string }>, options?: AgentSendOptions): Promise<void> {
    const agent = sessionId ? this.getAgentBySessionId(sessionId) : this.getActiveAgent();
    if (!agent) throw new Error("No active agent");
    const agentType = sessionId ? this.getSessionAgentType(sessionId) : this.getActiveAgentType();
    if (!supportsGuidance(agentType) || typeof agent.sendGuidance !== "function") {
      throw new Error("Guidance is not supported by this agent");
    }
    await agent.sendGuidance(message, images, options);
  }

  async forkSession(sessionId: string, target: AgentForkTarget): Promise<AgentForkResult> {
    const agent = this.getAgentBySessionId(sessionId);
    if (!agent) {
      return { supported: false, success: false, reason: "source session is not initialized" };
    }
    if (typeof agent.forkSession !== "function") {
      return { supported: false, success: false, reason: "agent does not support native fork" };
    }
    return agent.forkSession({
      ...target,
      sourceSessionFilePath: target.sourceSessionFilePath || agent.sessionFilePath || undefined,
    });
  }

  async reloadConfig(agentId: string, sessionId?: string): Promise<AgentReloadConfigResult> {
    const entries = Array.from(this.sessionAgents.entries());
    const targetEntries = sessionId
      ? entries.filter(([sid]) => sid === sessionId)
      : entries.filter(([sid]) => this.sessionAgentTypes.get(sid) === agentId);

    if (sessionId && targetEntries.length === 0) {
      return { success: false, error: "目标 Agent 会话尚未初始化。", reloadedSessionIds: [] };
    }

    if (targetEntries.length === 0) {
      return {
        success: true,
        models: await mergeModelsWithConfiguredAgentModels(agentId, []),
        reloadedSessionIds: [],
      };
    }

    const idleCheck = this.canReloadConfig(agentId, sessionId);
    if (!idleCheck.success) return idleCheck;

    for (const [sid] of targetEntries) {
      if (this.sessionAgentTypes.get(sid) !== agentId) {
        return { success: false, error: "目标会话不是指定 Agent。", reloadedSessionIds: [] };
      }
    }

    const busySession = targetEntries.find(([, agent]) => !agent.isIdle());
    if (busySession) {
      return {
        success: false,
        error: "当前 Agent 会话正在运行，请等待空闲后再重载配置。",
        reloadedSessionIds: [],
      };
    }

    const targets = targetEntries.map(([sid, agent]) => {
      const projectPath = this.sessionProjectPaths.get(sid);
      if (!projectPath) {
        throw new Error(`会话 ${sid} 缺少项目路径，无法重载配置。`);
      }
      return {
        sessionId: sid,
        agent,
        agentType: this.sessionAgentTypes.get(sid) || agentId,
        projectPath,
        sessionFilePath: agent.sessionFilePath || this.sessionFilePaths.get(sid),
      };
    });

    resetLocalModelsConfigCache();

    const initializedTargets: Array<{
      target: (typeof targets)[number];
      nextAgent: AgentBackend;
      nextSessionFilePath?: string;
    }> = [];

    try {
      for (const target of targets) {
        const nextAgent = this.createAgentBackend(target.agentType, target.sessionId);
        if (this.window) nextAgent.setWindow(this.window);
        await nextAgent.init(target.projectPath, target.sessionFilePath);
        initializedTargets.push({
          target,
          nextAgent,
          nextSessionFilePath: nextAgent.sessionFilePath || target.sessionFilePath,
        });
      }
    } catch (error) {
      for (const initialized of initializedTargets) {
        initialized.nextAgent.dispose();
      }
      throw error;
    }

    for (const { target, nextAgent, nextSessionFilePath } of initializedTargets) {
      target.agent.dispose();
      this.sessionAgents.set(target.sessionId, nextAgent);
      this.sessionAgentTypes.set(target.sessionId, target.agentType);
      if (nextSessionFilePath) {
        this.sessionFilePaths.set(target.sessionId, nextSessionFilePath);
      } else {
        this.sessionFilePaths.delete(target.sessionId);
      }
    }

    const reloadedSessionIds = targets.map((target) => target.sessionId);
    const modelSessionId =
      this.activeSessionId && reloadedSessionIds.includes(this.activeSessionId)
        ? this.activeSessionId
        : reloadedSessionIds[0];
    const models = modelSessionId ? await this.getModelsBySessionId(modelSessionId) : [];

    return { success: true, models, reloadedSessionIds };
  }

  removeSession(sessionId: string) {
    const agent = this.sessionAgents.get(sessionId);
    if (agent) { agent.dispose(); this.sessionAgents.delete(sessionId); }
    this.sessionAgentTypes.delete(sessionId);
    this.sessionFilePaths.delete(sessionId);
    this.sessionProjectPaths.delete(sessionId);
    if (this.activeSessionId === sessionId) this.activeSessionId = null;
  }
}

const agentManager = new AgentManager();

// ============================================================
// IPC handlers
// ============================================================
export function registerAgentHandlers(getWindow: () => BrowserWindow | null) {
  ipcMain.handle("agent:createSession", async (_event, agentId: string, projectPath: string, sessionId?: string, sessionFilePath?: string) => {
    const sid = sessionId || "default";
    try {
      const win = getWindow();
      if (win) agentManager.setWindow(win);
      await agentManager.createSession(sid, agentId, projectPath, sessionFilePath);
      const models = await agentManager.getModelsBySessionId(sid);
      return { success: true, sessionFilePath: agentManager.getSessionFilePath(sid), models };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("agent:switchSession", async (_event, sessionId: string) => {
    agentManager.switchSession(sessionId);
    return { success: true };
  });

  ipcMain.handle("agent:removeSession", async (_event, sessionId: string) => {
    agentManager.removeSession(sessionId);
    return { success: true };
  });

  ipcMain.handle("agent:sendMessage", async (_event, message: string, images?: Array<{ type: string; data: string; mimeType: string }>, sessionId?: string, options?: AgentSendOptions) => {
    const agent = sessionId ? agentManager.getAgentBySessionId(sessionId) : agentManager.getActiveAgent();
    if (!agent) return { success: false, error: "No active agent" };
    try {
      const agentType = sessionId ? agentManager.getSessionAgentType(sessionId) : agentManager.getActiveAgentType();
      const planModeEnabled = !!options?.planModeEnabled;
      const permissionMode: AgentSendOptions["permissionMode"] = planModeEnabled ? "plan" : "full-access";
      const effectiveMessage = planModeEnabled && !supportsNativePlanMode(agentType)
        ? withPromptPlanMode(message)
        : message;
      await agent.sendMessage(effectiveMessage, images, {
        planModeEnabled: planModeEnabled && supportsNativePlanMode(agentType),
        permissionMode,
        displayMessage: message,
        clientMessageId: options?.clientMessageId,
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("agent:forkSession", async (_event, sessionId: string, target: AgentForkTarget) => {
    try {
      return await agentManager.forkSession(sessionId, target);
    } catch (err: any) {
      return { supported: true, success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle("agent:reloadConfig", async (_event, agentId: string, sessionId?: string) => {
    try {
      return await agentManager.reloadConfig(agentId, sessionId);
    } catch (err: any) {
      return { success: false, error: err.message || String(err), reloadedSessionIds: [] };
    }
  });

  ipcMain.handle("agentConfig:list", async (_event, agentId: string) => {
    return listAgentConfig(agentId);
  });

  ipcMain.handle("agentConfig:save", async (_event, agentId: string, config: unknown) => {
    const saveResult = await saveAgentProviderConfig(agentId, config);
    if (!saveResult.success || !saveResult.config) {
      return saveResult;
    }
    if (agentId === "codex") {
      const models = await mergeModelsWithConfiguredAgentModels(agentId, []);
      return { ...saveResult, models };
    }

    const idleCheck = agentManager.canReloadConfig(agentId);
    if (!idleCheck.success) {
      const models = await mergeModelsWithConfiguredAgentModels(agentId, []);
      return {
        ...saveResult,
        models,
        error: `配置已保存到本地文件；${idleCheck.error || "当前 Agent 会话不是空闲状态，暂未重载。"}`,
        reloadedSessionIds: [],
      };
    }

    try {
      resetLocalModelsConfigCache();
      const reloadResult = await agentManager.reloadConfig(agentId);
      return { ...reloadResult, config: saveResult.config };
    } catch (err: any) {
      return { success: false, error: err.message || String(err), config: saveResult.config, reloadedSessionIds: [] };
    }
  });

  ipcMain.handle("agentConfig:delete", async (_event, agentId: string, providerId: string) => {
    const deleteResult = await deleteAgentProviderConfig(agentId, providerId);
    if (!deleteResult.success || !deleteResult.config) {
      return deleteResult;
    }
    if (agentId === "codex") {
      const models = await mergeModelsWithConfiguredAgentModels(agentId, []);
      return { ...deleteResult, models };
    }

    const idleCheck = agentManager.canReloadConfig(agentId);
    if (!idleCheck.success) {
      const models = await mergeModelsWithConfiguredAgentModels(agentId, []);
      return {
        ...deleteResult,
        models,
        error: `渠道已从本地配置删除；${idleCheck.error || "当前 Agent 会话不是空闲状态，暂未重载。"}`,
        reloadedSessionIds: [],
      };
    }

    try {
      resetLocalModelsConfigCache();
      const reloadResult = await agentManager.reloadConfig(agentId);
      return { ...reloadResult, config: deleteResult.config };
    } catch (err: any) {
      return { success: false, error: err.message || String(err), config: deleteResult.config, reloadedSessionIds: [] };
    }
  });

  ipcMain.handle("agentConfig:activate", async (_event, agentId: string, providerId: string) => {
    if (agentId !== "codex") {
      return { success: false, error: "只有 Codex 需要启用渠道；其它 Agent 保存后会以多渠道形式写入配置。", reloadedSessionIds: [] };
    }

    const idleCheck = agentManager.canReloadConfig(agentId);
    if (!idleCheck.success) return idleCheck;

    let snapshots: Awaited<ReturnType<typeof writeNativeAgentProviderConfig>>["snapshots"] = [];
    try {
      const written = await writeNativeAgentProviderConfig(agentId, providerId);
      snapshots = written.snapshots;
      resetLocalModelsConfigCache();

      const reloadResult = await agentManager.reloadConfig(agentId);
      if (!reloadResult.success) {
        await restoreNativeConfigSnapshots(snapshots);
        resetLocalModelsConfigCache();
        return reloadResult;
      }

      const config = await setActiveAgentProviderConfig(agentId, providerId);
      const models = await mergeModelsWithConfiguredAgentModels(agentId, reloadResult.models || []);
      return { ...reloadResult, models, config };
    } catch (err: any) {
      if (snapshots.length > 0) {
        await restoreNativeConfigSnapshots(snapshots).catch(() => undefined);
        resetLocalModelsConfigCache();
      }
      return { success: false, error: err.message || String(err), reloadedSessionIds: [] };
    }
  });

  ipcMain.handle("agent:sendGuidance", async (_event, message: string, images?: Array<{ type: string; data: string; mimeType: string }>, sessionId?: string, options?: AgentSendOptions) => {
    try {
      await agentManager.sendGuidance(sessionId, message, images, options);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("agent:abort", async (_event, sessionId?: string) => {
    const agent = sessionId ? agentManager.getAgentBySessionId(sessionId) : agentManager.getActiveAgent();
    if (!agent) return { success: false };
    await agent.abort();
    return { success: true };
  });

  ipcMain.handle("agent:getModels", async (_event, sessionId?: string) => {
    const agent = sessionId
      ? agentManager.getAgentBySessionId(sessionId)
      : agentManager.getActiveAgent();
    console.log("[agent-manager] getModels sessionId:", sessionId, "agent:", agent ? agent.constructor.name : "null");
    if (!agent) return [];
    const models = await agent.getModels();
    const agentType = sessionId ? agentManager.getSessionAgentType(sessionId) : agentManager.getActiveAgentType();
    const filteredModels = agentType === "pi" ? filterModelsByLocalConfig(models) : models;
    return mergeModelsWithConfiguredAgentModels(agentType, filteredModels);
  });

  ipcMain.handle("agent:setModel", async (_event, provider: string, modelId: string, sessionId?: string) => {
    const agent = agentManager.getAgentForSession(sessionId);
    if (!agent) return { success: false };
    await agent.setModel(provider, modelId);
    return { success: true };
  });

  ipcMain.handle("agent:setThinkingLevel", async (_event, level: string, sessionId?: string) => {
    const agent = agentManager.getAgentForSession(sessionId);
    if (!agent) return { success: false };
    await agent.setThinkingLevel(level);
    return { success: true };
  });

  ipcMain.handle("agent:sendUIResponse", async (_event, response: any) => {
    agentManager.sendUIResponse(response);
    return { success: true };
  });
}
