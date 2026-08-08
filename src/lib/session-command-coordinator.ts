import { getAgentName, requiresProviderActivation, supportsAgentActions, supportsGuidance, supportsNativeFork } from "@/lib/agents";
import {
  cloneMessagesForFork,
  createSessionForkContext,
  getCompatibleForkSessionTitle,
  getForkSessionTitle,
  getForkTargetTurnId,
} from "@/lib/session-forks";
import {
  buildSessionReferencesContext,
  createSessionReferenceSnapshot,
  getReferencesDisplayText,
} from "@/lib/session-references";
import {
  getSessionModel,
  getSessionThinking,
  getSessionThinkingOrDefault,
  saveSessionModel,
  saveSessionThinking,
  selectSessionModel,
} from "@/hooks/useDataPersistence";
import { useAgentCatalogStore } from "@/stores/agent-catalog-store";
import { archiveSessionsAfterBackendRemoval } from "@/lib/session-lifecycle";
import {
  getAssistantProcessLastActivityAt,
  hasOpenAssistantProcessState,
  useChatStore,
  type ChatMessage,
  type ModelInfo,
  type QueuedMessage,
  type QueuedMessageEditableDraft,
} from "@/stores/chat-store";
import { useProjectStore, type Project, type ProjectSession } from "@/stores/project-store";
import type { AgentForkResult, AgentImagePayload, AgentReloadConfigResult } from "@/types";
import { getQuestionnaireAnswerLabel } from "@shared/questionnaire";
import {
  getModelThinkingLevels,
  normalizeModelThinkingLevel,
  normalizeThinkingLevelId,
} from "@shared/models";
import type { AgentActionCatalogEntry, AgentActionInvocation } from "@shared/agent-actions";
import type { AgentPermissionMode } from "@shared/agent-permissions";
import { createComposerDraftSnapshot } from "@/lib/composer-history";
import { cloneComposerDocument, type ComposerDocument } from "@shared/composer-document";
import { USER_GUIDANCE_PROCESS_KIND } from "@shared/process-view";
import { formatModelRequestFailure, uiText } from "@/i18n/text";

export type PreparedSessionMessage = {
  editableContent?: string;
  displayContent: string;
  sendContent: string;
  messageImages?: Array<{ id: string; src: string; name: string }>;
  sessionReferences?: Array<{ sourceSessionId: string; sourceTitle: string }>;
  agentImages?: AgentImagePayload;
  planModeEnabled?: boolean;
  permissionMode?: AgentPermissionMode;
  forkContextUsed?: boolean;
  action?: AgentActionInvocation;
  editableDraft?: QueuedMessageEditableDraft;
  composerDocument?: ComposerDocument;
};

export type SendMessageHooks = {
  isProcessActive?: (sessionId: string) => boolean;
  commit?: (action: () => void) => void;
  onSendStarted?: (sessionId: string) => void;
  onOptimisticMessage?: (sessionId: string) => void;
  onReconcileCleanup?: (sessionId: string) => void;
  onSendFailureCleanup?: (sessionId: string) => void;
};

export type BackendSessionActivity = "busy" | "idle" | "missing" | "unknown";

type BackendSessionState = {
  success?: boolean;
  idle?: boolean;
  stale?: boolean;
};

export function classifyBackendSessionState(state: BackendSessionState | null | undefined): BackendSessionActivity {
  if (!state || state.stale === true) return "unknown";
  if (state.success === false && state.idle === true) return "missing";
  if (state.success === true && state.idle === false) return "busy";
  if (state.success === true && state.idle === true) return "idle";
  return "unknown";
}

export type InteractionCommandContext = {
  pendingInteraction?: {
    sessionId: string;
    requestId?: string;
    method?: string;
    entryId?: string;
  } | null;
  getPendingInteraction?: (sessionId: string) => {
    sessionId: string;
    requestId?: string;
    method?: string;
    entryId?: string;
  } | null;
  clearPendingInteraction: (sessionId: string) => void;
  onResponsePrepared?: (sessionId: string) => void;
  onResponseAccepted?: (sessionId: string) => void;
  onResponseFailed?: (
    sessionId: string,
    pendingInteraction: NonNullable<InteractionCommandContext["pendingInteraction"]>,
  ) => void | Promise<void>;
};

export type AbortCommandContext = {
  abortSession: (sessionId: string) => Promise<boolean>;
  clearPendingInteraction?: (sessionId: string) => void;
};

export type SessionCommandResult = {
  project: Project;
  session: ProjectSession;
  models?: ModelInfo[];
  warning?: string;
};

export type SendMessageResult = {
  queued: boolean;
  clientMessageId: string;
  abandoned?: boolean;
  error?: string;
};

const initializations = new Map<string, Promise<SessionCommandResult>>();
const sessionSendLocks = new Map<string, Promise<void>>();
const recoveredRuntimeMonitors = new Map<string, ReturnType<typeof setTimeout>>();
const RECOVERED_RUNTIME_POLL_MS = 2_000;

const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

async function withSessionSendLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
  const previous = sessionSendLocks.get(sessionId) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  sessionSendLocks.set(sessionId, current);

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (sessionSendLocks.get(sessionId) === current) sessionSendLocks.delete(sessionId);
  }
}

export function getSessionCommandTarget(sessionId: string) {
  const project = useProjectStore.getState().projects.find((candidate) =>
    candidate.sessions.some((session) => session.id === sessionId));
  const session = project?.sessions.find((candidate) => candidate.id === sessionId);
  if (!project || !session) throw new Error("SESSION_NOT_FOUND");
  return { project, session };
}

const sessionIsOpen = (sessionId: string) => useProjectStore.getState().projects.some((project) =>
  project.sessions.some((session) => session.id === sessionId && !session.closed));

const addStartupError = (sessionId: string, warning: string) => {
  const chat = useChatStore.getState();
  chat.clearAgentStartupErrors(sessionId);
  chat.addMessage({
    id: crypto.randomUUID(),
    role: "system",
    content: `Agent 启动失败: ${warning}`,
    timestamp: Date.now(),
    systemType: "agent_startup_error",
  }, sessionId);
};

const sameModelSelection = (
  left: Pick<ModelInfo, "id" | "provider"> | null | undefined,
  right: Pick<ModelInfo, "id" | "provider"> | null | undefined,
) => !!left && !!right && left.id === right.id && left.provider === right.provider;

const getRetainedActiveModels = (sessionId: string) => {
  if (useProjectStore.getState().activeSessionId !== sessionId) return [];
  const chat = useChatStore.getState();
  const persisted = getSessionModel(sessionId);
  if (!sameModelSelection(chat.currentModel, persisted)) return [];
  if (chat.availableModels.length > 0) return chat.availableModels;
  return chat.currentModel ? [chat.currentModel] : [];
};

