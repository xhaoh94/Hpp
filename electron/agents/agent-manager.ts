import { ipcMain, BrowserWindow, dialog, app } from "electron";
import { rm } from "fs/promises";
import { join } from "path";
import { getAgentPluginRegistry } from "./agent-plugin-registry";
import {
  downloadOfficialPluginZip,
  listOfficialAgentPlugins,
} from "./official-agent-plugins";
import type {
  AgentImagePayload,
  AgentActionCatalogEntry,
  AgentActionListOptions,
  AgentUIResponse,
} from "../../src/types/ipc";
import {
  activateAgentProviderConfig,
  copyAgentProviderConfig,
  deleteAgentProviderConfig,
  getAgentConfigStateForBackend,
  getAgentModelVisibility,
  getConfiguredAgentModels,
  listAgentConfig,
  reorderAgentProviderConfigs,
  restoreNativeConfigSnapshots,
  saveAgentProviderConfig,
  setAgentBackendModelsVisible,
  setActiveAgentProviderConfig,
  shouldShowAgentBackendModels,
} from "./agent-config";
import { fetchProviderModels } from "./agent-model-fetch";
import { combineAgentModels } from "./agent-model-list";
import { agentRuntimeOperationQueue } from "./agent-runtime-operation-queue";
import type {
  AgentBackend,
  AgentForkResult,
  AgentForkTarget,
  AgentModel,
  AgentSendOptions,
} from "./agent-backend";
import { getErrorMessage } from "../utils/unknown-value";

interface AgentReloadConfigResult {
  success: boolean;
  error?: string;
  models?: AgentModel[];
  reloadedSessionIds?: string[];
}

const AGENT_SESSION_INIT_TIMEOUT_MS = 90_000;
const agentRegistry = getAgentPluginRegistry();

