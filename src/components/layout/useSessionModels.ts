import { useCallback, useEffect, useRef } from "react";
import { useChatStore, type ModelInfo } from "@/stores/chat-store";
import { useProjectStore, type Project, type ProjectSession } from "@/stores/project-store";
import {
  getSessionModel,
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
};

export function useSessionModels({
  activeSessionId,
  activeSessionAgentId,
  activeSessionInitialized,
  setAvailableModels,
  setCurrentModel,
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
      // Only blank the picker when there is genuinely nothing usable left.
      // A temporarily unreachable backend (for example a Pi worker busy with
      // a context compaction) must not discard models that are already shown;
      // the next explicit refresh or compaction-settled refresh restores them.
      const chat = useChatStore.getState();
      if (chat.availableModels.length === 0 && !chat.currentModel) clearModels();
    }
  }, [clearModels, setAvailableModels, setCurrentModel]);

  /**
   * Re-run the model fetch for a session. Used when a temporary backend
   * condition (context compaction) may have prevented the initial fetch, so
   * the picker can recover without a session switch or app restart.
   */
  const refreshModels = useCallback((sessionId: string) => {
    if (!useProjectStore.getState().initializedSessionIds.has(sessionId)) return;
    const fetchRunId = ++modelFetchRunIdRef.current;
    void fetchModels(sessionId, fetchRunId);
  }, [fetchModels]);

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

  }, [
    activeSessionId,
    activeSessionAgentId,
    activeSessionInitialized,
    clearModels,
    fetchModels,
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

  return { switchToSession, refreshModels };
}
