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
  getSessionThinkingOrDefault,
  getSessionModel,
  getSessionThinking,
  saveSessionModel,
  saveSessionThinking,
  selectSessionModel,
} from "@/hooks/useDataPersistence";
import { useChatStore, type ChatMessage, type ModelInfo } from "@/stores/chat-store";
import { useAgentCatalogStore } from "@/stores/agent-catalog-store";
import { useProjectStore, type ProjectSession } from "@/stores/project-store";
import type { PendingUIResponse } from "@/components/layout/agentEventTypes";
import type {
  AgentImagePayload,
  AgentForkResult,
  RemoteRendererCommand,
  RemoteSession,
  RemoteSessionConfig,
  RemoteSessionCreateResult,
} from "@/types";
import { MAX_REMOTE_SESSION_REFERENCES } from "../../shared/remote-protocol";

export type RemoteCommandContext = {
  pendingInteraction: PendingUIResponse;
  abortSession: (sessionId: string) => Promise<boolean>;
  clearPendingInteraction: (sessionId: string) => void;
};

const getString = (value: unknown) => typeof value === "string" ? value : "";

const getTarget = (sessionId: string) => {
  const projectState = useProjectStore.getState();
  const project = projectState.projects.find((candidate) => candidate.sessions.some((session) => session.id === sessionId));
  const session = project?.sessions.find((candidate) => candidate.id === sessionId);
  if (!project || !session) throw new Error("SESSION_NOT_FOUND");
  return { project, session };
};

async function ensureSession(sessionId: string) {
  const projectState = useProjectStore.getState();
  const { project, session } = getTarget(sessionId);
  if (!projectState.initializedSessionIds.has(sessionId)) {
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
    useProjectStore.getState().markSessionInitialized(session.id);
  }
  return { project, session };
}

async function getSessionConfig(sessionId: string, includeModels = false): Promise<RemoteSessionConfig> {
  const chatState = useChatStore.getState();
  const models = includeModels ? await window.electronAPI.agentGetModels(sessionId) : undefined;
  const activeModel = getSessionModel(sessionId) || (
    chatState.activeSessionId === sessionId ? chatState.currentModel : null
  );
  const settings = await window.electronAPI.loadData("settings").catch(() => null) as { general?: { planModeEnabled?: unknown } } | null;
  return {
    model: activeModel,
    thinkingLevel: getSessionThinking(sessionId) || (
      chatState.activeSessionId === sessionId ? chatState.thinkingLevel : "medium"
    ),
    planModeEnabled: settings?.general?.planModeEnabled === true,
    availableModels: models,
  };
}

async function publishSessionConfig(sessionId: string, includeModels = false) {
  const config = await getSessionConfig(sessionId, includeModels);
  window.electronAPI.remotePublish({ type: "session.config", sessionId, config });
  return config;
}

function toRemoteSession(session: ProjectSession, config: RemoteSessionConfig): RemoteSession {
  return {
    id: session.id,
    agentId: session.agentId,
    title: session.title,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    closed: session.closed === true,
    status: useProjectStore.getState().agentStatuses[session.id] || "idle",
    config,
  };
}

