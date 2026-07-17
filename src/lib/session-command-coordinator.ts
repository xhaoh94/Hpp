import { getAgentName, requiresProviderActivation, supportsGuidance, supportsNativeFork } from "@/lib/agents";
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
import { useChatStore, type ChatMessage, type ModelInfo, type QueuedMessage } from "@/stores/chat-store";
import { useProjectStore, type Project, type ProjectSession } from "@/stores/project-store";
import type { AgentForkResult, AgentImagePayload, AgentReloadConfigResult } from "@/types";
import { getQuestionnaireAnswerLabel } from "@shared/questionnaire";

export type PreparedSessionMessage = {
  displayContent: string;
  sendContent: string;
  messageImages?: Array<{ id: string; src: string; name: string }>;
  sessionReferences?: Array<{ sourceSessionId: string; sourceTitle: string }>;
  agentImages?: AgentImagePayload;
  planModeEnabled?: boolean;
  forkContextUsed?: boolean;
};

export type SendMessageHooks = {
  isProcessActive?: (sessionId: string) => boolean;
  commit?: (action: () => void) => void;
  onSendStarted?: (sessionId: string) => void;
  onOptimisticMessage?: (sessionId: string) => void;
  onSendFailureCleanup?: (sessionId: string) => void;
};

export type InteractionCommandContext = {
  pendingInteraction: {
    sessionId: string;
    requestId?: string;
    method?: string;
    entryId?: string;
  } | null;
  clearPendingInteraction: (sessionId: string) => void;
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

const initializations = new Map<string, Promise<SessionCommandResult>>();

const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function getSessionCommandTarget(sessionId: string) {
  const project = useProjectStore.getState().projects.find((candidate) =>
    candidate.sessions.some((session) => session.id === sessionId));
  const session = project?.sessions.find((candidate) => candidate.id === sessionId);
  if (!project || !session) throw new Error("SESSION_NOT_FOUND");
  return { project, session };
}

const sessionExists = (sessionId: string) => useProjectStore.getState().projects.some((project) =>
  project.sessions.some((session) => session.id === sessionId));

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

const applyActiveModels = (sessionId: string, models: ModelInfo[], selected?: ModelInfo | null) => {
  if (useProjectStore.getState().activeSessionId !== sessionId) return;
  const chat = useChatStore.getState();
  chat.setAvailableModels(models);
  if (selected) chat.setCurrentModel(selected);
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
  }

  let models: ModelInfo[] = [];
  let warning: string | undefined;
  try {
    if (!useProjectStore.getState().initializedSessionIds.has(sessionId)) {
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

    const selectedModel = selectSessionModel(sessionId, models);
    if (selectedModel) {
      saveSessionModel(sessionId, selectedModel);
      const modelResult = await window.electronAPI.agentSetModel(selectedModel.provider, selectedModel.id, sessionId);
      if (!modelResult.success) throw new Error(modelResult.error || "MODEL_SWITCH_FAILED");
    }
    applyActiveModels(sessionId, models, selectedModel);

    const thinking = await getSessionThinkingOrDefault(sessionId, session.agentId);
    const thinkingResult = await window.electronAPI.agentSetThinkingLevel(thinking, sessionId);
    if (!thinkingResult.success) throw new Error("THINKING_LEVEL_FAILED");
    saveSessionThinking(sessionId, thinking);
    if (useProjectStore.getState().activeSessionId === sessionId) useChatStore.getState().setThinkingLevel(thinking);

    if (options.activate && useProjectStore.getState().activeSessionId === sessionId) {
      await window.electronAPI.agentSwitchSession(sessionId);
    }
  } catch (error) {
    warning = getErrorMessage(error);
    if (!options.recordFailure) throw error;
    useProjectStore.getState().markSessionInitialized(sessionId);
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

export async function closeSession(sessionId: string, context?: { clearPendingInteraction?: (sessionId: string) => void }) {
  const { project, session } = getSessionCommandTarget(sessionId);
  if (!session.closed) {
    useProjectStore.getState().closeSession(project.id, sessionId);
    await window.electronAPI.agentRemoveSession(sessionId);
  }
  const chat = useChatStore.getState();
  chat.clearSessionQueue(sessionId);
  if (chat.activeSessionId === sessionId) {
    chat.switchSession(null);
    chat.setStreaming(false);
  }
  context?.clearPendingInteraction?.(sessionId);
  return getSessionCommandTarget(sessionId);
}

export async function reopenSession(sessionId: string, options: { activate?: boolean } = {}) {
  const { project, session } = getSessionCommandTarget(sessionId);
  if (session.closed) useProjectStore.getState().reopenSession(project.id, sessionId);
  if (options.activate) return initializeSession(sessionId, { activate: true, recordFailure: true });
  return getSessionCommandTarget(sessionId);
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

const isRunning = (sessionId: string, hooks?: SendMessageHooks) =>
  hooks?.isProcessActive?.(sessionId) === true ||
  useProjectStore.getState().agentStatuses[sessionId] === "running";

const clearForkContext = (sessionId: string) => {
  const { project, session } = getSessionCommandTarget(sessionId);
  if (session.forkContext) useProjectStore.getState().setSessionForkContext(project.id, sessionId, undefined);
};

const settleFailedSend = (sessionId: string, hooks?: SendMessageHooks) => {
  useChatStore.getState().finishLastAssistantProcess(Date.now(), "completed", sessionId);
  if (useChatStore.getState().activeSessionId === sessionId) useChatStore.getState().setStreaming(false);
  useProjectStore.getState().setAgentStatus(sessionId, "idle");
  hooks?.onSendFailureCleanup?.(sessionId);
};

export async function sendMessage(input: {
  sessionId: string;
  clientMessageId: string;
  message: PreparedSessionMessage;
  queueIfRunning?: boolean;
  throwOnFailure?: boolean;
  hooks?: SendMessageHooks;
}) {
  if (!input.sessionId || !input.clientMessageId) throw new Error("INVALID_REQUEST");
  await initializeSession(input.sessionId);
  const message = input.message;
  if (!message.displayContent.trim() && !message.sendContent.trim() && !message.messageImages?.length && !message.sessionReferences?.length) {
    throw new Error("INVALID_REQUEST");
  }

  if (input.queueIfRunning !== false && isRunning(input.sessionId, input.hooks)) {
    const queued: QueuedMessage = {
      id: input.clientMessageId,
      sessionId: input.sessionId,
      displayContent: message.displayContent,
      sendContent: message.sendContent,
      messageImages: message.messageImages,
      sessionReferences: message.sessionReferences,
      agentImages: message.agentImages,
      planModeEnabled: message.planModeEnabled,
      createdAt: Date.now(),
      status: "queued",
    };
    useChatStore.getState().enqueueMessage(queued);
    if (message.forkContextUsed) clearForkContext(input.sessionId);
    return { queued: true, clientMessageId: input.clientMessageId };
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
    const thinking = getSessionThinking(input.sessionId);
    if (thinking) {
      const thinkingResult = await window.electronAPI.agentSetThinkingLevel(thinking, input.sessionId);
      if (!thinkingResult.success) throw new Error("THINKING_LEVEL_FAILED");
    }
    if (!sessionExists(input.sessionId)) {
      input.hooks?.onSendFailureCleanup?.(input.sessionId);
      return { queued: false, clientMessageId: input.clientMessageId, abandoned: true };
    }
    const result = await window.electronAPI.agentSendMessage(
      message.sendContent,
      message.agentImages,
      input.sessionId,
      { planModeEnabled: !!message.planModeEnabled, clientMessageId: input.clientMessageId },
    );
    if (!result.success) throw new Error(result.error || "SEND_FAILED");
  } catch (error) {
    const detail = getErrorMessage(error);
    if (sessionExists(input.sessionId)) {
      settleFailedSend(input.sessionId, input.hooks);
      useChatStore.getState().addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: `发送失败: ${detail}`,
        timestamp: Date.now(),
      }, input.sessionId);
    }
    if (input.throwOnFailure) throw error;
    return { queued: false, clientMessageId: input.clientMessageId, error: detail };
  }
  return { queued: false, clientMessageId: input.clientMessageId };
}

export async function abortSession(sessionId: string, context: AbortCommandContext) {
  await initializeSession(sessionId);
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
  saveSessionModel(sessionId, selected);
  applyActiveModels(sessionId, availableModels, selected);
  return { model: selected, models: availableModels, previous };
}

export async function setThinking(
  sessionId: string,
  level: string,
  options: { isProcessActive?: (sessionId: string) => boolean } = {},
) {
  if (isRunning(sessionId, { isProcessActive: options.isProcessActive })) throw new Error("SESSION_BUSY");
  await initializeSession(sessionId);
  const previous = getSessionThinking(sessionId) ||
    (useChatStore.getState().activeSessionId === sessionId ? useChatStore.getState().thinkingLevel : "medium");
  const result = await window.electronAPI.agentSetThinkingLevel(level, sessionId);
  if (!result.success) throw new Error("THINKING_LEVEL_FAILED");
  saveSessionThinking(sessionId, level);
  if (useChatStore.getState().activeSessionId === sessionId) useChatStore.getState().setThinkingLevel(level);
  return { level, previous };
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
  applyActiveModels(sessionId, models, selected);
  return { ...result, models };
}

export async function getAvailableModels(sessionId: string) {
  await initializeSession(sessionId);
  return window.electronAPI.agentGetModels(sessionId) as Promise<ModelInfo[]>;
}

export async function getSessionCommandConfig(sessionId: string, includeModels = false) {
  const chat = useChatStore.getState();
  return {
    model: getSessionModel(sessionId) || (chat.activeSessionId === sessionId ? chat.currentModel : null),
    thinkingLevel: getSessionThinking(sessionId) ||
      (chat.activeSessionId === sessionId ? chat.thinkingLevel : "medium"),
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
  const { session } = getSessionCommandTarget(sessionId);
  if (!supportsGuidance(session.agentId)) throw new Error("GUIDANCE_NOT_SUPPORTED");
  if (!isRunning(sessionId)) throw new Error("SESSION_NOT_RUNNING");
  const chat = useChatStore.getState();
  const item = (chat.messageQueues[sessionId] || []).find((candidate) => candidate.id === queueItemId);
  if (!item) throw new Error("QUEUE_ITEM_NOT_FOUND");
  if (item.status === "sending") throw new Error("QUEUE_ITEM_BUSY");
  chat.markQueuedMessageSending(sessionId, queueItemId);
  try {
    const result = await window.electronAPI.agentSendGuidance(
      item.sendContent,
      item.agentImages,
      sessionId,
      { planModeEnabled: !!item.planModeEnabled },
    );
    if (!result.success) throw new Error(result.error || "GUIDANCE_FAILED");
    useChatStore.getState().removeQueuedMessage(sessionId, queueItemId);
    return { success: true, queueItemId };
  } catch (error) {
    useChatStore.getState().markQueuedMessageFailed(sessionId, queueItemId, getErrorMessage(error));
    throw error;
  }
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

export async function respondToInteraction(
  input: { sessionId: string; cancelled?: boolean; answers?: unknown[]; text?: string },
  context: InteractionCommandContext,
) {
  const pending = context.pendingInteraction;
  if (!pending || pending.sessionId !== input.sessionId) throw new Error("INTERACTION_NOT_FOUND");
  const cancelled = input.cancelled === true;
  const answers = input.answers;
  const summary = input.text || answers?.map(getQuestionnaireAnswerLabel)
    .filter(Boolean).join("\n") || (cancelled ? "Cancelled" : "Submitted response");
  const result = await window.electronAPI.agentSendUIResponse({
    sessionId: input.sessionId,
    type: "extension_ui_response",
    id: pending.requestId,
    method: pending.method,
    cancelled,
    result: { cancelled, answers: answers || [] },
    value: summary,
    text: summary,
    answers,
  });
  if (!result.success) throw new Error("INTERACTION_RESPONSE_FAILED");
  context.clearPendingInteraction(input.sessionId);
  const chat = useChatStore.getState();
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
  chat.addMessage({ id: crypto.randomUUID(), role: "user", content: summary, timestamp: Date.now() }, input.sessionId);
  return { cancelled };
}

export const SessionCommandCoordinator = {
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
  reloadSession,
  getAvailableModels,
  getSessionCommandConfig,
  getSessionCommandStatus,
  getAllSessionCommandIds,
  prepareSessionReferenceContext,
  guideQueuedMessage,
  removeQueuedMessage,
  respondToInteraction,
};
