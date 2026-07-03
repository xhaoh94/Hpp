import { useEffect, useRef } from "react";
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
  getToolProcessFiles,
  isPlanLikeProcessEvent,
  mergeRuntimeChangeFile,
  normalizePlanStepsFromEvent,
  normalizeProcessEntryState,
  normalizeProcessEntryType,
  resetSessionRuntimeAfterTurn,
  scheduleRuntimeRenderFlush,
  summarizeRuntimeChanges,
  stringifyProcessValue,
  truncateProcessDetail,
  type InferredStepSignal,
  type SessionRuntime,
} from "./agentEventUtils";
import {
  handleDefaultQuestionEvent,
  handleDirectQuestionEvent,
} from "./agentQuestionHandlers";
import {
  handleAgentDisconnectedEvent,
  handleDiffUpdateEvent,
  handleMessageStartEvent,
  handleStreamDeltaEvent,
  handleStreamEndEvent,
  handleStreamSnapshotEvent,
  handleStreamStartEvent,
  handleThinkingDeltaEvent,
} from "./agentStreamHandlers";
import {
  handleToolEndEvent,
  handleToolStartEvent,
} from "./agentToolHandlers";
import type {
  AgentEventHandlerContext,
  PendingUIResponse,
  PendingUIResponseUpdate,
} from "./agentEventTypes";

type UseAgentEventsOptions = {
  activeAgentId: string;
  sessionRuntimeRef: { current: Record<string, SessionRuntime> };
  pendingUIResponseRef: { current: PendingUIResponse };
  setPendingUIResponseState: (next: PendingUIResponseUpdate) => void;
  setStreaming: (streaming: boolean) => void;
};

