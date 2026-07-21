import { useEffect } from "react";
import {
  useProjectStore,
  type Project,
  type ProjectSession,
  type SessionForkContext,
  type SessionForkOrigin,
  type SessionReference,
} from "@/stores/project-store";
import { isAgentStartupFailureMessage, useChatStore, type ChatMessage, type ModelInfo } from "@/stores/chat-store";
import { PersistenceFlushScheduler } from "./persistenceScheduler";
import { parseComposerDraftSnapshot } from "@/lib/composer-history";

interface PersistedData {
  projects: Project[];
  activeProjectId: string | null;
  activeSessionId: string | null;
}

interface PersistedMessages {
  sessionMessages: Record<string, ChatMessage[]>;
}

interface PersistedModel {
  modelVersion?: number;
  currentModel?: ModelInfo | null;
  thinkingLevel?: string;
  thinkingLevels?: Record<string, string>;
  models?: Record<string, ModelInfo>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const getString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const getStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const parseSessionReference = (value: unknown): SessionReference | null => {
  if (!isRecord(value)) return null;
  const sourceSessionId = getString(value.sourceSessionId);
  const sourceAgentId = getString(value.sourceAgentId);
  const sourceTitle = getString(value.sourceTitle);
  const sourceUpdatedAt = getString(value.sourceUpdatedAt);
  const addedAt = getString(value.addedAt);
  const summary = getString(value.summary);
  if (!sourceSessionId || !sourceAgentId || !sourceTitle || !sourceUpdatedAt || !addedAt || !summary) return null;
  return {
    sourceSessionId,
    sourceAgentId,
    sourceTitle,
    sourceUpdatedAt,
    addedAt,
    summary,
  };
};

const parseSessionForkContext = (value: unknown): SessionForkContext | undefined => {
  if (!isRecord(value)) return undefined;
  const sourceSessionId = getString(value.sourceSessionId);
  const sourceTitle = getString(value.sourceTitle);
  const throughMessageId = getString(value.throughMessageId);
  const createdAt = getString(value.createdAt);
  const context = getString(value.context);
  const messageCount = typeof value.messageCount === "number" ? value.messageCount : undefined;
  if (!sourceSessionId || !sourceTitle || !throughMessageId || !createdAt || !context || messageCount === undefined) {
    return undefined;
  }
  return {
    sourceSessionId,
    sourceTitle,
    throughMessageId,
    createdAt,
    messageCount,
    context,
  };
};

const parseSessionForkOrigin = (value: unknown): SessionForkOrigin | undefined => {
  if (!isRecord(value)) return undefined;
  const sourceSessionId = getString(value.sourceSessionId);
  const sourceTitle = getString(value.sourceTitle);
  const throughMessageId = getString(value.throughMessageId);
  const createdAt = getString(value.createdAt);
  if (!sourceSessionId || !sourceTitle || !throughMessageId || !createdAt) return undefined;
  return {
    sourceSessionId,
    sourceTitle,
    throughMessageId,
    createdAt,
  };
};

const parseProjectSession = (value: unknown): ProjectSession | null => {
  if (!isRecord(value)) return null;
  const id = getString(value.id);
  const agentId = getString(value.agentId);
  const agentSessionId = getString(value.agentSessionId);
  const title = getString(value.title);
  const createdAt = getString(value.createdAt);
  const lastActiveAt = getString(value.lastActiveAt);
  if (!id || !agentId || !agentSessionId || !title || !createdAt || !lastActiveAt) return null;

  const forkContext = parseSessionForkContext(value.forkContext);

  return {
    id,
    agentId,
    agentSessionId,
    title,
    createdAt,
    lastActiveAt,
    sessionFilePath: getString(value.sessionFilePath),
    closed: typeof value.closed === "boolean" ? value.closed : undefined,
    references: Array.isArray(value.references)
      ? value.references.map(parseSessionReference).filter((ref): ref is SessionReference => !!ref)
      : undefined,
    forkedFrom: parseSessionForkOrigin(value.forkedFrom) || (forkContext ? parseSessionForkOrigin(forkContext) : undefined),
    forkContext,
  };
};

const parseProject = (value: unknown): Project | null => {
  if (!isRecord(value)) return null;
  const id = getString(value.id);
  const name = getString(value.name);
  const path = getString(value.path);
  const createdAt = getString(value.createdAt);
  if (!id || !name || !path || !createdAt) return null;

  return {
    id,
    name,
    path,
    createdAt,
    agents: getStringArray(value.agents),
    sessions: Array.isArray(value.sessions)
      ? value.sessions.map(parseProjectSession).filter((session): session is ProjectSession => !!session)
      : [],
  };
};

const parsePersistedData = (value: unknown): PersistedData | null => {
  if (!isRecord(value) || !Array.isArray(value.projects)) return null;
  const projects = value.projects.map(parseProject).filter((project): project is Project => !!project);
  const activeProjectId = getString(value.activeProjectId) || null;
  const activeSessionId = getString(value.activeSessionId) || null;

  return {
    projects,
    activeProjectId: activeProjectId && projects.some((project) => project.id === activeProjectId)
      ? activeProjectId
      : null,
    activeSessionId: activeSessionId && projects.some((project) => project.sessions.some((session) => session.id === activeSessionId))
      ? activeSessionId
      : null,
  };
};

export const parsePersistedChatMessage = (value: unknown): ChatMessage | null => {
  if (!isRecord(value)) return null;
  const id = getString(value.id);
  const role = value.role;
  const content = getString(value.content);
  const timestamp = typeof value.timestamp === "number" ? value.timestamp : undefined;
  if (!id || (role !== "user" && role !== "assistant" && role !== "system") || content === undefined || timestamp === undefined) {
    return null;
  }

  const persistedMessage = value as Partial<ChatMessage>;
  const composerDraft = parseComposerDraftSnapshot(value.composerDraft);
  return {
    ...persistedMessage,
    id,
    role,
    content,
    timestamp,
    composerDraft,
    // Never restore a stale streaming state after app restart.
    isStreaming: false,
  };
};

const parsePersistedMessages = (value: unknown): PersistedMessages | null => {
  if (!isRecord(value) || !isRecord(value.sessionMessages)) return null;
  const sessionMessages: Record<string, ChatMessage[]> = {};
  for (const [sessionId, messages] of Object.entries(value.sessionMessages)) {
    if (!Array.isArray(messages)) continue;
    sessionMessages[sessionId] = messages
      .map(parsePersistedChatMessage)
      .filter((message): message is ChatMessage => !!message && !isAgentStartupFailureMessage(message));
  }
  return { sessionMessages };
};

const stripTransientMessages = (sessionMessages: Record<string, ChatMessage[]>) => {
  const result: Record<string, ChatMessage[]> = {};
  for (const [sessionId, messages] of Object.entries(sessionMessages)) {
    result[sessionId] = messages.filter((message) => !isAgentStartupFailureMessage(message));
  }
  return result;
};

const parseModelInfo = (value: unknown): ModelInfo | null => {
  if (!isRecord(value)) return null;
  const id = getString(value.id);
  const name = getString(value.name);
  const provider = getString(value.provider);
  if (!id || !name || !provider) return null;
  return {
    id,
    name,
    provider,
    reasoning: typeof value.reasoning === "boolean" ? value.reasoning : false,
    supportsImages: typeof value.supportsImages === "boolean" ? value.supportsImages : undefined,
    supportedThinkingLevels: Array.isArray(value.supportedThinkingLevels)
      ? value.supportedThinkingLevels.filter((level): level is string => typeof level === "string")
      : undefined,
  };
};

const parseModelRecord = (value: unknown): Record<string, ModelInfo> => {
  if (!isRecord(value)) return {};
  const result: Record<string, ModelInfo> = {};
  for (const [sessionId, model] of Object.entries(value)) {
    const parsed = parseModelInfo(model);
    if (parsed) result[sessionId] = parsed;
  }
  return result;
};

const parseStringRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
};