const applyActiveModels = (
  sessionId: string,
  models: ModelInfo[],
  selected?: ModelInfo | null,
  options: { allowEmpty?: boolean } = {},
) => {
  if (useProjectStore.getState().activeSessionId !== sessionId) return;
  const chat = useChatStore.getState();
  const effectiveModels = models.length > 0
    ? models
    : options.allowEmpty
      ? []
      : selected
      ? [selected]
      : getRetainedActiveModels(sessionId);
  if (effectiveModels.length > 0) {
    chat.setAvailableModels(effectiveModels);
  } else if (options.allowEmpty) {
    chat.setAvailableModels([]);
    useChatStore.setState({ currentModel: null });
  }
  if (selected) chat.setCurrentModel(selected);
};

/** Restore the cheap, per-session toolbar state before an async model refresh. */
const restoreActiveSessionSettings = (sessionId: string) => {
  if (useProjectStore.getState().activeSessionId !== sessionId) return;
  const chat = useChatStore.getState();
  const model = getSessionModel(sessionId);
  if (model) chat.setCurrentModel(model);

  const thinking = getSessionThinking(sessionId);
  if (thinking) {
    chat.setThinkingLevel(normalizeModelThinkingLevel(thinking, model || chat.currentModel));
  }
};

const reconcileThinkingForModel = async (
  sessionId: string,
  agentId: string,
  model: ModelInfo,
) => {
  const thinkingLevels = getModelThinkingLevels(model);
  if (thinkingLevels.length === 0) return;
  // A model switch can invalidate the persisted level (for example,
  // minimal -> a model that starts at low). Reconcile it immediately rather
  // than showing a toolbar fallback while keeping/sending the stale value.
  const requestedThinking = await getSessionThinkingOrDefault(sessionId, agentId);
  const effectiveThinking = normalizeModelThinkingLevel(requestedThinking, model);
  const thinkingResult = await window.electronAPI.agentSetThinkingLevel(effectiveThinking, sessionId);
  if (!thinkingResult.success) throw new Error("THINKING_LEVEL_FAILED");
  saveSessionThinking(sessionId, effectiveThinking);
  if (useProjectStore.getState().activeSessionId === sessionId) {
    useChatStore.getState().setThinkingLevel(effectiveThinking);
  }
};

async function runInitialization(
  sessionId: string,
  options: { activate?: boolean; recordFailure?: boolean; refreshModels?: boolean } = {},
): Promise<SessionCommandResult> {
  const initialTarget = getSessionCommandTarget(sessionId);
  const { project, session } = initialTarget;
  const projectStore = useProjectStore.getState();
  const chatStore = useChatStore.getState();

  if (options.activate) {
    projectStore.setActiveProject(project.id);
    projectStore.setActiveSession(session.id);
    chatStore.setActiveAgent(session.agentId);
    chatStore.switchSession(session.id);
    if (projectStore.agentStatuses[session.id] === "completed") projectStore.setAgentStatus(session.id, "idle");
    if (projectStore.initializedSessionIds.has(sessionId)) restoreActiveSessionSettings(sessionId);
  }

  let models: ModelInfo[] = [];
  let warning: string | undefined;
  let runtimeStateUnknown = false;
  try {
    const needsRuntimeInitialization = !useProjectStore.getState().initializedSessionIds.has(sessionId);

    // Switching to an already initialized backend is a UI operation. Model
    // discovery is repeated by useSessionModels after the new session is
    // painted, so do not make the tab click wait for an IPC/backend roundtrip.
    if (options.activate && !needsRuntimeInitialization) {
      void window.electronAPI.agentSwitchSession(sessionId).catch((error) => {
        console.warn("[agent] background session switch failed:", error);
      });
      return { ...getSessionCommandTarget(sessionId) };
    }

    let createdRuntime = false;
    if (needsRuntimeInitialization) {
      const backendActivity = await getBackendSessionActivity(sessionId);
      if (backendActivity === "unknown") {
        runtimeStateUnknown = true;
        throw new Error("SESSION_RUNTIME_STATE_UNKNOWN");
      }
      if (backendActivity === "missing") {
        const result = await window.electronAPI.agentCreateSession(
          session.agentId,
          project.path,
          session.id,
          session.sessionFilePath,
        );
        if (!result.success) throw new Error(result.error || "SESSION_INITIALIZE_FAILED");
        if (result.sessionFilePath) {
          useProjectStore.getState().setSessionFilePath(project.id, session.id, result.sessionFilePath);
        }
        models = (result.models || []) as ModelInfo[];
        createdRuntime = true;
      } else {
        recoverExistingBackendRuntime(sessionId, backendActivity);
      }
      useProjectStore.getState().markSessionInitialized(session.id);
      useChatStore.getState().clearAgentStartupErrors(session.id);
    }

    if (options.refreshModels !== false) {
      try {
        const refreshed = await window.electronAPI.agentGetModels(sessionId);
        if (refreshed.length > 0 || models.length === 0) models = refreshed as ModelInfo[];
      } catch {
        // Initialization models remain usable while a backend is still warming up.
      }
    }

    let selectedModel = selectSessionModel(sessionId, models);
    if (createdRuntime) {
      if (selectedModel) {
        saveSessionModel(sessionId, selectedModel);
        const modelResult = await window.electronAPI.agentSetModel(selectedModel.provider, selectedModel.id, sessionId);
        if (!modelResult.success) throw new Error(modelResult.error || "MODEL_SWITCH_FAILED");
        const refreshedModels = await window.electronAPI.agentGetModels(sessionId) as ModelInfo[];
        if (refreshedModels.length > 0) {
          models = refreshedModels;
          selectedModel = models.find((model) =>
            model.provider === selectedModel?.provider && model.id === selectedModel?.id
          ) || selectedModel;
          saveSessionModel(sessionId, selectedModel);
        }
      }

      const thinkingLevels = getModelThinkingLevels(selectedModel);
      if (thinkingLevels.length > 0) {
        const requestedThinking = await getSessionThinkingOrDefault(sessionId, session.agentId);
        const thinking = normalizeModelThinkingLevel(requestedThinking, selectedModel);
        const thinkingResult = await window.electronAPI.agentSetThinkingLevel(thinking, sessionId);
        if (!thinkingResult.success) throw new Error("THINKING_LEVEL_FAILED");
        saveSessionThinking(sessionId, thinking);
        if (useProjectStore.getState().activeSessionId === sessionId) useChatStore.getState().setThinkingLevel(thinking);
      }
    }
    applyActiveModels(sessionId, models, selectedModel);

    if (options.activate && useProjectStore.getState().activeSessionId === sessionId) {
      await window.electronAPI.agentSwitchSession(sessionId);
    }
  } catch (error) {
    warning = getErrorMessage(error);
    if (!options.recordFailure) throw error;
    // An unavailable/stale state query proves neither that a backend exists
    // nor that it is safe to create a replacement. Leave the session
    // uninitialized so a later explicit/automatic initialization can probe
    // again without disposing a possibly live task.
    if (!runtimeStateUnknown) useProjectStore.getState().markSessionInitialized(sessionId);
    addStartupError(sessionId, warning);
  }

  const current = getSessionCommandTarget(sessionId);
  return { ...current, models, ...(warning ? { warning } : {}) };
}

