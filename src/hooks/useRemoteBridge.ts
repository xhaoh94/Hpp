import { useCallback, useEffect, useRef, useState } from "react";
import { getSessionModel, getSessionThinking, SESSION_CONFIG_UPDATED_EVENT } from "@/hooks/useDataPersistence";
import { executeRemoteSessionCommand } from "@/lib/remote-session-commands";
import { useChatStore, type ChatMessage, type QueuedMessage } from "@/stores/chat-store";
import { useAgentCatalogStore } from "@/stores/agent-catalog-store";
import { useProjectStore, type Project } from "@/stores/project-store";
import type { PendingUIResponse, PendingUIResponseUpdate } from "@/components/layout/agentEventTypes";
import type {
  RemoteChatMessage,
  RemoteAgent,
  RemoteInteraction,
  RemoteProject,
  RemoteQueuedMessage,
  RemoteRendererPublish,
  RemoteSessionConfig,
} from "@/types";

type UseRemoteBridgeOptions = {
  pendingInteraction: PendingUIResponse;
  setPendingInteraction: (next: PendingUIResponseUpdate) => void;
  abortSession: (sessionId: string) => Promise<boolean>;
};

const normalizeSlashes = (value: string) => value.replace(/\\/g, "/");

export function relativeRemotePath(value: string, projectPath: string) {
  const path = normalizeSlashes(value);
  const root = normalizeSlashes(projectPath).replace(/\/$/, "");
  if (path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return path.slice(root.length + 1);
  if (/^(?:[a-z]:\/|\/)/i.test(path)) return path.split("/").filter(Boolean).pop() || "file";
  return path;
}

export function sanitizeRemoteMessage(message: ChatMessage, projectPath: string): RemoteChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    isStreaming: message.isStreaming,
    systemType: message.systemType,
    nativeTurnId: message.nativeTurnId,
    action: message.action ? { kind: message.action.kind, name: message.action.name } : undefined,
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
    process: message.process ? {
      startedAt: message.process.startedAt,
      endedAt: message.process.endedAt,
      planSteps: message.process.planSteps,
      changeSummary: message.process.changeSummary,
      entries: message.process.entries.map((entry) => ({
        id: entry.id,
        type: entry.type,
        title: entry.title,
        toolKind: entry.toolKind,
        detail: entry.detail,
        command: entry.command,
        timestamp: entry.timestamp,
        state: entry.state,
        files: entry.files?.map((file) => ({
          ...file,
          file: relativeRemotePath(file.file, projectPath),
        })),
      })),
    } : undefined,
  };
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
  }));
}

function getProjectForSession(projects: Project[], sessionId: string) {
  return projects.find((project) => project.sessions.some((session) => session.id === sessionId));
}

function buildSessionConfig(sessionId: string, planModeEnabled: boolean): RemoteSessionConfig {
  const chatState = useChatStore.getState();
  return {
    model: getSessionModel(sessionId) || (chatState.activeSessionId === sessionId ? chatState.currentModel : null),
    thinkingLevel: getSessionThinking(sessionId) || (
      chatState.activeSessionId === sessionId ? chatState.thinkingLevel : "medium"
    ),
    planModeEnabled,
    availableModels: chatState.activeSessionId === sessionId ? chatState.availableModels : undefined,
  };
}

export function getRemoteSessionTitle(sessionTitle: string, messages: ChatMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user" && message.content.trim());
  if (!firstUserMessage) return sessionTitle;
  return firstUserMessage.content.length > 30
    ? `${firstUserMessage.content.substring(0, 30)}...`
    : firstUserMessage.content;
}

function buildCatalog(projects: Project[], planModeEnabled: boolean): RemoteProject[] {
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
      config: buildSessionConfig(session.id, planModeEnabled),
    })),
  }));
}

export function sanitizeRemoteAgent(agent: {
  id: string;
  name: string;
  desc?: string;
  description?: string;
  runtime: "cli" | "sdk" | "plugin";
  capabilities?: { providerActivation?: string; guidance?: boolean; actions?: boolean };
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
  };
}

