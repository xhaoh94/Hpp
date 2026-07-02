import { useEffect } from "react";
import { useProjectStore, type Project, type ProjectSession } from "@/stores/project-store";
import { useChatStore, type ChatMessage, type ModelInfo } from "@/stores/chat-store";

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

const parseProjectSession = (value: unknown): ProjectSession | null => {
  if (!isRecord(value)) return null;
  const id = getString(value.id);
  const agentId = getString(value.agentId);
  const agentSessionId = getString(value.agentSessionId);
  const title = getString(value.title);
  const createdAt = getString(value.createdAt);
  const lastActiveAt = getString(value.lastActiveAt);
  if (!id || !agentId || !agentSessionId || !title || !createdAt || !lastActiveAt) return null;

  return {
    id,
    agentId,
    agentSessionId,
    title,
    createdAt,
    lastActiveAt,
    sessionFilePath: getString(value.sessionFilePath),
    closed: typeof value.closed === "boolean" ? value.closed : undefined,
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

const parseChatMessage = (value: unknown): ChatMessage | null => {
  if (!isRecord(value)) return null;
  const id = getString(value.id);
  const role = value.role;
  const content = getString(value.content);
  const timestamp = typeof value.timestamp === "number" ? value.timestamp : undefined;
  if (!id || (role !== "user" && role !== "assistant" && role !== "system") || content === undefined || timestamp === undefined) {
    return null;
  }

  return {
    ...(value as unknown as ChatMessage),
    id,
    role,
    content,
    timestamp,
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
      .map(parseChatMessage)
      .filter((message): message is ChatMessage => !!message);
  }
  return { sessionMessages };
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
let _cacheDirty = false;
let _saveTimeout: ReturnType<typeof setTimeout> | null = null;
let _projectsSaveTimeout: ReturnType<typeof setTimeout> | null = null;
let _messagesSaveTimeout: ReturnType<typeof setTimeout> | null = null;
let _pendingProjectsData: PersistedData | null = null;
let _pendingMessagesData: PersistedMessages | null = null;

function flushProjectsToDisk() {
  if (_projectsSaveTimeout) {
    clearTimeout(_projectsSaveTimeout);
    _projectsSaveTimeout = null;
  }
  if (!_pendingProjectsData) return;
  const data = _pendingProjectsData;
  _pendingProjectsData = null;
  window.electronAPI.saveData("projects", data);
}

function scheduleProjectsSave(data: PersistedData) {
  _pendingProjectsData = data;
  if (_projectsSaveTimeout) clearTimeout(_projectsSaveTimeout);
  _projectsSaveTimeout = setTimeout(flushProjectsToDisk, 500);
}

function flushMessagesToDisk() {
  if (_messagesSaveTimeout) {
    clearTimeout(_messagesSaveTimeout);
    _messagesSaveTimeout = null;
  }
  if (!_pendingMessagesData) return;
  const data = _pendingMessagesData;
  _pendingMessagesData = null;
  window.electronAPI.saveData("sessionMessages", data);
}

function scheduleMessagesSave(data: PersistedMessages) {
  _pendingMessagesData = data;
  if (_messagesSaveTimeout) clearTimeout(_messagesSaveTimeout);
  _messagesSaveTimeout = setTimeout(flushMessagesToDisk, 1000);
}

function flushPendingDataToDisk() {
  if (_cacheDirty) {
    flushModelsToDisk();
  }
  flushProjectsToDisk();
  flushMessagesToDisk();
}

function flushModelsToDisk() {
  if (_saveTimeout) {
    clearTimeout(_saveTimeout);
    _saveTimeout = null;
  }
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
  if (_saveTimeout) clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(flushModelsToDisk, 500);
}

/** Get persisted model for a session (synchronous, from cache) */
export function getSessionModel(sessionId: string): ModelInfo | null {
  return _sessionModelsCache[sessionId] || null;
}

/** Save thinking level for a specific session (synchronous cache update, debounced disk write) */
export function saveSessionThinking(sessionId: string, level: string) {
  _sessionThinkingCache[sessionId] = level;
  _cacheDirty = true;
  if (_saveTimeout) clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(flushModelsToDisk, 500);
}

/** Get persisted thinking level for a session (synchronous, from cache) */
export function getSessionThinking(sessionId: string): string | null {
  return _sessionThinkingCache[sessionId] || null;
}

export function applySessionModels(sessionId: string, models?: ModelInfo[]) {
  if (!models || models.length === 0) return;
  const chatState = useChatStore.getState();
  chatState.setAvailableModels(models);

  const currentModel = chatState.currentModel;
  if (currentModel && models.some(m => m.id === currentModel.id && m.provider === currentModel.provider)) {
    return;
  }

  const persisted = getSessionModel(sessionId);
  if (persisted && models.some(m => m.id === persisted.id && m.provider === persisted.provider)) {
    chatState.setCurrentModel(persisted);
  } else {
    chatState.setCurrentModel(models[0]);
  }
}

export function useDataPersistence() {
  // Load everything on mount in a single coordinated flow
  useEffect(() => {
    Promise.all([
      window.electronAPI.loadData("projects"),
      window.electronAPI.loadData("sessionMessages"),
      window.electronAPI.loadData("currentModel"),
    ]).then(([projectData, msgData, modelData]) => {
      // 1. Load projects and restore active session
      let activeSessionId: string | null = null;
      let activeAgentId: string | null = null;
      let activeProject: Project | undefined;
      let activeSession: ProjectSession | undefined;

      const d = parsePersistedData(projectData);
      if (d) {
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
        useChatStore.setState({ sessionMessages: md.sessionMessages });
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

      // 4. Restart agent backend for the active session (async, in background)
      if (activeSessionId && activeProject && activeSession) {
        window.electronAPI.agentCreateSession(
          activeSession.agentId, activeProject.path, activeSession.id, activeSession.sessionFilePath
        ).then((result) => {
          const projectState = useProjectStore.getState();
          if (result.sessionFilePath) {
            projectState.setSessionFilePath(activeProject!.id, activeSessionId!, result.sessionFilePath);
          }
          if (useProjectStore.getState().activeSessionId === activeSessionId) {
            applySessionModels(activeSessionId!, result.models);
          }
          projectState.markSessionInitialized(activeSessionId!);
        });
      }
    });
  }, []);

  // NOTE: Model and thinking level saving is done directly in handleSelectModel
  // and handleSelectThinking (ChatPanel) to avoid race conditions from
  // subscription-based saves during session switches.

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

      scheduleMessagesSave({
        sessionMessages: state.sessionMessages,
      });
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
