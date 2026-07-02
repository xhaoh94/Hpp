import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { getAgentName } from "@/lib/agents";
import { useChatStore, type AgentProcessEntry } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import type { AgentEvent } from "@/types";
import { normalizeAskQuestionsFromCandidates, type AskQuestionPayload } from "./QuestionnairePanel";
import {
  asRecord,
  createProcessEntryId,
  createSessionRuntime,
  getQuestionTitle,
  getRepeatedThinkingPattern,
  getThinkingPreview,
  getToolDetail,
  getToolKey,
  getToolName,
  getToolProcessFiles,
  getToolSummary,
  normalizeProcessEntryState,
  normalizeProcessEntryType,
  normalizeToolKind,
  resetSessionRuntimeAfterTurn,
  stringifyProcessValue,
  truncateProcessDetail,
  type SessionRuntime,
} from "./agentEventUtils";

export type PendingUIResponse = {
  sessionId: string;
  requestId?: string;
  method?: string;
  entryId?: string;
  questions?: AskQuestionPayload[];
} | null;

type PendingUIResponseUpdate =
  | PendingUIResponse
  | ((current: PendingUIResponse) => PendingUIResponse);

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

    const completeIdleNotice = (sessionId: string) => {
      const runtime = getRuntime(sessionId);
      if (!runtime.streamIdleNoticeEntryId) return;
      useChatStore.getState().updateLastAssistantProcessEntry(runtime.streamIdleNoticeEntryId, {
        state: "completed",
        expanded: false,
      }, sessionId);
      runtime.streamIdleNoticeEntryId = null;
    };

    const appendOrRefreshIdleNotice = (sessionId: string) => {
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

    const finishThinkingEntry = (sessionId: string) => {
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
        useChatStore.getState().updateLastAssistantProcessEntry(runtime.thinkingEntryId, {
          title: `正在思考: ${thinkingPreview}`,
          detail: runtime.thinkingBuffer,
          state: "running",
        }, sessionId);
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
      if (!runtime.processActive) return;
      runtime.streamWatchdog = setTimeout(() => {
        appendOrRefreshIdleNotice(currentSessionId);
        refreshStreamWatchdog(currentSessionId);
      }, 45000);
    };

    const ensureAssistantContinuation = (currentSessionId: string) => {
      const runtime = getRuntime(currentSessionId);
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

    const unsubscribe = window.electronAPI.onAgentEvent((event) => {
      // Always read from store to avoid stale closure (useEffect deps=[])
      const currentSessionId = typeof event.sessionId === "string"
        ? event.sessionId
        : useProjectStore.getState().activeSessionId;
      if (!currentSessionId) return;
      const runtime = getRuntime(currentSessionId);
      if (
        event.type !== "message_start" &&
        event.type !== "stream_start" &&
        event.type !== "stream_snapshot" &&
        event.type !== "stream_end" &&
        event.type !== "agent_end" &&
        event.type !== "agent_disconnected"
      ) {
        completeIdleNotice(currentSessionId);
        refreshStreamWatchdog(currentSessionId);
      }
      switch (event.type) {
        case "message_start":
          if (runtime.processActive) {
            clearStreamWatchdog(currentSessionId);
            appendOrRefreshAlreadyRunningNotice(currentSessionId);
            break;
          }
          if (runtime.streamStarted) {
            clearStreamWatchdog(currentSessionId);
            completeIdleNotice(currentSessionId);
            finishThinkingEntry(currentSessionId);
            useChatStore.getState().finishLastAssistantProcess(Date.now(), "completed", currentSessionId);
          }
          runtime.streamBuffer = "";
          runtime.thinkingBuffer = "";
          runtime.thinkingEntryId = null;
          runtime.streamStarted = false;
          runtime.activeToolEntry = {};
          runtime.activeToolFile = {};
          runtime.autoAbortReason = null;
          runtime.processTextEntryId = null;
          runtime.processTextEntryIds = [];
          runtime.processTextHistory = [];
          runtime.processTextBuffer = "";
          setPendingUIResponse((current) => current?.sessionId === currentSessionId ? null : current);
          useChatStore.getState().startAssistantProcess(Date.now(), currentSessionId);
          runtime.processActive = true;
          const messagePreview = event.content ?
            (event.content.length > 50 ? event.content.substring(0, 50) + "..." : event.content) :
            "用户消息";
          appendProcessEntry(currentSessionId, {
            type: "status",
            title: `收到消息: "${messagePreview}"`,
            detail: event.content ? truncateProcessDetail(String(event.content)) : undefined,
            state: "completed",
          });
          break;
        case "stream_start":
          const alreadyStarted = runtime.streamStarted;
          completeIdleNotice(currentSessionId);
          flushSync(() => {
            if (!alreadyStarted) {
              runtime.streamBuffer = "";
              runtime.thinkingBuffer = "";
              runtime.thinkingEntryId = null;
              runtime.processTextEntryId = null;
              runtime.processTextEntryIds = [];
              runtime.processTextHistory = [];
              runtime.processTextBuffer = "";
            }
            if (currentSessionId === useProjectStore.getState().activeSessionId) setStreamingState(true);
            runtime.processActive = true;
            runtime.streamStarted = true;
            runtime.autoAbortReason = null;
            runtime.activeToolEntry = {};
            runtime.activeToolFile = {};
            if (!alreadyStarted) {
              useChatStore.getState().startAssistantProcess(Date.now(), currentSessionId);
            }
            if (currentSessionId) useProjectStore.getState().setAgentStatus(currentSessionId, "running");
          });
          if (!alreadyStarted) {
            appendProcessEntry(currentSessionId, {
              type: "status",
              title: "正在分析请求并生成响应",
              state: "running",
            });
          }
          refreshStreamWatchdog(currentSessionId);
          break;
        case "stream_delta":
          if (!event.delta) break;
          ensureAssistantContinuation(currentSessionId);
          finishThinkingEntry(currentSessionId);
          appendAssistantProcessText(currentSessionId, String(event.delta));
          refreshStreamWatchdog(currentSessionId);
          break;
        case "stream_snapshot":
          {
            const content = String(event.content || "");
            if (!content) break;
            completeIdleNotice(currentSessionId);
            ensureAssistantContinuation(currentSessionId);
            finishThinkingEntry(currentSessionId);
            replaceAssistantProcessText(currentSessionId, content);
            refreshStreamWatchdog(currentSessionId);
          }
          break;
        case "thinking_delta":
          ensureAssistantContinuation(currentSessionId);
          finishAssistantProcessText(currentSessionId);
          appendThinkingDelta(currentSessionId, String(event.delta || ""));
          break;
        case "thinking_end":
          finishThinkingEntry(currentSessionId);
          break;
        case "user_ask_question":
        case "ask_user_question":
        case "ask_user":
        case "droid.ask_user":
          {
            finishAssistantProcessText(currentSessionId);
            finishThinkingEntry(currentSessionId);
            const entryId = createProcessEntryId();
            setPendingUIResponse(getPendingUIFromEvent(event, currentSessionId, entryId));
            appendProcessEntry(currentSessionId, {
              id: entryId,
              type: "question",
              title: getQuestionTitle(true),
              state: "running",
              expanded: false,
            });
          }
          break;
        case "stream_end":
          {
            if (!runtime.processActive) {
              const eventContent = event.content ? String(event.content) : "";
              if (!eventContent.trim()) break;
              ensureAssistantContinuation(currentSessionId);
            }
            if (pendingUIResponseRef.current?.sessionId === currentSessionId && !event.force) break;
            finishAssistantProcessText(currentSessionId);
            finishThinkingEntry(currentSessionId);
            const eventContent = event.content ? String(event.content) : "";
            completeAssistantStream(currentSessionId, eventContent, false);
            setPendingUIResponse((current) => current?.sessionId === currentSessionId ? null : current);
          }
          break;
        case "agent_end":
          // Some backends can emit agent_end before the assistant stream is
          // actually complete. stream_end is the UI completion signal.
          break;
        case "agent_disconnected":
          if (!runtime.processActive) break;
          finishAssistantProcessText(currentSessionId);
          finishThinkingEntry(currentSessionId);
          completeAssistantStream(currentSessionId, undefined, true);
          setPendingUIResponse((current) => current?.sessionId === currentSessionId ? null : current);
          break;
        case "tool_start":
          {
            ensureAssistantContinuation(currentSessionId);
            finishAssistantProcessText(currentSessionId);
            finishThinkingEntry(currentSessionId);
            const key = getToolKey(event);
            if (normalizeToolKind(event.toolKind) === "question") {
              if (!runtime.activeToolEntry[key]) {
                const entryId = createProcessEntryId();
                runtime.activeToolEntry[key] = entryId;
                setPendingUIResponse(getPendingUIFromEvent(event, currentSessionId, entryId));
                appendProcessEntry(currentSessionId, {
                  id: entryId,
                  type: "question",
                  title: getQuestionTitle(true),
                  state: "running",
                  expanded: false,
                });
              }
              break;
            }
            const existingEntryId = runtime.activeToolEntry[key];
            const toolFiles = getToolProcessFiles(event);
            if (toolFiles.length > 0) runtime.activeToolFile[key] = toolFiles;
            const toolDetail = getToolDetail(event);
            const toolKind = normalizeToolKind(event.toolKind);
            const entryType: AgentProcessEntry["type"] = toolKind === "question" ? "question" : "tool";
            const toolSummary = getToolSummary(event, true);
            if (existingEntryId) {
              useChatStore.getState().updateLastAssistantProcessEntry(existingEntryId, {
                title: toolSummary,
                detail: toolDetail || undefined,
                files: toolFiles.length > 0 ? toolFiles : undefined,
                toolKind,
                command: typeof event.command === "string" ? event.command : undefined,
                state: "running",
                type: entryType,
                expanded: true,
              }, currentSessionId);
            } else {
              const entryId = createProcessEntryId();
              runtime.activeToolEntry[key] = entryId;
              appendProcessEntry(currentSessionId, {
                id: entryId,
                type: entryType,
                title: toolSummary,
                detail: toolDetail || undefined,
                files: toolFiles.length > 0 ? toolFiles : undefined,
                toolKind,
                command: typeof event.command === "string" ? event.command : undefined,
                state: "running",
                expanded: true,
              });
            }
          }
          break;
        case "tool_end":
          {
            finishAssistantProcessText(currentSessionId);
            finishThinkingEntry(currentSessionId);
            const key = getToolKey(event);
            const entryId = runtime.activeToolEntry[key];
            if (normalizeToolKind(event.toolKind) === "question") {
              if (entryId && !pendingUIResponseRef.current) {
                useChatStore.getState().updateLastAssistantProcessEntry(entryId, {
                  title: event.isError ? getQuestionTitle(false, true) : getQuestionTitle(false),
                  state: event.isError ? "error" : "completed",
                  expanded: false,
                }, currentSessionId);
              }
              delete runtime.activeToolEntry[key];
              delete runtime.activeToolFile[key];
              break;
            }
            const toolName = getToolName(event);
            const toolFiles = getToolProcessFiles(event);
            const preservedToolFiles = toolFiles.length > 0 ? toolFiles : runtime.activeToolFile[key] || [];
            const toolDetail = getToolDetail(event);
            const toolSummary = getToolSummary({ ...event, files: preservedToolFiles.length > 0 ? preservedToolFiles : event.files }, false);
            const entryType: AgentProcessEntry["type"] = normalizeToolKind(event.toolKind) === "question"
              ? (event.isError ? "error" : "question")
              : (event.isError ? "error" : "tool");
            const patch = {
              title: toolSummary,
              detail: toolDetail || undefined,
              files: preservedToolFiles.length > 0 && !event.isError ? preservedToolFiles : undefined,
              toolKind: normalizeToolKind(event.toolKind),
              command: typeof event.command === "string" ? event.command : undefined,
              state: event.isError ? "error" : "completed",
              type: entryType,
              expanded: !!event.isError,
            } satisfies Partial<Omit<AgentProcessEntry, "id">>;

            if (entryId) {
              useChatStore.getState().updateLastAssistantProcessEntry(entryId, patch, currentSessionId);
              delete runtime.activeToolEntry[key];
              delete runtime.activeToolFile[key];
            } else {
              appendProcessEntry(currentSessionId, {
                type: entryType,
                title: patch.title || (event.isError ? `${toolName} 执行失败` : `已完成 ${toolName}`),
                detail: patch.detail,
                files: patch.files,
                state: patch.state,
                expanded: patch.expanded,
              });
            }
          }
          break;
        case "diff_update":
          ensureAssistantContinuation(currentSessionId);
          if (Array.isArray(event.diffs) && event.diffs.length > 0) {
            finishAssistantProcessText(currentSessionId);
            finishThinkingEntry(currentSessionId);
            useChatStore.getState().appendLastAssistantDiffs(event.diffs, currentSessionId);
          }
          break;
        case "process_event":
          const eventType = normalizeProcessEntryType(event.entryType || event.kind || event.mode || event.toolName || event.name);
          const eventTitle = String(event.title || "Agent 事件");
          const eventDetail = event.detail ? truncateProcessDetail(stringifyProcessValue(event.detail)) : undefined;
          const eventState = normalizeProcessEntryState(event.state);
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
            files: Array.isArray(event.files) ? getToolProcessFiles(event) : undefined,
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
          if (normalizeToolKind(event.mode || event.entryType || event.kind || event.toolKind) === "question") {
            finishThinkingEntry(currentSessionId);
            const entryId = createProcessEntryId();
            setPendingUIResponse(getPendingUIFromEvent(event, currentSessionId, entryId));
            appendProcessEntry(currentSessionId, {
              id: entryId,
              type: "question",
              title: getQuestionTitle(true),
              state: normalizeProcessEntryState(event.state) || "running",
              expanded: false,
            });
          }
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