const hasStreamingMessages = (sessionMessages: Record<string, ChatMessage[]>) =>
  Object.values(sessionMessages).some((messages) =>
    messages.some((message) => message.isStreaming || (!!message.process && !message.process.endedAt))
  );

const parsePersistedModel = (value: unknown): PersistedModel | null => {
  if (!isRecord(value)) return null;
  return {
    modelVersion: typeof value.modelVersion === "number" ? value.modelVersion : undefined,
    currentModel: parseModelInfo(value.currentModel),
    thinkingLevel: getString(value.thinkingLevel),
    thinkingLevels: parseStringRecord(value.thinkingLevels),
    models: parseModelRecord(value.models),
  };
};

// In-memory cache for per-session models and thinking levels, synced to disk.
let _sessionModelsCache: Record<string, ModelInfo> = {};
let _sessionThinkingCache: Record<string, string> = {};
export const SESSION_CONFIG_UPDATED_EVENT = "session-config-updated";
export const SESSION_DATA_PURGED_EVENT = "session-data-purged";
export const DISK_USAGE_INVALIDATED_EVENT = "disk-usage-invalidated";

const notifySessionConfigUpdated = (sessionId: string) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SESSION_CONFIG_UPDATED_EVENT, { detail: { sessionId } }));
};
let _cacheDirty = false;
let _pendingProjectsData: PersistedData | null = null;
let _pendingMessagesData: PersistedMessages | null = null;
const saveScheduler = new PersistenceFlushScheduler();