export async function initializeSession(
  sessionId: string,
  options: { activate?: boolean; recordFailure?: boolean; refreshModels?: boolean } = {},
) {
  const current = initializations.get(sessionId);
  if (current) {
    const result = await current;
    if (options.activate) return runInitialization(sessionId, { ...options, refreshModels: true });
    return result;
  }
  const pending = runInitialization(sessionId, options).finally(() => initializations.delete(sessionId));
  initializations.set(sessionId, pending);
  return pending;
}

export async function createSession(input: {
  projectId: string;
  agentId: string;
  sessionId?: string;
  activate?: boolean;
  verifyInstalled?: boolean;
}) {
  const sessionId = input.sessionId || crypto.randomUUID();
  const projectState = useProjectStore.getState();
  const project = projectState.projects.find((candidate) => candidate.id === input.projectId);
  if (!project) throw new Error("PROJECT_NOT_FOUND");

  const existingProject = projectState.projects.find((candidate) =>
    candidate.sessions.some((session) => session.id === sessionId));
  const existing = existingProject?.sessions.find((session) => session.id === sessionId);
  if (existingProject && existing) {
    if (existingProject.id !== input.projectId || existing.agentId !== input.agentId) throw new Error("SESSION_ID_CONFLICT");
    return initializeSession(existing.id, { activate: input.activate, recordFailure: true });
  }

  const agents = await useAgentCatalogStore.getState().loadAgents();
  if (!agents.some((agent) => agent.id === input.agentId)) throw new Error("AGENT_NOT_FOUND");
  if (input.verifyInstalled !== false) {
    const status = await window.electronAPI.agentGetStatus(input.agentId);
    if (!status.installed) throw new Error("AGENT_NOT_INSTALLED");
  }

  const concurrent = useProjectStore.getState().projects.find((candidate) =>
    candidate.sessions.some((session) => session.id === sessionId));
  if (concurrent) throw new Error("SESSION_ID_CONFLICT");

  const now = new Date();
  const session: ProjectSession = {
    id: sessionId,
    agentId: input.agentId,
    agentSessionId: sessionId,
    title: `新会话 - ${now.toLocaleString("zh-CN")}`,
    createdAt: now.toISOString(),
    lastActiveAt: now.toISOString(),
  };
  const currentModel = useChatStore.getState().currentModel;
  if (currentModel) saveSessionModel(sessionId, currentModel);
  useProjectStore.getState().addSession(project.id, session, input.activate === true);
  return initializeSession(sessionId, { activate: input.activate, recordFailure: true });
}

export async function closeSession(
  sessionId: string,
  context?: {
    clearPendingInteraction?: (sessionId: string) => void;
  },
) {
  return withSessionSendLock(sessionId, async () => {
    const { session } = getSessionCommandTarget(sessionId);
    let warning: string | undefined;
    if (!session.closed) {
      try {
        await window.electronAPI.agentRemoveSession(sessionId);
      } catch (error) {
        // AgentManager removes the backend from its maps in a finally block so
        // a dispose error can mean "removed with a cleanup warning", not that
        // the session is still usable. Confirm that state before preserving UI.
        if (await getBackendSessionActivity(sessionId) !== "missing") throw error;
        warning = `Agent 已关闭，但清理过程报告异常：${getErrorMessage(error)}`;
      }
    }
    archiveSessionsAfterBackendRemoval([sessionId]);
    context?.clearPendingInteraction?.(sessionId);
    return { ...getSessionCommandTarget(sessionId), ...(warning ? { warning } : {}) };
  });
}

export async function reopenSession(sessionId: string, options: { activate?: boolean } = {}) {
  return withSessionSendLock(sessionId, async () => {
    const { project, session } = getSessionCommandTarget(sessionId);
    if (session.closed) useProjectStore.getState().reopenSession(project.id, sessionId);
    if (options.activate) return initializeSession(sessionId, { activate: true, recordFailure: true });
    return getSessionCommandTarget(sessionId);
  });
}

export async function forkSession(input: {
  sourceSessionId: string;
  throughMessageId: string;
  sessionId?: string;
  activate?: boolean;
}) {
  const sessionId = input.sessionId || crypto.randomUUID();
  const projectState = useProjectStore.getState();
  const { project, session: sourceSession } = getSessionCommandTarget(input.sourceSessionId);
  const existingProject = projectState.projects.find((candidate) =>
    candidate.sessions.some((session) => session.id === sessionId));
  const existing = existingProject?.sessions.find((session) => session.id === sessionId);
  if (existingProject && existing) {
    if (
      existingProject.id !== project.id ||
      existing.forkedFrom?.sourceSessionId !== input.sourceSessionId ||
      existing.forkedFrom?.throughMessageId !== input.throughMessageId
    ) throw new Error("SESSION_ID_CONFLICT");
    return { project: existingProject, session: existing };
  }

  const chat = useChatStore.getState();
  const currentMessages = chat.sessionMessages[input.sourceSessionId] ||
    (chat.activeSessionId === input.sourceSessionId ? chat.messages : []);
  const messageIndex = currentMessages.findIndex((message) => message.id === input.throughMessageId);
  if (messageIndex < 0) throw new Error("MESSAGE_NOT_FOUND");
  const sourceMessage = currentMessages[messageIndex];
  if (sourceMessage.role !== "assistant") throw new Error("FORK_REQUIRES_ASSISTANT_MESSAGE");

  const sourceMessages = currentMessages.slice(0, messageIndex + 1);
  const forkMessages = cloneMessagesForFork(sourceMessages);
  const sourceUserMessageIndex = sourceMessages.filter((message) => message.role === "user").length - 1;
  const rollbackUserMessageCount = Math.max(
    0,
    currentMessages.filter((message) => message.role === "user").length - (sourceUserMessageIndex + 1),
  );
  const targetTurnId = getForkTargetTurnId(sourceMessage, sourceMessages);
  const now = new Date().toISOString();
  let warning: string | undefined;
  let sessionFilePath: string | undefined;

  if (supportsNativeFork(sourceSession.agentId) && sourceUserMessageIndex >= 0) {
    await initializeSession(sourceSession.id);
    const initializedSource = getSessionCommandTarget(sourceSession.id).session;
    const nativeFork: AgentForkResult = await window.electronAPI.agentForkSession(sourceSession.id, {
      newSessionId: sessionId,
      sourceSessionFilePath: initializedSource.sessionFilePath,
      sourceUserMessageIndex,
      rollbackUserMessageCount,
      targetTurnId,
      sourceMessageContent: sourceMessage.content,
      throughMessageId: sourceMessage.id,
    }).catch((error: unknown) => ({
      supported: true,
      success: false,
      error: getErrorMessage(error),
    }));
    if (nativeFork.success && nativeFork.sessionFilePath) sessionFilePath = nativeFork.sessionFilePath;
    else {
      const detail = nativeFork.error || nativeFork.reason;
      warning = detail
        ? `${getAgentName(sourceSession.agentId)} 原生分叉失败，当前会话使用隐藏上下文兼容模式。\n原因：${detail}`
        : `${getAgentName(sourceSession.agentId)} 原生分叉失败，当前会话使用隐藏上下文兼容模式。`;
    }
  } else if (supportsNativeFork(sourceSession.agentId)) {
    warning = `${getAgentName(sourceSession.agentId)} 原生分叉失败，当前会话使用隐藏上下文兼容模式。\n原因：没有可定位的用户消息`;
  }

  const forkedFrom = {
    sourceSessionId: sourceSession.id,
    sourceTitle: sourceSession.title,
    throughMessageId: sourceMessage.id,
    createdAt: now,
  };
  const session: ProjectSession = {
    id: sessionId,
    agentId: sourceSession.agentId,
    agentSessionId: sessionId,
    title: warning ? getCompatibleForkSessionTitle(sourceMessage) : getForkSessionTitle(sourceMessage),
    createdAt: now,
    lastActiveAt: now,
    ...(sessionFilePath ? { sessionFilePath } : {}),
    forkedFrom,
    ...(!sessionFilePath ? { forkContext: createSessionForkContext(sourceSession, sourceMessages, sourceMessage.id) } : {}),
  };
  const visibleMessages: ChatMessage[] = warning
    ? [...forkMessages, { id: crypto.randomUUID(), role: "system", content: warning, timestamp: Date.now() }]
    : forkMessages;
  if (useProjectStore.getState().projects.some((candidate) =>
    candidate.sessions.some((candidate) => candidate.id === sessionId))) throw new Error("SESSION_ID_CONFLICT");
  useChatStore.getState().loadSessionMessages(sourceSession.id, currentMessages);
  useChatStore.getState().loadSessionMessages(sessionId, visibleMessages);
  useProjectStore.getState().addSession(project.id, session, input.activate === true);
  const sourceModel = getSessionModel(sourceSession.id);
  const sourceThinking = getSessionThinking(sourceSession.id);
  if (sourceModel) saveSessionModel(sessionId, sourceModel);
  if (sourceThinking) saveSessionThinking(sessionId, sourceThinking);
  if (input.activate) {
    useProjectStore.getState().setActiveProject(project.id);
    useProjectStore.getState().setActiveSession(sessionId);
    useChatStore.getState().setActiveAgent(session.agentId);
    useChatStore.getState().switchSession(sessionId);
  }
  return { project, session, ...(warning ? { warning } : {}) };
}