async function createSession(payload: Record<string, unknown>): Promise<RemoteSessionCreateResult> {
  const projectId = getString(payload.projectId);
  const agentId = getString(payload.agentId);
  const sessionId = getString(payload.clientSessionId);
  const projectState = useProjectStore.getState();
  const project = projectState.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error("PROJECT_NOT_FOUND");

  const existingProject = projectState.projects.find((candidate) => candidate.sessions.some((session) => session.id === sessionId));
  const existingSession = existingProject?.sessions.find((session) => session.id === sessionId);
  if (existingProject && existingSession) {
    if (existingProject.id !== projectId || existingSession.agentId !== agentId) throw new Error("SESSION_ID_CONFLICT");
    const config = await getSessionConfig(existingSession.id, true).catch(() => getSessionConfig(existingSession.id));
    return { projectId, session: toRemoteSession(existingSession, config), config };
  }

  const agents = await useAgentCatalogStore.getState().loadAgents();
  if (!agents.some((agent) => agent.id === agentId)) throw new Error("AGENT_NOT_FOUND");
  const status = await window.electronAPI.agentGetStatus(agentId);
  if (!status.installed) throw new Error("AGENT_NOT_INSTALLED");

  const latestProjectState = useProjectStore.getState();
  const concurrentProject = latestProjectState.projects.find((candidate) => candidate.sessions.some((candidate) => candidate.id === sessionId));
  const concurrentSession = concurrentProject?.sessions.find((candidate) => candidate.id === sessionId);
  if (concurrentProject && concurrentSession) {
    if (concurrentProject.id !== projectId || concurrentSession.agentId !== agentId) throw new Error("SESSION_ID_CONFLICT");
    const config = await getSessionConfig(concurrentSession.id, true).catch(() => getSessionConfig(concurrentSession.id));
    return { projectId, session: toRemoteSession(concurrentSession, config), config };
  }

  const now = new Date();
  const session: ProjectSession = {
    id: sessionId,
    agentId,
    agentSessionId: sessionId,
    title: `新会话 - ${now.toLocaleString("zh-CN")}`,
    createdAt: now.toISOString(),
    lastActiveAt: now.toISOString(),
  };
  useProjectStore.getState().addSession(projectId, session, false);

  let models: ModelInfo[] = [];
  let warning: string | undefined;
  try {
    const result = await window.electronAPI.agentCreateSession(agentId, project.path, sessionId);
    useProjectStore.getState().markSessionInitialized(sessionId);
    if (result.sessionFilePath) {
      useProjectStore.getState().setSessionFilePath(projectId, sessionId, result.sessionFilePath);
    }
    models = result.models || [];
    if (result.success) {
      try {
        const refreshedModels = await window.electronAPI.agentGetModels(sessionId);
        if (refreshedModels.length > 0) models = refreshedModels;
      } catch {
        // The models returned during initialization remain usable.
      }
      const selectedModel = selectSessionModel(sessionId, models);
      if (selectedModel) {
        saveSessionModel(sessionId, selectedModel);
        const modelResult = await window.electronAPI.agentSetModel(selectedModel.provider, selectedModel.id, sessionId);
        if (!modelResult.success) warning = modelResult.error || "MODEL_SWITCH_FAILED";
      }
      const thinking = await getSessionThinkingOrDefault(sessionId, agentId);
      saveSessionThinking(sessionId, thinking);
      const thinkingResult = await window.electronAPI.agentSetThinkingLevel(thinking, sessionId);
      if (!thinkingResult.success && !warning) warning = "THINKING_LEVEL_FAILED";
    } else {
      warning = result.error || "SESSION_INITIALIZE_FAILED";
    }
  } catch (error) {
    useProjectStore.getState().markSessionInitialized(sessionId);
    warning = error instanceof Error ? error.message : String(error);
  }

  if (warning) {
    useChatStore.getState().addMessage({
      id: crypto.randomUUID(),
      role: "system",
      content: `Agent 启动失败: ${warning}`,
      timestamp: Date.now(),
      systemType: "agent_startup_error",
    }, sessionId);
  }
  const config = await getSessionConfig(sessionId);
  config.availableModels = models;
  window.electronAPI.remotePublish({ type: "session.config", sessionId, config });
  return {
    projectId,
    session: toRemoteSession(session, config),
    config,
    ...(warning ? { warning } : {}),
  };
}