export function useAgentEvents({
  activeAgentId,
  sessionRuntimeRef,
  pendingUIResponseRef,
  setPendingUIResponseState,
  setStreaming,
}: UseAgentEventsOptions) {
  const latestOptionsRef = useRef({
    activeAgentId,
    setPendingUIResponseState,
    setStreaming,
  });
  latestOptionsRef.current = {
    activeAgentId,
    setPendingUIResponseState,
    setStreaming,
  };

  useEffect(() => {
    const setPendingUIResponse = (next: PendingUIResponseUpdate) => {
      latestOptionsRef.current.setPendingUIResponseState(next);
    };

    const setStreamingState = (streaming: boolean) => {
      latestOptionsRef.current.setStreaming(streaming);
    };

    const getRuntime = (sessionId: string) => {
      const existing = sessionRuntimeRef.current[sessionId];
      if (existing) return existing;
      const runtime = createSessionRuntime();
      sessionRuntimeRef.current[sessionId] = runtime;
      return runtime;
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
      useChatStore.getState().updateLastAssistantProcessMeta({ planSteps: steps }, sessionId);
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
    };

    const failAssistantStream = (currentSessionId: string, title: string, detail?: string) => {
      const runtime = getRuntime(currentSessionId);
      clearStreamWatchdog(currentSessionId);
      completeIdleNotice(currentSessionId);
      finishAssistantProcessText(currentSessionId);
      finishThinkingEntry(currentSessionId);
      updateInferredPlanSteps(currentSessionId, "failed");

      const errorContent = detail?.trim()
        ? `${title}\n\n${detail.trim()}`
        : title;
      if (errorContent.trim()) {
        runtime.streamBuffer = errorContent;
        useChatStore.getState().updateLastAssistant(errorContent, currentSessionId);
      }

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

      runtime.processActive = true;
      runtime.streamStarted = true;
      runtime.autoAbortReason = null;
      useChatStore.getState().startAssistantProcess(Date.now(), currentSessionId);
      if (currentSessionId === useProjectStore.getState().activeSessionId) setStreamingState(true);
      useProjectStore.getState().setAgentStatus(currentSessionId, "running");
      refreshStreamWatchdog(currentSessionId);
    };

    const handlerContext: AgentEventHandlerContext = {
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
    };

    const unsubscribe = window.electronAPI.onAgentEvent((event) => {
      // Always read from store to avoid stale closure (useEffect deps=[])
      const currentSessionId = typeof event.sessionId === "string"
        ? event.sessionId
        : useProjectStore.getState().activeSessionId;
      if (!currentSessionId) return;
      const runtime = getRuntime(currentSessionId);
      if (runtime.manualAbortRequested && event.type !== "aborted" && event.type !== "agent_disconnected") {
        return;
      }
      if (
        event.type !== "message_start" &&
        event.type !== "stream_start" &&
        event.type !== "stream_snapshot" &&
        event.type !== "stream_end" &&
        event.type !== "agent_end" &&
        event.type !== "agent_disconnected" &&
        event.type !== "context_compaction"
      ) {
        completeIdleNotice(currentSessionId);
        refreshStreamWatchdog(currentSessionId);
      }
      switch (event.type) {
        case "message_start":
          handleMessageStartEvent(event, currentSessionId, runtime, handlerContext);
          break;
        case "stream_start":
          handleStreamStartEvent(currentSessionId, runtime, handlerContext);
          break;
        case "stream_delta":
          handleStreamDeltaEvent(event, currentSessionId, handlerContext);
          break;
        case "stream_snapshot":
          handleStreamSnapshotEvent(event, currentSessionId, handlerContext);
          break;
        case "thinking_delta":
          handleThinkingDeltaEvent(event, currentSessionId, handlerContext);
          break;
        case "thinking_end":
          finishThinkingEntry(currentSessionId);
          break;
        case "user_ask_question":
        case "ask_user_question":
        case "ask_user":
        case "droid.ask_user":
          handleDirectQuestionEvent(event, currentSessionId, handlerContext);
          break;
        case "stream_end":
          handleStreamEndEvent(event, currentSessionId, runtime, handlerContext);
          break;
        case "agent_end":
          // Some backends can emit agent_end before the assistant stream is
          // actually complete. stream_end is the UI completion signal.
          break;
        case "agent_disconnected":
          if (runtime.manualAbortRequested) {
            finishManualAbort(currentSessionId);
            break;
          }
          handleAgentDisconnectedEvent(currentSessionId, runtime, handlerContext);
          break;
        case "aborted":
          finishManualAbort(currentSessionId);
          break;
        case "tool_start":
          handleToolStartEvent(event, currentSessionId, runtime, handlerContext);
          break;
        case "tool_end":
          handleToolEndEvent(event, currentSessionId, runtime, handlerContext);
          break;
        case "diff_update":
          handleDiffUpdateEvent(event, currentSessionId, handlerContext);
          break;
        case "context_compaction":
          appendContextCompactionDivider(currentSessionId, typeof event.id === "string" ? event.id : undefined);
          break;
        case "plan_update":
          {
            const steps = normalizePlanStepsFromEvent(event);
            if (steps.length === 0) break;
            ensureAssistantContinuation(currentSessionId);
            finishAssistantProcessText(currentSessionId);
            finishThinkingEntry(currentSessionId);
            updateProcessPlanSteps(currentSessionId, steps, true);
          }
          break;
        case "process_event":
          const eventType = normalizeProcessEntryType(event.entryType || event.kind || event.mode || event.toolName || event.name);
          const eventTitle = String(event.title || "Agent 事件");
          const eventDetail = event.detail ? truncateProcessDetail(stringifyProcessValue(event.detail)) : undefined;
          const eventState = normalizeProcessEntryState(event.state);
          if (isPlanLikeProcessEvent(event)) {
            const steps = normalizePlanStepsFromEvent(event);
            if (steps.length > 0) {
              ensureAssistantContinuation(currentSessionId);
              finishAssistantProcessText(currentSessionId);
              finishThinkingEntry(currentSessionId);
              updateProcessPlanSteps(currentSessionId, steps, true);
              break;
            }
          }
          if (
            (eventType === "error" || eventState === "error") &&
            isAlreadyRunningError(eventTitle, eventDetail) &&
            (runtime.processActive || useProjectStore.getState().agentStatuses[currentSessionId] === "running")
          ) {
            if (!runtime.processActive) ensureAssistantContinuation(currentSessionId);
            appendOrRefreshAlreadyRunningNotice(currentSessionId);
            break;
          }
          ensureAssistantContinuation(currentSessionId);
          finishAssistantProcessText(currentSessionId);
          finishThinkingEntry(currentSessionId);
          if (eventType === "error" || eventState === "error") {
            failAssistantStream(currentSessionId, eventTitle, eventDetail);
            setPendingUIResponse((current) => current?.sessionId === currentSessionId ? null : current);
            break;
          }
          let questionEntryId: string | undefined;
          if (eventType === "question") {
            questionEntryId = createProcessEntryId();
            setPendingUIResponse(getPendingUIFromEvent(event, currentSessionId, questionEntryId));
          }
          const processFiles = Array.isArray(event.files) ? getToolProcessFiles(event) : undefined;
          const changedProcessFiles = (processFiles || []).filter((file) =>
            file.action === "edited" ||
            file.action === "written" ||
            file.action === "modified" ||
            typeof file.additions === "number" ||
            typeof file.deletions === "number"
          );
          if (changedProcessFiles.length > 0) {
            recordProcessFiles(currentSessionId, changedProcessFiles, "modify");
          } else if (eventType === "tool" || eventType === "diff") {
            updateInferredPlanSteps(currentSessionId, eventType === "diff" ? "modify" : "operate");
          }

          let processedTitle = eventTitle;
          if (eventType === "tool" && !eventTitle.includes("运行") && !eventTitle.includes("已完成") && !eventTitle.includes("失败")) {
            processedTitle = `正在执行: ${eventTitle}`;
          } else if (eventType === "diff" && !eventTitle.includes("修改") && !eventTitle.includes("变更")) {
            processedTitle = `文件变更: ${eventTitle}`;
          } else if (eventType === "thinking" && !eventTitle.includes("思考")) {
            processedTitle = `思考: ${eventTitle}`;
          } else if (eventType === "question" && !eventTitle.includes("询问") && !eventTitle.includes("问题")) {
            processedTitle = `询问用户: ${eventTitle}`;
          }

          appendProcessEntry(currentSessionId, {
            id: questionEntryId,
            type: eventType,
            title: processedTitle,
            detail: eventType === "question" ? undefined : eventDetail,
            files: processFiles,
            state: eventType === "question" ? eventState || "running" : eventState,
          });
          break;
        case "agent_ready":
          const agentName = getAgentName(String(event.agentId || latestOptionsRef.current.activeAgentId));
          appendProcessEntry(currentSessionId, {
            type: "status",
            title: `${agentName} 已就绪，可以开始对话`,
            state: "completed",
          });
          // Models are fetched by the useEffect watching activeSessionId
          break;
        case "session_file_path":
          {
            const sessionFilePath = String(event.sessionFilePath || "");
            if (!sessionFilePath) break;
            const project = useProjectStore.getState().projects.find((p) =>
              p.sessions.some((session) => session.id === currentSessionId)
            );
            if (project) {
              useProjectStore.getState().setSessionFilePath(project.id, currentSessionId, sessionFilePath);
            }
          }
          break;
        default:
          handleDefaultQuestionEvent(event, currentSessionId, handlerContext);
          break;
      }
    });
    return () => {
      clearStreamWatchdog();
      Object.values(sessionRuntimeRef.current).forEach((runtime) => {
        if (runtime.streamWatchdog) {
          clearTimeout(runtime.streamWatchdog);
          runtime.streamWatchdog = null;
        }
      });
      unsubscribe();
    };
  }, []);
}
