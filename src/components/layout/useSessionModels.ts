import { useCallback, useEffect, useRef } from "react";
import { useChatStore, type ModelInfo } from "@/stores/chat-store";
import { useProjectStore, type Project, type ProjectSession } from "@/stores/project-store";
import {
  applySessionModels,
  getSessionModel,
  getSessionThinkingOrDefault,
  saveSessionModel,
  selectSessionModel,
} from "@/hooks/useDataPersistence";

const MODEL_FETCH_RETRY_DELAYS = [0, 500, 1000, 2000, 4000, 8000];

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const addAgentStartupError = (sessionId: string, error: unknown) => {
  const chatStore = useChatStore.getState();
  chatStore.clearAgentStartupErrors(sessionId);
  chatStore.addMessage({
    id: crypto.randomUUID(),
    role: "system",
    content: `Agent 启动失败: ${getErrorMessage(error)}`,
    timestamp: Date.now(),
    systemType: "agent_startup_error",
  }, sessionId);
};

const applyAndSyncSessionModel = async (sessionId: string, model: ModelInfo, setCurrentModel: (model: ModelInfo) => void) => {
  saveSessionModel(sessionId, model);
  setCurrentModel(model);
  await window.electronAPI.agentSetModel(model.provider, model.id, sessionId);
};

type UseSessionModelsOptions = {
  activeSessionId: string | null;
  activeSessionAgentId?: string;
  activeSessionInitialized: boolean;
  setAvailableModels: (models: ModelInfo[]) => void;
  setCurrentModel: (model: ModelInfo) => void;
  setThinkingLevel: (level: string) => void;
};

export function useSessionModels({
  activeSessionId,
  activeSessionAgentId,
  activeSessionInitialized,
  setAvailableModels,
  setCurrentModel,
  setThinkingLevel,
}: UseSessionModelsOptions) {
  const modelFetchRunIdRef = useRef(0);

  const clearModels = useCallback(() => {
    setAvailableModels([]);
    useChatStore.setState({ currentModel: null });
  }, [setAvailableModels]);

  const fetchModels = useCallback(async (sessionId: string, fetchRunId: number) => {
    for (const delay of MODEL_FETCH_RETRY_DELAYS) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const stillCurrent =
        modelFetchRunIdRef.current === fetchRunId &&
        useProjectStore.getState().activeSessionId === sessionId;
      if (!stillCurrent) return;

      try {
        const models = await window.electronAPI.agentGetModels(sessionId);
        const stillCurrentAfterFetch =
          modelFetchRunIdRef.current === fetchRunId &&
          useProjectStore.getState().activeSessionId === sessionId;
        if (!stillCurrentAfterFetch) return;

        if (models && models.length > 0) {
          setAvailableModels(models);
          const selectedModel = selectSessionModel(sessionId, models);
          if (selectedModel) await applyAndSyncSessionModel(sessionId, selectedModel, setCurrentModel);
          return;
        }
      } catch {
        // Retry below; final empty state is handled after all attempts.
      }
    }

    if (
      modelFetchRunIdRef.current === fetchRunId &&
      useProjectStore.getState().activeSessionId === sessionId
    ) {
      clearModels();
    }
  }, [clearModels, setAvailableModels, setCurrentModel]);

  useEffect(() => {
    const fetchRunId = ++modelFetchRunIdRef.current;

    if (!activeSessionId || !activeSessionAgentId || !activeSessionInitialized) {
      clearModels();
      return;
    }

    void fetchModels(activeSessionId, fetchRunId);

    void getSessionThinkingOrDefault(activeSessionId, activeSessionAgentId).then((thinkingToSet) => {
      if (
        modelFetchRunIdRef.current !== fetchRunId ||
        useProjectStore.getState().activeSessionId !== activeSessionId
      ) {
        return;
      }
      setThinkingLevel(thinkingToSet);
      void window.electronAPI.agentSetThinkingLevel(thinkingToSet, activeSessionId);
    });
  }, [
    activeSessionId,
    activeSessionAgentId,
    activeSessionInitialized,
    clearModels,
    fetchModels,
    setThinkingLevel,
  ]);

  const switchToSession = useCallback((project: Project, session: ProjectSession) => {
    const currentModel = useChatStore.getState().currentModel;
    if (!getSessionModel(session.id) && currentModel) {
      saveSessionModel(session.id, currentModel);
    }
    useProjectStore.getState().setActiveSession(session.id);
    useChatStore.getState().setActiveAgent(session.agentId);
    useChatStore.getState().switchSession(session.id);

    void window.electronAPI.agentCreateSession(
      session.agentId,
      project.path,
      session.id,
      session.sessionFilePath
    ).then(async (result) => {
      if (result.success) {
        useChatStore.getState().clearAgentStartupErrors(session.id);
      } else {
        addAgentStartupError(session.id, result.error || "Agent 会话初始化失败");
      }
      if (result.sessionFilePath) {
        useProjectStore.getState().setSessionFilePath(project.id, session.id, result.sessionFilePath);
      }
      if (useProjectStore.getState().activeSessionId === session.id) {
        applySessionModels(session.id, result.models);
        if (result.models && result.models.length > 0) {
          const selectedModel = selectSessionModel(session.id, result.models);
          if (selectedModel) {
            useChatStore.getState().setCurrentModel(selectedModel);
            await window.electronAPI.agentSetModel(selectedModel.provider, selectedModel.id, session.id);
          }
        }
      }
      useProjectStore.getState().markSessionInitialized(session.id);
      if (useProjectStore.getState().activeSessionId === session.id) {
        await window.electronAPI.agentSwitchSession(session.id);
        try {
          const models = await window.electronAPI.agentGetModels(session.id);
          if (models && models.length > 0) {
            useChatStore.getState().setAvailableModels(models);
            const selectedModel = selectSessionModel(session.id, models);
            if (selectedModel) {
              useChatStore.getState().setCurrentModel(selectedModel);
              await window.electronAPI.agentSetModel(selectedModel.provider, selectedModel.id, session.id);
            }
          }
        } catch {
          // The active-session model effect will retry and show an empty list if needed.
        }
      }
    }).catch((error: unknown) => {
      useProjectStore.getState().markSessionInitialized(session.id);
      addAgentStartupError(session.id, error);
    });
  }, []);

  return { switchToSession };
}