async function mergeModelsWithConfiguredAgentModels(agentId: string | undefined, models: AgentModel[]): Promise<AgentModel[]> {
  if (!agentId) return models;
  const capabilities = await agentRegistry.getCapabilities(agentId);
  if (capabilities.configuration === "none") return models;
  const configuredModels = await getConfiguredAgentModels(agentId).catch(() => []);
  const backendModelsVisible = await shouldShowAgentBackendModels(agentId);
  return combineAgentModels(
    models,
    configuredModels,
    capabilities.configuration.modelListMode,
    backendModelsVisible,
  );
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
// Agent Manager - manages plugin backends per session.
// ============================================================
export class AgentManager {
  private sessionAgents = new Map<string, AgentBackend>();
  private sessionAgentTypes = new Map<string, string>();
  private sessionFilePaths = new Map<string, string>();
  private sessionProjectPaths = new Map<string, string>();
  private runtimeUpdatingAgentIds = new Set<string>();
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
    if (this.runtimeUpdatingAgentIds.has(agentId)) {
      throw new Error(`${agentId} CLI 正在更新，请等待更新完成。`);
    }
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
    return this.getAgentBySessionId(this.activeSessionId);
  }
  getAgentBySessionId(sessionId: string): AgentBackend | null {
    const agentId = this.sessionAgentTypes.get(sessionId);
    if (agentId && this.runtimeUpdatingAgentIds.has(agentId)) return null;
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
    return mergeModelsWithConfiguredAgentModels(agentType, models);
  }

  async listActions(sessionId?: string, options?: AgentActionListOptions): Promise<AgentActionCatalogEntry[]> {
    const agent = this.getAgentForSession(sessionId);
    if (!agent) return [];
    return agent.listActions(options);
  }

  async getModelsByAgentId(agentId: string): Promise<AgentModel[]> {
    const preferredSessionId = this.activeSessionId && this.sessionAgentTypes.get(this.activeSessionId) === agentId
      ? this.activeSessionId
      : Array.from(this.sessionAgentTypes.entries()).find(([, type]) => type === agentId)?.[0];
    return preferredSessionId
      ? this.getModelsBySessionId(preferredSessionId)
      : mergeModelsWithConfiguredAgentModels(agentId, []);
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

  isAgentRuntimeUpdating(agentId?: string): boolean {
    return !!agentId && this.runtimeUpdatingAgentIds.has(agentId);
  }

  async suspendAgentSessionsForRuntimeUpdate(agentId: string): Promise<{
    success: boolean;
    sessionCount: number;
    error?: string;
  }> {
    if (this.runtimeUpdatingAgentIds.has(agentId)) {
      return { success: false, sessionCount: 0, error: "该 Agent CLI 已在更新中。" };
    }

    const targets = Array.from(this.sessionAgents.entries())
      .filter(([sessionId]) => this.sessionAgentTypes.get(sessionId) === agentId);
    const busySession = targets.find(([, agent]) => !agent.isIdle());
    if (busySession) {
      return {
        success: false,
        sessionCount: targets.length,
        error: "该 Agent 仍有会话正在运行，请等待任务结束后再更新。",
      };
    }
    this.runtimeUpdatingAgentIds.add(agentId);
    if (targets.length === 0) {
      return { success: true, sessionCount: 0 };
    }
    const results = await Promise.allSettled(
      targets.map(([, agent]) => Promise.resolve(agent.dispose()))
    );
    const failure = results.find((result) => result.status === "rejected");
    if (!failure || failure.status !== "rejected") {
      return { success: true, sessionCount: targets.length };
    }

    let recoveryError = "";
    try {
      const recovery = await this.resumeAgentSessionsAfterRuntimeUpdate(agentId);
      if (!recovery.success) recoveryError = recovery.error || "会话恢复失败";
    } catch (error) {
      recoveryError = getErrorMessage(error);
    }
    const detail = getErrorMessage(failure.reason);
    return {
      success: false,
      sessionCount: targets.length,
      error: recoveryError
        ? `无法暂停 Agent 空闲会话：${detail}；恢复会话失败：${recoveryError}`
        : `无法暂停 Agent 空闲会话：${detail}`,
    };
  }

  async resumeAgentSessionsAfterRuntimeUpdate(agentId: string): Promise<AgentReloadConfigResult> {
    if (!this.runtimeUpdatingAgentIds.has(agentId)) {
      return { success: true, reloadedSessionIds: [] };
    }
    try {
      return await this.reloadConfig(agentId);
    } finally {
      this.runtimeUpdatingAgentIds.delete(agentId);
    }
  }

  async removeSession(sessionId: string) {
    const agent = this.sessionAgents.get(sessionId);
    if (agent) {
      this.sessionAgents.delete(sessionId);
      await Promise.resolve(agent.dispose());
    }
    this.sessionAgentTypes.delete(sessionId);
    this.sessionFilePaths.delete(sessionId);
    this.sessionProjectPaths.delete(sessionId);
    if (this.activeSessionId === sessionId) this.activeSessionId = null;
  }

  async shutdown(): Promise<void> {
    const agents = Array.from(this.sessionAgents.values());
    this.sessionAgents.clear();
    this.sessionAgentTypes.clear();
    this.sessionFilePaths.clear();
    this.sessionProjectPaths.clear();
    this.activeSessionId = null;
    await Promise.allSettled(agents.map((agent) => Promise.resolve(agent.dispose())));
  }
}

const agentManager = new AgentManager();

async function activateProviderAndReload(agentId: string, providerId: string) {
  const idleCheck = agentManager.canReloadConfig(agentId);
  if (!idleCheck.success) return idleCheck;

  let snapshots: Awaited<ReturnType<typeof activateAgentProviderConfig>>["snapshots"] = [];
  try {
    const activation = await activateAgentProviderConfig(agentId, providerId);
    snapshots = activation.snapshots;
    const reloadResult = await agentManager.reloadConfig(agentId);
    if (!reloadResult.success) {
      await restoreNativeConfigSnapshots(snapshots);
      return reloadResult;
    }

    const config = await setActiveAgentProviderConfig(agentId, providerId);
    const models = await mergeModelsWithConfiguredAgentModels(agentId, reloadResult.models || []);
    return { ...reloadResult, models, config };
  } catch (error: unknown) {
    if (snapshots.length > 0) {
      await restoreNativeConfigSnapshots(snapshots).catch(() => undefined);
    }
    return { success: false, error: getErrorMessage(error), reloadedSessionIds: [] };
  }
}

export async function shutdownAgentRuntime(): Promise<void> {
  await agentManager.shutdown();
  await agentRegistry.shutdown(true);
}

// ============================================================
// IPC handlers
// ============================================================
export function registerAgentHandlers(getWindow: () => BrowserWindow | null) {
  ipcMain.handle("agent:update", async (_event, agentId: string) => {
    return agentRuntimeOperationQueue.run(agentId, "update", async () => {
      const suspension = await agentManager.suspendAgentSessionsForRuntimeUpdate(agentId);
      if (!suspension.success) {
        return {
          success: false,
          error: suspension.error,
          status: await agentRegistry.getStatus(agentId),
        };
      }

      let updateResult: Awaited<ReturnType<typeof agentRegistry.updateAgent>> | undefined;
      let updateError = "";
      try {
        updateResult = await agentRegistry.updateAgent(agentId);
      } catch (error) {
        updateError = getErrorMessage(error);
      }

      let resumeError = "";
      try {
        const resumeResult = await agentManager.resumeAgentSessionsAfterRuntimeUpdate(agentId);
        if (!resumeResult.success) resumeError = resumeResult.error || "会话恢复失败";
      } catch (error) {
        resumeError = getErrorMessage(error);
      }

      if (resumeError) {
        const prefix = updateResult?.success
          ? "CLI 已更新，但空闲会话自动恢复失败"
          : updateError || updateResult?.error || "CLI 更新失败";
        return {
          success: false,
          error: `${prefix}：${resumeError}。请重载会话或重启 Hpp。`,
          status: updateResult?.status || await agentRegistry.getStatus(agentId),
        };
      }
      if (updateError) {
        return {
          success: false,
          error: updateError,
          status: await agentRegistry.getStatus(agentId),
        };
      }
      return updateResult!;
    });
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
    return listOfficialAgentPlugins(app.getVersion());
  });

  ipcMain.handle("agentPlugin:installOfficial", async (_event, agentId: string) => {
    const catalog = await listOfficialAgentPlugins(app.getVersion());
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

    if (!plugin.compatible) {
      return {
        success: false,
        error: plugin.compatibilityError || `${plugin.name} 与当前 Hpp 版本不兼容。`,
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
    return agentRuntimeOperationQueue.run(agentId, "uninstall", async () => {
      if (agentManager.hasAgentSessions(agentId)) {
        return {
          success: false,
          error: "该 Agent 仍有已打开会话，请先关闭相关会话后再卸载插件。",
          agents: await agentRegistry.listAgents(),
        };
      }
      return agentRegistry.removePlugin(agentId, removeRuntime);
    });
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
    const agentId = agentManager.getSessionAgentType(sessionId);
    if (!agentId) {
      await agentManager.removeSession(sessionId);
      return { success: true };
    }
    return agentRuntimeOperationQueue.run(agentId, "session-dispose", async () => {
      await agentManager.removeSession(sessionId);
      return { success: true };
    });
  });

  ipcMain.handle("agent:getSessionState", (_event, sessionId: string) => {
    const agent = agentManager.getAgentBySessionId(sessionId);
    if (!agent) return { success: false, idle: true, error: "No active agent" };
    return { success: true, idle: agent.isIdle() };
  });

  ipcMain.handle("agent:sendMessage", async (_event, message: string, images?: AgentImagePayload, sessionId?: string, options?: AgentSendOptions) => {
    try {
      const agentType = sessionId ? agentManager.getSessionAgentType(sessionId) : agentManager.getActiveAgentType();
      if (agentManager.isAgentRuntimeUpdating(agentType)) {
        return { success: false, error: "该 Agent CLI 正在更新，请等待更新完成。" };
      }
      const agent = sessionId ? agentManager.getAgentBySessionId(sessionId) : agentManager.getActiveAgent();
      if (!agent) return { success: false, error: "No active agent" };
      const planModeEnabled = !!options?.planModeEnabled;
      const permissionMode: AgentSendOptions["permissionMode"] = planModeEnabled ? "plan" : "full-access";
      const nativePlanMode = await supportsNativePlanMode(agentType);
      if (agentManager.isAgentRuntimeUpdating(agentType)) {
        return { success: false, error: "该 Agent CLI 正在更新，请等待更新完成。" };
      }
      const effectiveMessage = planModeEnabled && !nativePlanMode
        ? withPromptPlanMode(message)
        : message;
      await agent.sendMessage(effectiveMessage, images, {
        planModeEnabled: planModeEnabled && nativePlanMode,
        permissionMode,
        displayMessage: message,
        clientMessageId: options?.clientMessageId,
        action: options?.action,
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

  ipcMain.handle("agentConfig:getModelVisibility", async (_event, agentId: string) => {
    return getAgentModelVisibility(agentId);
  });

  ipcMain.handle("agentConfig:setBackendModelsVisible", async (_event, agentId: string, visible: boolean) => {
    const result = await setAgentBackendModelsVisible(agentId, visible);
    if (!result.success) return result;
    return {
      ...result,
      models: await agentManager.getModelsByAgentId(agentId),
    };
  });

  ipcMain.handle("agentConfig:fetchModels", async (
    _event,
    baseUrl: string,
    apiKey: string,
    endpoint?: string,
    authMode?: "bearer" | "x-api-key",
  ) => {
    try {
      const models = await fetchProviderModels(baseUrl, apiKey, endpoint, authMode);
      return { success: true, models };
    } catch (error: unknown) {
      return { success: false, error: getErrorMessage(error), models: [] };
    }
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
      const reloadResult = await agentManager.reloadConfig(agentId);
      return { ...reloadResult, config: saveResult.config };
    } catch (err: unknown) {
      return { success: false, error: getErrorMessage(err), config: saveResult.config, reloadedSessionIds: [] };
    }
  });

  ipcMain.handle("agentConfig:copy", async (
    _event,
    sourceAgentId: string,
    sourceProviderId: string,
    targetAgentId: string,
  ) => {
    const copyResult = await copyAgentProviderConfig(sourceAgentId, sourceProviderId, targetAgentId);
    if (!copyResult.success || !copyResult.config) return copyResult;
    if (await usesSingleActiveProvider(targetAgentId)) {
      const models = await mergeModelsWithConfiguredAgentModels(targetAgentId, []);
      return { ...copyResult, models };
    }

    const idleCheck = agentManager.canReloadConfig(targetAgentId);
    if (!idleCheck.success) {
      const models = await mergeModelsWithConfiguredAgentModels(targetAgentId, []);
      return {
        ...copyResult,
        models,
        error: `渠道已复制，但${idleCheck.error || "目标 Agent 会话当前不为空闲状态，暂未重载。"}`,
        reloadedSessionIds: [],
      };
    }

    try {
      const reloadResult = await agentManager.reloadConfig(targetAgentId);
      return { ...copyResult, ...reloadResult, config: copyResult.config };
    } catch (error: unknown) {
      const models = await mergeModelsWithConfiguredAgentModels(targetAgentId, []);
      return {
        ...copyResult,
        models,
        error: `渠道已复制，但目标 Agent 重载失败：${getErrorMessage(error)}`,
        reloadedSessionIds: [],
      };
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
      const reloadResult = await agentManager.reloadConfig(agentId);
      if (!reloadResult.success) {
        const models = await mergeModelsWithConfiguredAgentModels(agentId, []);
        return {
          ...deleteResult,
          models,
          error: `渠道已从本地配置删除；${reloadResult.error || "Agent 重载失败。"}`,
          reloadedSessionIds: [],
        };
      }
      return { ...reloadResult, config: deleteResult.config };
    } catch (err: unknown) {
      const models = await mergeModelsWithConfiguredAgentModels(agentId, []).catch(() => []);
      return {
        ...deleteResult,
        models,
        error: `渠道已从本地配置删除；Agent 重载失败：${getErrorMessage(err)}`,
        reloadedSessionIds: [],
      };
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
      const reloadResult = await agentManager.reloadConfig(agentId);
      return { ...reloadResult, config: reorderResult.config };
    } catch (err: unknown) {
      return { success: false, error: getErrorMessage(err), config: reorderResult.config, reloadedSessionIds: [] };
    }
  });

  ipcMain.handle("agentConfig:activate", async (_event, agentId: string, providerId: string) => {
    return activateProviderAndReload(agentId, providerId);
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
    return mergeModelsWithConfiguredAgentModels(agentType, models);
  });

  ipcMain.handle("agent:listActions", async (_event, sessionId?: string, options?: AgentActionListOptions) => {
    try {
      return await agentManager.listActions(sessionId, options);
    } catch (err: unknown) {
      console.error("[agent-manager] listActions failed:", getErrorMessage(err));
      return [];
    }
  });

  ipcMain.handle("agent:setModel", async (_event, provider: string, modelId: string, sessionId?: string) => {
    try {
      const agentType = sessionId ? agentManager.getSessionAgentType(sessionId) : agentManager.getActiveAgentType();
      if (agentType) {
        const capabilities = await agentRegistry.getCapabilities(agentType);
        if (capabilities.configuration !== "none" && capabilities.configuration.modelListMode === "configured") {
          const configuredModels = await getConfiguredAgentModels(agentType);
          if (
            configuredModels.length > 0 &&
            !configuredModels.some((model) => model.provider === provider && model.id === modelId)
          ) {
            return { success: false, error: "所选模型不属于已配置渠道，请刷新模型列表后重试。" };
          }

          if (capabilities.providerActivation === "single-active" && configuredModels.length > 0) {
            const configState = await getAgentConfigStateForBackend(agentType);
            if (configState.activeProviderId !== provider) {
              const activationResult = await activateProviderAndReload(agentType, provider);
              if (!activationResult.success) return activationResult;
            }
          }
        }
      }
      const agent = agentManager.getAgentForSession(sessionId);
      if (!agent) return { success: false, error: "No active agent" };
      await agent.setModel(provider, modelId);
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
