import { useCallback, useEffect, useRef, useState } from "react";
import { getSessionModel, getSessionThinking, SESSION_CONFIG_UPDATED_EVENT } from "@/hooks/useDataPersistence";
import { executeRemoteSessionCommand } from "@/lib/remote-session-commands";
import { relativeRemotePath } from "@/lib/project-file-path";
import { getChatMessagePreviewText } from "@/lib/chat-message-preview";

export { relativeRemotePath } from "@/lib/project-file-path";
import { useChatStore, isUserSpeechMessage, type ChatMessage, type QueuedMessage } from "@/stores/chat-store";
import { useAgentCatalogStore } from "@/stores/agent-catalog-store";
import { useProjectStore, type AgentStatus, type Project } from "@/stores/project-store";
import type { PendingUIResponse } from "@/components/layout/agentEventTypes";
import type { PendingUIResponses } from "@/components/layout/usePendingUIResponse";
import type {
  RemoteChatMessage,
  RemoteAgent,
  RemoteInteraction,
  RemoteProject,
  RemoteQueuedMessage,
  RemoteRendererPublish,
  RemoteSessionConfig,
} from "@/types";
import { normalizeAgentPermissionMode, type AgentPermissionMode } from "@shared/agent-permissions";
import {
  getActiveAssistantTurnId,
  normalizeProcessForView,
  type ProcessTerminalViewState,
} from "@shared/process-view";

type UseRemoteBridgeOptions = {
  pendingInteractions: PendingUIResponses;
  getPendingInteraction: (sessionId: string) => PendingUIResponse;
  clearPendingInteraction: (sessionId: string) => void;
  abortSession: (sessionId: string) => Promise<boolean>;
  onInteractionResponsePrepared?: (sessionId: string) => void;
  onInteractionResponseAccepted?: (sessionId: string) => void;
  onInteractionResponseFailed?: (
    sessionId: string,
    pendingInteraction: Exclude<PendingUIResponse, null>,
  ) => void | Promise<void>;
};

export function sanitizeRemoteMessage(
  message: ChatMessage,
  projectPath: string,
  options: {
    turnRunning?: boolean;
    terminalState?: ProcessTerminalViewState;
  } = {},
): RemoteChatMessage {
  const turnRunning = options.turnRunning !== false;
  const fallbackProcessEndedAt = Math.max(
    message.timestamp,
    ...(message.commentary || []).map((item) => item.timestamp),
  );
  const process = message.process ? normalizeProcessForView(message.process, {
    running: turnRunning,
    terminalState: options.terminalState,
    fallbackEndedAt: fallbackProcessEndedAt,
  }) : undefined;
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    isStreaming: message.isStreaming === true ? turnRunning : message.isStreaming,
    systemType: message.systemType,
    compactionState: message.compactionState,
    modelLabel: message.modelLabel,
    tokenUsage: message.tokenUsage ? { ...message.tokenUsage } : undefined,
    nativeTurnId: message.nativeTurnId,
    commentary: message.commentary?.map((item) => ({
      id: item.id,
      content: item.content,
      timestamp: item.timestamp,
      isStreaming: item.isStreaming === true ? turnRunning : item.isStreaming,
    })),
    action: message.action ? { kind: message.action.kind, name: message.action.name } : undefined,
    composerDocument: message.composerDocument ? {
      version: message.composerDocument.version,
      nodes: message.composerDocument.nodes.map((node) => node.type === "image"
        ? { id: node.id, type: node.type, name: node.name, mimeType: node.mimeType }
        : node),
    } : undefined,
    sessionReferences: message.sessionReferences?.map((reference) => ({
      sourceSessionId: reference.sourceSessionId,
      sourceTitle: reference.sourceTitle,
    })),
    images: message.images
      ?.filter((image) => image.src.startsWith("data:image/"))
      .map(({ id, src, name }) => ({ id, src, name })),
    diffs: message.diffs?.map((diff) => ({
      ...diff,
      file: relativeRemotePath(diff.file, projectPath),
    })),
    process: process ? {
      startedAt: process.startedAt,
      endedAt: process.endedAt,
      planSteps: process.planSteps,
      planStepsSource: process.planStepsSource,
      changeSummary: process.changeSummary,
      entries: process.entries.map((entry) => ({
        id: entry.id,
        type: entry.type,
        kind: entry.kind,
        title: entry.title,
        toolKind: entry.toolKind,
        detail: entry.detail,
        prompt: entry.prompt,
        command: entry.command,
        exitCode: entry.exitCode,
        timestamp: entry.timestamp,
        state: entry.state,
        phase: entry.phase,
        action: entry.action,
        tool: entry.tool,
        activityKind: entry.activityKind,
        startedAt: entry.startedAt,
        completedAt: entry.completedAt,
        ...(entry.guidanceDocument ? {
          guidanceDocument: {
            version: entry.guidanceDocument.version,
            nodes: entry.guidanceDocument.nodes.map((node) => node.type === "image"
              ? { id: node.id, type: node.type, name: node.name, mimeType: node.mimeType }
              : node),
          },
        } : {}),
        ...(entry.guidanceImages?.length ? {
          guidanceImages: entry.guidanceImages
            .filter((image) => image.src.startsWith("data:image/"))
            .map(({ id, src, name }) => ({ id, src, name })),
        } : {}),
        files: entry.files?.map((file) => ({
          ...file,
          file: relativeRemotePath(file.file, projectPath),
        })),
        subagents: entry.subagents?.map((subagent) => ({
          id: subagent.id,
          label: subagent.label,
          status: subagent.status,
          model: subagent.model,
          path: subagent.path,
          message: subagent.message,
          prompt: subagent.prompt,
          ...(subagent.usage ? { usage: subagent.usage } : {}),
        })),
      })),
    } : undefined,
  };
}