export class PersistenceHydrationGate {
  private generation = 0;
  private hydrated = false;

  begin(): number {
    this.hydrated = false;
    this.generation += 1;
    return this.generation;
  }

  complete(generation: number): boolean {
    if (generation !== this.generation) return false;
    this.hydrated = true;
    return true;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  canPersist(): boolean {
    return this.hydrated;
  }
}

const persistenceHydration = new PersistenceHydrationGate();

function flushProjectsToDisk() {
  saveScheduler.clear("projects");
  if (!persistenceHydration.canPersist()) {
    _pendingProjectsData = null;
    return;
  }
  if (!_pendingProjectsData) return;
  const data = _pendingProjectsData;
  _pendingProjectsData = null;
  window.electronAPI.saveData("projects", data);
}

function scheduleProjectsSave(data: PersistedData) {
  if (!persistenceHydration.canPersist()) return;
  _pendingProjectsData = data;
  saveScheduler.schedule("projects", 500, flushProjectsToDisk);
}

function flushMessagesToDisk() {
  saveScheduler.clearMany(["messages", "streamingMessages"]);
  if (!persistenceHydration.canPersist()) {
    _pendingMessagesData = null;
    return;
  }
  if (!_pendingMessagesData) return;
  const data = _pendingMessagesData;
  _pendingMessagesData = null;
  window.electronAPI.saveData("sessionMessages", data);
}

function scheduleMessagesSave(data: PersistedMessages) {
  if (!persistenceHydration.canPersist()) return;
  _pendingMessagesData = data;
  saveScheduler.schedule("messages", 1000, flushMessagesToDisk);
}

function scheduleStreamingMessagesSave(data: PersistedMessages) {
  if (!persistenceHydration.canPersist()) return;
  _pendingMessagesData = data;
  saveScheduler.schedule("streamingMessages", 8000, flushMessagesToDisk, { reset: false });
}

function flushPendingDataToDisk() {
  if (_cacheDirty) {
    flushModelsToDisk();
  }
  flushProjectsToDisk();
  flushMessagesToDisk();
}

function flushModelsToDisk() {
  saveScheduler.clear("models");
  if (!_cacheDirty) return;
  _cacheDirty = false;
  window.electronAPI.saveData("currentModel", {
    models: { ..._sessionModelsCache },
    thinkingLevels: { ..._sessionThinkingCache },
    modelVersion: 5,
  });
}

/** Save a model for a specific session (synchronous cache update, debounced disk write) */
export function saveSessionModel(sessionId: string, model: ModelInfo) {
  _sessionModelsCache[sessionId] = model;
  _cacheDirty = true;
  saveScheduler.schedule("models", 500, flushModelsToDisk);
  notifySessionConfigUpdated(sessionId);
}

/** Get persisted model for a session (synchronous, from cache) */
export function getSessionModel(sessionId: string): ModelInfo | null {
  return _sessionModelsCache[sessionId] || null;
}

/** Save thinking level for a specific session (synchronous cache update, debounced disk write) */
export function saveSessionThinking(sessionId: string, level: string) {
  _sessionThinkingCache[sessionId] = level;
  _cacheDirty = true;
  saveScheduler.schedule("models", 500, flushModelsToDisk);
  notifySessionConfigUpdated(sessionId);
}

/** Get persisted thinking level for a session (synchronous, from cache) */
export function getSessionThinking(sessionId: string): string | null {
  return _sessionThinkingCache[sessionId] || null;
}

const withoutSessionKeys = <T>(record: Record<string, T>, sessionIds: Set<string>) =>
  Object.fromEntries(Object.entries(record).filter(([sessionId]) => !sessionIds.has(sessionId)));

export async function purgeDeletedSessionData(sessionIds: string[], projectIds: string[] = []) {
  const normalizedSessionIds = new Set(sessionIds.map((id) => id.trim()).filter(Boolean));
  const normalizedProjectIds = new Set(projectIds.map((id) => id.trim()).filter(Boolean));
  if (normalizedSessionIds.size === 0 && normalizedProjectIds.size === 0) return { success: true };

  const previousModelCount = Object.keys(_sessionModelsCache).length;
  const previousThinkingCount = Object.keys(_sessionThinkingCache).length;
  _sessionModelsCache = withoutSessionKeys(_sessionModelsCache, normalizedSessionIds);
  _sessionThinkingCache = withoutSessionKeys(_sessionThinkingCache, normalizedSessionIds);
  if (
    Object.keys(_sessionModelsCache).length !== previousModelCount ||
    Object.keys(_sessionThinkingCache).length !== previousThinkingCount
  ) {
    _cacheDirty = true;
    saveScheduler.schedule("models", 500, flushModelsToDisk);
  }

  if (_pendingMessagesData) {
    _pendingMessagesData = {
      sessionMessages: withoutSessionKeys(_pendingMessagesData.sessionMessages, normalizedSessionIds),
    };
  }
  if (_pendingProjectsData) {
    const projects = _pendingProjectsData.projects
      .filter((project) => !normalizedProjectIds.has(project.id))
      .map((project) => ({
        ...project,
        sessions: project.sessions.filter((session) => !normalizedSessionIds.has(session.id)),
      }));
    _pendingProjectsData = {
      projects,
      activeProjectId: _pendingProjectsData.activeProjectId && normalizedProjectIds.has(_pendingProjectsData.activeProjectId)
        ? null
        : _pendingProjectsData.activeProjectId,
      activeSessionId: _pendingProjectsData.activeSessionId && normalizedSessionIds.has(_pendingProjectsData.activeSessionId)
        ? null
        : _pendingProjectsData.activeSessionId,
    };
  }

  window.dispatchEvent(new CustomEvent(SESSION_DATA_PURGED_EVENT, {
    detail: { sessionIds: [...normalizedSessionIds], projectIds: [...normalizedProjectIds] },
  }));
  const result = await window.electronAPI.purgeSessionData({
    sessionIds: [...normalizedSessionIds],
    projectIds: [...normalizedProjectIds],
  });
  if (!result.success) {
    throw new Error(result.error || "Failed to purge deleted session data.");
  }
  window.dispatchEvent(new CustomEvent(DISK_USAGE_INVALIDATED_EVENT));
  return result;
}

export async function getSessionThinkingOrDefault(sessionId: string, agentId?: string): Promise<string> {
  const persisted = getSessionThinking(sessionId);
  if (persisted) return persisted;

  try {
    return await window.electronAPI.agentGetDefaultThinkingLevel(agentId || "");
  } catch {
    return "medium";
  }
}

export function selectSessionModel(sessionId: string, models: ModelInfo[]): ModelInfo | null {
  if (models.length === 0) return null;
  const chatState = useChatStore.getState();

  const persisted = getSessionModel(sessionId);
  const persistedMatch = persisted
    ? models.find(m => m.id === persisted.id && m.provider === persisted.provider)
    : undefined;
  if (persistedMatch) return persistedMatch;

  const currentModel = chatState.currentModel;
  const currentMatch = currentModel
    ? models.find(m => m.id === currentModel.id && m.provider === currentModel.provider)
    : undefined;
  if (currentMatch) return currentMatch;

  return models[0];
}

export function useDataPersistence() {
  // Load everything on mount in a single coordinated flow
  useEffect(() => {
    if (persistenceHydration.canPersist()) {
      flushPendingDataToDisk();
    }
    const hydrationGeneration = persistenceHydration.begin();
    let cancelled = false;
    _pendingProjectsData = null;
    _pendingMessagesData = null;
    saveScheduler.clearMany(["projects", "messages", "streamingMessages"]);

    Promise.all([
      window.electronAPI.loadData("projects").catch(() => null),
      window.electronAPI.loadData("sessionMessages").catch(() => null),
      window.electronAPI.loadData("currentModel").catch(() => null),
    ]).then(([projectData, msgData, modelData]) => {
      if (cancelled || !persistenceHydration.isCurrent(hydrationGeneration)) return;

      // 1. Load projects and restore active session
      let activeSessionId: string | null = null;
      let activeAgentId: string | null = null;
      let activeProject: Project | undefined;
      let activeSession: ProjectSession | undefined;
      let validSessionIds: Set<string> | null = null;

      const d = parsePersistedData(projectData);
      if (d) {
        validSessionIds = new Set(d.projects.flatMap((project) => project.sessions.map((session) => session.id)));
        activeSessionId = d.activeSessionId || null;
        useProjectStore.setState({
          projects: d.projects,
          activeProjectId: d.activeProjectId || (d.projects.length > 0 ? d.projects[0].id : null),
          activeSessionId,
        });
        if (activeSessionId) {
          activeProject = d.projects.find((p) => p.sessions.some((s) => s.id === activeSessionId));
          activeSession = activeProject?.sessions.find((s) => s.id === activeSessionId);
          if (activeSession) {
            activeAgentId = activeSession.agentId;
            useChatStore.setState({ activeAgentId });
          }
        }
      }

      // 2. Load session messages
      const md = parsePersistedMessages(msgData);
      if (md) {
        const sessionMessages = validSessionIds
          ? Object.fromEntries(Object.entries(md.sessionMessages).filter(([sessionId]) => validSessionIds!.has(sessionId)))
          : md.sessionMessages;
        useChatStore.setState({ sessionMessages });
        if (activeSessionId) {
          useChatStore.getState().switchSession(activeSessionId);
        }
      } else if (activeSessionId) {
        useChatStore.getState().switchSession(activeSessionId);
      }

      // 3. Load per-session models and thinking levels into cache, restore active session
      const model = parsePersistedModel(modelData);
      if (model) {

        // Migration: v4 (per-agent→per-session) or older → reset to empty
        if (!model.modelVersion || model.modelVersion < 5) {
          _sessionModelsCache = {};
          _sessionThinkingCache = {};
          // Migrate legacy global thinkingLevel if present
          if (model.thinkingLevel) {
            _sessionThinkingCache = {};
          }
          window.electronAPI.saveData("currentModel", {
            models: {},
            thinkingLevels: {},
            modelVersion: 5,
          });
        } else {
          if (model.models) _sessionModelsCache = { ...model.models };
          if (model.thinkingLevels) _sessionThinkingCache = { ...model.thinkingLevels };
          if (validSessionIds) {
            _sessionModelsCache = Object.fromEntries(
              Object.entries(_sessionModelsCache).filter(([sessionId]) => validSessionIds!.has(sessionId))
            );
            _sessionThinkingCache = Object.fromEntries(
              Object.entries(_sessionThinkingCache).filter(([sessionId]) => validSessionIds!.has(sessionId))
            );
          }
        }

        // Restore active session's model from cache
        if (activeSessionId && _sessionModelsCache[activeSessionId]) {
          useChatStore.setState({ currentModel: _sessionModelsCache[activeSessionId] });
        }

        // Restore active session's thinking level from cache
        if (activeSessionId && _sessionThinkingCache[activeSessionId]) {
          useChatStore.setState({ thinkingLevel: _sessionThinkingCache[activeSessionId] });
        }
      }

      if (!persistenceHydration.complete(hydrationGeneration)) return;

      if (validSessionIds) {
        void window.electronAPI.purgeSessionData({
          validSessionIds: [...validSessionIds],
          validProjectIds: d?.projects.map((project) => project.id) || [],
        })
          .catch((error) => console.error("[persistence] orphan cleanup failed:", error));
      }

      // The active ChatPanel initializes its restored session through SessionCommandCoordinator.
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Model and thinking settings are persisted by SessionCommandCoordinator.

  // Save projects, activeProjectId, and activeSessionId when they change
  useEffect(() => {
    let lastProjects = useProjectStore.getState().projects;
    let lastActiveProjectId = useProjectStore.getState().activeProjectId;
    let lastActiveSessionId = useProjectStore.getState().activeSessionId;

    const unsubscribe = useProjectStore.subscribe((state) => {
      if (
        state.projects === lastProjects &&
        state.activeProjectId === lastActiveProjectId &&
        state.activeSessionId === lastActiveSessionId
      ) {
        return;
      }

      lastProjects = state.projects;
      lastActiveProjectId = state.activeProjectId;
      lastActiveSessionId = state.activeSessionId;

      if (!persistenceHydration.canPersist()) return;

      scheduleProjectsSave({
        projects: state.projects,
        activeProjectId: state.activeProjectId,
        activeSessionId: state.activeSessionId,
      });
    });
    return unsubscribe;
  }, []);

  // Save session messages when they change
  useEffect(() => {
    let lastSessionMessages = useChatStore.getState().sessionMessages;
    const unsubscribe = useChatStore.subscribe((state) => {
      if (state.sessionMessages === lastSessionMessages) return;
      lastSessionMessages = state.sessionMessages;
      if (!persistenceHydration.canPersist()) return;
      const data = { sessionMessages: stripTransientMessages(state.sessionMessages) };
      if (hasStreamingMessages(state.sessionMessages)) {
        scheduleStreamingMessagesSave(data);
        return;
      }

      scheduleMessagesSave(data);
    });
    return unsubscribe;
  }, []);

  // Flush debounced saves before the renderer is suspended or closed.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushPendingDataToDisk();
      }
    };

    window.addEventListener("beforeunload", flushPendingDataToDisk);
    window.addEventListener("pagehide", flushPendingDataToDisk);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("beforeunload", flushPendingDataToDisk);
      window.removeEventListener("pagehide", flushPendingDataToDisk);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      flushPendingDataToDisk();
    };
  }, []);
}