const isRunning = (sessionId: string, hooks?: SendMessageHooks) => {
  const chat = useChatStore.getState();
  const messages = chat.activeSessionId === sessionId
    ? chat.messages
    : chat.sessionMessages[sessionId] || [];
  return hooks?.isProcessActive?.(sessionId) === true ||
    chat.compactingSessions[sessionId] === true ||
    (chat.activeSessionId === sessionId && chat.isStreaming) ||
    messages.some(hasOpenAssistantProcessState) ||
    useProjectStore.getState().agentStatuses[sessionId] === "running";
};

export async function getBackendSessionActivity(sessionId: string): Promise<BackendSessionActivity> {
  try {
    return classifyBackendSessionState(await window.electronAPI.agentGetSessionState(sessionId));
  } catch {
    return "unknown";
  }
}

const clearMissingRuntimeInitialization = (sessionId: string) => {
  useProjectStore.setState((state) => {
    if (!state.initializedSessionIds.has(sessionId)) return {};
    const initializedSessionIds = new Set(state.initializedSessionIds);
    initializedSessionIds.delete(sessionId);
    return { initializedSessionIds };
  });
};

const cleanupStaleRendererRuntime = (sessionId: string, hooks?: SendMessageHooks) => {
  const chat = useChatStore.getState();
  const messages = chat.activeSessionId === sessionId
    ? chat.messages
    : chat.sessionMessages[sessionId] || [];
  const latestOpenAssistant = [...messages].reverse().find(hasOpenAssistantProcessState);
  chat.finishAllAssistantProcesses(
    latestOpenAssistant ? getAssistantProcessLastActivityAt(latestOpenAssistant) : undefined,
    "interrupted",
    sessionId,
  );
  chat.interruptSessionCompaction(sessionId);
  if (chat.activeSessionId === sessionId) chat.setStreaming(false);
  useProjectStore.getState().setAgentStatus(sessionId, "idle");
  hooks?.onReconcileCleanup?.(sessionId);
};

const settleRecoveredRendererRuntime = (sessionId: string) => {
  const chat = useChatStore.getState();
  chat.finishAllAssistantProcesses(Date.now(), "completed", sessionId);
  chat.interruptSessionCompaction(sessionId);
  if (chat.activeSessionId === sessionId) chat.setStreaming(false);
  useProjectStore.getState().setAgentStatus(sessionId, "idle");
};

const stopRecoveredRuntimeMonitor = (sessionId: string) => {
  const timer = recoveredRuntimeMonitors.get(sessionId);
  if (timer) clearTimeout(timer);
  recoveredRuntimeMonitors.delete(sessionId);
};

/**
 * A renderer can reload while the main-process backend keeps running. The new
 * renderer has no SessionRuntime watchdog until another Agent event arrives,
 * so keep a lightweight backend poll alive for only those recovered turns.
 * It stops as soon as normal lifecycle events settle the renderer status.
 */
const scheduleRecoveredRuntimeMonitor = (sessionId: string) => {
  if (recoveredRuntimeMonitors.has(sessionId)) return;
  const timer = setTimeout(() => {
    if (recoveredRuntimeMonitors.get(sessionId) !== timer) return;
    recoveredRuntimeMonitors.delete(sessionId);
    const projectState = useProjectStore.getState();
    if (
      projectState.agentStatuses[sessionId] !== "running" ||
      !projectState.initializedSessionIds.has(sessionId) ||
      !sessionIsOpen(sessionId)
    ) {
      return;
    }
    void getBackendSessionActivity(sessionId).then((activity) => {
      if (activity === "idle") {
        settleRecoveredRendererRuntime(sessionId);
        return;
      }
      if (activity === "missing") {
        cleanupStaleRendererRuntime(sessionId);
        clearMissingRuntimeInitialization(sessionId);
        return;
      }
      // Busy and unknown are both unsafe to settle. Keep polling until the
      // backend becomes authoritative or the normal event lifecycle closes it.
      scheduleRecoveredRuntimeMonitor(sessionId);
    });
  }, RECOVERED_RUNTIME_POLL_MS);
  recoveredRuntimeMonitors.set(sessionId, timer);
};