export function toRemoteInteraction(value: PendingUIResponse): RemoteInteraction | null {
  if (!value) return null;
  return {
    sessionId: value.sessionId,
    requestId: value.requestId,
    method: value.method,
    questions: value.questions || [],
  };
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

export function useRemoteBridge({ pendingInteraction, setPendingInteraction, abortSession }: UseRemoteBridgeOptions) {
  const [planModeEnabled, setPlanModeEnabled] = useState(false);
  const pendingInteractionRef = useRef(pendingInteraction);
  const publishedInteractionSessionRef = useRef<string | null>(null);
  const planModeRef = useRef(false);
  const remoteAgentsRef = useRef<RemoteAgent[]>([]);
  const messageTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingMessageUpdatesRef = useRef(new Map<string, RemoteRendererPublish>());

  pendingInteractionRef.current = pendingInteraction;
  planModeRef.current = planModeEnabled;

  const publish = useCallback((update: RemoteRendererPublish) => {
    window.electronAPI.remotePublish(update);
  }, []);

  const publishSnapshot = useCallback(() => {
    const projectState = useProjectStore.getState();
    const chatState = useChatStore.getState();
    const messages: Record<string, RemoteChatMessage[]> = {};
    const queues: Record<string, RemoteQueuedMessage[]> = {};
    const interactions: Record<string, RemoteInteraction | null> = {};
    const configs: Record<string, RemoteSessionConfig> = {};
    for (const project of projectState.projects) {
      for (const session of project.sessions) {
        messages[session.id] = (chatState.sessionMessages[session.id] || []).map((message) => sanitizeRemoteMessage(message, project.path));
        queues[session.id] = sanitizeQueue(chatState.messageQueues[session.id] || []);
        interactions[session.id] = pendingInteractionRef.current?.sessionId === session.id
          ? toRemoteInteraction(pendingInteractionRef.current)
          : null;
        configs[session.id] = buildSessionConfig(session.id, planModeRef.current);
      }
    }
    publish({
      type: "snapshot",
      catalog: buildCatalog(projectState.projects, planModeRef.current),
      agents: remoteAgentsRef.current,
      messages,
      queues,
      interactions,
      configs,
    });
  }, [publish]);

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
        catalog: buildCatalog(projectState.projects, planModeRef.current),
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
      setPlanModeEnabled(enabled);
      planModeRef.current = enabled;
      setTimeout(publishSnapshot, 0);
    });
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<{ planModeEnabled?: boolean }>).detail;
      if (typeof detail?.planModeEnabled !== "boolean") return;
      setPlanModeEnabled(detail.planModeEnabled);
      planModeRef.current = detail.planModeEnabled;
      const projectState = useProjectStore.getState();
      publish({
        type: "catalog",
        catalog: buildCatalog(projectState.projects, detail.planModeEnabled),
        agents: remoteAgentsRef.current,
      });
      for (const project of projectState.projects) {
        for (const session of project.sessions) {
          publish({
            type: "session.config",
            sessionId: session.id,
            config: buildSessionConfig(session.id, detail.planModeEnabled),
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
        config: buildSessionConfig(sessionId, planModeRef.current),
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
      previousProjects = state.projects;
      previousStatuses = state.agentStatuses;
      publish({ type: "catalog", catalog: buildCatalog(state.projects, planModeRef.current), agents: remoteAgentsRef.current });
    });
    return unsubscribe;
  }, [publish]);

  useEffect(() => {
    let previousMessages = useChatStore.getState().sessionMessages;
    let previousQueues = useChatStore.getState().messageQueues;
    let previousCurrentModel = useChatStore.getState().currentModel;
    let previousThinking = useChatStore.getState().thinkingLevel;
    let previousModels = useChatStore.getState().availableModels;
    const scheduleMessagePublish = (sessionId: string, update: RemoteRendererPublish) => {
      const pending = pendingMessageUpdatesRef.current.get(sessionId);
      if (shouldFlushPendingMessageUpdate(pending, update)) publish(pending!);
      pendingMessageUpdatesRef.current.set(sessionId, update);
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
          if (canPublishMessageUpsert(previous, next)) {
            scheduleMessagePublish(sessionId, {
              type: "session.message.upsert",
              sessionId,
              message: sanitizeRemoteMessage(next[next.length - 1], project.path),
            });
          } else {
            scheduleMessagePublish(sessionId, {
              type: "session.messages.replace",
              sessionId,
              messages: next.map((message) => sanitizeRemoteMessage(message, project.path)),
            });
          }
        }
        if (catalogTitleChanged) {
          publish({ type: "catalog", catalog: buildCatalog(projects, planModeRef.current), agents: remoteAgentsRef.current });
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
            config: buildSessionConfig(state.activeSessionId, planModeRef.current),
          });
        }
      }
    });
    return () => {
      unsubscribe();
      for (const timer of messageTimersRef.current.values()) clearTimeout(timer);
      messageTimersRef.current.clear();
      pendingMessageUpdatesRef.current.clear();
    };
  }, [publish]);

  useEffect(() => {
    const interaction = toRemoteInteraction(pendingInteraction);
    const previousSessionId = publishedInteractionSessionRef.current;
    if (previousSessionId && previousSessionId !== interaction?.sessionId) {
      publish({ type: "session.interaction", sessionId: previousSessionId, interaction: null });
    }
    if (interaction) {
      publish({ type: "session.interaction", sessionId: interaction.sessionId, interaction });
    }
    publishedInteractionSessionRef.current = interaction?.sessionId || null;
  }, [pendingInteraction, publish]);

  useEffect(() => window.electronAPI.onRemoteCommand((command) => {
    void executeRemoteSessionCommand(command, {
      pendingInteraction: pendingInteractionRef.current,
      abortSession,
      clearPendingInteraction: (sessionId) => {
        setPendingInteraction((current) => current?.sessionId === sessionId ? null : current);
        publish({ type: "session.interaction", sessionId, interaction: null });
      },
    }).then((payload) => {
      window.electronAPI.remoteCommandResult({ commandId: command.commandId, success: true, payload });
    }).catch((error: unknown) => {
      window.electronAPI.remoteCommandResult({
        commandId: command.commandId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }), [abortSession, publish, setPendingInteraction]);

  useEffect(() => {
    const timer = setTimeout(publishSnapshot, 750);
    return () => clearTimeout(timer);
  }, [publishSnapshot]);
}
