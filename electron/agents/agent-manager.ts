import { ipcMain, BrowserWindow, dialog, app } from "electron";
import { readFileSync, existsSync, statSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { getAgentPluginRegistry } from "./agent-plugin-registry";
import {
  downloadOfficialPluginZip,
  listOfficialAgentPlugins,
} from "./official-agent-plugins";
import type {
  AgentImagePayload,
  AgentSendOptions as BaseAgentSendOptions,
  AgentUIResponse,
} from "../../src/types/ipc";
import {
  activateAgentProviderConfig,
  deleteAgentProviderConfig,
  getAgentConfigStateForBackend,
  getConfiguredAgentModels,
  listAgentConfig,
  reorderAgentProviderConfigs,
  restoreNativeConfigSnapshots,
  saveAgentProviderConfig,
  setActiveAgentProviderConfig,
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

interface AgentSendOptions extends BaseAgentSendOptions {
  planModeEnabled?: boolean;
  displayMessage?: string;
  permissionMode?: "plan" | "full-access";
}

interface AgentForkTarget {
  newSessionId: string;
  sourceSessionFilePath?: string;
  sourceUserMessageIndex: number;
  rollbackUserMessageCount?: number;
  targetTurnId?: string;
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

const AGENT_SESSION_INIT_TIMEOUT_MS = 90_000;
const agentRegistry = getAgentPluginRegistry();

// ============================================================
// Local models.json config support
// ============================================================

interface ProviderModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
}

interface ProviderConfig {
  models?: ProviderModelConfig[];
}

interface LocalModelsConfig {
  providers?: Record<string, ProviderConfig>;
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
    const content = readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "");
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
    const configuredModels = Array.isArray(providerConfig?.models)
      ? providerConfig.models.filter((configuredModel) => typeof configuredModel?.id === "string")
      : undefined;
    if (!configuredModels) {
      // Provider not configured — keep all models
      result.push(model);
    } else {
      // Provider is configured — only include models whose id matches
      const configuredIds = new Set(configuredModels.map((configuredModel) => configuredModel.id));
      if (configuredIds.has(model.id)) {
        // Use the config's model info as-is (id, name, reasoning) to respect custom overrides
        const configuredModel = configuredModels.find((candidate) => candidate.id === model.id);
        result.push({
          ...model,
          name: typeof configuredModel?.name === "string" ? configuredModel.name : model.name,
          reasoning: typeof configuredModel?.reasoning === "boolean" ? configuredModel.reasoning : model.reasoning,
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
  if (agentId === "codex") return configuredModels;
  if (configuredModels.length === 0) return models;
  if (agentId === "pi") return models;

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

async function supportsNativePlanMode(agentId?: string): Promise<boolean> {
  if (!agentId) return false;
  const capabilities = await agentRegistry.getCapabilities(agentId);
  return capabilities.planMode === "native";
}

async function supportsGuidance(agentId?: string): Promise<boolean> {
  if (!agentId) return false;
  const capabilities = await agentRegistry.getCapabilities(agentId);
  return capabilities.guidance === true;
}

async function usesSingleActiveProvider(agentId?: string): Promise<boolean> {
  if (!agentId) return false;
  const capabilities = await agentRegistry.getCapabilities(agentId);
  return capabilities.providerActivation === "single-active";
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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

  private async createAgentBackend(agentId: string, sessionId: string): Promise<AgentBackend> {
    return agentRegistry.createBackend(agentId, sessionId, {
      window: this.window,
      getConfigState: () => getAgentConfigStateForBackend(agentId),
    });
  }

  private async initAgentBackend(
    agent: AgentBackend,
    projectPath: string,
    existingSessionFilePath?: string
  ): Promise<void> {
    await withTimeout(
      agent.init(projectPath, existingSessionFilePath),
      AGENT_SESSION_INIT_TIMEOUT_MS,
      "Agent 会话初始化超时，请检查 Agent 是否已安装、可启动，或稍后重试。"
    );
  }

  /** Create or resume a session */
  async createSession(
    sessionId: string, agentId: string, projectPath: string,
    existingSessionFilePath?: string
  ): Promise<void> {
    console.log("[agent-manager] createSession:", sessionId, "agent:", agentId, "existingSessionFilePath:", existingSessionFilePath);
    let agent = this.sessionAgents.get(sessionId);
    if (!agent) {
      agent = await this.createAgentBackend(agentId, sessionId);
      this.sessionAgents.set(sessionId, agent);
      this.sessionAgentTypes.set(sessionId, agentId);
      console.log("[agent-manager] Created new agent:", agent.constructor.name);
    } else {
      console.log("[agent-manager] Reusing existing agent:", agent.constructor.name);
    }
    this.sessionProjectPaths.set(sessionId, projectPath);
    if (this.window) agent.setWindow(this.window);
    try {
      await this.initAgentBackend(agent, projectPath, existingSessionFilePath);
    } catch (error) {
      if (this.sessionAgents.get(sessionId) === agent) {
        agent.dispose();
        this.sessionAgents.delete(sessionId);
        this.sessionAgentTypes.delete(sessionId);
        this.sessionFilePaths.delete(sessionId);
        this.sessionProjectPaths.delete(sessionId);
      }
      if (this.activeSessionId === sessionId) this.activeSessionId = null;
      throw error;
    }

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

  sendUIResponse(response: AgentUIResponse) {
    const sessionId = typeof response.sessionId === "string" ? response.sessionId : undefined;
    const agent = sessionId
      ? this.getAgentBySessionId(sessionId)
      : this.getActiveAgent();
    if (!agent) return;
    agent.sendUIResponse(response);
  }

  async sendGuidance(sessionId: string | undefined, message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void> {
    const agent = sessionId ? this.getAgentBySessionId(sessionId) : this.getActiveAgent();
    if (!agent) throw new Error("No active agent");
    const agentType = sessionId ? this.getSessionAgentType(sessionId) : this.getActiveAgentType();
    if (!(await supportsGuidance(agentType)) || typeof agent.sendGuidance !== "function") {
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
        const nextAgent = await this.createAgentBackend(target.agentType, target.sessionId);
        if (this.window) nextAgent.setWindow(this.window);
        await this.initAgentBackend(nextAgent, target.projectPath, target.sessionFilePath);
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
      this.sessionAgents.set(target.sessionId, nextAgent);
      this.sessionAgentTypes.set(target.sessionId, target.agentType);
      if (nextSessionFilePath) {
        this.sessionFilePaths.set(target.sessionId, nextSessionFilePath);
      } else {
        this.sessionFilePaths.delete(target.sessionId);
      }
      target.agent.dispose();
    }

    const reloadedSessionIds = targets.map((target) => target.sessionId);
    const modelSessionId =
      this.activeSessionId && reloadedSessionIds.includes(this.activeSessionId)
        ? this.activeSessionId
        : reloadedSessionIds[0];
    const models = modelSessionId ? await this.getModelsBySessionId(modelSessionId) : [];

    return { success: true, models, reloadedSessionIds };
  }

  hasAgentSessions(agentId: string): boolean {
    return Array.from(this.sessionAgentTypes.values()).includes(agentId);
  }

  hasBusyAgentSessions(agentId: string): boolean {
    for (const [sessionId, agent] of this.sessionAgents.entries()) {
      if (this.sessionAgentTypes.get(sessionId) === agentId && !agent.isIdle()) return true;
    }
    return false;
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
  ipcMain.handle("agent:update", async (_event, agentId: string) => {
    if (agentManager.hasAgentSessions(agentId)) {
      return {
        success: false,
        error: "该 Agent 仍有已打开会话，请先关闭相关会话后再更新。",
        status: await agentRegistry.getStatus(agentId),
      };
    }
    return agentRegistry.updateAgent(agentId);
  });

  ipcMain.handle("agentPlugin:choosePath", async (event, kind?: "zip" | "directory") => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win || undefined, {
      properties: kind === "directory" ? ["openDirectory"] : ["openFile"],
      filters: kind === "directory"
        ? undefined
        : [
            { name: "Agent plugin ZIP", extensions: ["zip"] },
            { name: "All files", extensions: ["*"] },
          ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: "" };
    }
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle("agentPlugin:installFromPath", async (_event, pluginPath: string) => {
    return agentRegistry.installFromPath(pluginPath, {
      canReplace: (agentId) => !agentManager.hasAgentSessions(agentId),
    });
  });

  ipcMain.handle("agentPlugin:listOfficial", async () => {
    return listOfficialAgentPlugins();
  });

  ipcMain.handle("agentPlugin:installOfficial", async (_event, agentId: string) => {
    const catalog = await listOfficialAgentPlugins();
    if (!catalog.success) {
      return {
        success: false,
        error: catalog.error || "无法获取官方插件列表。",
        agents: await agentRegistry.listAgents(),
      };
    }

    const plugin = catalog.plugins.find((candidate) => candidate.id === agentId);
    if (!plugin) {
      return {
        success: false,
        error: `官方插件列表中不存在 ${agentId}。`,
        agents: await agentRegistry.listAgents(),
      };
    }

    if (agentManager.hasAgentSessions(agentId)) {
      return {
        success: false,
        error: "该 Agent 仍有已打开会话，请先关闭相关会话后再安装或更新插件。",
        agents: await agentRegistry.listAgents(),
      };
    }

    let zipPath = "";
    try {
      zipPath = await downloadOfficialPluginZip(
        plugin,
        join(app.getPath("temp"), "hpp-agent-plugin-downloads")
      );
      return await agentRegistry.installFromPath(zipPath, {
        expectedAgentId: plugin.id,
        canReplace: (candidateAgentId) => !agentManager.hasAgentSessions(candidateAgentId),
      });
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
        agents: await agentRegistry.listAgents(),
      };
    } finally {
      if (zipPath) {
        await rm(zipPath, { force: true }).catch(() => undefined);
      }
    }
  });

  ipcMain.handle("agentPlugin:remove", async (_event, agentId: string, removeRuntime = false) => {
    if (agentManager.hasAgentSessions(agentId)) {
      return {
        success: false,
        error: "该 Agent 仍有已打开会话，请先关闭相关会话后再卸载插件。",
        agents: await agentRegistry.listAgents(),
      };
    }
    return agentRegistry.removePlugin(agentId, removeRuntime);
  });

  ipcMain.handle("agentPlugin:reload", async () => {
    try {
      return { success: true, agents: await agentRegistry.reload() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error), agents: await agentRegistry.listAgents() };
    }
  });

  ipcMain.handle("agent:createSession", async (_event, agentId: string, projectPath: string, sessionId?: string, sessionFilePath?: string) => {
    const sid = sessionId || "default";
    try {
      const win = getWindow();
      if (win) agentManager.setWindow(win);
      await agentManager.createSession(sid, agentId, projectPath, sessionFilePath);
      const models = await agentManager.getModelsBySessionId(sid);
      return { success: true, sessionFilePath: agentManager.getSessionFilePath(sid), models };
    } catch (err: unknown) {
      return { success: false, error: getErrorMessage(err) };
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

  ipcMain.handle("agent:sendMessage", async (_event, message: string, images?: AgentImagePayload, sessionId?: string, options?: AgentSendOptions) => {
    const agent = sessionId ? agentManager.getAgentBySessionId(sessionId) : agentManager.getActiveAgent();
    if (!agent) return { success: false, error: "No active agent" };
    try {
      const agentType = sessionId ? agentManager.getSessionAgentType(sessionId) : agentManager.getActiveAgentType();
      const planModeEnabled = !!options?.planModeEnabled;
      const permissionMode: AgentSendOptions["permissionMode"] = planModeEnabled ? "plan" : "full-access";
      const nativePlanMode = await supportsNativePlanMode(agentType);
      const effectiveMessage = planModeEnabled && !nativePlanMode
        ? withPromptPlanMode(message)
        : message;
      await agent.sendMessage(effectiveMessage, images, {
        planModeEnabled: planModeEnabled && nativePlanMode,
        permissionMode,
        displayMessage: message,
        clientMessageId: options?.clientMessageId,
      });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: getErrorMessage(err) };
    }
  });

  ipcMain.handle("agent:forkSession", async (_event, sessionId: string, target: AgentForkTarget) => {
    try {
      return await agentManager.forkSession(sessionId, target);
    } catch (err: unknown) {
      return { supported: true, success: false, error: getErrorMessage(err) };
    }
  });

  ipcMain.handle("agent:reloadConfig", async (_event, agentId: string, sessionId?: string) => {
    try {
      return await agentManager.reloadConfig(agentId, sessionId);
    } catch (err: unknown) {
      return { success: false, error: getErrorMessage(err), reloadedSessionIds: [] };
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
    if (await usesSingleActiveProvider(agentId)) {
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
    } catch (err: unknown) {
      return { success: false, error: getErrorMessage(err), config: saveResult.config, reloadedSessionIds: [] };
    }
  });

  ipcMain.handle("agentConfig:delete", async (_event, agentId: string, providerId: string) => {
    const deleteResult = await deleteAgentProviderConfig(agentId, providerId);
    if (!deleteResult.success || !deleteResult.config) {
      return deleteResult;
    }
    if (await usesSingleActiveProvider(agentId)) {
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
    } catch (err: unknown) {
      return { success: false, error: getErrorMessage(err), config: deleteResult.config, reloadedSessionIds: [] };
    }
  });

  ipcMain.handle("agentConfig:reorder", async (_event, agentId: string, providerIds: unknown) => {
    const reorderResult = await reorderAgentProviderConfigs(agentId, providerIds);
    if (!reorderResult.success || !reorderResult.config) {
      return reorderResult;
    }
    if (await usesSingleActiveProvider(agentId)) {
      const models = await mergeModelsWithConfiguredAgentModels(agentId, []);
      return { ...reorderResult, models };
    }

    const idleCheck = agentManager.canReloadConfig(agentId);
    if (!idleCheck.success) {
      const models = await mergeModelsWithConfiguredAgentModels(agentId, []);
      return {
        ...reorderResult,
        models,
        error: `渠道顺序已保存到本地配置，${idleCheck.error || "当前 Agent 会话不是空闲状态，暂未重载。"}`,
        reloadedSessionIds: [],
      };
    }

    try {
      resetLocalModelsConfigCache();
      const reloadResult = await agentManager.reloadConfig(agentId);
      return { ...reloadResult, config: reorderResult.config };
    } catch (err: unknown) {
      return { success: false, error: getErrorMessage(err), config: reorderResult.config, reloadedSessionIds: [] };
    }
  });

  ipcMain.handle("agentConfig:activate", async (_event, agentId: string, providerId: string) => {
    const idleCheck = agentManager.canReloadConfig(agentId);
    if (!idleCheck.success) return idleCheck;

    let snapshots: Awaited<ReturnType<typeof activateAgentProviderConfig>>["snapshots"] = [];
    try {
      const activation = await activateAgentProviderConfig(agentId, providerId);
      snapshots = activation.snapshots;
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
    } catch (err: unknown) {
      if (snapshots.length > 0) {
        await restoreNativeConfigSnapshots(snapshots).catch(() => undefined);
        resetLocalModelsConfigCache();
      }
      return { success: false, error: getErrorMessage(err), reloadedSessionIds: [] };
    }
  });

  ipcMain.handle("agent:sendGuidance", async (_event, message: string, images?: AgentImagePayload, sessionId?: string, options?: AgentSendOptions) => {
    try {
      await agentManager.sendGuidance(sessionId, message, images, options);
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: getErrorMessage(err) };
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
    try {
      const agent = agentManager.getAgentForSession(sessionId);
      if (!agent) return { success: false, error: "No active agent" };
      const agentType = sessionId
        ? agentManager.getSessionAgentType(sessionId)
        : agentManager.getActiveAgentType();
      await agent.setModel(agentType === "codex" ? "codex" : provider, modelId);
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: getErrorMessage(err) };
    }
  });

  ipcMain.handle("agent:setThinkingLevel", async (_event, level: string, sessionId?: string) => {
    const agent = agentManager.getAgentForSession(sessionId);
    if (!agent) return { success: false };
    await agent.setThinkingLevel(level);
    return { success: true };
  });

  ipcMain.handle("agent:sendUIResponse", async (_event, response: AgentUIResponse) => {
    agentManager.sendUIResponse(response);
    return { success: true };
  });
}
