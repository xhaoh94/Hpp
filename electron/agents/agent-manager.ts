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
import {
  HPP_AGENT_SYSTEM_PROMPT,
  withHppPlanModePrompt,
} from "./agent-runtime-policy";
import { normalizeAgentPermissionMode } from "../../shared/agent-permissions";
import type {
  AgentBackend,
  AgentForkResult,
  AgentForkTarget,
  AgentModel,
  AgentSendOptions,
} from "./agent-backend";
import { getErrorMessage } from "../utils/unknown-value";
import {
  clearAllPendingUIEvents,
  clearPendingUIEvents,
  clearPendingUIResponse,
  getPendingUIEventSnapshot,
  hasPendingUIEvents,
  type PendingUIEventSnapshot,
} from "./pending-ui-events";

interface AgentReloadConfigResult {
  success: boolean;
  error?: string;
  models?: AgentModel[];
  reloadedSessionIds?: string[];
  detachedSessionIds?: string[];
}

interface SuspendedPluginSessions {
  activeSessionId: string | null;
  targets: Array<{
    sessionId: string;
    agentType: string;
    projectPath: string;
    sessionFilePath?: string;
  }>;
}

const AGENT_SESSION_INIT_TIMEOUT_MS = 90_000;
const AGENT_SESSION_STATE_REFRESH_TIMEOUT_MS = 3_000;
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
  return withHppPlanModePrompt(message);
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
  private pluginMutatingAgentIds = new Set<string>();
  private suspendedPluginSessions = new Map<string, SuspendedPluginSessions>();
  private initializingSessionAgentTypes = new Map<string, string>();
  private disposingSessionIds = new Set<string>();
  private pluginCatalogMutating = false;
  private activeSessionId: string | null = null;
  private window: BrowserWindow | null = null;

  setWindow(win: BrowserWindow) { this.window = win; }

  private publishPendingUIRevision(sessionId: string, revision: number) {
    this.window?.webContents.send("agent:event", {
      type: "pending_ui_cache_revision",
      sessionId,
      pendingUIRevision: revision,
    });
  }

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
      agent.init(projectPath, existingSessionFilePath, {
        hostSystemPrompt: HPP_AGENT_SYSTEM_PROMPT,
      }),
      AGENT_SESSION_INIT_TIMEOUT_MS,
      "Agent 会话初始化超时，请检查 Agent 是否已安装、可启动，或稍后重试。"
    );
  }

  /** Create or resume a session */
  async createSession(
    sessionId: string, agentId: string, projectPath: string,
    existingSessionFilePath?: string
  ): Promise<void> {
    if (this.pluginCatalogMutating) {
      throw new Error("Agent 插件正在安装或刷新，请等待操作完成。");
    }
    if (this.runtimeUpdatingAgentIds.has(agentId)) {
      throw new Error(`${agentId} CLI 正在更新，请等待更新完成。`);
    }
    if (this.pluginMutatingAgentIds.has(agentId)) {
      throw new Error(`${agentId} 正在卸载，请等待操作完成。`);
    }
    if (this.disposingSessionIds.has(sessionId)) {
      throw new Error("Agent 会话正在关闭，请稍后重试。");
    }
    if (this.initializingSessionAgentTypes.has(sessionId)) {
      throw new Error("Agent 会话正在初始化，请稍后重试。");
    }
    this.initializingSessionAgentTypes.set(sessionId, agentId);
    try {
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
          await Promise.resolve().then(() => agent.dispose()).catch(() => undefined);
          this.sessionAgents.delete(sessionId);
          this.sessionAgentTypes.delete(sessionId);
          this.sessionFilePaths.delete(sessionId);
          this.sessionProjectPaths.delete(sessionId);
        }
        clearPendingUIEvents(sessionId);
        if (this.activeSessionId === sessionId) this.activeSessionId = null;
        const message = getErrorMessage(error);
        const status = await agentRegistry.getStatus(agentId).catch(() => undefined);
        if (status?.canRollback && status.rollbackVersion) {
          throw new Error(`${message}\n可在 Agent 设置中一键回退到 v${status.rollbackVersion}。`);
        }
        throw error;
      }

      const fp = agent.sessionFilePath;
      console.log("[agent-manager] After init, sessionFilePath:", fp);
      if (fp) this.sessionFilePaths.set(sessionId, fp);

      this.activeSessionId = sessionId;
    } finally {
      if (this.initializingSessionAgentTypes.get(sessionId) === agentId) {
        this.initializingSessionAgentTypes.delete(sessionId);
      }
    }
  }

  getSessionFilePath(sessionId: string): string | undefined {
    return this.sessionFilePaths.get(sessionId);
  }

  getSessionAgentType(sessionId: string): string | undefined {
    const activeType = this.sessionAgentTypes.get(sessionId);
    if (activeType) return activeType;
    const initializingType = this.initializingSessionAgentTypes.get(sessionId);
    if (initializingType) return initializingType;
    for (const suspended of this.suspendedPluginSessions.values()) {
      const target = suspended.targets.find((candidate) => candidate.sessionId === sessionId);
      if (target) return target.agentType;
    }
    return undefined;
  }

  switchSession(sessionId: string) {
    if (this.sessionAgents.has(sessionId) && !this.disposingSessionIds.has(sessionId)) {
      this.activeSessionId = sessionId;
    }
  }

  getActiveAgent(): AgentBackend | null {
    if (!this.activeSessionId) return null;
    return this.getAgentBySessionId(this.activeSessionId);
  }
  getAgentBySessionId(sessionId: string): AgentBackend | null {
    if (
      this.disposingSessionIds.has(sessionId)
      || this.initializingSessionAgentTypes.has(sessionId)
    ) return null;
    const agentId = this.getSessionAgentType(sessionId);
    if (this.isAgentRuntimeUnavailable(agentId)) return null;
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

  async sendUIResponse(response: AgentUIResponse): Promise<number | undefined> {
    const sessionId = typeof response.sessionId === "string" ? response.sessionId : undefined;
    const targetSessionId = sessionId || this.activeSessionId || undefined;
    const agent = targetSessionId
      ? this.getAgentBySessionId(targetSessionId)
      : this.getActiveAgent();
    if (!agent) throw new Error("No active agent");
    await agent.sendUIResponse(response);
    if (!targetSessionId) return undefined;
    const revision = clearPendingUIResponse(targetSessionId, response);
    this.publishPendingUIRevision(targetSessionId, revision);
    return revision;
  }

  getPendingUIRequests(sessionId: string): PendingUIEventSnapshot {
    if (!this.getAgentBySessionId(sessionId)) return { revision: 0, requests: [] };
    return getPendingUIEventSnapshot(sessionId);
  }

  async abort(sessionId?: string): Promise<void> {
    const targetSessionId = sessionId || this.activeSessionId || undefined;
    const agent = targetSessionId
      ? this.getAgentBySessionId(targetSessionId)
      : this.getActiveAgent();
    if (!agent) throw new Error("No active agent");
    await agent.abort();
    if (targetSessionId) {
      const revision = clearPendingUIEvents(targetSessionId);
      this.publishPendingUIRevision(targetSessionId, revision);
    }
  }

  async sendGuidance(sessionId: string | undefined, message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void> {
    const agent = sessionId ? this.getAgentBySessionId(sessionId) : this.getActiveAgent();
    if (!agent) throw new Error("No active agent");
    const agentType = sessionId ? this.getSessionAgentType(sessionId) : this.getActiveAgentType();
    if (!(await supportsGuidance(agentType)) || typeof agent.sendGuidance !== "function") {
      throw new Error("Guidance is not supported by this agent");
    }
    await agent.sendGuidance(message, images, {
      ...options,
      displayMessage: options?.displayMessage || message,
      hostSystemPrompt: HPP_AGENT_SYSTEM_PROMPT,
    });
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
        const initializedTarget = {
          target,
          nextAgent,
          nextSessionFilePath: target.sessionFilePath,
        };
        // Track the backend before init so a partially initialized instance is
        // still disposed if init rejects after registering event listeners.
        initializedTargets.push(initializedTarget);
        await this.initAgentBackend(nextAgent, target.projectPath, target.sessionFilePath);
        initializedTarget.nextSessionFilePath = nextAgent.sessionFilePath || target.sessionFilePath;
      }
    } catch (error) {
      await Promise.allSettled(initializedTargets.map(({ nextAgent }) => (
        Promise.resolve().then(() => nextAgent.dispose())
      )));
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
    }

    // The replacement is already initialized and authoritative. Quiesce all
    // old listeners before returning, but do not roll back a healthy
    // replacement merely because teardown of its predecessor reports an
    // error. Promise.resolve().then also captures synchronous dispose throws.
    await Promise.allSettled(initializedTargets.map(({ target }) => (
      Promise.resolve().then(() => target.agent.dispose())
    )));

    const reloadedSessionIds = targets.map((target) => target.sessionId);
    const modelSessionId =
      this.activeSessionId && reloadedSessionIds.includes(this.activeSessionId)
        ? this.activeSessionId
        : reloadedSessionIds[0];
    const models = modelSessionId ? await this.getModelsBySessionId(modelSessionId) : [];

    return { success: true, models, reloadedSessionIds };
  }

  hasAgentSessions(agentId: string): boolean {
    return (
      Array.from(this.sessionAgentTypes.values()).includes(agentId)
      || Array.from(this.initializingSessionAgentTypes.values()).includes(agentId)
      || Array.from(this.suspendedPluginSessions.values()).some((suspended) => (
        suspended.targets.some((target) => target.agentType === agentId)
      ))
    );
  }

  hasBusyAgentSessions(agentId: string): boolean {
    if (Array.from(this.initializingSessionAgentTypes.values()).includes(agentId)) return true;
    for (const [sessionId, agent] of this.sessionAgents.entries()) {
      if (this.sessionAgentTypes.get(sessionId) === agentId && !agent.isIdle()) return true;
    }
    return false;
  }

  hasAnyAgentSessions(): boolean {
    return (
      this.sessionAgents.size > 0
      || this.initializingSessionAgentTypes.size > 0
      || Array.from(this.suspendedPluginSessions.values()).some((suspended) => (
        suspended.targets.length > 0
      ))
    );
  }

  beginPluginCatalogMutation(): void {
    this.pluginCatalogMutating = true;
  }

  finishPluginCatalogMutation(): void {
    this.pluginCatalogMutating = false;
  }

  isAgentRuntimeUpdating(agentId?: string): boolean {
    return !!agentId && this.runtimeUpdatingAgentIds.has(agentId);
  }

  isAgentRuntimeUnavailable(agentId?: string): boolean {
    return !!agentId && (
      this.runtimeUpdatingAgentIds.has(agentId)
      || this.pluginMutatingAgentIds.has(agentId)
    );
  }

  async suspendAgentSessionsForPluginRemoval(
    agentId: string,
    operation: "卸载" | "安装或更新" = "卸载",
  ): Promise<{
    success: boolean;
    sessionCount: number;
    error?: string;
    detachedSessionIds?: string[];
  }> {
    if (this.isAgentRuntimeUnavailable(agentId)) {
      return { success: false, sessionCount: 0, error: "该 Agent 已在更新或卸载中。" };
    }
    if (Array.from(this.initializingSessionAgentTypes.values()).includes(agentId)) {
      return {
        success: false,
        sessionCount: 0,
        error: `该 Agent 仍有会话正在初始化，请等待初始化完成后再${operation}插件。`,
      };
    }

    const targets = Array.from(this.sessionAgents.entries())
      .filter(([sessionId]) => this.sessionAgentTypes.get(sessionId) === agentId);
    if (targets.some(([, agent]) => !agent.isIdle())) {
      return {
        success: false,
        sessionCount: targets.length,
        error: `该 Agent 仍有会话正在运行，请等待任务结束后再${operation}插件。`,
      };
    }

    const suspendedTargets: SuspendedPluginSessions["targets"] = [];
    for (const [sessionId, agent] of targets) {
      const projectPath = this.sessionProjectPaths.get(sessionId);
      if (!projectPath) {
        return {
          success: false,
          sessionCount: targets.length,
          error: `会话 ${sessionId} 缺少项目路径，无法安全${operation}插件。`,
        };
      }
      suspendedTargets.push({
        sessionId,
        agentType: this.sessionAgentTypes.get(sessionId) || agentId,
        projectPath,
        sessionFilePath: agent.sessionFilePath || this.sessionFilePaths.get(sessionId),
      });
    }

    this.pluginMutatingAgentIds.add(agentId);
    const results = await Promise.allSettled(
      targets.map(([, agent]) => Promise.resolve().then(() => agent.dispose()))
    );
    const activeSessionId = this.activeSessionId;
    const disposedTargets = suspendedTargets.filter((_, index) => results[index]?.status === "fulfilled");
    for (const [index, [sessionId, agent]] of targets.entries()) {
      if (results[index]?.status !== "fulfilled" || this.sessionAgents.get(sessionId) !== agent) continue;
      this.sessionAgents.delete(sessionId);
      this.sessionAgentTypes.delete(sessionId);
      this.sessionFilePaths.delete(sessionId);
      this.sessionProjectPaths.delete(sessionId);
      if (this.activeSessionId === sessionId) this.activeSessionId = null;
    }

    const failureIndex = results.findIndex((result) => result.status === "rejected");
    if (failureIndex >= 0) {
      this.suspendedPluginSessions.set(agentId, { activeSessionId, targets: disposedTargets });
      const restoration = await this.finishAgentPluginRemoval(agentId, true);
      const detail = getErrorMessage((results[failureIndex] as PromiseRejectedResult).reason);
      return {
        success: false,
        sessionCount: targets.length,
        error: restoration.success
          ? `无法关闭 Agent 空闲会话：${detail}`
          : `无法关闭 Agent 空闲会话：${detail}；会话恢复失败：${restoration.error || "未知错误"}`,
        detachedSessionIds: restoration.detachedSessionIds,
      };
    }

    this.suspendedPluginSessions.set(agentId, {
      activeSessionId,
      targets: disposedTargets,
    });
    return { success: true, sessionCount: targets.length };
  }

  async finishAgentPluginRemoval(agentId: string, restoreSessions: boolean): Promise<AgentReloadConfigResult> {
    const suspended = this.suspendedPluginSessions.get(agentId);
    try {
      if (!suspended || suspended.targets.length === 0) {
        return { success: true, reloadedSessionIds: [], detachedSessionIds: [] };
      }
      const detachedSessionIds = suspended.targets.map((target) => target.sessionId);
      if (!restoreSessions) {
        return { success: true, reloadedSessionIds: [], detachedSessionIds };
      }

      const restored: Array<{
        target: SuspendedPluginSessions["targets"][number];
        agent: AgentBackend;
      }> = [];
      try {
        for (const target of suspended.targets) {
          const agent = await this.createAgentBackend(target.agentType, target.sessionId);
          restored.push({ target, agent });
          if (this.window) agent.setWindow(this.window);
          await this.initAgentBackend(agent, target.projectPath, target.sessionFilePath);
        }
      } catch (error) {
        await Promise.allSettled(restored.map(({ agent }) => (
          Promise.resolve().then(() => agent.dispose())
        )));
        return {
          success: false,
          error: getErrorMessage(error),
          reloadedSessionIds: [],
          detachedSessionIds,
        };
      }

      for (const { target, agent } of restored) {
        this.sessionAgents.set(target.sessionId, agent);
        this.sessionAgentTypes.set(target.sessionId, target.agentType);
        this.sessionProjectPaths.set(target.sessionId, target.projectPath);
        const sessionFilePath = agent.sessionFilePath || target.sessionFilePath;
        if (sessionFilePath) this.sessionFilePaths.set(target.sessionId, sessionFilePath);
      }
      if (
        suspended.activeSessionId
        && suspended.targets.some((target) => target.sessionId === suspended.activeSessionId)
      ) {
        this.activeSessionId = suspended.activeSessionId;
      }
      return {
        success: true,
        reloadedSessionIds: restored.map(({ target }) => target.sessionId),
        detachedSessionIds: [],
      };
    } finally {
      this.suspendedPluginSessions.delete(agentId);
      this.pluginMutatingAgentIds.delete(agentId);
    }
  }

  async suspendAgentSessionsForRuntimeUpdate(agentId: string): Promise<{
    success: boolean;
    sessionCount: number;
    error?: string;
  }> {
    if (this.runtimeUpdatingAgentIds.has(agentId)) {
      return { success: false, sessionCount: 0, error: "该 Agent CLI 已在更新中。" };
    }
    if (Array.from(this.initializingSessionAgentTypes.values()).includes(agentId)) {
      return {
        success: false,
        sessionCount: 0,
        error: "该 Agent 仍有会话正在初始化，请等待初始化完成后再更新。",
      };
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
      targets.map(([, agent]) => Promise.resolve().then(() => agent.dispose()))
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
    if (this.initializingSessionAgentTypes.has(sessionId)) {
      throw new Error("Agent 会话正在初始化，请稍后关闭。");
    }
    if (this.disposingSessionIds.has(sessionId)) {
      throw new Error("Agent 会话正在关闭，请稍后重试。");
    }
    const agent = this.sessionAgents.get(sessionId);
    this.disposingSessionIds.add(sessionId);
    try {
      if (agent) {
        await Promise.resolve().then(() => agent.dispose());
      }
    } finally {
      clearPendingUIEvents(sessionId);
      this.sessionAgents.delete(sessionId);
      this.sessionAgentTypes.delete(sessionId);
      this.sessionFilePaths.delete(sessionId);
      this.sessionProjectPaths.delete(sessionId);
      if (this.activeSessionId === sessionId) this.activeSessionId = null;
      this.disposingSessionIds.delete(sessionId);
    }
  }

  async shutdown(): Promise<void> {
    const agents = Array.from(this.sessionAgents.values());
    this.sessionAgents.clear();
    this.sessionAgentTypes.clear();
    this.sessionFilePaths.clear();
    this.sessionProjectPaths.clear();
    this.runtimeUpdatingAgentIds.clear();
    this.pluginMutatingAgentIds.clear();
    this.suspendedPluginSessions.clear();
    this.initializingSessionAgentTypes.clear();
    this.disposingSessionIds.clear();
    this.pluginCatalogMutating = false;
    this.activeSessionId = null;
    clearAllPendingUIEvents();
    await Promise.allSettled(agents.map((agent) => Promise.resolve().then(() => agent.dispose())));
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
  const runAgentRuntimeChange = async (
    agentId: string,
    operation: "update" | "rollback",
    versionSpec?: string,
  ) => agentRuntimeOperationQueue.run(agentId, operation, async () => {
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
        updateResult = operation === "rollback"
          ? await agentRegistry.rollbackAgent(agentId)
          : await agentRegistry.updateAgent(agentId, versionSpec);
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

  ipcMain.handle("agent:update", async (_event, agentId: string, versionSpec?: string) =>
    runAgentRuntimeChange(agentId, "update", typeof versionSpec === "string" ? versionSpec : undefined));
  ipcMain.handle("agent:rollback", async (_event, agentId: string) => runAgentRuntimeChange(agentId, "rollback"));
  ipcMain.handle("agent:versions", async (_event, agentId: string) => agentRegistry.getPackageVersions(agentId));

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
    return agentRuntimeOperationQueue.run("local-plugin", "plugin-install", async () => {
      let candidate: Awaited<ReturnType<typeof agentRegistry.inspectInstallCandidate>>;
      try {
        candidate = await agentRegistry.inspectInstallCandidate(pluginPath);
      } catch (error) {
        return {
          success: false,
          error: getErrorMessage(error),
          agents: await agentRegistry.listAgents(),
        };
      }

      const suspension = await agentManager.suspendAgentSessionsForPluginRemoval(candidate.id, "安装或更新");
      if (!suspension.success) {
        return {
          success: false,
          error: suspension.error,
          agents: await agentRegistry.listAgents(),
          detachedSessionIds: suspension.detachedSessionIds,
        };
      }

      let result: Awaited<ReturnType<typeof agentRegistry.installFromPath>>;
      agentManager.beginPluginCatalogMutation();
      try {
        result = await agentRegistry.installFromPath(pluginPath, {
          expectedAgentId: candidate.id,
          canReplace: (agentId) => agentId === candidate.id,
        });
      } catch (error) {
        result = {
          success: false,
          error: getErrorMessage(error),
          agents: await agentRegistry.listAgents(),
        };
      } finally {
        agentManager.finishPluginCatalogMutation();
      }

      const restoration = await agentManager.finishAgentPluginRemoval(candidate.id, true);
      if (!restoration.success) {
        return {
          ...result,
          success: false,
          error: `${result.error || (result.success ? "插件已安装或更新" : "插件安装或更新失败")}；会话恢复失败：${restoration.error || "未知错误"}`,
          detachedSessionIds: restoration.detachedSessionIds,
        };
      }
      return { ...result, detachedSessionIds: restoration.detachedSessionIds };
    });
  });

  ipcMain.handle("agentPlugin:listOfficial", async () => {
    return listOfficialAgentPlugins(app.getVersion());
  });

  ipcMain.handle("agentPlugin:installOfficial", async (_event, agentId: string) => {
    return agentRuntimeOperationQueue.run(agentId, "plugin-install", async () => {
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

      const suspension = await agentManager.suspendAgentSessionsForPluginRemoval(agentId, "安装或更新");
      if (!suspension.success) {
        return {
          success: false,
          error: suspension.error,
          agents: await agentRegistry.listAgents(),
          detachedSessionIds: suspension.detachedSessionIds,
        };
      }

      let zipPath = "";
      let result: Awaited<ReturnType<typeof agentRegistry.installFromPath>>;
      try {
        zipPath = await downloadOfficialPluginZip(
          plugin,
          join(app.getPath("temp"), "hpp-agent-plugin-downloads")
        );
        agentManager.beginPluginCatalogMutation();
        try {
          result = await agentRegistry.installFromPath(zipPath, {
            expectedAgentId: plugin.id,
            canReplace: (candidateAgentId) => candidateAgentId === agentId,
          });
        } finally {
          agentManager.finishPluginCatalogMutation();
        }
      } catch (error) {
        result = {
          success: false,
          error: getErrorMessage(error),
          agents: await agentRegistry.listAgents(),
        };
      } finally {
        if (zipPath) {
          await rm(zipPath, { force: true }).catch(() => undefined);
        }
      }

      const restoration = await agentManager.finishAgentPluginRemoval(agentId, true);
      if (!restoration.success) {
        return {
          ...result,
          success: false,
          error: `${result.error || (result.success ? "插件已安装或更新" : "插件安装或更新失败")}；会话恢复失败：${restoration.error || "未知错误"}`,
          detachedSessionIds: restoration.detachedSessionIds,
        };
      }
      return { ...result, detachedSessionIds: restoration.detachedSessionIds };
    });
  });

  ipcMain.handle("agentPlugin:remove", async (_event, agentId: string, removeRuntime = false) => {
    return agentRuntimeOperationQueue.run(agentId, "uninstall", async () => {
      const suspension = await agentManager.suspendAgentSessionsForPluginRemoval(agentId);
      if (!suspension.success) {
        return {
          success: false,
          error: suspension.error,
          agents: await agentRegistry.listAgents(),
          detachedSessionIds: suspension.detachedSessionIds,
        };
      }

      let result: Awaited<ReturnType<typeof agentRegistry.removePlugin>>;
      try {
        result = await agentRegistry.removePlugin(agentId, removeRuntime);
      } catch (error) {
        const restoration = await agentManager.finishAgentPluginRemoval(agentId, true);
        const detail = getErrorMessage(error);
        return {
          success: false,
          error: restoration.success
            ? detail
            : `${detail}；会话恢复失败：${restoration.error || "未知错误"}`,
          agents: await agentRegistry.listAgents(),
          detachedSessionIds: restoration.detachedSessionIds,
        };
      }

      const restoration = await agentManager.finishAgentPluginRemoval(agentId, !result.success);
      if (!restoration.success) {
        return {
          ...result,
          success: false,
          error: `${result.error || "插件卸载失败"}；会话恢复失败：${restoration.error || "未知错误"}`,
          detachedSessionIds: restoration.detachedSessionIds,
        };
      }
      return { ...result, detachedSessionIds: restoration.detachedSessionIds };
    });
  });

  ipcMain.handle("agentPlugin:reload", async () => {
    return agentRuntimeOperationQueue.run("plugin-catalog", "plugin-reload", async () => {
      if (agentManager.hasAnyAgentSessions()) {
        return {
          success: false,
          error: "仍有 Agent 会话处于打开或初始化状态，请先关闭后再刷新插件。",
          agents: await agentRegistry.listAgents(),
        };
      }
      agentManager.beginPluginCatalogMutation();
      try {
        return { success: true, agents: await agentRegistry.reload() };
      } catch (error) {
        return { success: false, error: getErrorMessage(error), agents: await agentRegistry.listAgents() };
      } finally {
        agentManager.finishPluginCatalogMutation();
      }
    });
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

  ipcMain.handle("agent:getSessionState", async (_event, sessionId: string) => {
    const agent = agentManager.getAgentBySessionId(sessionId);
    if (!agent) return { success: false, idle: true, error: "No active agent" };
    const cachedIdle = agent.isIdle();
    const pendingUI = hasPendingUIEvents(sessionId);
    if (typeof agent.refreshIdle !== "function") return { success: true, idle: cachedIdle && !pendingUI };
    try {
      const refreshedIdle = await withTimeout(
        agent.refreshIdle(),
        AGENT_SESSION_STATE_REFRESH_TIMEOUT_MS,
        "Agent idle refresh timed out",
      );
      return {
        success: true,
        // Waiting for a host-rendered answer is semantically busy even if a
        // plugin's optional isIdle() implementation reports otherwise.
        idle: refreshedIdle && !hasPendingUIEvents(sessionId),
      };
    } catch (error) {
      // A transport failure must not turn an uncertain live session into an
      // idle one. Return the last revision-guarded cache, but mark it stale so
      // callers do not mistake an old `false` for authoritative busy state.
      return {
        success: true,
        idle: agent.isIdle() && !hasPendingUIEvents(sessionId),
        stale: true,
        error: getErrorMessage(error),
      };
    }
  });

  ipcMain.handle("agent:getPendingUIRequests", async (_event, sessionId: string) => (
    agentManager.getPendingUIRequests(sessionId)
  ));

  ipcMain.handle("agent:sendMessage", async (_event, message: string, images?: AgentImagePayload, sessionId?: string, options?: AgentSendOptions) => {
    try {
      const agentType = sessionId ? agentManager.getSessionAgentType(sessionId) : agentManager.getActiveAgentType();
      if (agentManager.isAgentRuntimeUpdating(agentType)) {
        return { success: false, error: "该 Agent CLI 正在更新，请等待更新完成。" };
      }
      if (agentManager.isAgentRuntimeUnavailable(agentType)) {
        return { success: false, error: "该 Agent 正在卸载，请等待操作完成。" };
      }
      const agent = sessionId ? agentManager.getAgentBySessionId(sessionId) : agentManager.getActiveAgent();
      if (!agent) return { success: false, error: "No active agent" };
      const planModeEnabled = !!options?.planModeEnabled;
      const capabilities = agentType ? await agentRegistry.getCapabilities(agentType) : null;
      const permissionMode = capabilities?.permissions === true
        ? normalizeAgentPermissionMode(options?.permissionMode)
        : "full-access";
      // Pi's Plan enforcement lives in Hpp's built-in worker. Treat older
      // official Pi plugin manifests (which declared prompt mode) as native so
      // an Hpp update fixes Plan mode without requiring a separate plugin
      // reinstall first.
      const nativePlanMode = capabilities?.planMode === "native" ||
        (agentType === "pi" && capabilities?.planMode === "prompt");
      if (agentManager.isAgentRuntimeUpdating(agentType)) {
        return { success: false, error: "该 Agent CLI 正在更新，请等待更新完成。" };
      }
      if (agentManager.isAgentRuntimeUnavailable(agentType)) {
        return { success: false, error: "该 Agent 正在卸载，请等待操作完成。" };
      }
      const currentAgent = sessionId
        ? agentManager.getAgentBySessionId(sessionId)
        : agentManager.getActiveAgent();
      if (currentAgent !== agent) {
        return { success: false, error: "No active agent" };
      }
      const modeAwareMessage = planModeEnabled && !nativePlanMode
        ? withPromptPlanMode(message)
        : message;
      await agent.sendMessage(modeAwareMessage, images, {
        planModeEnabled: planModeEnabled && nativePlanMode,
        permissionMode,
        displayMessage: message,
        hostSystemPrompt: HPP_AGENT_SYSTEM_PROMPT,
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
    await agentManager.abort(sessionId);
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
    try {
      const pendingUIRevision = await agentManager.sendUIResponse(response);
      return { success: true, pendingUIRevision };
    } catch (err: unknown) {
      return { success: false, error: getErrorMessage(err) };
    }
  });
}
