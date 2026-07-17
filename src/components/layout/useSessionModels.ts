import { useCallback, useEffect, useRef } from "react";
import { useChatStore, type ModelInfo } from "@/stores/chat-store";
import { useProjectStore, type Project, type ProjectSession } from "@/stores/project-store";
import {
  getSessionModel,
  getSessionThinkingOrDefault,
  saveSessionModel,
  selectSessionModel,
} from "@/hooks/useDataPersistence";
import { SessionCommandCoordinator } from "@/lib/session-command-coordinator";

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
        const models = await SessionCommandCoordinator.getAvailableModels(sessionId);
        const stillCurrentAfterFetch =
          modelFetchRunIdRef.current === fetchRunId &&
          useProjectStore.getState().activeSessionId === sessionId;
        if (!stillCurrentAfterFetch) return;

        if (models && models.length > 0) {
          setAvailableModels(models);
          const selectedModel = selectSessionModel(sessionId, models);
          if (selectedModel) await SessionCommandCoordinator.setModel(sessionId, selectedModel, { models });
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

    if (!activeSessionId || !activeSessionAgentId) {
      clearModels();
      return;
    }

    if (!activeSessionInitialized) {
      void SessionCommandCoordinator.initializeSession(activeSessionId, {
        recordFailure: true,
      });
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
      void SessionCommandCoordinator.setThinking(activeSessionId, thinkingToSet).catch(() => undefined);
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

    void SessionCommandCoordinator.initializeSession(session.id, {
      activate: true,
      recordFailure: true,
    }).catch((error: unknown) => addAgentStartupError(session.id, error));
  }, []);

  return { switchToSession };
}