const recoverExistingBackendRuntime = (
  sessionId: string,
  activity: Exclude<BackendSessionActivity, "missing" | "unknown">,
) => {
  stopRecoveredRuntimeMonitor(sessionId);
  if (activity === "idle") {
    settleRecoveredRendererRuntime(sessionId);
    return;
  }
  useProjectStore.getState().setAgentStatus(sessionId, "running");
  if (useChatStore.getState().activeSessionId === sessionId) {
    useChatStore.getState().setStreaming(true);
  }
  scheduleRecoveredRuntimeMonitor(sessionId);
};

const reconcileSessionRunningState = async (
  sessionId: string,
  hooks?: SendMessageHooks,
  options: { allowUnknownWhenRendererIdle?: boolean } = {},
) => {
  const rendererRunning = isRunning(sessionId, hooks);
  const backendActivity = await getBackendSessionActivity(sessionId);
  if (backendActivity === "busy") {
    useProjectStore.getState().setAgentStatus(sessionId, "running");
    if (useChatStore.getState().activeSessionId === sessionId) useChatStore.getState().setStreaming(true);
    return true;
  }
  if (backendActivity === "idle") {
    if (rendererRunning) cleanupStaleRendererRuntime(sessionId, hooks);
    return false;
  }
  if (backendActivity === "missing") {
    cleanupStaleRendererRuntime(sessionId, hooks);
    clearMissingRuntimeInitialization(sessionId);
    return false;
  }
  // A failed state query must not turn an uncertain renderer state into a
  // destructive cleanup or an unsafe immediate send. A pristine/new runtime
  // is the one exception: it cannot own a preceding turn, so its first send
  // must remain usable while a temporarily mismatched preload lacks the state
  // query IPC.
  return rendererRunning || options.allowUnknownWhenRendererIdle !== true;
};

const clearForkContext = (sessionId: string) => {
  const { project, session } = getSessionCommandTarget(sessionId);
  if (session.forkContext) useProjectStore.getState().setSessionForkContext(project.id, sessionId, undefined);
};

const settleFailedSend = (sessionId: string, hooks?: SendMessageHooks) => {
  useChatStore.getState().finishAllAssistantProcesses(Date.now(), "interrupted", sessionId);
  if (useChatStore.getState().activeSessionId === sessionId) useChatStore.getState().setStreaming(false);
  useProjectStore.getState().setAgentStatus(sessionId, "idle");
  hooks?.onSendFailureCleanup?.(sessionId);
};

const appendSendFailureNotice = (sessionId: string, detail: string) => {
  const chat = useChatStore.getState();
  const messages = chat.sessionMessages[sessionId] || (
    chat.activeSessionId === sessionId ? chat.messages : []
  );
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (messages.slice(latestUserIndex + 1).some((message) => (
    message.role === "assistant" && message.content.includes(uiText.process.modelRequestFailed)
  ))) return;

  chat.appendLastAssistantContent(formatModelRequestFailure(detail), sessionId);
};

export async function sendMessage(input: {
  sessionId: string;
  clientMessageId: string;
  message: PreparedSessionMessage;
  queueIfRunning?: boolean;
  throwOnFailure?: boolean;
  hooks?: SendMessageHooks;
}): Promise<SendMessageResult> {
  if (!input.sessionId || !input.clientMessageId) throw new Error("INVALID_REQUEST");
  const message = input.message;
  if (!message.displayContent.trim() && !message.sendContent.trim() && !message.messageImages?.length && !message.sessionReferences?.length && !message.action) {
    throw new Error("INVALID_REQUEST");
  }

  return withSessionSendLock(input.sessionId, async () => {
    let { session } = getSessionCommandTarget(input.sessionId);
    if (session.closed) throw new Error("SESSION_CLOSED");
    if (message.action && !supportsAgentActions(session.agentId)) {
      throw new Error("ACTION_NOT_SUPPORTED");
    }

    const enqueue = (): SendMessageResult => {
      const chat = useChatStore.getState();
      const existing = (chat.messageQueues[input.sessionId] || [])
        .find((item) => item.id === input.clientMessageId);
      const queued: QueuedMessage = {
        id: input.clientMessageId,
        sessionId: input.sessionId,
        editableContent: message.editableContent,
        displayContent: message.displayContent,
        sendContent: message.sendContent,
        messageImages: message.messageImages,
        sessionReferences: message.sessionReferences,
        agentImages: message.agentImages,
        planModeEnabled: message.planModeEnabled,
        permissionMode: message.permissionMode,
        action: message.action,
        editableDraft: message.editableDraft,
        composerDocument: message.composerDocument,
        createdAt: existing?.createdAt ?? Date.now(),
        status: "queued" as const,
      };
      if (existing) chat.upsertQueuedMessage(queued);
      else chat.enqueueMessage(queued);
      if (message.forkContextUsed) clearForkContext(input.sessionId);
      return { queued: true, clientMessageId: input.clientMessageId };
    };

    const chatBeforeAdmission = useChatStore.getState();
    const messagesBeforeAdmission = chatBeforeAdmission.activeSessionId === input.sessionId
      ? chatBeforeAdmission.messages
      : chatBeforeAdmission.sessionMessages[input.sessionId] || [];
    const allowUnknownWhenRendererIdle =
      !useProjectStore.getState().initializedSessionIds.has(input.sessionId) ||
      !messagesBeforeAdmission.some((candidate) => candidate.role === "user" || candidate.role === "assistant");

    // Reconcile against the backend before initialization: model/thinking
    // synchronization is unsafe while any Agent still has an active turn.
    if (
      input.queueIfRunning !== false &&
      await reconcileSessionRunningState(input.sessionId, input.hooks, { allowUnknownWhenRendererIdle })
    ) {
      return enqueue();
    }

    ({ session } = await initializeSession(input.sessionId));
    if (session.closed || !sessionIsOpen(input.sessionId)) {
      input.hooks?.onSendFailureCleanup?.(input.sessionId);
      return { queued: false, clientMessageId: input.clientMessageId, abandoned: true };
    }
    // Initialization is asynchronous, so re-check in case another sender started the session meanwhile.
    if (
      input.queueIfRunning !== false &&
      await reconcileSessionRunningState(input.sessionId, input.hooks, { allowUnknownWhenRendererIdle })
    ) {
      return enqueue();
    }

    const commit = input.hooks?.commit || ((action: () => void) => action());
    commit(() => {
      useChatStore.getState().addMessage({
        id: input.clientMessageId,
        role: "user",
        content: message.displayContent,
        timestamp: Date.now(),
        images: message.messageImages,
        sessionReferences: message.sessionReferences,
        action: message.action,
        composerDraft: createComposerDraftSnapshot(message.editableDraft),
        composerDocument: message.composerDocument,
      }, input.sessionId);
      useProjectStore.getState().setAgentStatus(input.sessionId, "running");
      if (useChatStore.getState().activeSessionId === input.sessionId) useChatStore.getState().setStreaming(true);
      input.hooks?.onSendStarted?.(input.sessionId);
    });
    if (message.forkContextUsed) clearForkContext(input.sessionId);
    input.hooks?.onOptimisticMessage?.(input.sessionId);

    try {
      const chat = useChatStore.getState();
      const model = getSessionModel(input.sessionId) ||
        (chat.activeSessionId === input.sessionId ? chat.currentModel : null);
      if (model) {
        const modelResult = await window.electronAPI.agentSetModel(model.provider, model.id, input.sessionId);
        if (!modelResult.success) throw new Error(modelResult.error || "MODEL_SWITCH_FAILED");
      }
      const storedThinking = getSessionThinking(input.sessionId);
      const thinking = storedThinking && getModelThinkingLevels(model).length > 0
        ? normalizeModelThinkingLevel(storedThinking, model)
        : undefined;
      if (thinking) {
        const thinkingResult = await window.electronAPI.agentSetThinkingLevel(thinking, input.sessionId);
        if (!thinkingResult.success) throw new Error("THINKING_LEVEL_FAILED");
        if (thinking !== storedThinking) {
          saveSessionThinking(input.sessionId, thinking);
          if (chat.activeSessionId === input.sessionId) chat.setThinkingLevel(thinking);
        }
      }
      if (!sessionIsOpen(input.sessionId)) {
        input.hooks?.onSendFailureCleanup?.(input.sessionId);
        return { queued: false, clientMessageId: input.clientMessageId, abandoned: true };
      }
      const result = await window.electronAPI.agentSendMessage(
        message.sendContent,
        message.agentImages,
        input.sessionId,
        {
          planModeEnabled: !!message.planModeEnabled,
          permissionMode: message.permissionMode,
          clientMessageId: input.clientMessageId,
          ...(message.action ? { action: message.action } : {}),
        },
      );
      if (!result.success) throw new Error(result.error || "SEND_FAILED");
      if (!sessionIsOpen(input.sessionId)) {
        input.hooks?.onSendFailureCleanup?.(input.sessionId);
        return { queued: false, clientMessageId: input.clientMessageId, abandoned: true };
      }
    } catch (error) {
      if (!sessionIsOpen(input.sessionId)) {
        input.hooks?.onSendFailureCleanup?.(input.sessionId);
        return { queued: false, clientMessageId: input.clientMessageId, abandoned: true };
      }
      const detail = getErrorMessage(error);
      if (sessionIsOpen(input.sessionId)) {
        appendSendFailureNotice(input.sessionId, detail);
        settleFailedSend(input.sessionId, input.hooks);
      }
      if (input.throwOnFailure) throw error;
      return { queued: false, clientMessageId: input.clientMessageId, error: detail };
    }
    return { queued: false, clientMessageId: input.clientMessageId };
  });
}