export function sanitizeRemoteMessages(
  messages: ChatMessage[],
  projectPath: string,
  sessionStatus: AgentStatus,
) {
  const activeTurnId = getActiveAssistantTurnId(messages, sessionStatus === "running");
  const terminalState: ProcessTerminalViewState = sessionStatus === "error" ? "error" : "completed";
  return messages.map((message) => sanitizeRemoteMessage(message, projectPath, {
    turnRunning: message.id === activeTurnId,
    terminalState,
  }));
}

export function shouldPublishRemoteMessagesReplace(
  previous: ChatMessage[],
  next: ChatMessage[],
  sessionStatus: AgentStatus,
) {
  if (!canPublishMessageUpsert(previous, next)) return true;
  const sessionRunning = sessionStatus === "running";
  const previousActiveTurnId = getActiveAssistantTurnId(previous, sessionRunning);
  return previousActiveTurnId !== null &&
    previousActiveTurnId !== getActiveAssistantTurnId(next, sessionRunning);
}

export function getRemoteStatusSettlementUpdates(
  previousStatuses: Record<string, AgentStatus>,
  nextStatuses: Record<string, AgentStatus>,
  projects: Project[],
  sessionMessages: Record<string, ChatMessage[]>,
): RemoteMessagePublish[] {
  const updates: RemoteMessagePublish[] = [];
  for (const [sessionId, previousStatus] of Object.entries(previousStatuses)) {
    const project = getProjectForSession(projects, sessionId);
    if (previousStatus !== "running" || !project) continue;
    // Closing a session removes its explicit status while retaining it in the
    // catalog. Treat that missing value exactly like buildCatalog does: idle.
    const nextStatus = nextStatuses[sessionId] || "idle";
    if (nextStatus === "running") continue;
    updates.push({
      type: "session.messages.replace",
      sessionId,
      messages: sanitizeRemoteMessages(
        sessionMessages[sessionId] || [],
        project.path,
        nextStatus,
      ),
    });
  }
  return updates;
}