async function forkSession(payload: Record<string, unknown>): Promise<RemoteSessionCreateResult> {
  const sourceSessionId = getString(payload.sessionId);
  const throughMessageId = getString(payload.throughMessageId);
  const sessionId = getString(payload.clientSessionId);
  const projectState = useProjectStore.getState();
  const { project, session: sourceSession } = getTarget(sourceSessionId);

  const existingProject = projectState.projects.find((candidate) => candidate.sessions.some((session) => session.id === sessionId));
  const existingSession = existingProject?.sessions.find((session) => session.id === sessionId);
  if (existingProject && existingSession) {
    if (
      existingProject.id !== project.id ||
      existingSession.forkedFrom?.sourceSessionId !== sourceSessionId ||
      existingSession.forkedFrom?.throughMessageId !== throughMessageId
    ) throw new Error("SESSION_ID_CONFLICT");
    const config = await getSessionConfig(existingSession.id);
    return { projectId: project.id, session: toRemoteSession(existingSession, config), config };
  }

  const chatState = useChatStore.getState();
  const currentMessages = chatState.sessionMessages[sourceSessionId] || (
    chatState.activeSessionId === sourceSessionId ? chatState.messages : []
  );
  const messageIndex = currentMessages.findIndex((message) => message.id === throughMessageId);
  if (messageIndex < 0) throw new Error("MESSAGE_NOT_FOUND");
  const sourceMessage = currentMessages[messageIndex];
  if (sourceMessage.role !== "assistant") throw new Error("FORK_REQUIRES_ASSISTANT_MESSAGE");

  const sourceMessages = currentMessages.slice(0, messageIndex + 1);
  const forkMessages = cloneMessagesForFork(sourceMessages);
  const sourceUserMessageCount = sourceMessages.filter((message) => message.role === "user").length;
  const sourceUserMessageIndex = sourceUserMessageCount - 1;
  const totalUserMessageCount = currentMessages.filter((message) => message.role === "user").length;
  const rollbackUserMessageCount = Math.max(0, totalUserMessageCount - sourceUserMessageCount);
  const targetTurnId = getForkTargetTurnId(sourceMessage, sourceMessages);
  const now = new Date().toISOString();
  const forkedFrom = {
    sourceSessionId,
    sourceTitle: sourceSession.title,
    throughMessageId,
    createdAt: now,
  };

  let warning: string | undefined;
  let sessionFilePath: string | undefined;
  if (supportsNativeFork(sourceSession.agentId) && sourceUserMessageIndex >= 0) {
    await ensureSession(sourceSessionId);
    const initializedSourceSession = getTarget(sourceSessionId).session;
    const nativeFork: AgentForkResult = await window.electronAPI.agentForkSession(sourceSessionId, {
      newSessionId: sessionId,
      sourceSessionFilePath: initializedSourceSession.sessionFilePath,
      sourceUserMessageIndex,
      rollbackUserMessageCount,
      targetTurnId,
      sourceMessageContent: sourceMessage.content,
      throughMessageId,
    }).catch((error: unknown) => ({
      supported: true,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (nativeFork.success && nativeFork.sessionFilePath) {
      sessionFilePath = nativeFork.sessionFilePath;
    } else {
      const detail = nativeFork.error || nativeFork.reason;
      warning = detail
        ? `${getAgentName(sourceSession.agentId)} 原生分叉失败，当前会话使用隐藏上下文兼容模式。\n原因：${detail}`
        : `${getAgentName(sourceSession.agentId)} 原生分叉失败，当前会话使用隐藏上下文兼容模式。`;
    }
  } else if (supportsNativeFork(sourceSession.agentId)) {
    warning = `${getAgentName(sourceSession.agentId)} 原生分叉失败，当前会话使用隐藏上下文兼容模式。\n原因：没有可定位的用户消息`;
  }

  const session: ProjectSession = {
    id: sessionId,
    agentId: sourceSession.agentId,
    agentSessionId: sessionId,
    title: warning ? getCompatibleForkSessionTitle(sourceMessage) : getForkSessionTitle(sourceMessage),
    createdAt: now,
    lastActiveAt: now,
    ...(sessionFilePath ? { sessionFilePath } : {}),
    forkedFrom,
    ...(!sessionFilePath ? { forkContext: createSessionForkContext(sourceSession, sourceMessages, throughMessageId) } : {}),
  };
  const visibleMessages: ChatMessage[] = warning
    ? [...forkMessages, { id: crypto.randomUUID(), role: "system", content: warning, timestamp: Date.now() }]
    : forkMessages;

  const latestState = useProjectStore.getState();
  if (latestState.projects.some((candidate) => candidate.sessions.some((candidate) => candidate.id === sessionId))) {
    throw new Error("SESSION_ID_CONFLICT");
  }
  latestState.addSession(project.id, session, false);
  useChatStore.getState().loadSessionMessages(sessionId, visibleMessages);
  const sourceModel = getSessionModel(sourceSessionId);
  const sourceThinking = getSessionThinking(sourceSessionId);
  if (sourceModel) saveSessionModel(sessionId, sourceModel);
  if (sourceThinking) saveSessionThinking(sessionId, sourceThinking);
  const config = await getSessionConfig(sessionId);
  return {
    projectId: project.id,
    session: toRemoteSession(session, config),
    config,
    ...(warning ? { warning } : {}),
  };
}

async function closeSession(
  payload: Record<string, unknown>,
  context: RemoteCommandContext,
): Promise<RemoteSessionCreateResult> {
  const sessionId = getString(payload.sessionId);
  const { project, session } = getTarget(sessionId);
  if (!session.closed) {
    useProjectStore.getState().closeSession(project.id, sessionId);
    await window.electronAPI.agentRemoveSession(sessionId);
  }

  const chatState = useChatStore.getState();
  chatState.clearSessionQueue(sessionId);
  if (chatState.activeSessionId === sessionId) {
    chatState.switchSession(null);
    chatState.setStreaming(false);
  }
  context.clearPendingInteraction(sessionId);

  const updated = getTarget(sessionId).session;
  const config = await getSessionConfig(sessionId);
  return { projectId: project.id, session: toRemoteSession(updated, config), config };
}

async function reopenSession(payload: Record<string, unknown>): Promise<RemoteSessionCreateResult> {
  const sessionId = getString(payload.sessionId);
  const { project, session } = getTarget(sessionId);
  if (session.closed) useProjectStore.getState().reopenSession(project.id, sessionId);
  const updated = getTarget(sessionId).session;
  const config = await getSessionConfig(sessionId);
  return { projectId: project.id, session: toRemoteSession(updated, config), config };
}

async function sendMessage(payload: Record<string, unknown>) {
  const sessionId = getString(payload.sessionId);
  const content = getString(payload.content).trim();
  const clientMessageId = getString(payload.clientMessageId);
  if (!sessionId || !clientMessageId) throw new Error("INVALID_REQUEST");
  const { project, session } = await ensureSession(sessionId);
  const rawReferenceIds = Array.isArray(payload.sessionReferences)
    ? payload.sessionReferences.map((value) => getString(
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).sourceSessionId
          : undefined,
      )).filter(Boolean)
    : [];
  const referenceIds = [...new Set(rawReferenceIds)].slice(0, MAX_REMOTE_SESSION_REFERENCES);
  const sourceSessions = referenceIds.map((sourceSessionId) => {
    if (sourceSessionId === sessionId) throw new Error("INVALID_SESSION_REFERENCE");
    const sourceSession = project.sessions.find((candidate) => candidate.id === sourceSessionId);
    if (!sourceSession) throw new Error("INVALID_SESSION_REFERENCE");
    return sourceSession;
  });
  const currentMessages = useChatStore.getState().sessionMessages;
  const references = sourceSessions.map((sourceSession) => createSessionReferenceSnapshot(
    sourceSession,
    currentMessages[sourceSession.id] || [],
  ));
  const messageSessionReferences = references.map((reference) => ({
    sourceSessionId: reference.sourceSessionId,
    sourceTitle: reference.sourceTitle,
  }));
  const contextBlocks = [
    session.forkContext?.context,
    buildSessionReferencesContext(references),
  ].filter((value): value is string => !!value);
  const displayContent = content || (Array.isArray(payload.images) && payload.images.length > 0 ? "请查看附件图片。" : "");
  if (!displayContent && contextBlocks.length === 0) throw new Error("INVALID_REQUEST");
  const sendContent = contextBlocks.length > 0
    ? [
        ...contextBlocks,
        "",
        "<current_user_message>",
        displayContent,
        "</current_user_message>",
      ].join("\n")
    : displayContent;
  const clearForkContext = () => {
    if (session.forkContext) useProjectStore.getState().setSessionForkContext(project.id, session.id, undefined);
  };
  const rawImages = Array.isArray(payload.images) ? payload.images : [];
  const messageImages = rawImages.map((image) => {
    const raw = image as { id: string; name: string; mimeType: string; data: string };
    return { id: raw.id, name: raw.name, src: `data:${raw.mimeType};base64,${raw.data}` };
  });
  const agentImages: AgentImagePayload = rawImages.map((image) => {
    const raw = image as { mimeType: string; data: string };
    return { type: "image", mimeType: raw.mimeType, data: raw.data };
  });
  const running = useProjectStore.getState().agentStatuses[sessionId] === "running";
  const planModeEnabled = payload.planModeEnabled === true;
  if (running) {
    useChatStore.getState().enqueueMessage({
      id: clientMessageId,
      sessionId,
      displayContent: displayContent || getReferencesDisplayText(references),
      sendContent,
      messageImages,
      sessionReferences: messageSessionReferences.length > 0 ? messageSessionReferences : undefined,
      agentImages,
      planModeEnabled,
      createdAt: Date.now(),
      status: "queued",
    });
    clearForkContext();
    return { queued: true, clientMessageId };
  }

  const chatState = useChatStore.getState();
  chatState.addMessage({
    id: clientMessageId,
    role: "user",
    content: displayContent,
    timestamp: Date.now(),
    images: messageImages.length > 0 ? messageImages : undefined,
    sessionReferences: messageSessionReferences.length > 0 ? messageSessionReferences : undefined,
  }, sessionId);
  useProjectStore.getState().setAgentStatus(sessionId, "running");
  if (chatState.activeSessionId === sessionId) chatState.setStreaming(true);
  clearForkContext();

  try {
    const model = getSessionModel(sessionId) || (chatState.activeSessionId === sessionId ? chatState.currentModel : null);
    if (model) {
      const modelResult = await window.electronAPI.agentSetModel(model.provider, model.id, sessionId);
      if (!modelResult.success) throw new Error(modelResult.error || "MODEL_SWITCH_FAILED");
    }
    const thinking = getSessionThinking(sessionId);
    if (thinking) await window.electronAPI.agentSetThinkingLevel(thinking, sessionId);

    const result = await window.electronAPI.agentSendMessage(
      sendContent,
      agentImages.length > 0 ? agentImages : undefined,
      sessionId,
      { planModeEnabled, clientMessageId },
    );
    if (!result.success) throw new Error(result.error || "SEND_FAILED");
  } catch (error) {
    useProjectStore.getState().setAgentStatus(sessionId, "error");
    if (useChatStore.getState().activeSessionId === sessionId) useChatStore.getState().setStreaming(false);
    useChatStore.getState().addMessage({
      id: crypto.randomUUID(),
      role: "system",
      content: `Remote send failed: ${error instanceof Error ? error.message : String(error)}`,
      timestamp: Date.now(),
    }, sessionId);
    throw error;
  }
  return { queued: false, clientMessageId, agentId: session.agentId };
}

async function setModel(payload: Record<string, unknown>) {
  const sessionId = getString(payload.sessionId);
  if (useProjectStore.getState().agentStatuses[sessionId] === "running") throw new Error("SESSION_BUSY");
  const { session } = await ensureSession(sessionId);
  const models = await window.electronAPI.agentGetModels(sessionId);
  const model = models.find((candidate) => candidate.provider === payload.provider && candidate.id === payload.modelId);
  if (!model) throw new Error("MODEL_NOT_FOUND");
  const previous = getSessionModel(sessionId);
  if (requiresProviderActivation(session.agentId) && previous && previous.provider !== model.provider) {
    const activation = await window.electronAPI.agentConfigActivate(session.agentId, model.provider);
    if (!activation.success) throw new Error(activation.error || "PROVIDER_ACTIVATION_FAILED");
  }
  const result = await window.electronAPI.agentSetModel(model.provider, model.id, sessionId);
  if (!result.success) throw new Error(result.error || "MODEL_SWITCH_FAILED");
  saveSessionModel(sessionId, model as ModelInfo);
  if (useChatStore.getState().activeSessionId === sessionId) {
    useChatStore.getState().setCurrentModel(model as ModelInfo);
    useChatStore.getState().setAvailableModels(models);
  }
  return publishSessionConfig(sessionId, true);
}

async function setThinking(payload: Record<string, unknown>) {
  const sessionId = getString(payload.sessionId);
  const level = getString(payload.level);
  if (useProjectStore.getState().agentStatuses[sessionId] === "running") throw new Error("SESSION_BUSY");
  await ensureSession(sessionId);
  const result = await window.electronAPI.agentSetThinkingLevel(level, sessionId);
  if (!result.success) throw new Error("THINKING_LEVEL_FAILED");
  saveSessionThinking(sessionId, level);
  if (useChatStore.getState().activeSessionId === sessionId) useChatStore.getState().setThinkingLevel(level);
  return publishSessionConfig(sessionId, true);
}

async function setPlanMode(payload: Record<string, unknown>) {
  const data = await window.electronAPI.loadData("settings").catch(() => null);
  const settings = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const general = settings.general && typeof settings.general === "object" && !Array.isArray(settings.general)
    ? settings.general as Record<string, unknown>
    : {};
  const enabled = payload.enabled === true;
  const result = await window.electronAPI.saveData("settings", {
    ...settings,
    general: { ...general, planModeEnabled: enabled },
  });
  if (!result.success) throw new Error(result.error || "SETTINGS_SAVE_FAILED");
  window.dispatchEvent(new CustomEvent("agent-settings-updated", { detail: { planModeEnabled: enabled } }));
  for (const project of useProjectStore.getState().projects) {
    for (const session of project.sessions) void publishSessionConfig(session.id);
  }
  return { enabled };
}

async function respondToInteraction(payload: Record<string, unknown>, context: RemoteCommandContext) {
  const sessionId = getString(payload.sessionId);
  const pending = context.pendingInteraction;
  if (!pending || pending.sessionId !== sessionId) throw new Error("INTERACTION_NOT_FOUND");
  const cancelled = payload.cancelled === true;
  const answers = Array.isArray(payload.answers) ? payload.answers : undefined;
  const text = getString(payload.text);
  const summary = text || answers?.map((answer) => {
    const raw = answer && typeof answer === "object" ? answer as Record<string, unknown> : {};
    return String(raw.label || raw.answer || raw.value || "");
  }).filter(Boolean).join("\n") || (cancelled ? "Cancelled" : "Submitted response");
  const result = await window.electronAPI.agentSendUIResponse({
    sessionId,
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
  context.clearPendingInteraction(sessionId);
  const chatStore = useChatStore.getState();
  if (pending.entryId) {
    chatStore.updateLastAssistantProcessEntry(pending.entryId, {
      state: cancelled ? "error" : "completed",
      expanded: false,
    }, sessionId);
    chatStore.finishAssistantProcessContainingEntry(
      pending.entryId,
      Date.now(),
      cancelled ? "interrupted" : "completed",
      sessionId,
    );
  } else {
    chatStore.finishLastAssistantProcess(Date.now(), cancelled ? "interrupted" : "completed", sessionId);
  }
  chatStore.addMessage({
    id: crypto.randomUUID(),
    role: "user",
    content: summary,
    timestamp: Date.now(),
  }, sessionId);
  return { cancelled };
}

async function guideQueuedMessage(payload: Record<string, unknown>) {
  const sessionId = getString(payload.sessionId);
  const queueItemId = getString(payload.queueItemId);
  const { session } = getTarget(sessionId);
  if (!supportsGuidance(session.agentId)) throw new Error("GUIDANCE_NOT_SUPPORTED");
  if (useProjectStore.getState().agentStatuses[sessionId] !== "running") throw new Error("SESSION_NOT_RUNNING");

  const chatStore = useChatStore.getState();
  const item = (chatStore.messageQueues[sessionId] || []).find((candidate) => candidate.id === queueItemId);
  if (!item) throw new Error("QUEUE_ITEM_NOT_FOUND");
  if (item.status === "sending") throw new Error("QUEUE_ITEM_BUSY");

  chatStore.markQueuedMessageSending(sessionId, queueItemId);
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
    const message = error instanceof Error ? error.message : String(error);
    useChatStore.getState().markQueuedMessageFailed(sessionId, queueItemId, message);
    throw error;
  }
}

async function reloadSession(payload: Record<string, unknown>) {
  const sessionId = getString(payload.sessionId);
  if (useProjectStore.getState().agentStatuses[sessionId] === "running") throw new Error("SESSION_BUSY");
  const { session } = await ensureSession(sessionId);
  const result = await window.electronAPI.agentReloadConfig(session.agentId, sessionId);
  if (!result.success) throw new Error(result.error || "SESSION_RELOAD_FAILED");
  const config = await publishSessionConfig(sessionId, true);
  return {
    reloaded: result.reloadedSessionIds?.includes(sessionId) === true,
    config,
  };
}

function removeQueuedMessage(payload: Record<string, unknown>) {
  const sessionId = getString(payload.sessionId);
  const queueItemId = getString(payload.queueItemId);
  getTarget(sessionId);
  const item = (useChatStore.getState().messageQueues[sessionId] || [])
    .find((candidate) => candidate.id === queueItemId);
  if (!item) throw new Error("QUEUE_ITEM_NOT_FOUND");
  if (item.status === "sending") throw new Error("QUEUE_ITEM_BUSY");
  useChatStore.getState().removeQueuedMessage(sessionId, queueItemId);
  return { success: true, queueItemId };
}

export async function abortRemoteSession(sessionId: string, context: RemoteCommandContext) {
  const success = await context.abortSession(sessionId);
  if (!success) throw new Error("ABORT_FAILED");
  context.clearPendingInteraction(sessionId);
  return { success: true };
}

export async function executeRemoteSessionCommand(
  command: RemoteRendererCommand,
  context: RemoteCommandContext,
): Promise<unknown> {
  switch (command.name) {
    case "session.create":
      return createSession(command.payload);
    case "session.fork":
      return forkSession(command.payload);
    case "session.close":
      return closeSession(command.payload, context);
    case "session.reopen":
      return reopenSession(command.payload);
    case "session.send":
      return sendMessage(command.payload);
    case "session.abort": {
      const sessionId = getString(command.payload.sessionId);
      await ensureSession(sessionId);
      return abortRemoteSession(sessionId, context);
    }
    case "session.reload":
      return reloadSession(command.payload);
    case "session.queue.guide":
      return guideQueuedMessage(command.payload);
    case "session.queue.remove":
      return removeQueuedMessage(command.payload);
    case "session.setModel":
      return setModel(command.payload);
    case "session.setThinking":
      return setThinking(command.payload);
    case "session.models.get": {
      const sessionId = getString(command.payload.sessionId);
      await ensureSession(sessionId);
      return publishSessionConfig(sessionId, true);
    }
    case "settings.setPlanMode":
      return setPlanMode(command.payload);
    case "interaction.respond":
      return respondToInteraction(command.payload, context);
    default:
      throw new Error("UNSUPPORTED_REMOTE_COMMAND");
  }
}