export async function abortSession(sessionId: string, context: AbortCommandContext) {
  getSessionCommandTarget(sessionId);
  const success = await context.abortSession(sessionId);
  if (!success) throw new Error("ABORT_FAILED");
  context.clearPendingInteraction?.(sessionId);
  return { success: true };
}

export async function setModel(
  sessionId: string,
  model: Pick<ModelInfo, "id" | "provider">,
  options: { models?: ModelInfo[]; isProcessActive?: (sessionId: string) => boolean } = {},
) {
  if (isRunning(sessionId, { isProcessActive: options.isProcessActive })) throw new Error("SESSION_BUSY");
  const { session } = await initializeSession(sessionId);
  const models = options.models || await window.electronAPI.agentGetModels(sessionId) as ModelInfo[];
  const selected = models.find((candidate) => candidate.provider === model.provider && candidate.id === model.id);
  if (!selected) throw new Error("MODEL_NOT_FOUND");
  const previous = getSessionModel(sessionId) ||
    (useChatStore.getState().activeSessionId === sessionId ? useChatStore.getState().currentModel : null);
  let availableModels = models;
  if (requiresProviderActivation(session.agentId) && previous && previous.provider !== selected.provider) {
    const activation = await window.electronAPI.agentConfigActivate(session.agentId, selected.provider);
    if (!activation.success) throw new Error(activation.error || "PROVIDER_ACTIVATION_FAILED");
    if (activation.models?.length) availableModels = activation.models as ModelInfo[];
  }
  const result = await window.electronAPI.agentSetModel(selected.provider, selected.id, sessionId);
  if (!result.success) throw new Error(result.error || "MODEL_SWITCH_FAILED");
  const refreshedModels = await window.electronAPI.agentGetModels(sessionId) as ModelInfo[];
  if (refreshedModels.length > 0) availableModels = refreshedModels;
  const effectiveModel = availableModels.find((candidate) =>
    candidate.provider === selected.provider && candidate.id === selected.id
  ) || selected;
  saveSessionModel(sessionId, effectiveModel);
  applyActiveModels(sessionId, availableModels, effectiveModel);
  await reconcileThinkingForModel(sessionId, session.agentId, effectiveModel);
  return { model: effectiveModel, models: availableModels, previous };
}

export async function setThinking(
  sessionId: string,
  level: string,
  options: { isProcessActive?: (sessionId: string) => boolean } = {},
) {
  if (isRunning(sessionId, { isProcessActive: options.isProcessActive })) throw new Error("SESSION_BUSY");
  const normalizedLevel = normalizeThinkingLevelId(level);
  const chat = useChatStore.getState();
  const knownModel = getSessionModel(sessionId) || (chat.activeSessionId === sessionId ? chat.currentModel : null);
  if (knownModel && !getModelThinkingLevels(knownModel).some((candidate) => candidate.id === normalizedLevel)) {
    throw new Error("UNSUPPORTED_THINKING_LEVEL");
  }
  await initializeSession(sessionId);
  const model = getSessionModel(sessionId) || (chat.activeSessionId === sessionId ? chat.currentModel : null);
  if (!getModelThinkingLevels(model).some((candidate) => candidate.id === normalizedLevel)) {
    throw new Error("UNSUPPORTED_THINKING_LEVEL");
  }
  const previous = getSessionThinking(sessionId) ||
    (useChatStore.getState().activeSessionId === sessionId ? useChatStore.getState().thinkingLevel : "medium");
  const result = await window.electronAPI.agentSetThinkingLevel(normalizedLevel, sessionId);
  if (!result.success) throw new Error("THINKING_LEVEL_FAILED");
  saveSessionThinking(sessionId, normalizedLevel);
  if (useChatStore.getState().activeSessionId === sessionId) useChatStore.getState().setThinkingLevel(normalizedLevel);
  return { level: normalizedLevel, previous };
}

