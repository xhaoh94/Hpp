import { useCallback, useEffect, useRef } from "react";
import { useChatStore, type ModelInfo } from "@/stores/chat-store";
import { useProjectStore, type Project, type ProjectSession } from "@/stores/project-store";
import {
  getSessionModel,
  getSessionThinking,
  saveSessionModel,
  selectSessionModel,
} from "@/hooks/useDataPersistence";
import { normalizeModelThinkingLevel } from "@shared/models";
import { SessionCommandCoordinator } from "@/lib/session-command-coordinator";

const MODEL_FETCH_RETRY_DELAYS = [0, 500, 1000, 2000, 4000, 8000];
// Startup initialization can lose a race against plugin/catalog warm-up and
// fail silently (the spinner overlay hides the startup-error message). Retry
// the auto-init a few times instead of spinning forever until the user
// manually switches sessions.
const AUTO_INIT_RETRY_DELAYS_MS = [1500, 4000];

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
          if (selectedModel) {
            // The session coordinator already applied the persisted model when
            // the runtime was created. Re-sending setModel on every tab switch
            // needlessly performs another backend roundtrip (and can also
            // trigger thinking-level reconciliation). Only configure when the
            // catalog selection differs from the persisted session selection.
            setCurrentModel(selectedModel);
            const persistedThinking = getSessionThinking(sessionId);
            if (persistedThinking) {
              useChatStore.getState().setThinkingLevel(
                normalizeModelThinkingLevel(persistedThinking, selectedModel),
              );
            }
            const persistedModel = getSessionModel(sessionId);
            if (
              !persistedModel ||
              persistedModel.id !== selectedModel.id ||
              persistedModel.provider !== selectedModel.provider
            ) {
              await SessionCommandCoordinator.setModel(sessionId, selectedModel, { models });
            }
          }
          return;
        }
        // 没有已发现目录时，当前模型可能只是旧会话/旧版本遗留的
        // 持久化值；先清掉它，再继续重试真正的模型发现。
        if (useChatStore.getState().availableModels.length === 0) clearModels();
      } catch {
        // 没有任何已发现目录时，错误也不能让旧 currentModel 继续显示。
        if (useChatStore.getState().availableModels.length === 0) clearModels();
        // Retry below; final empty state is handled after all attempts.
      }
    }

    if (
      modelFetchRunIdRef.current === fetchRunId &&
      useProjectStore.getState().activeSessionId === sessionId
    ) {
      // getAvailableModels 保留的是已经存在的有效目录；如果所有重试都
      // 仍然没有目录，说明当前会话确实没有可用模型，也要清掉可能由旧
      // 会话或旧版本遗留的 currentModel，不能让它继续伪装成可用模型。
      clearModels();
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

  // 模型目录是按会话/Agent 作用域的。切换后先同步清空，避免异步发现
  // 完成前把上一个会话的目录误显示在当前聊天栏。
  useEffect(() => {
    clearModels();
  }, [activeSessionId, activeSessionAgentId, clearModels]);

  useEffect(() => {
    const fetchRunId = ++modelFetchRunIdRef.current;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    if (!activeSessionId || !activeSessionAgentId) {
      clearModels();
      return;
    }

    if (!activeSessionInitialized) {
      const scheduleRetry = (attempt: number) => {
        if (attempt >= AUTO_INIT_RETRY_DELAYS_MS.length) return;
        retryTimer = setTimeout(() => {
          const projectState = useProjectStore.getState();
          if (
            projectState.activeSessionId !== activeSessionId ||
            projectState.initializedSessionIds.has(activeSessionId)
          ) return;
          const session = projectState.projects
            .flatMap((candidate) => candidate.sessions)
            .find((candidate) => candidate.id === activeSessionId);
          if (!session || session.agentId !== activeSessionAgentId) return;
          void SessionCommandCoordinator.initializeSession(activeSessionId, {
            recordFailure: true,
          }).finally(() => {
            if (
              useProjectStore.getState().activeSessionId === activeSessionId &&
              !useProjectStore.getState().initializedSessionIds.has(activeSessionId)
            ) {
              scheduleRetry(attempt + 1);
            }
          });
        }, AUTO_INIT_RETRY_DELAYS_MS[attempt]);
      };
      void SessionCommandCoordinator.initializeSession(activeSessionId, {
        recordFailure: true,
      }).finally(() => {
        if (
          useProjectStore.getState().activeSessionId === activeSessionId &&
          !useProjectStore.getState().initializedSessionIds.has(activeSessionId)
        ) {
          scheduleRetry(0);
        }
      });
      return () => {
        if (retryTimer) clearTimeout(retryTimer);
      };
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
    const projectState = useProjectStore.getState();
    const chatState = useChatStore.getState();
    const currentSession = projectState.activeSessionId
      ? projectState.projects
        .flatMap((candidate) => candidate.sessions)
        .find((candidate) => candidate.id === projectState.activeSessionId)
      : undefined;
    // 只在同一 Agent 内继承模型。跨 Agent 继承会把旧 Agent 的模型/渠道
    // 写入新会话；目标 Agent（尤其是尚未注册渠道的 Droid）随后会错误地
    // 把这份旧目录当成自己的可用模型。
    if (
      currentSession?.agentId === session.agentId &&
      !getSessionModel(session.id) &&
      chatState.currentModel
    ) {
      saveSessionModel(session.id, chatState.currentModel);
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