export function sanitizeQueue(queue: QueuedMessage[]): RemoteQueuedMessage[] {
  return queue.map((item) => ({
    id: item.id,
    sessionId: item.sessionId,
    editableContent: item.editableContent,
    displayContent: item.displayContent,
    status: item.status,
    createdAt: item.createdAt,
    error: item.error,
    action: item.action ? { kind: item.action.kind, name: item.action.name } : undefined,
    images: (item.editableDraft?.images || item.messageImages?.map((image) => ({
      ...image,
      mimeType: /^data:([^;,]+)[;,]/.exec(image.src)?.[1] || "image/png",
    })) || []).map((image) => ({
        id: image.id,
        name: image.name,
        src: image.src,
        mimeType: image.mimeType,
      })),
    sessionReferences: item.editableDraft?.sessionReferences.map((reference) => ({
      sourceSessionId: reference.sourceSessionId,
      sourceTitle: reference.sourceTitle,
    })) || item.sessionReferences,
    attachments: item.editableDraft ? [
      ...item.editableDraft.pendingFiles.map((file) => ({
        id: file.id,
        name: `${file.fileName}:${file.startLine}-${file.endLine}`,
        kind: "snippet" as const,
      })),
      ...item.editableDraft.pendingPathAttachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        kind: attachment.kind,
      })),
    ] : undefined,
    composerDocument: item.composerDocument ? {
      version: item.composerDocument.version,
      nodes: item.composerDocument.nodes.map((node) => node.type === "image"
        ? { id: node.id, type: node.type, name: node.name, mimeType: node.mimeType }
        : node),
    } : undefined,
  }));
}

function getProjectForSession(projects: Project[], sessionId: string) {
  return projects.find((project) => project.sessions.some((session) => session.id === sessionId));
}

function buildSessionConfig(
  sessionId: string,
  planModeEnabled: boolean,
  permissionMode: AgentPermissionMode,
): RemoteSessionConfig {
  const chatState = useChatStore.getState();
  const isActiveSession = chatState.activeSessionId === sessionId;
  return {
    // 活跃会话必须以当前运行时状态为准。持久化模型可能是旧版本在
    // 跨 Agent 切换时遗留的值，不能在模型目录为空时继续同步给远端客户端。
    model: isActiveSession ? chatState.currentModel : getSessionModel(sessionId),
    thinkingLevel: isActiveSession ? chatState.thinkingLevel : (getSessionThinking(sessionId) || "medium"),
    planModeEnabled,
    permissionMode,
    availableModels: isActiveSession ? chatState.availableModels : undefined,
  };
}

export function getRemoteSessionTitle(sessionTitle: string, messages: ChatMessage[]) {
  const firstUserMessage = messages.find((message) => isUserSpeechMessage(message) && message.content.trim());
  if (!firstUserMessage) return sessionTitle;
  return getChatMessagePreviewText(firstUserMessage) || sessionTitle;
}

function buildCatalog(
  projects: Project[],
  planModeEnabled: boolean,
  permissionMode: AgentPermissionMode,
): RemoteProject[] {
  const statuses = useProjectStore.getState().agentStatuses;
  const messages = useChatStore.getState().sessionMessages;
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    sessions: project.sessions.map((session) => ({
      id: session.id,
      agentId: session.agentId,
      title: getRemoteSessionTitle(session.title, messages[session.id] || []),
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      closed: session.closed === true,
      status: statuses[session.id] || "idle",
      forkedFrom: session.forkedFrom ? {
        sourceSessionId: session.forkedFrom.sourceSessionId,
        sourceTitle: session.forkedFrom.sourceTitle,
      } : undefined,
      config: buildSessionConfig(session.id, planModeEnabled, permissionMode),
    })),
  }));
}

export function sanitizeRemoteAgent(agent: {
  id: string;
  name: string;
  desc?: string;
  description?: string;
  runtime: "cli" | "sdk" | "plugin";
  capabilities?: { providerActivation?: string; guidance?: boolean; actions?: boolean; permissions?: boolean };
}): RemoteAgent {
  const description = agent.description || agent.desc;
  return {
    id: agent.id,
    name: agent.name,
    ...(description ? { description } : {}),
    runtime: agent.runtime,
    ...(agent.capabilities?.providerActivation === "single-active"
      ? { requiresProviderActivation: true }
      : {}),
    ...(agent.capabilities?.guidance === true ? { supportsGuidance: true } : {}),
    ...(agent.capabilities?.actions === true ? { supportsActions: true } : {}),
    ...(agent.capabilities?.permissions === true ? { supportsPermissions: true } : {}),
  };
}

export function toRemoteInteraction(value: PendingUIResponse): RemoteInteraction | null {
  if (!value) return null;
  return {
    sessionId: value.sessionId,
    requestId: value.requestId,
    method: value.method,
    ...(value.title ? { title: value.title } : {}),
    ...(value.description ? { description: value.description } : {}),
    questions: value.questions || [],
  };
}