export async function reloadSession(sessionId: string) {
  if (isRunning(sessionId)) throw new Error("SESSION_BUSY");
  const { session } = await initializeSession(sessionId);
  const result: AgentReloadConfigResult = await window.electronAPI.agentReloadConfig(session.agentId, sessionId);
  if (!result.success) throw new Error(result.error || "SESSION_RELOAD_FAILED");
  const models = (result.models || []) as ModelInfo[];
  const selected = selectSessionModel(sessionId, models);
  if (selected) {
    const modelResult = await window.electronAPI.agentSetModel(selected.provider, selected.id, sessionId);
    if (!modelResult.success) throw new Error(modelResult.error || "MODEL_SWITCH_FAILED");
    saveSessionModel(sessionId, selected);
  }
  applyActiveModels(sessionId, models, selected, { allowEmpty: true });
  if (selected) await reconcileThinkingForModel(sessionId, session.agentId, selected);
  return { ...result, models };
}

export async function getAvailableModels(sessionId: string) {
  await initializeSession(sessionId);
  try {
    const models = await window.electronAPI.agentGetModels(sessionId) as ModelInfo[];
    if (models.length > 0) return models;
    return getRetainedActiveModels(sessionId);
  } catch (error) {
    const retainedModels = getRetainedActiveModels(sessionId);
    if (retainedModels.length > 0) return retainedModels;
    throw error;
  }
}

export async function getActions(sessionId: string, reload = false): Promise<AgentActionCatalogEntry[]> {
  const { session } = getSessionCommandTarget(sessionId);
  if (!supportsAgentActions(session.agentId)) return [];
  await initializeSession(sessionId, { refreshModels: false });
  return window.electronAPI.agentListActions(sessionId, { reload });
}

export async function getSessionCommandConfig(sessionId: string, includeModels = false) {
  const chat = useChatStore.getState();
  const model = getSessionModel(sessionId) || (chat.activeSessionId === sessionId ? chat.currentModel : null);
  const storedThinking = getSessionThinking(sessionId) ||
    (chat.activeSessionId === sessionId ? chat.thinkingLevel : "medium");
  return {
    model,
    thinkingLevel: normalizeModelThinkingLevel(storedThinking, model),
    availableModels: includeModels ? await getAvailableModels(sessionId) : undefined,
  };
}

export const getSessionCommandStatus = (sessionId: string) =>
  useProjectStore.getState().agentStatuses[sessionId] || "idle";

export const getAllSessionCommandIds = () => useProjectStore.getState().projects
  .flatMap((project) => project.sessions.map((session) => session.id));

export function prepareSessionReferenceContext(
  sessionId: string,
  referenceIds: string[],
  maxReferences: number,
) {
  const { project, session } = getSessionCommandTarget(sessionId);
  const uniqueIds = [...new Set(referenceIds)].slice(0, maxReferences);
  const sourceSessions = uniqueIds.map((sourceSessionId) => {
    if (sourceSessionId === sessionId) throw new Error("INVALID_SESSION_REFERENCE");
    const source = project.sessions.find((candidate) => candidate.id === sourceSessionId);
    if (!source) throw new Error("INVALID_SESSION_REFERENCE");
    return source;
  });
  const sessionMessages = useChatStore.getState().sessionMessages;
  const references = sourceSessions.map((source) =>
    createSessionReferenceSnapshot(source, sessionMessages[source.id] || []));
  return {
    session,
    references,
    contextBlocks: [session.forkContext?.context, buildSessionReferencesContext(references)]
      .filter((value): value is string => !!value),
    messageReferences: references.map((reference) => ({
      sourceSessionId: reference.sourceSessionId,
      sourceTitle: reference.sourceTitle,
    })),
    displayText: getReferencesDisplayText(references),
  };
}

export async function guideQueuedMessage(sessionId: string, queueItemId: string) {
  return withSessionSendLock(sessionId, async () => {
    const { session } = getSessionCommandTarget(sessionId);
    if (session.closed) throw new Error("SESSION_CLOSED");
    if (!supportsGuidance(session.agentId)) throw new Error("GUIDANCE_NOT_SUPPORTED");
    if (!isRunning(sessionId)) throw new Error("SESSION_NOT_RUNNING");
    const chat = useChatStore.getState();
    const item = (chat.messageQueues[sessionId] || []).find((candidate) => candidate.id === queueItemId);
    if (!item) throw new Error("QUEUE_ITEM_NOT_FOUND");
    if (item.status === "sending") throw new Error("QUEUE_ITEM_BUSY");
    if (item.action) throw new Error("GUIDANCE_NOT_SUPPORTED_FOR_ACTION");
    const guidanceEntryId = `guidance-${item.id}`;
    chat.markQueuedMessageSending(sessionId, queueItemId);
    chat.appendLastAssistantProcessEntry({
      id: guidanceEntryId,
      type: "info",
      kind: USER_GUIDANCE_PROCESS_KIND,
      toolKind: "guidance_message",
      title: "引导",
      detail: item.displayContent || undefined,
      timestamp: Date.now(),
      state: "running",
      guidanceDocument: item.composerDocument
        ? cloneComposerDocument(item.composerDocument)
        : undefined,
      guidanceImages: item.messageImages?.map((image) => ({ ...image })),
    }, sessionId);
    try {
      const result = await window.electronAPI.agentSendGuidance(
        item.sendContent,
        item.agentImages,
        sessionId,
        { planModeEnabled: !!item.planModeEnabled, permissionMode: item.permissionMode },
      );
      if (!result.success) throw new Error(result.error || "GUIDANCE_FAILED");
      useChatStore.getState().updateLastAssistantProcessEntry(guidanceEntryId, {
        state: "completed",
        completedAt: Date.now(),
      }, sessionId);
      if (!sessionIsOpen(sessionId)) return { success: false, queueItemId, abandoned: true };
      useChatStore.getState().removeQueuedMessage(sessionId, queueItemId);
      return { success: true, queueItemId };
    } catch (error) {
      useChatStore.getState().removeLastAssistantProcessEntries([guidanceEntryId], sessionId);
      if (sessionIsOpen(sessionId)) {
        useChatStore.getState().markQueuedMessageFailed(sessionId, queueItemId, getErrorMessage(error));
      }
      throw error;
    }
  });
}

export function editQueuedMessage(sessionId: string, queueItemId: string, message: PreparedSessionMessage) {
  getSessionCommandTarget(sessionId);
  if ((message.editableContent || "").length > 200_000) throw new Error("MESSAGE_TOO_LARGE");
  const chat = useChatStore.getState();
  const item = (chat.messageQueues[sessionId] || []).find((candidate) => candidate.id === queueItemId);
  if (!item) throw new Error("QUEUE_ITEM_NOT_FOUND");
  if (item.status === "sending") throw new Error("QUEUE_ITEM_BUSY");
  if (
    !message.displayContent.trim() && !message.sendContent.trim() && !message.messageImages?.length &&
    !message.sessionReferences?.length && !message.action
  ) throw new Error("INVALID_REQUEST");
  const updated: QueuedMessage = {
    id: item.id,
    sessionId: item.sessionId,
    editableContent: message.editableContent,
    displayContent: message.displayContent,
    sendContent: message.sendContent,
    messageImages: message.messageImages,
    sessionReferences: message.sessionReferences,
    agentImages: message.agentImages,
    planModeEnabled: item.planModeEnabled,
    permissionMode: item.permissionMode,
    action: message.action,
    editableDraft: message.editableDraft,
    composerDocument: message.composerDocument,
    createdAt: item.createdAt,
    status: "queued",
    error: undefined,
  };
  chat.upsertQueuedMessage(updated);
  return {
    success: true,
    queueItem: {
      id: updated.id,
      editableContent: updated.editableContent,
      displayContent: updated.displayContent,
      messageImages: updated.messageImages,
      sessionReferences: updated.sessionReferences,
      action: updated.action,
      status: updated.status,
    },
  };
}

