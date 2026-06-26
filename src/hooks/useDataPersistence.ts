import { useEffect } from "react";
import { useProjectStore, type Project } from "@/stores/project-store";
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
  currentModel?: ModelInfo | null;
  thinkingLevel?: string;
  thinkingLevels?: Record<string, string>;
  models?: Record<string, ModelInfo>;
}

// In-memory cache for per-session models and thinking levels, synced to disk.
let _sessionModelsCache: Record<string, ModelInfo> = {};
let _sessionThinkingCache: Record<string, string> = {};
let _cacheDirty = false;
let _saveTimeout: ReturnType<typeof setTimeout> | null = null;

function flushModelsToDisk() {
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
      let activeSession: any = undefined;

      if (projectData && typeof projectData === "object" && "projects" in projectData) {
        const d = projectData as PersistedData;
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
      if (msgData && typeof msgData === "object" && "sessionMessages" in msgData) {
        const md = msgData as PersistedMessages;
        useChatStore.setState({ sessionMessages: md.sessionMessages });
        if (activeSessionId && md.sessionMessages[activeSessionId]) {
          useChatStore.setState({ messages: md.sessionMessages[activeSessionId] });
        }
      }

      // 3. Load per-session models and thinking levels into cache, restore active session
      if (modelData && typeof modelData === "object") {
        const md = modelData as PersistedModel;

        // Migration: v4 (per-agent→per-session) or older → reset to empty
        if (!(modelData as any).modelVersion || (modelData as any).modelVersion < 5) {
          _sessionModelsCache = {};
          _sessionThinkingCache = {};
          // Migrate legacy global thinkingLevel if present
          if (md.thinkingLevel) {
            _sessionThinkingCache = {};
          }
          window.electronAPI.saveData("currentModel", {
            models: {},
            thinkingLevels: {},
            modelVersion: 5,
          });
        } else {
          if (md.models) _sessionModelsCache = { ...md.models };
          if (md.thinkingLevels) _sessionThinkingCache = { ...md.thinkingLevels };
        }

        // Restore active session's model from cache
        if (activeSessionId && _sessionModelsCache[activeSessionId]) {
          useChatStore.setState({ currentModel: _sessionModelsCache[activeSessionId] });
        }

        // Restore active session's thinking level from cache
        if (activeSessionId && _sessionThinkingCache[activeSessionId]) {
          useChatStore.setState({ thinkingLevel: _sessionThinkingCache[activeSessionId] } as any);
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
    const unsubscribe = useProjectStore.subscribe((state) => {
      window.electronAPI.saveData("projects", {
        projects: state.projects,
        activeProjectId: state.activeProjectId,
        activeSessionId: state.activeSessionId,
      });
    });
    return unsubscribe;
  }, []);

  // Save session messages when they change
  useEffect(() => {
    const unsubscribe = useChatStore.subscribe((state) => {
      window.electronAPI.saveData("sessionMessages", {
        sessionMessages: state.sessionMessages,
      });
    });
    return unsubscribe;
  }, []);
}
