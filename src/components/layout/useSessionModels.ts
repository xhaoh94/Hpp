import { useCallback, useEffect, useRef } from "react";
import { useChatStore, type ModelInfo } from "@/stores/chat-store";
import { useProjectStore, type Project, type ProjectSession } from "@/stores/project-store";
import { applySessionModels, getSessionModel, getSessionThinking } from "@/hooks/useDataPersistence";

const MODEL_FETCH_RETRY_DELAYS = [0, 500, 1000, 2000, 4000, 8000];

const hasModel = (models: ModelInfo[], model: ModelInfo | null): model is ModelInfo =>
  !!model && models.some((item) => item.id === model.id && item.provider === model.provider);

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
          const savedModel = useChatStore.getState().currentModel;
          const persisted = getSessionModel(sessionId);

          if (hasModel(models, savedModel)) {
            setCurrentModel(savedModel);
          } else if (hasModel(models, persisted)) {
            setCurrentModel(persisted);
          } else {
            setCurrentModel(models[0]);
          }
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

    const thinkingToSet = getSessionThinking(activeSessionId) || "medium";
    setThinkingLevel(thinkingToSet);
    void window.electronAPI.agentSetThinkingLevel(thinkingToSet);
  }, [
    activeSessionId,
    activeSessionAgentId,
    activeSessionInitialized,
    clearModels,
    fetchModels,
    setThinkingLevel,
  ]);

  const switchToSession = useCallback((project: Project, session: ProjectSession) => {
    useProjectStore.getState().setActiveSession(session.id);
    useChatStore.getState().setActiveAgent(session.agentId);
    useChatStore.getState().switchSession(session.id);

    void window.electronAPI.agentCreateSession(
      session.agentId,
      project.path,
      session.id,
      session.sessionFilePath
    ).then(async (result) => {
      if (result.sessionFilePath) {
        useProjectStore.getState().setSessionFilePath(project.id, session.id, result.sessionFilePath);
      }
      if (useProjectStore.getState().activeSessionId === session.id) {
        applySessionModels(session.id, result.models);
      }
      useProjectStore.getState().markSessionInitialized(session.id);
      if (useProjectStore.getState().activeSessionId === session.id) {
        await window.electronAPI.agentSwitchSession(session.id);
        try {
          const models = await window.electronAPI.agentGetModels(session.id);
          if (models && models.length > 0) {
            useChatStore.getState().setAvailableModels(models);
          }
        } catch {
          // The active-session model effect will retry and show an empty list if needed.
        }
      }
    });
  }, []);

  return { switchToSession };
}