export function reorderQueuedMessage(sessionId: string, queueItemId: string, toIndex: number) {
  getSessionCommandTarget(sessionId);
  const chat = useChatStore.getState();
  const queue = chat.messageQueues[sessionId] || [];
  const item = queue.find((candidate) => candidate.id === queueItemId);
  if (!item) throw new Error("QUEUE_ITEM_NOT_FOUND");
  if (item.status === "sending") throw new Error("QUEUE_ITEM_BUSY");
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= queue.length) throw new Error("INVALID_QUEUE_INDEX");
  chat.reorderQueuedMessage(sessionId, queueItemId, toIndex);
  return { success: true, queueItemId, toIndex };
}

export function removeQueuedMessage(sessionId: string, queueItemId: string) {
  getSessionCommandTarget(sessionId);
  const item = (useChatStore.getState().messageQueues[sessionId] || [])
    .find((candidate) => candidate.id === queueItemId);
  if (!item) throw new Error("QUEUE_ITEM_NOT_FOUND");
  if (item.status === "sending") throw new Error("QUEUE_ITEM_BUSY");
  useChatStore.getState().removeQueuedMessage(sessionId, queueItemId);
  return { success: true, queueItemId };
}

export async function setPlanMode(enabled: boolean) {
  const data = await window.electronAPI.loadData("settings").catch(() => null);
  const settings = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const general = settings.general && typeof settings.general === "object" && !Array.isArray(settings.general)
    ? settings.general as Record<string, unknown>
    : {};
  const result = await window.electronAPI.saveData("settings", {
    ...settings,
    general: { ...general, planModeEnabled: enabled },
  });
  if (!result.success) throw new Error(result.error || "SETTINGS_SAVE_FAILED");
  window.dispatchEvent(new CustomEvent("agent-settings-updated", { detail: { planModeEnabled: enabled } }));
  return { enabled };
}

export async function setPermissionMode(mode: AgentPermissionMode) {
  const normalizedMode = normalizeAgentPermissionMode(mode);
  const data = await window.electronAPI.loadData("settings").catch(() => null);
  const settings = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const general = settings.general && typeof settings.general === "object" && !Array.isArray(settings.general)
    ? settings.general as Record<string, unknown>
    : {};
  const result = await window.electronAPI.saveData("settings", {
    ...settings,
    general: { ...general, permissionMode: normalizedMode },
  });
  if (!result.success) throw new Error(result.error || "SETTINGS_SAVE_FAILED");
  window.dispatchEvent(new CustomEvent("agent-settings-updated", { detail: { permissionMode: normalizedMode } }));
  return { mode: normalizedMode };
}

export async function respondToInteraction(
  input: { sessionId: string; cancelled?: boolean; confirmed?: boolean; answers?: unknown[]; text?: string },
  context: InteractionCommandContext,
) {
  return withSessionSendLock(input.sessionId, async () => {
    const pending = context.getPendingInteraction
      ? context.getPendingInteraction(input.sessionId)
      : context.pendingInteraction;
    if (!pending || pending.sessionId !== input.sessionId) throw new Error("INTERACTION_NOT_FOUND");
    const cancelled = input.cancelled === true;
    const isConfirmation = pending.method?.toLowerCase() === "confirm";
    const isPermissionChoice = !isConfirmation && pending.method?.toLowerCase().includes("permission") === true;
    const confirmed = isConfirmation ? input.confirmed === true : undefined;
    const answers = input.answers;
    const summary = isConfirmation
      ? (confirmed ? "允许" : "拒绝")
      : input.text || answers?.map(getQuestionnaireAnswerLabel)
        .filter(Boolean).join("\n") || (cancelled ? "" : "已提交问卷回答");
    const chat = useChatStore.getState();

    // Match the desktop response path: close the question process and clear
    // the interaction before handing control back to the backend. This keeps
    // continuation events out of an already-ended question process.
    context.clearPendingInteraction(input.sessionId);
    if (pending.entryId) {
      chat.updateLastAssistantProcessEntry(pending.entryId, {
        state: cancelled ? "error" : "completed",
        expanded: false,
      }, input.sessionId);
      chat.finishAssistantProcessContainingEntry(
        pending.entryId,
        Date.now(),
        cancelled ? "interrupted" : "completed",
        input.sessionId,
      );
    } else {
      chat.finishLastAssistantProcess(Date.now(), cancelled ? "interrupted" : "completed", input.sessionId);
    }
    if (!cancelled && !isConfirmation && !isPermissionChoice) {
      chat.addMessage({ id: crypto.randomUUID(), role: "user", content: summary, timestamp: Date.now() }, input.sessionId);
    }
    context.onResponsePrepared?.(input.sessionId);

    let result: { success: boolean; error?: string };
    try {
      result = await window.electronAPI.agentSendUIResponse({
        sessionId: input.sessionId,
        type: "extension_ui_response",
        id: pending.requestId,
        method: pending.method,
        cancelled,
        ...(isConfirmation ? { confirmed } : {}),
        result: { cancelled, answers: answers || [] },
        value: summary,
        text: summary,
        answers,
      });
      if (!result.success) throw new Error(result.error || "INTERACTION_RESPONSE_FAILED");
    } catch (error) {
      if (context.onResponseFailed) {
        await context.onResponseFailed(input.sessionId, pending);
      } else {
        chat.finishAllAssistantProcesses(Date.now(), "interrupted", input.sessionId);
        chat.interruptSessionCompaction(input.sessionId);
        useProjectStore.getState().setAgentStatus(input.sessionId, "error");
      }
      throw error;
    }

    context.onResponseAccepted?.(input.sessionId);
    return { cancelled };
  });
}

export const SessionCommandCoordinator = {
  getBackendSessionActivity,
  createSession,
  initializeSession,
  closeSession,
  reopenSession,
  forkSession,
  sendMessage,
  abortSession,
  setModel,
  setThinking,
  setPlanMode,
  setPermissionMode,
  reloadSession,
  getAvailableModels,
  getActions,
  getSessionCommandConfig,
  getSessionCommandStatus,
  getAllSessionCommandIds,
  prepareSessionReferenceContext,
  guideQueuedMessage,
  editQueuedMessage,
  reorderQueuedMessage,
  removeQueuedMessage,
  respondToInteraction,
};
