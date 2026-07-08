import { getAgentName } from "@/lib/agents";
import {
  useChatStore,
  type AgentProcessEntry,
  type AgentProcessFile,
  type AgentProcessStep,
} from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import type { AgentEvent } from "@/types";
import { normalizeAskQuestionsFromCandidates } from "./QuestionnairePanel";
import {
  asRecord,
  buildInferredPlanSteps,
  createProcessEntryId,
  createSessionRuntime,
  getRepeatedThinkingPattern,
  getThinkingPreview,
  mergeRuntimeChangeFile,
  resetSessionRuntimeAfterTurn,
  scheduleRuntimeRenderFlush,
  summarizeRuntimeChanges,
  type InferredStepSignal,
  type SessionRuntime,
} from "./agentEventUtils";
import type {
  AgentEventRuntimeController,
  PendingUIResponse,
} from "./agentEventTypes";

type CreateAgentEventControllerOptions = {
  activeAgentIdRef: { current: string };
  sessionRuntimeRef: { current: Record<string, SessionRuntime> };
  pendingUIResponseRef: { current: PendingUIResponse };
  setPendingUIResponse: AgentEventRuntimeController["setPendingUIResponse"];
  setStreamingState: AgentEventRuntimeController["setStreamingState"];
};

export function createAgentEventController({
  activeAgentIdRef,
  sessionRuntimeRef,
  pendingUIResponseRef,
  setPendingUIResponse,
  setStreamingState,
}: CreateAgentEventControllerOptions): AgentEventRuntimeController {
  const getActiveAgentId = () => activeAgentIdRef.current;
  const getRuntime = (sessionId: string) => {
    const existing = sessionRuntimeRef.current[sessionId];
    if (existing) return existing;
    const runtime = createSessionRuntime();
    sessionRuntimeRef.current[sessionId] = runtime;
    return runtime;
  };

  const isOpenProjectSession = (sessionId: string) =>
    useProjectStore.getState().projects.some((project) =>
      project.sessions.some((session) => session.id === sessionId && !session.closed)
    );

  const discardRuntime = (sessionId: string) => {
    const runtime = sessionRuntimeRef.current[sessionId];
    if (runtime) {
      if (runtime.streamWatchdog) {
        clearTimeout(runtime.streamWatchdog);
        runtime.streamWatchdog = null;
      }
      resetSessionRuntimeAfterTurn(runtime);
      delete sessionRuntimeRef.current[sessionId];
    }
    setPendingUIResponse((current) => current?.sessionId === sessionId ? null : current);
  };

  const hasLastAssistantProcessEntry = (sessionId: string, entryId: string) => {
    const state = useChatStore.getState();
    const messages = state.sessionMessages[sessionId] || (state.activeSessionId === sessionId ? state.messages : []);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      return !!message.process?.entries.some((entry) => entry.id === entryId);
    }
    return false;
  };

  const flushRuntimeRender = (sessionId: string) => {
    const runtime = getRuntime(sessionId);
    if (runtime.streamRenderFlushTimer) {
      clearTimeout(runtime.streamRenderFlushTimer);
      runtime.streamRenderFlushTimer = null;
    }
    runtime.streamRenderBufferedChars = 0;

    if (runtime.processTextEntryId && runtime.pendingProcessTextDetail !== "") {
      useChatStore.getState().updateLastAssistantProcessEntry(runtime.processTextEntryId, {
        title: "正文输出",
        detail: runtime.pendingProcessTextDetail,
        state: "running",
      }, sessionId);
      runtime.pendingProcessTextDetail = "";
    }

    if (runtime.thinkingEntryId && runtime.pendingThinkingDetail !== "") {
      useChatStore.getState().updateLastAssistantProcessEntry(runtime.thinkingEntryId, {
        title: runtime.pendingThinkingTitle || `正在思考: ${getThinkingPreview(runtime.pendingThinkingDetail)}`,
        detail: runtime.pendingThinkingDetail,
        state: "running",
      }, sessionId);
      runtime.pendingThinkingDetail = "";
      runtime.pendingThinkingTitle = null;
    }
  };

  const appendProcessEntry = (sessionId: string, entry: Omit<AgentProcessEntry, "id" | "timestamp"> & { id?: string; timestamp?: number }) => {
    const runtime = getRuntime(sessionId);
    if (!runtime.processActive) return;
    if (entry.id && hasLastAssistantProcessEntry(sessionId, entry.id)) {
      useChatStore.getState().updateLastAssistantProcessEntry(entry.id, {
        timestamp: entry.timestamp || Date.now(),
        type: entry.type,
        title: entry.title,
        detail: entry.detail,
        files: entry.files,
        toolKind: entry.toolKind,
        command: entry.command,
        state: entry.state,
        expanded: entry.expanded,
      }, sessionId);
      return;
    }
    useChatStore.getState().appendLastAssistantProcessEntry({
      id: entry.id || createProcessEntryId(),
      timestamp: entry.timestamp || Date.now(),
      type: entry.type,
      title: entry.title,
      detail: entry.detail,
      files: entry.files,
      toolKind: entry.toolKind,
      command: entry.command,
      state: entry.state,
      expanded: entry.expanded,
    }, sessionId);
  };

  const updateProcessPlanSteps = (sessionId: string, steps: AgentProcessStep[], native = true) => {
    if (steps.length === 0) return;
    const runtime = getRuntime(sessionId);
    if (native) runtime.nativePlanSteps = true;
    useChatStore.getState().updateLastAssistantProcessMeta({
      planSteps: steps,
      planStepsSource: native ? "native" : "inferred",
    }, sessionId);
  };

  const updateInferredPlanSteps = (sessionId: string, signal: InferredStepSignal) => {
    const runtime = getRuntime(sessionId);
    const steps = buildInferredPlanSteps(runtime, signal);
    if (!steps || steps.length === 0) return;
    updateProcessPlanSteps(sessionId, steps, false);
  };

  const recordProcessFiles = (
    sessionId: string,
    files: AgentProcessFile[],
    signal: InferredStepSignal = "modify"
  ) => {
    const runtime = getRuntime(sessionId);
    let changed = false;
    for (const file of files) {
      if (mergeRuntimeChangeFile(runtime, file)) changed = true;
    }
    updateInferredPlanSteps(sessionId, signal);
    if (!changed) return;
    useChatStore.getState().updateLastAssistantProcessMeta({
      changeSummary: summarizeRuntimeChanges(runtime),
    }, sessionId);
  };

  const completeIdleNotice = (sessionId: string) => {
    flushRuntimeRender(sessionId);
    const runtime = getRuntime(sessionId);
    if (!runtime.streamIdleNoticeEntryId) return;
    useChatStore.getState().updateLastAssistantProcessEntry(runtime.streamIdleNoticeEntryId, {
      state: "completed",
      expanded: false,
    }, sessionId);
    runtime.streamIdleNoticeEntryId = null;
  };

  const appendOrRefreshIdleNotice = (sessionId: string) => {
    flushRuntimeRender(sessionId);
    const runtime = getRuntime(sessionId);
    if (!runtime.processActive) return;

    if (runtime.streamIdleNoticeEntryId) {
      useChatStore.getState().updateLastAssistantProcessEntry(runtime.streamIdleNoticeEntryId, {
        title: "Codex 仍在运行，暂时没有新输出",
        detail: "Codex 任务还没有结束，正在等待后续事件或最终响应。",
        state: "running",
        expanded: false,
      }, sessionId);
    } else {
      const entryId = createProcessEntryId();
      runtime.streamIdleNoticeEntryId = entryId;
      appendProcessEntry(sessionId, {
        id: entryId,
        type: "status",
        title: "Codex 仍在运行，暂时没有新输出",
        detail: "Codex 任务还没有结束，正在等待后续事件或最终响应。",
        state: "running",
        expanded: false,
      });
    }

    if (sessionId === useProjectStore.getState().activeSessionId) setStreamingState(true);
    useProjectStore.getState().setAgentStatus(sessionId, "running");
  };

  const appendOrRefreshAlreadyRunningNotice = (sessionId: string) => {
    flushRuntimeRender(sessionId);
    const runtime = getRuntime(sessionId);
    if (!runtime.processActive) return;

    if (runtime.streamIdleNoticeEntryId) {
      useChatStore.getState().updateLastAssistantProcessEntry(runtime.streamIdleNoticeEntryId, {
        title: "Codex 仍在执行上一条请求",
        detail: "新的发送请求已忽略；当前 Codex 任务还在运行，后续输出会继续追加到这里。",
        state: "running",
        expanded: false,
      }, sessionId);
    } else {
      const entryId = createProcessEntryId();
      runtime.streamIdleNoticeEntryId = entryId;
      appendProcessEntry(sessionId, {
        id: entryId,
        type: "status",
        title: "Codex 仍在执行上一条请求",
        detail: "新的发送请求已忽略；当前 Codex 任务还在运行，后续输出会继续追加到这里。",
        state: "running",
        expanded: false,
      });
    }

    if (sessionId === useProjectStore.getState().activeSessionId) setStreamingState(true);
    useProjectStore.getState().setAgentStatus(sessionId, "running");
    refreshStreamWatchdog(sessionId);
  };

  const isAlreadyRunningError = (title: string, detail?: string) =>
    /Codex is already running/i.test(`${title}\n${detail || ""}`);

  const finishManualAbort = (sessionId: string) => {
    flushRuntimeRender(sessionId);
    const runtime = getRuntime(sessionId);
    if (!runtime.manualAbortRequested) return;
    clearStreamWatchdog(sessionId);
    completeIdleNotice(sessionId);
    finishAssistantProcessText(sessionId);
    finishThinkingEntry(sessionId);
    updateInferredPlanSteps(sessionId, "cancelled");
    useChatStore.getState().finishLastAssistantProcess(Date.now(), "interrupted", sessionId);
    resetSessionRuntimeAfterTurn(runtime);
    runtime.autoAbortReason = null;
    runtime.manualAbortRequested = false;
    setPendingUIResponse((current) => current?.sessionId === sessionId ? null : current);
    if (sessionId === useProjectStore.getState().activeSessionId) setStreamingState(false);
    useProjectStore.getState().setAgentStatus(sessionId, "idle");
  };

  const finishThinkingEntry = (sessionId: string) => {
    flushRuntimeRender(sessionId);
    const runtime = getRuntime(sessionId);
    if (runtime.thinkingEntryId) {
      useChatStore.getState().updateLastAssistantProcessEntry(runtime.thinkingEntryId, {
        state: "completed",
      }, sessionId);
    }
    runtime.thinkingEntryId = null;
    runtime.thinkingBuffer = "";
  };

  const abortRepeatedThinking = (sessionId: string, pattern: string, repeatCount: number) => {
    flushRuntimeRender(sessionId);
    const runtime = getRuntime(sessionId);
    if (runtime.autoAbortReason) return;

    runtime.autoAbortReason = "repeated-thinking";
    if (runtime.streamWatchdog) {
      clearTimeout(runtime.streamWatchdog);
      runtime.streamWatchdog = null;
    }

    useChatStore.getState().appendLastAssistantProcessEntry({
      id: createProcessEntryId(),
      timestamp: Date.now(),
      type: "error",
      title: "检测到重复思考，已自动中断",
      detail: `最近思考内容连续重复 ${repeatCount} 次:\n${pattern}`,
      state: "interrupted",
      expanded: true,
    }, sessionId);
    useChatStore.getState().finishLastAssistantProcess(Date.now(), "interrupted", sessionId);

    resetSessionRuntimeAfterTurn(runtime);

    setPendingUIResponse((current) => current?.sessionId === sessionId ? null : current);
    if (sessionId === useProjectStore.getState().activeSessionId) setStreamingState(false);
    useProjectStore.getState().setAgentStatus(sessionId, "idle");

    void window.electronAPI.agentAbort(sessionId).catch((err) => {
      console.error("[agent] auto abort repeated thinking failed:", err);
    });
  };

  const appendAssistantProcessText = (sessionId: string, delta: string) => {
    if (!delta) return;
    const runtime = getRuntime(sessionId);
    runtime.streamBuffer += delta;
    runtime.processTextBuffer += delta;

    if (runtime.processTextEntryId) {
      runtime.pendingProcessTextDetail = runtime.processTextBuffer;
      scheduleRuntimeRenderFlush(runtime, () => flushRuntimeRender(sessionId), delta.length);
      return;
    }

    if (runtime.processTextEntryId) {
      useChatStore.getState().updateLastAssistantProcessEntry(runtime.processTextEntryId, {
        title: "正文输出",
        detail: runtime.processTextBuffer,
        state: "running",
      }, sessionId);
      return;
    }

    const entryId = createProcessEntryId();
    runtime.processTextEntryId = entryId;
    runtime.processTextEntryIds.push(entryId);
    appendProcessEntry(sessionId, {
      id: entryId,
      type: "info",
      title: "正文输出",
      detail: runtime.processTextBuffer,
      state: "running",
    });
  };

  const finishAssistantProcessText = (sessionId: string) => {
    flushRuntimeRender(sessionId);
    const runtime = getRuntime(sessionId);
    if (runtime.processTextEntryId) {
      useChatStore.getState().updateLastAssistantProcessEntry(runtime.processTextEntryId, {
        title: "正文输出",
        detail: runtime.processTextBuffer,
        state: "completed",
      }, sessionId);
      if (runtime.processTextBuffer.trim()) {
        runtime.processTextHistory.push(runtime.processTextBuffer);
      }
    }
    runtime.processTextEntryId = null;
    runtime.processTextBuffer = "";
  };

  const replaceAssistantProcessText = (sessionId: string, content: string) => {
    const runtime = getRuntime(sessionId);
    const delta = content.startsWith(runtime.streamBuffer)
      ? content.slice(runtime.streamBuffer.length)
      : content;
    if (delta) appendAssistantProcessText(sessionId, delta);
  };

  const normalizeStreamText = (value: string) => value.replace(/\s+/g, " ").trim();

  const stripProcessTextPrefixFromFinal = (sessionId: string, finalContent: string) => {
    const runtime = getRuntime(sessionId);
    let remaining = finalContent.trim();
    for (const text of runtime.processTextHistory.slice(0, -1)) {
      const prefix = text.trim();
      const next = remaining.trimStart();
      if (prefix && next.startsWith(prefix)) {
        remaining = next.slice(prefix.length).trimStart();
      }
    }
    return remaining.trim();
  };

  const moveFinalAssistantProcessTextToBubble = (sessionId: string, finalContent: string) => {
    const runtime = getRuntime(sessionId);
    const lastIndex = runtime.processTextHistory.length - 1;
    if (lastIndex < 0) return;
    const lastText = runtime.processTextHistory[lastIndex];
    const lastEntryId = runtime.processTextEntryIds[lastIndex];
    if (!lastEntryId || normalizeStreamText(lastText) !== normalizeStreamText(finalContent)) return;
    useChatStore.getState().removeLastAssistantProcessEntries([lastEntryId], sessionId);
    runtime.processTextEntryIds.splice(lastIndex, 1);
    runtime.processTextHistory.splice(lastIndex, 1);
  };

  const appendThinkingDelta = (sessionId: string, delta: string) => {
    if (!delta) return;
    const runtime = getRuntime(sessionId);
    runtime.thinkingBuffer += delta;
    const thinkingPreview = getThinkingPreview(runtime.thinkingBuffer);

    if (runtime.thinkingEntryId) {
      runtime.pendingThinkingDetail = runtime.thinkingBuffer;
      runtime.pendingThinkingTitle = `正在思考: ${thinkingPreview}`;
      scheduleRuntimeRenderFlush(runtime, () => flushRuntimeRender(sessionId), delta.length);
    } else {
      const entryId = createProcessEntryId();
      runtime.thinkingEntryId = entryId;
      appendProcessEntry(sessionId, {
        id: entryId,
        type: "thinking",
        title: `正在思考: ${thinkingPreview}`,
        detail: runtime.thinkingBuffer,
        state: "running",
        expanded: false,
      });
    }

    const repeatedPattern = getRepeatedThinkingPattern(runtime.thinkingBuffer);
    if (repeatedPattern) {
      abortRepeatedThinking(sessionId, repeatedPattern.pattern, repeatedPattern.repeatCount);
    }
  };

  const getPendingUIFromEvent = (event: AgentEvent, sessionId: string, entryId: string): PendingUIResponse => {
    const detail = asRecord(event.detail);
    const args = asRecord(event.args);
    const input = asRecord(event.input);
    const method = String(event.method || detail.method || event.kind || event.toolName || "").trim();
    const normalizedMethod =
      method === "custom" && detail.kind === "ask_user_question"
        ? "ask_user_question"
        : method;
    const questions = normalizeAskQuestionsFromCandidates(
      event.questions,
      detail.questions,
      args.questions,
      input.questions,
      event,
      detail,
      args,
      input,
      event.detail
    );
    const fallbackQuestion =
      questions.length > 0
        ? questions
        : normalizeAskQuestionsFromCandidates(
            event.question,
            event.prompt,
            event.message,
            event.title,
            detail.question,
            detail.prompt,
            detail.message,
            detail.title
          );
    return {
      sessionId,
      requestId: typeof event.requestId === "string"
        ? event.requestId
        : typeof event.id === "string"
          ? event.id
          : typeof detail.id === "string"
            ? detail.id
            : undefined,
      method: normalizedMethod || undefined,
      entryId,
      questions: fallbackQuestion.length > 0 ? fallbackQuestion : [{ question: "请回答 Agent 的问题", options: [] }],
    };
  };

  const clearStreamWatchdog = (sessionId?: string) => {
    if (!sessionId) {
      return;
    }
    const runtime = getRuntime(sessionId);
    if (runtime.streamWatchdog) {
      clearTimeout(runtime.streamWatchdog);
      runtime.streamWatchdog = null;
    }
  };

  const notifyAgentTaskCompleted = (sessionId: string, timedOut: boolean) => {
    const projectState = useProjectStore.getState();
    const project = projectState.projects.find((candidate) =>
      candidate.sessions.some((session) => session.id === sessionId)
    );
    const session = project?.sessions.find((candidate) => candidate.id === sessionId);
    const agentName = getAgentName(session?.agentId || getActiveAgentId());
    const title = timedOut ? `${agentName} 任务已停止` : `${agentName} 任务已完成`;
    const context = [
      project?.name,
      session?.title,
    ].filter(Boolean).join(" · ");

    void window.electronAPI.showNotification({
      title,
      body: context || "点击查看 Hpp",
    }).catch((error) => {
      console.error("[notification] show failed:", error);
    });
  };

  const completeAssistantStream = (
    currentSessionId: string,
    content?: string,
    timedOut = false
  ) => {
    const runtime = getRuntime(currentSessionId);
    clearStreamWatchdog(currentSessionId);
    completeIdleNotice(currentSessionId);
    finishAssistantProcessText(currentSessionId);
    updateInferredPlanSteps(currentSessionId, timedOut ? "failed" : "verify");
    const finalContent = stripProcessTextPrefixFromFinal(currentSessionId, content || runtime.streamBuffer);
    if (finalContent.trim().length > 0) {
      runtime.streamBuffer = finalContent;
      useChatStore.getState().updateLastAssistant(finalContent, currentSessionId);
      moveFinalAssistantProcessTextToBubble(currentSessionId, finalContent);
      useChatStore.getState().collapseLastAssistantProcess(currentSessionId);
    } else if (timedOut) {
      useChatStore.getState().appendLastAssistantProcessEntry({
        id: createProcessEntryId(),
        timestamp: Date.now(),
        type: "error",
        title: "未收到响应结束事件",
        detail: "Agent 长时间没有返回新的输出，已停止等待。",
        state: "error",
        expanded: true,
      }, currentSessionId);
    }
    finishThinkingEntry(currentSessionId);
    if (currentSessionId === useProjectStore.getState().activeSessionId) setStreamingState(false);
    useChatStore.getState().finishLastAssistantProcess(Date.now(), "completed", currentSessionId);
    resetSessionRuntimeAfterTurn(runtime);
    if (currentSessionId) {
      const activeId = useProjectStore.getState().activeSessionId;
      // Only show "completed" notification if the user wasn't watching this session
      useProjectStore.getState().setAgentStatus(
        currentSessionId,
        currentSessionId === activeId ? "idle" : timedOut ? "error" : "completed"
      );
    }
    notifyAgentTaskCompleted(currentSessionId, timedOut);
  };

  const failAssistantStream = (currentSessionId: string, title: string, detail?: string) => {
    const runtime = getRuntime(currentSessionId);
    clearStreamWatchdog(currentSessionId);
    completeIdleNotice(currentSessionId);
    finishAssistantProcessText(currentSessionId);
    finishThinkingEntry(currentSessionId);
    updateInferredPlanSteps(currentSessionId, "failed");

    useChatStore.getState().appendLastAssistantProcessEntry({
      id: createProcessEntryId(),
      timestamp: Date.now(),
      type: "error",
      title,
      detail,
      state: "error",
      expanded: true,
    }, currentSessionId);
    useChatStore.getState().finishLastAssistantProcess(Date.now(), "interrupted", currentSessionId);

    resetSessionRuntimeAfterTurn(runtime);
    runtime.autoAbortReason = null;

    if (currentSessionId === useProjectStore.getState().activeSessionId) setStreamingState(false);
    useProjectStore.getState().setAgentStatus(currentSessionId, "error");
  };

  const refreshStreamWatchdog = (currentSessionId: string) => {
    const runtime = getRuntime(currentSessionId);
    clearStreamWatchdog(currentSessionId);
    if (!runtime.processActive || runtime.manualAbortRequested) return;
    runtime.streamWatchdog = setTimeout(() => {
      appendOrRefreshIdleNotice(currentSessionId);
      refreshStreamWatchdog(currentSessionId);
    }, 45000);
  };

  const ensureAssistantContinuation = (currentSessionId: string) => {
    const runtime = getRuntime(currentSessionId);
    if (runtime.manualAbortRequested) return runtime;
    if (runtime.processActive) return runtime;

    runtime.processActive = true;
    runtime.streamStarted = true;
    runtime.autoAbortReason = null;
    completeIdleNotice(currentSessionId);
    useChatStore.getState().startAssistantProcess(Date.now(), currentSessionId);
    if (currentSessionId === useProjectStore.getState().activeSessionId) setStreamingState(true);
    useProjectStore.getState().setAgentStatus(currentSessionId, "running");
    return runtime;
  };

  const appendContextCompactionDivider = (currentSessionId: string, eventId?: string) => {
    const runtime = getRuntime(currentSessionId);
    if (runtime.processActive) {
      completeIdleNotice(currentSessionId);
      finishAssistantProcessText(currentSessionId);
      finishThinkingEntry(currentSessionId);
      appendProcessEntry(currentSessionId, {
        id: eventId ? `context-compaction-entry-${eventId}` : undefined,
        type: "status",
        title: "上下文已自动压缩",
        state: "completed",
        expanded: false,
      });
      if (currentSessionId === useProjectStore.getState().activeSessionId) setStreamingState(true);
      useProjectStore.getState().setAgentStatus(currentSessionId, "running");
      refreshStreamWatchdog(currentSessionId);
      return;
    }

    useChatStore.getState().appendContextCompactionDivider(eventId, currentSessionId);
  };

  const clearAllStreamWatchdogs = () => {
    Object.values(sessionRuntimeRef.current).forEach((runtime) => {
      if (runtime.streamWatchdog) {
        clearTimeout(runtime.streamWatchdog);
        runtime.streamWatchdog = null;
      }
    });
  };

  return {
    pendingUIResponseRef,
    setPendingUIResponse,
    setStreamingState,
    getRuntime,
    appendProcessEntry,
    updateProcessPlanSteps,
    updateInferredPlanSteps,
    recordProcessFiles,
    completeIdleNotice,
    appendOrRefreshAlreadyRunningNotice,
    finishThinkingEntry,
    appendAssistantProcessText,
    finishAssistantProcessText,
    replaceAssistantProcessText,
    appendThinkingDelta,
    getPendingUIFromEvent,
    clearStreamWatchdog,
    completeAssistantStream,
    failAssistantStream,
    refreshStreamWatchdog,
    ensureAssistantContinuation,
    isAlreadyRunningError,
    getActiveAgentId,
    isOpenProjectSession,
    discardRuntime,
    finishManualAbort,
    appendContextCompactionDivider,
    clearAllStreamWatchdogs,
  };
}