type RemoteInteractionPublish = Extract<RemoteRendererPublish, { type: "session.interaction" }>;

export function buildRemoteInteractionSnapshot(
  sessions: ReadonlyArray<{ id: string; closed?: boolean }>,
  getPendingInteraction: (sessionId: string) => PendingUIResponse,
): Record<string, RemoteInteraction | null> {
  const interactions: Record<string, RemoteInteraction | null> = {};
  for (const session of sessions) {
    interactions[session.id] = session.closed
      ? null
      : toRemoteInteraction(getPendingInteraction(session.id));
  }
  return interactions;
}

export function getRemoteInteractionUpdates(
  previous: PendingUIResponses,
  current: PendingUIResponses,
): RemoteInteractionPublish[] {
  const updates: RemoteInteractionPublish[] = [];
  const sessionIds = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const sessionId of sessionIds) {
    if (previous[sessionId] === current[sessionId]) continue;
    updates.push({
      type: "session.interaction",
      sessionId,
      interaction: toRemoteInteraction(current[sessionId] || null),
    });
  }
  return updates;
}

export function canPublishMessageUpsert(previous: ChatMessage[], next: ChatMessage[]) {
  if (next.length === 0) return false;
  if (next.length !== previous.length && next.length !== previous.length + 1) return false;
  const prefixLength = next.length - 1;
  for (let index = 0; index < prefixLength; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

export function shouldFlushPendingMessageUpdate(
  pending: RemoteRendererPublish | undefined,
  update: RemoteRendererPublish,
) {
  return pending?.type === "session.message.upsert" &&
    update.type === "session.message.upsert" &&
    pending.message.id !== update.message.id;
}

export type RemoteMessagePublish = Extract<
  RemoteRendererPublish,
  { type: "session.message.upsert" | "session.messages.replace" }
>;

export function coalescePendingMessageUpdate(
  pending: RemoteMessagePublish | undefined,
  update: RemoteMessagePublish,
): { pending: RemoteMessagePublish; flush?: RemoteMessagePublish } {
  if (!pending) return { pending: update };
  if (pending.sessionId !== update.sessionId) return { pending: update, flush: pending };

  // A replace is an authoritative repair of the whole message list. Never
  // downgrade it to a later single-message upsert while it is still queued;
  // fold that upsert into the replace instead so both updates reach clients.
  if (pending.type === "session.messages.replace" && update.type === "session.message.upsert") {
    const messages = [...pending.messages];
    const index = messages.findIndex((message) => message.id === update.message.id);
    if (index >= 0) messages[index] = update.message;
    else messages.push(update.message);
    return { pending: { ...pending, messages } };
  }

  // A newer full replacement already contains any preceding upsert and can
  // supersede it without an intermediate publish.
  if (update.type === "session.messages.replace") return { pending: update };
  if (shouldFlushPendingMessageUpdate(pending, update)) return { pending: update, flush: pending };
  return { pending: update };
}

export function flushPendingMessageUpdates(
  pendingUpdates: Map<string, RemoteMessagePublish>,
  publish: (update: RemoteMessagePublish) => void,
) {
  for (const update of pendingUpdates.values()) publish(update);
  pendingUpdates.clear();
}

export function useRemoteBridge({
  pendingInteractions,
  getPendingInteraction,
  clearPendingInteraction,
  abortSession,
  onInteractionResponsePrepared,
  onInteractionResponseAccepted,
  onInteractionResponseFailed,
}: UseRemoteBridgeOptions) {
  const [planModeEnabled, setPlanModeEnabled] = useState(false);
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>("auto");
  const publishedInteractionsRef = useRef<PendingUIResponses>({});
  const planModeRef = useRef(false);
  const permissionModeRef = useRef<AgentPermissionMode>("auto");
  const remoteAgentsRef = useRef<RemoteAgent[]>([]);
  const messageTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingMessageUpdatesRef = useRef(new Map<string, RemoteMessagePublish>());

  planModeRef.current = planModeEnabled;
  permissionModeRef.current = permissionMode;

  const publish = useCallback((update: RemoteRendererPublish) => {
    window.electronAPI.remotePublish(update);
  }, []);

  const clearRemotePendingInteraction = useCallback((sessionId: string) => {
    clearPendingInteraction(sessionId);
    publish({ type: "session.interaction", sessionId, interaction: null });
    const current = publishedInteractionsRef.current;
    if (!current[sessionId]) return;
    const next = { ...current };
    delete next[sessionId];
    publishedInteractionsRef.current = next;
  }, [clearPendingInteraction, publish]);

  const publishSnapshot = useCallback(() => {
    const projectState = useProjectStore.getState();
    const chatState = useChatStore.getState();
    const messages: Record<string, RemoteChatMessage[]> = {};
    const queues: Record<string, RemoteQueuedMessage[]> = {};
    const configs: Record<string, RemoteSessionConfig> = {};
    const sessions = projectState.projects.flatMap((project) => project.sessions);
    const interactions = buildRemoteInteractionSnapshot(sessions, getPendingInteraction);
    for (const project of projectState.projects) {
      for (const session of project.sessions) {
        messages[session.id] = sanitizeRemoteMessages(
          chatState.sessionMessages[session.id] || [],
          project.path,
          projectState.agentStatuses[session.id] || "idle",
        );
        queues[session.id] = sanitizeQueue(chatState.messageQueues[session.id] || []);
        configs[session.id] = buildSessionConfig(session.id, planModeRef.current, permissionModeRef.current);
      }
    }
    publish({
      type: "snapshot",
      catalog: buildCatalog(projectState.projects, planModeRef.current, permissionModeRef.current),
      agents: remoteAgentsRef.current,
      messages,
      queues,
      interactions,
      configs,
    });
  }, [getPendingInteraction, publish]);

  useEffect(() => {
    let cancelled = false;
    let previousAgents = useAgentCatalogStore.getState().agents;
    let refreshGeneration = 0;
    const refresh = async (agents = useAgentCatalogStore.getState().agents) => {
      const generation = ++refreshGeneration;
      const statuses = await Promise.all(agents.map(async (agent) => {
        try {
          const status = await window.electronAPI.agentGetStatus(agent.id);
          return status.installed === true ? sanitizeRemoteAgent(agent) : null;
        } catch {
          return null;
        }
      }));
      if (cancelled || generation !== refreshGeneration) return;
      remoteAgentsRef.current = statuses.filter((agent): agent is RemoteAgent => agent !== null);
      const projectState = useProjectStore.getState();
      publish({
        type: "catalog",
        catalog: buildCatalog(projectState.projects, planModeRef.current, permissionModeRef.current),
        agents: remoteAgentsRef.current,
      });
    };

    const catalogState = useAgentCatalogStore.getState();
    if (catalogState.loaded) {
      void refresh(catalogState.agents);
    } else {
      void catalogState.loadAgents().then((agents) => {
        previousAgents = agents;
        return refresh(agents);
      });
    }
    const unsubscribe = useAgentCatalogStore.subscribe((state) => {
      if (state.agents === previousAgents) return;
      previousAgents = state.agents;
      void refresh(state.agents);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [publish]);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.loadData("settings").then((data) => {
      const settings = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
      const general = settings.general && typeof settings.general === "object" && !Array.isArray(settings.general)
        ? settings.general as Record<string, unknown>
        : {};
      if (cancelled) return;
      const enabled = general.planModeEnabled === true;
      const nextPermissionMode = normalizeAgentPermissionMode(general.permissionMode);
      setPlanModeEnabled(enabled);
      setPermissionMode(nextPermissionMode);
      planModeRef.current = enabled;
      permissionModeRef.current = nextPermissionMode;
      setTimeout(publishSnapshot, 0);
    });
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<{
        planModeEnabled?: boolean;
        permissionMode?: AgentPermissionMode;
      }>).detail;
      const hasPlanUpdate = typeof detail?.planModeEnabled === "boolean";
      const hasPermissionUpdate = detail?.permissionMode !== undefined;
      if (!hasPlanUpdate && !hasPermissionUpdate) return;
      const nextPlanModeEnabled = hasPlanUpdate ? detail.planModeEnabled! : planModeRef.current;
      const nextPermissionMode = hasPermissionUpdate
        ? normalizeAgentPermissionMode(detail.permissionMode)
        : permissionModeRef.current;
      setPlanModeEnabled(nextPlanModeEnabled);
      setPermissionMode(nextPermissionMode);
      planModeRef.current = nextPlanModeEnabled;
      permissionModeRef.current = nextPermissionMode;
      const projectState = useProjectStore.getState();
      publish({
        type: "catalog",
        catalog: buildCatalog(projectState.projects, nextPlanModeEnabled, nextPermissionMode),
        agents: remoteAgentsRef.current,
      });
      for (const project of projectState.projects) {
        for (const session of project.sessions) {
          publish({
            type: "session.config",
            sessionId: session.id,
            config: buildSessionConfig(session.id, nextPlanModeEnabled, nextPermissionMode),
          });
        }
      }
    };
    window.addEventListener("agent-settings-updated", onSettings);
    return () => {
      cancelled = true;
      window.removeEventListener("agent-settings-updated", onSettings);
    };
  }, [publish, publishSnapshot]);

  useEffect(() => {
    const onSessionConfigUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      const sessionId = detail?.sessionId;
      if (!sessionId || !getProjectForSession(useProjectStore.getState().projects, sessionId)) return;
      publish({
        type: "session.config",
        sessionId,
        config: buildSessionConfig(sessionId, planModeRef.current, permissionModeRef.current),
      });
    };
    window.addEventListener(SESSION_CONFIG_UPDATED_EVENT, onSessionConfigUpdated);
    return () => window.removeEventListener(SESSION_CONFIG_UPDATED_EVENT, onSessionConfigUpdated);
  }, [publish]);

  useEffect(() => {
    let previousProjects = useProjectStore.getState().projects;
    let previousStatuses = useProjectStore.getState().agentStatuses;
    const unsubscribe = useProjectStore.subscribe((state) => {
      if (state.projects === previousProjects && state.agentStatuses === previousStatuses) return;
      const settlementUpdates = state.agentStatuses === previousStatuses
        ? []
        : getRemoteStatusSettlementUpdates(
            previousStatuses,
            state.agentStatuses,
            state.projects,
            useChatStore.getState().sessionMessages,
          );
      previousProjects = state.projects;
      previousStatuses = state.agentStatuses;
      publish({ type: "catalog", catalog: buildCatalog(state.projects, planModeRef.current, permissionModeRef.current), agents: remoteAgentsRef.current });
      for (const update of settlementUpdates) {
        const timer = messageTimersRef.current.get(update.sessionId);
        if (timer) clearTimeout(timer);
        messageTimersRef.current.delete(update.sessionId);
        // A queued running upsert is older than this authoritative terminal
        // replacement. Remove it so it cannot revive the remote cache after
        // the catalog has already reported the session as idle/completed.
        pendingMessageUpdatesRef.current.delete(update.sessionId);
        publish(update);
      }
    });
    return unsubscribe;
  }, [publish]);

  useEffect(() => {
    let previousMessages = useChatStore.getState().sessionMessages;
    let previousQueues = useChatStore.getState().messageQueues;
    let previousCurrentModel = useChatStore.getState().currentModel;
    let previousThinking = useChatStore.getState().thinkingLevel;
    let previousModels = useChatStore.getState().availableModels;
    const scheduleMessagePublish = (sessionId: string, update: RemoteMessagePublish) => {
      const pending = pendingMessageUpdatesRef.current.get(sessionId);
      const coalesced = coalescePendingMessageUpdate(pending, update);
      if (coalesced.flush) publish(coalesced.flush);
      pendingMessageUpdatesRef.current.set(sessionId, coalesced.pending);
      if (messageTimersRef.current.has(sessionId)) return;
      const timer = setTimeout(() => {
        messageTimersRef.current.delete(sessionId);
        const pending = pendingMessageUpdatesRef.current.get(sessionId);
        pendingMessageUpdatesRef.current.delete(sessionId);
        if (pending) publish(pending);
      }, 100);
      messageTimersRef.current.set(sessionId, timer);
    };
    const unsubscribe = useChatStore.subscribe((state) => {
      if (state.sessionMessages !== previousMessages) {
        const projects = useProjectStore.getState().projects;
        const sessionIds = new Set([...Object.keys(previousMessages), ...Object.keys(state.sessionMessages)]);
        let catalogTitleChanged = false;
        for (const sessionId of sessionIds) {
          const previous = previousMessages[sessionId] || [];
          const next = state.sessionMessages[sessionId] || [];
          if (previous === next) continue;
          if (getRemoteSessionTitle("", previous) !== getRemoteSessionTitle("", next)) {
            catalogTitleChanged = true;
          }
          const project = getProjectForSession(projects, sessionId);
          if (!project) continue;
          const sessionStatus = useProjectStore.getState().agentStatuses[sessionId] || "idle";
          const activeTurnId = getActiveAssistantTurnId(next, sessionStatus === "running");
          const terminalState: ProcessTerminalViewState = sessionStatus === "error" ? "error" : "completed";
          if (!shouldPublishRemoteMessagesReplace(previous, next, sessionStatus)) {
            scheduleMessagePublish(sessionId, {
              type: "session.message.upsert",
              sessionId,
              message: sanitizeRemoteMessage(next[next.length - 1], project.path, {
                turnRunning: next[next.length - 1].id === activeTurnId,
                terminalState,
              }),
            });
          } else {
            scheduleMessagePublish(sessionId, {
              type: "session.messages.replace",
              sessionId,
              messages: sanitizeRemoteMessages(next, project.path, sessionStatus),
            });
          }
        }
        if (catalogTitleChanged) {
          publish({ type: "catalog", catalog: buildCatalog(projects, planModeRef.current, permissionModeRef.current), agents: remoteAgentsRef.current });
        }
        previousMessages = state.sessionMessages;
      }
      if (state.messageQueues !== previousQueues) {
        const sessionIds = new Set([...Object.keys(previousQueues), ...Object.keys(state.messageQueues)]);
        for (const sessionId of sessionIds) {
          if (previousQueues[sessionId] !== state.messageQueues[sessionId]) {
            publish({ type: "session.queue", sessionId, queue: sanitizeQueue(state.messageQueues[sessionId] || []) });
          }
        }
        previousQueues = state.messageQueues;
      }
      if (
        state.currentModel !== previousCurrentModel ||
        state.thinkingLevel !== previousThinking ||
        state.availableModels !== previousModels
      ) {
        previousCurrentModel = state.currentModel;
        previousThinking = state.thinkingLevel;
        previousModels = state.availableModels;
        if (state.activeSessionId) {
          publish({
            type: "session.config",
            sessionId: state.activeSessionId,
            config: buildSessionConfig(state.activeSessionId, planModeRef.current, permissionModeRef.current),
          });
        }
      }
    });
    return () => {
      unsubscribe();
      for (const timer of messageTimersRef.current.values()) clearTimeout(timer);
      messageTimersRef.current.clear();
      flushPendingMessageUpdates(pendingMessageUpdatesRef.current, publish);
    };
  }, [publish]);

  useEffect(() => {
    const previous = publishedInteractionsRef.current;
    for (const update of getRemoteInteractionUpdates(previous, pendingInteractions)) publish(update);
    publishedInteractionsRef.current = pendingInteractions;
  }, [pendingInteractions, publish]);

  useEffect(() => window.electronAPI.onRemoteCommand((command) => {
    void executeRemoteSessionCommand(command, {
      getPendingInteraction,
      abortSession,
      clearPendingInteraction: clearRemotePendingInteraction,
      onInteractionResponsePrepared,
      onInteractionResponseAccepted,
      onInteractionResponseFailed,
    }).then((payload) => {
      window.electronAPI.remoteCommandResult({ commandId: command.commandId, success: true, payload });
    }).catch((error: unknown) => {
      window.electronAPI.remoteCommandResult({
        commandId: command.commandId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }), [
    abortSession,
    clearRemotePendingInteraction,
    getPendingInteraction,
    onInteractionResponseAccepted,
    onInteractionResponseFailed,
    onInteractionResponsePrepared,
  ]);

  useEffect(() => {
    const timer = setTimeout(publishSnapshot, 750);
    return () => clearTimeout(timer);
  }, [publishSnapshot]);
}
