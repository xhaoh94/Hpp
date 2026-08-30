import { getAgentName } from "@/lib/agents";
import { formatModelRequestFailure, uiText } from "@/i18n/text";
import { cancelPendingGuidance } from "@/lib/session-command-coordinator";
import {
  ASSISTANT_NARRATION_PROCESS_KIND,
} from "@shared/process-view";
import {
  hasOpenAssistantProcessState,
  useChatStore,
  type AgentProcessEntry,
  type AgentProcessFile,
  type AgentProcessStep,
} from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import type { AgentEvent } from "@/types";
import { normalizeAskQuestionsFromCandidates } from "./QuestionnairePanel";
import {
  activateSessionRuntimeTurn,
  asRecord,
  buildInferredPlanSteps,
  createProcessEntryId,
  createSessionRuntime,
  getRepeatedThinkingPattern,
  getContextCompactionPresentation,
  getThinkingPreview,
  isModelRequestFailureTitle,
  markSessionRuntimeTurnSettled,
  mergeRuntimeChangeFile,
  normalizeAgentTurnRevision,
  rememberSettledCompactionEvent,
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
  getPendingUIResponse: (sessionId: string) => PendingUIResponse;
  setPendingUIResponse: AgentEventRuntimeController["setPendingUIResponse"];
  setStreamingState: AgentEventRuntimeController["setStreamingState"];
  preserveAssistantProcessCollapse?: (sessionId: string, action: () => void) => void;
};

const AGENT_END_GRACE_MS = 750;
const AGENT_END_QUERY_RETRY_MS = 1_000;
const AGENT_END_QUERY_FAILURE_LIMIT = 3;
const STREAM_WATCHDOG_MS = 45_000;

const firstNonEmptyString = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

export function createAgentEventController({
  activeAgentIdRef,
  sessionRuntimeRef,
  getPendingUIResponse,
  setPendingUIResponse,
  setStreamingState,
  preserveAssistantProcessCollapse,
}: CreateAgentEventControllerOptions): AgentEventRuntimeController {
  const agentEndGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const agentEndGraceVersions = new Map<string, number>();
  const agentEndAwaitingReconciliation = new Set<string>();
  const agentEndStateQueryFailures = new Map<string, number>();
  const streamWatchdogVersions = new Map<string, number>();
  const discardedSessionTurns = new Map<string, {
    revisions: string[];
    userMessageIds: string[];
  }>();
  const getActiveAgentId = () => activeAgentIdRef.current;
  const getSessionAgentName = (sessionId: string) => {
    const session = useProjectStore.getState().projects
      .flatMap((project) => project.sessions)
      .find((candidate) => candidate.id === sessionId);
    return getAgentName(session?.agentId || getActiveAgentId());
  };
  const getRuntime = (sessionId: string) => {
    const existing = sessionRuntimeRef.current[sessionId];
    if (existing) return existing;
    const runtime = createSessionRuntime();
    const discardedTurn = discardedSessionTurns.get(sessionId);
    if (discardedTurn) {
      runtime.turnEventState = "settled";
      runtime.turnTerminalReason = "aborted";
      runtime.settledTurnRevisions = [...discardedTurn.revisions];
      runtime.settledTurnUserMessageIds = [...discardedTurn.userMessageIds];
    }
    sessionRuntimeRef.current[sessionId] = runtime;
    return runtime;
  };

  const getSessionMessages = (sessionId: string) => {
    const state = useChatStore.getState();
    return state.sessionMessages[sessionId] || (state.activeSessionId === sessionId ? state.messages : []);
  };

  const hasOpenAssistantProcess = (sessionId: string) =>
    getSessionMessages(sessionId).some(hasOpenAssistantProcessState);

  const getLatestUserMessageId = (sessionId: string) => {
    const messages = getSessionMessages(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") return messages[index].id;
    }
    return null;
  };

  const getLatestModelRequestFailureDetail = (sessionId: string): string | null => {
    const messages = getSessionMessages(sessionId);
    let latestUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") {
        latestUserIndex = index;
        break;
      }
    }

    for (let index = messages.length - 1; index > latestUserIndex; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant" || !message.process) continue;
      for (let entryIndex = message.process.entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
        const entry = message.process.entries[entryIndex];
        if (
          entry.type !== "error" ||
          entry.state !== "error" ||
          entry.title === "未收到响应结束事件" ||
          !isModelRequestFailureTitle(entry.title)
        ) continue;
        return entry.detail?.trim() || "";
      }
    }
    return null;
  };

  const mergeModelRequestFailureIntoContent = (
    content: string,
    detail: string,
  ) => {
    const failureContent = formatModelRequestFailure(detail);
    const normalizedContent = content.trim();
    if (!normalizedContent) return failureContent;
    // Some backends already stream a provider-specific error body. Replace it
    // with the common wording instead of displaying the same error twice.
    if (detail && normalizedContent.includes(detail)) return failureContent;
    if (normalizedContent.includes(failureContent)) return normalizedContent;
    return `${normalizedContent}\n\n${failureContent}`;
  };

  const clearAgentEndGraceTimer = (sessionId: string) => {
    agentEndGraceVersions.set(sessionId, (agentEndGraceVersions.get(sessionId) || 0) + 1);
    const timer = agentEndGraceTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    agentEndGraceTimers.delete(sessionId);
  };

  const clearAgentEndObservation = (sessionId: string) => {
    agentEndAwaitingReconciliation.delete(sessionId);
    agentEndStateQueryFailures.delete(sessionId);
  };

  const cancelAgentEndGrace = (sessionId: string) => {
    clearAgentEndGraceTimer(sessionId);
    clearAgentEndObservation(sessionId);
  };

  const stopContextCompaction = (sessionId: string) => {
    const runtime = getRuntime(sessionId);
    if (runtime.activeCompactionId) {
      rememberSettledCompactionEvent(runtime, runtime.activeCompactionId);
      if (runtime.activeCompactionPresentation === "process") {
        useChatStore.getState().updateLastAssistantProcessEntry(runtime.activeCompactionId, {
          title: "上下文压缩已中断",
          state: "interrupted",
          expanded: false,
        }, sessionId);
      } else {
        useChatStore.getState().appendContextCompactionDivider(
          runtime.activeCompactionId,
          sessionId,
          "interrupted",
        );
      }
      runtime.activeCompactionId = null;
      runtime.activeCompactionPresentation = null;
    }
    useChatStore.getState().interruptSessionCompaction(sessionId);
  };

  const promoteContextCompactionToDivider = (sessionId: string) => {
    const runtime = getRuntime(sessionId);
    if (!runtime.activeCompactionId || runtime.activeCompactionPresentation !== "process") return;
    const compactionId = runtime.activeCompactionId;
    const chatStore = useChatStore.getState();
    chatStore.removeLastAssistantProcessEntries([compactionId], sessionId);
    chatStore.appendContextCompactionDivider(compactionId, sessionId, "running");
    runtime.activeCompactionPresentation = "divider";
  };

  const isOpenProjectSession = (sessionId: string) =>
    useProjectStore.getState().projects.some((project) =>
      project.sessions.some((session) => session.id === sessionId && !session.closed)
    );

  const discardRuntime = (sessionId: string, event?: AgentEvent) => {
    const runtime = sessionRuntimeRef.current[sessionId];
    const eventRevision = normalizeAgentTurnRevision(event?.lifecycleRevision ?? event?.turnRevision);
    cancelAgentEndGrace(sessionId);
    if (runtime) {
      stopContextCompaction(sessionId);
      if (runtime.streamWatchdog) {
        clearTimeout(runtime.streamWatchdog);
        runtime.streamWatchdog = null;
      }
      resetSessionRuntimeAfterTurn(runtime);
      markSessionRuntimeTurnSettled(runtime, "aborted", {
        revision: eventRevision,
        userMessageId: runtime.activeTurnUserMessageId || getLatestUserMessageId(sessionId),
      });
      discardedSessionTurns.set(sessionId, {
        revisions: [...runtime.settledTurnRevisions],
        userMessageIds: [...runtime.settledTurnUserMessageIds],
      });
      delete sessionRuntimeRef.current[sessionId];
    } else {
      const userMessageId = getLatestUserMessageId(sessionId);
      const discardedTurn = discardedSessionTurns.get(sessionId) || { revisions: [], userMessageIds: [] };
      if (eventRevision && !discardedTurn.revisions.includes(eventRevision)) {
        discardedTurn.revisions.push(eventRevision);
      }
      if (userMessageId && !discardedTurn.userMessageIds.includes(userMessageId)) {
        discardedTurn.userMessageIds.push(userMessageId);
      }
      discardedSessionTurns.set(sessionId, discardedTurn);
    }
    useChatStore.getState().finishAllAssistantProcesses(Date.now(), "interrupted", sessionId);
    useChatStore.getState().interruptSessionCompaction(sessionId);
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
        kind: ASSISTANT_NARRATION_PROCESS_KIND,
        title: uiText.process.narration,
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
        type: entry.type,
        ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
        title: entry.title,
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
        ...(entry.prompt !== undefined ? { prompt: entry.prompt } : {}),
        ...(entry.files !== undefined ? { files: entry.files } : {}),
        ...(entry.toolKind !== undefined ? { toolKind: entry.toolKind } : {}),
        ...(entry.command !== undefined ? { command: entry.command } : {}),
        ...(entry.state !== undefined ? { state: entry.state } : {}),
        ...(entry.subagents !== undefined ? { subagents: entry.subagents } : {}),
        ...(entry.phase !== undefined ? { phase: entry.phase } : {}),
        ...(entry.action !== undefined ? { action: entry.action } : {}),
        ...(entry.tool !== undefined ? { tool: entry.tool } : {}),
        ...(entry.activityKind !== undefined ? { activityKind: entry.activityKind } : {}),
        ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
        ...(entry.completedAt !== undefined ? { completedAt: entry.completedAt } : {}),
        ...(entry.guidanceDocument !== undefined ? { guidanceDocument: entry.guidanceDocument } : {}),
        ...(entry.guidanceImages !== undefined ? { guidanceImages: entry.guidanceImages } : {}),
      }, sessionId);
      return;
    }
    useChatStore.getState().appendLastAssistantProcessEntry({
      id: entry.id || createProcessEntryId(),
      timestamp: entry.timestamp || Date.now(),
      type: entry.type,
      kind: entry.kind,
      title: entry.title,
      detail: entry.detail,
      prompt: entry.prompt,
      files: entry.files,
      toolKind: entry.toolKind,
      command: entry.command,
      state: entry.state,
      expanded: entry.expanded,
      subagents: entry.subagents,
      phase: entry.phase,
      action: entry.action,
      tool: entry.tool,
      activityKind: entry.activityKind,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      guidanceDocument: entry.guidanceDocument,
      guidanceImages: entry.guidanceImages,
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
    const entryId = runtime.streamIdleNoticeEntryId;
    if (entryId) {
      // 每个无输出区间保留自己的开始/结束时间，渲染层会把同一处理过程
      // 中的所有区间合并后显示总时长。
      useChatStore.getState().updateLastAssistantProcessEntry(entryId, {
        state: "completed",
        completedAt: Date.now(),
        expanded: false,
      }, sessionId);
    }
    runtime.streamIdleNoticeEntryId = null;
    runtime.streamIdleSince = null;
  };

  const appendOrRefreshIdleNotice = (sessionId: string) => {
    flushRuntimeRender(sessionId);
    const runtime = getRuntime(sessionId);
    if (!runtime.processActive) return;
    // 上下文压缩本身就是有明确状态的运行阶段，不应再显示“暂时没有新输出”。
    if (useChatStore.getState().compactingSessions[sessionId] === true) {
      completeIdleNotice(sessionId);
      return;
    }
    const agentName = getSessionAgentName(sessionId);
    runtime.streamIdleSince ??= Date.now();
    const idleSince = runtime.streamIdleSince;

    if (runtime.streamIdleNoticeEntryId) {
      useChatStore.getState().updateLastAssistantProcessEntry(runtime.streamIdleNoticeEntryId, {
        title: `${agentName} 仍在运行，暂时没有新输出`,
        detail: `${agentName} 任务还没有结束，正在等待后续事件或最终响应。`,
        toolKind: "stream_idle_notice",
        startedAt: idleSince,
        completedAt: undefined,
        state: "running",
        expanded: false,
      }, sessionId);
    } else {
      const entryId = createProcessEntryId();
      runtime.streamIdleNoticeEntryId = entryId;
      appendProcessEntry(sessionId, {
        id: entryId,
        type: "status",
        title: `${agentName} 仍在运行，暂时没有新输出`,
        detail: `${agentName} 任务还没有结束，正在等待后续事件或最终响应。`,
        toolKind: "stream_idle_notice",
        startedAt: idleSince,
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
    const agentName = getSessionAgentName(sessionId);

    if (runtime.streamIdleNoticeEntryId) {
      useChatStore.getState().updateLastAssistantProcessEntry(runtime.streamIdleNoticeEntryId, {
        title: `${agentName} 仍在执行上一条请求`,
        detail: `新的发送请求已忽略；当前 ${agentName} 任务还在运行，后续输出会继续追加到这里。`,
        toolKind: "already_running_notice",
        state: "running",
        expanded: false,
      }, sessionId);
    } else {
      const entryId = createProcessEntryId();
      runtime.streamIdleNoticeEntryId = entryId;
      appendProcessEntry(sessionId, {
        id: entryId,
        type: "status",
        title: `${agentName} 仍在执行上一条请求`,
        detail: `新的发送请求已忽略；当前 ${agentName} 任务还在运行，后续输出会继续追加到这里。`,
        toolKind: "already_running_notice",
        state: "running",
        expanded: false,
      });
    }

    if (sessionId === useProjectStore.getState().activeSessionId) setStreamingState(true);
    useProjectStore.getState().setAgentStatus(sessionId, "running");
    refreshStreamWatchdog(sessionId);
  };

  const finishManualAbort = (sessionId: string) => {
    const runtime = getRuntime(sessionId);
    if (!runtime.manualAbortRequested) return;
    finishAbortedTurn(sessionId);
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
    clearStreamWatchdog(sessionId);

    useChatStore.getState().appendLastAssistantProcessEntry({
      id: createProcessEntryId(),
      timestamp: Date.now(),
      type: "error",
      title: "检测到重复思考，已自动中断",
      detail: `最近思考内容连续重复 ${repeatCount} 次:\n${pattern}`,
      state: "interrupted",
      expanded: false,
    }, sessionId);
    finishAbortedTurn(sessionId);

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
        kind: ASSISTANT_NARRATION_PROCESS_KIND,
        title: uiText.process.narration,
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
      kind: ASSISTANT_NARRATION_PROCESS_KIND,
      title: uiText.process.narration,
      detail: runtime.processTextBuffer,
      state: "running",
    });
  };

  const finishAssistantProcessText = (sessionId: string) => {
    flushRuntimeRender(sessionId);
    const runtime = getRuntime(sessionId);
    if (runtime.processTextEntryId) {
      useChatStore.getState().updateLastAssistantProcessEntry(runtime.processTextEntryId, {
        kind: ASSISTANT_NARRATION_PROCESS_KIND,
        title: uiText.process.narration,
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
    if (content === runtime.streamBuffer) return;
    if (content.startsWith(runtime.streamBuffer)) {
      appendAssistantProcessText(sessionId, content.slice(runtime.streamBuffer.length));
      return;
    }

    // A stream snapshot is authoritative for the whole turn. Reconcile only
    // the currently open narration segment; treating an unmatched snapshot as
    // a delta duplicates Pi text after a tool boundary.
    const currentSegmentStart = Math.max(0, runtime.streamBuffer.length - runtime.processTextBuffer.length);
    const completedPrefix = runtime.streamBuffer.slice(0, currentSegmentStart);
    if (!content.startsWith(completedPrefix)) return;

    runtime.streamBuffer = content;
    runtime.processTextBuffer = content.slice(completedPrefix.length);
    if (runtime.processTextEntryId) {
      useChatStore.getState().updateLastAssistantProcessEntry(runtime.processTextEntryId, {
        kind: ASSISTANT_NARRATION_PROCESS_KIND,
        title: uiText.process.narration,
        detail: runtime.processTextBuffer,
        state: "running",
      }, sessionId);
    } else if (runtime.processTextBuffer) {
      const currentText = runtime.processTextBuffer;
      runtime.streamBuffer = completedPrefix;
      runtime.processTextBuffer = "";
      appendAssistantProcessText(sessionId, currentText);
    }
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
    const normalizedFinalContent = normalizeStreamText(finalContent);
    if (!normalizedFinalContent) return;

    // Claude 的 Task/subagent 生命周期可能把同一段最终正文切成多个相邻的
    // narration 节点。最终正文会被迁移到气泡中，因此末尾所有与最终正文
    // 相同的 narration 节点都必须移除，不能只移除最后一个，否则处理时间线
    // 还会残留一份正文，形成“最终正文输出两遍”。
    while (runtime.processTextHistory.length > 0) {
      const lastIndex = runtime.processTextHistory.length - 1;
      const lastText = runtime.processTextHistory[lastIndex];
      const lastEntryId = runtime.processTextEntryIds[lastIndex];
      if (!lastEntryId || normalizeStreamText(lastText) !== normalizedFinalContent) break;
      useChatStore.getState().removeLastAssistantProcessEntries([lastEntryId], sessionId);
      runtime.processTextEntryIds.splice(lastIndex, 1);
      runtime.processTextHistory.splice(lastIndex, 1);
    }
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
        // 不预设 expanded：默认展开状态跟随设置 expandThinkingWhileRunning，
        // 用户手动展开/折叠后再以条目自身状态为准（见 ProcessBlock）。
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
    const isConfirmation = normalizedMethod.toLowerCase() === "confirm";
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
      title: firstNonEmptyString(event.prompt, detail.title, event.title)?.replace(/^正在询问用户\s*[:：]\s*/, ""),
      description: firstNonEmptyString(
        event.description,
        event.message,
        event.question,
        detail.description,
        detail.message,
        detail.question,
      ),
      questions: isConfirmation
        ? undefined
        : fallbackQuestion.length > 0
          ? fallbackQuestion
          : [{ question: "请回答 Agent 的问题", options: [] }],
    };
  };

  const clearStreamWatchdog = (sessionId?: string) => {
    if (!sessionId) {
      return;
    }
    streamWatchdogVersions.set(sessionId, (streamWatchdogVersions.get(sessionId) || 0) + 1);
    const runtime = getRuntime(sessionId);
    if (runtime.streamWatchdog) {
      clearTimeout(runtime.streamWatchdog);
      runtime.streamWatchdog = null;
    }
  };

  const notifyAgentTaskCompleted = (sessionId: string, timedOut: boolean) => {
    if (typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus())) return;

    const projectState = useProjectStore.getState();
    const project = projectState.projects.find((candidate) =>
      candidate.sessions.some((session) => session.id === sessionId)
    );
    const session = project?.sessions.find((candidate) => candidate.id === sessionId);
    const agentName = getSessionAgentName(sessionId);
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

  type SettleAssistantTurnOptions = {
    finalState: "completed" | "interrupted";
    planSignal: InferredStepSignal;
    status: "normal" | "idle" | "error";
    content?: string;
    finalizeContent?: boolean;
    finishAllProcesses?: boolean;
    stopCompaction?: boolean;
    promoteCompaction?: boolean;
    errorEntry?: { title: string; detail?: string; onlyWhenEmpty?: boolean };
    notify?: "completed" | "stopped";
    terminalReason: "completed" | "aborted" | "disconnected" | "error";
  };

  const settleAssistantTurn = (
    currentSessionId: string,
    options: SettleAssistantTurnOptions,
  ) => {
    const runtime = getRuntime(currentSessionId);
    const modelRequestFailureDetail = getLatestModelRequestFailureDetail(currentSessionId);
    cancelAgentEndGrace(currentSessionId);
    if (options.stopCompaction) stopContextCompaction(currentSessionId);
    clearStreamWatchdog(currentSessionId);
    completeIdleNotice(currentSessionId);
    finishAssistantProcessText(currentSessionId);
    finishThinkingEntry(currentSessionId);
    updateInferredPlanSteps(currentSessionId, options.planSignal);

    const streamedContent = options.finalizeContent === false
      ? ""
      : stripProcessTextPrefixFromFinal(currentSessionId, options.content || runtime.streamBuffer);
    const finalContent = modelRequestFailureDetail !== null
      ? mergeModelRequestFailureIntoContent(streamedContent, modelRequestFailureDetail)
      : streamedContent;
    if (finalContent.trim()) {
      runtime.streamBuffer = finalContent;
      const finalizeVisibleResponse = () => {
        useChatStore.getState().updateLastAssistant(finalContent, currentSessionId);
        moveFinalAssistantProcessTextToBubble(currentSessionId, finalContent);
        useChatStore.getState().collapseLastAssistantProcess(currentSessionId);
      };
      if (preserveAssistantProcessCollapse) {
        preserveAssistantProcessCollapse(currentSessionId, finalizeVisibleResponse);
      } else {
        finalizeVisibleResponse();
      }
    }

    if (options.errorEntry && (!options.errorEntry.onlyWhenEmpty || !finalContent.trim())) {
      useChatStore.getState().appendLastAssistantProcessEntry({
        id: createProcessEntryId(),
        timestamp: Date.now(),
        type: "error",
        title: options.errorEntry.title,
        detail: options.errorEntry.detail,
        state: "error",
        expanded: false,
      }, currentSessionId);
    }

    if (currentSessionId === useProjectStore.getState().activeSessionId) setStreamingState(false);
    const chatStore = useChatStore.getState();
    if (options.finishAllProcesses) {
      chatStore.finishAllAssistantProcesses(Date.now(), options.finalState, currentSessionId);
    } else {
      chatStore.finishLastAssistantProcess(Date.now(), options.finalState, currentSessionId);
    }
    if (options.promoteCompaction) promoteContextCompactionToDivider(currentSessionId);
    resetSessionRuntimeAfterTurn(runtime);
    markSessionRuntimeTurnSettled(runtime, options.terminalReason, {
      userMessageId: runtime.activeTurnUserMessageId || getLatestUserMessageId(currentSessionId),
    });
    runtime.autoAbortReason = null;
    setPendingUIResponse((current) => current?.sessionId === currentSessionId ? null : current);

    const activeId = useProjectStore.getState().activeSessionId;
    const status = options.status === "normal"
      ? currentSessionId === activeId ? "idle" : "completed"
      : options.status;
    useProjectStore.getState().setAgentStatus(currentSessionId, status);
    if (options.notify) notifyAgentTaskCompleted(currentSessionId, options.notify === "stopped");
  };

  const settleRuntimeTurnOnly = (
    currentSessionId: string,
    terminalReason: "completed" | "aborted" | "disconnected" | "error",
  ) => {
    const runtime = getRuntime(currentSessionId);
    const userMessageId = runtime.activeTurnUserMessageId || getLatestUserMessageId(currentSessionId);
    cancelAgentEndGrace(currentSessionId);
    clearStreamWatchdog(currentSessionId);
    resetSessionRuntimeAfterTurn(runtime);
    markSessionRuntimeTurnSettled(runtime, terminalReason, { userMessageId });
    runtime.autoAbortReason = null;
    if (currentSessionId === useProjectStore.getState().activeSessionId) setStreamingState(false);
  };

  const completeAssistantStream = (
    currentSessionId: string,
    content?: string,
    timedOut = false
  ) => {
    settleAssistantTurn(currentSessionId, {
      finalState: timedOut ? "interrupted" : "completed",
      planSignal: timedOut ? "failed" : "verify",
      status: timedOut ? "error" : "normal",
      content,
      finishAllProcesses: true,
      stopCompaction: timedOut,
      promoteCompaction: !timedOut,
      errorEntry: timedOut ? {
        title: "未收到响应结束事件",
        detail: "Agent 连接已经结束，已停止等待后续事件。",
        onlyWhenEmpty: true,
      } : undefined,
      notify: timedOut ? "stopped" : "completed",
      terminalReason: timedOut ? "disconnected" : "completed",
    });
  };

  const finishAbortedTurn = (currentSessionId: string) => {
    cancelPendingGuidance(currentSessionId);
    settleAssistantTurn(currentSessionId, {
      finalState: "interrupted",
      planSignal: "cancelled",
      status: "idle",
      finalizeContent: false,
      finishAllProcesses: true,
      stopCompaction: true,
      terminalReason: "aborted",
    });
  };

  const finishDisconnectedTurn = (currentSessionId: string) => {
    completeAssistantStream(currentSessionId, undefined, true);
  };

  const finishIdleBackendTurn = (currentSessionId: string) => {
    // Some adapters report idle while a host-rendered question is still
    // awaiting its UI response. Never consume that question merely because
    // the backend's generic idle implementation is coarse; the watchdog will
    // reconcile the turn again after the pending interaction is answered.
    if (getPendingUIResponse(currentSessionId)) {
      refreshStreamWatchdog(currentSessionId);
      return;
    }
    const runtime = getRuntime(currentSessionId);
    if (runtime.activeCompactionId) {
      // backend_idle is authoritative completion evidence when an adapter
      // loses the explicit compaction-completed event. Finalize the visible
      // compaction before settling the turn so it does not look interrupted.
      appendContextCompactionDivider(
        currentSessionId,
        runtime.activeCompactionId,
        "completed",
      );
    }
    if (!hasVisibleSessionTurnState(currentSessionId)) {
      settleRuntimeTurnOnly(currentSessionId, "completed");
      return;
    }
    settleAssistantTurn(currentSessionId, {
      finalState: "completed",
      planSignal: "verify",
      status: "normal",
      finishAllProcesses: true,
      stopCompaction: true,
      notify: "completed",
      terminalReason: "completed",
    });
  };

  const hasVisibleSessionTurnState = (sessionId: string) => {
    const runtime = getRuntime(sessionId);
    return runtime.processActive ||
      hasOpenAssistantProcess(sessionId) ||
      useChatStore.getState().compactingSessions[sessionId] === true ||
      useProjectStore.getState().agentStatuses[sessionId] === "running";
  };

  const isSessionTurnStillOpen = (sessionId: string) => {
    const runtime = getRuntime(sessionId);
    return runtime.turnEventState === "active" || hasVisibleSessionTurnState(sessionId);
  };

  const retryOrFinishUnavailableAgentEndState = (sessionId: string) => {
    if (!agentEndAwaitingReconciliation.has(sessionId)) return false;
    const failureCount = (agentEndStateQueryFailures.get(sessionId) || 0) + 1;
    agentEndStateQueryFailures.set(sessionId, failureCount);
    if (failureCount >= AGENT_END_QUERY_FAILURE_LIMIT) {
      finishDisconnectedTurn(sessionId);
      return true;
    }
    armAgentEndGrace(sessionId, AGENT_END_QUERY_RETRY_MS * failureCount);
    return true;
  };

  const refreshStreamWatchdog = (currentSessionId: string) => {
    const runtime = getRuntime(currentSessionId);
    clearStreamWatchdog(currentSessionId);
    if (!isSessionTurnStillOpen(currentSessionId) || runtime.manualAbortRequested) return;
    runtime.streamIdleSince ??= Date.now();
    const version = streamWatchdogVersions.get(currentSessionId) || 0;
    runtime.streamWatchdog = setTimeout(() => {
      runtime.streamWatchdog = null;
      void window.electronAPI.agentGetSessionState(currentSessionId)
        .catch(() => null)
        .then((state) => {
          if (streamWatchdogVersions.get(currentSessionId) !== version) return;
          if (!isSessionTurnStillOpen(currentSessionId) || runtime.manualAbortRequested) return;
          const awaitingUI = !!getPendingUIResponse(currentSessionId);
          const stateIsFresh = state?.stale !== true;
          if (stateIsFresh && state?.idle === true && !awaitingUI) {
            if (!hasVisibleSessionTurnState(currentSessionId)) {
              settleRuntimeTurnOnly(
                currentSessionId,
                state.success === true ? "completed" : "disconnected",
              );
            } else if (state.success === true) finishIdleBackendTurn(currentSessionId);
            else finishDisconnectedTurn(currentSessionId);
            return;
          }
          if (
            !awaitingUI &&
            (!stateIsFresh || state?.idle !== false) &&
            retryOrFinishUnavailableAgentEndState(currentSessionId)
          ) {
            return;
          }
          if (stateIsFresh && state?.idle === false) clearAgentEndObservation(currentSessionId);
          if (!awaitingUI) {
            if (!hasVisibleSessionTurnState(currentSessionId)) ensureAssistantContinuation(currentSessionId);
            appendOrRefreshIdleNotice(currentSessionId);
          }
          refreshStreamWatchdog(currentSessionId);
        });
    }, STREAM_WATCHDOG_MS);
  };

  function armAgentEndGrace(currentSessionId: string, delayMs = AGENT_END_GRACE_MS) {
    clearAgentEndGraceTimer(currentSessionId);
    if (!isSessionTurnStillOpen(currentSessionId)) return;
    const version = agentEndGraceVersions.get(currentSessionId) || 0;
    const timer = setTimeout(() => {
      agentEndGraceTimers.delete(currentSessionId);
      if (getRuntime(currentSessionId).manualAbortRequested) {
        finishAbortedTurn(currentSessionId);
        return;
      }
      void window.electronAPI.agentGetSessionState(currentSessionId)
        .catch(() => null)
        .then((state) => {
          if (agentEndGraceVersions.get(currentSessionId) !== version) return;
          if (!isSessionTurnStillOpen(currentSessionId)) return;
          if (getPendingUIResponse(currentSessionId)) {
            refreshStreamWatchdog(currentSessionId);
            return;
          }
          const stateIsFresh = state?.stale !== true;
          if (stateIsFresh && state?.idle === true) {
            if (!hasVisibleSessionTurnState(currentSessionId)) {
              settleRuntimeTurnOnly(
                currentSessionId,
                state.success === true ? "completed" : "disconnected",
              );
            } else if (state.success === true) finishIdleBackendTurn(currentSessionId);
            else finishDisconnectedTurn(currentSessionId);
            return;
          }
          if ((!stateIsFresh || state?.idle !== false) && retryOrFinishUnavailableAgentEndState(currentSessionId)) {
            return;
          }
          clearAgentEndObservation(currentSessionId);
          if (!hasVisibleSessionTurnState(currentSessionId)) ensureAssistantContinuation(currentSessionId);
          appendOrRefreshIdleNotice(currentSessionId);
          refreshStreamWatchdog(currentSessionId);
        });
    }, delayMs);
    agentEndGraceTimers.set(currentSessionId, timer);
  }

  const scheduleAgentEndGrace = (currentSessionId: string) => {
    const alreadyAwaitingReconciliation = agentEndAwaitingReconciliation.has(currentSessionId);
    clearAgentEndGraceTimer(currentSessionId);
    if (!isSessionTurnStillOpen(currentSessionId)) {
      clearAgentEndObservation(currentSessionId);
      return;
    }
    agentEndAwaitingReconciliation.add(currentSessionId);
    if (!alreadyAwaitingReconciliation) agentEndStateQueryFailures.set(currentSessionId, 0);
    armAgentEndGrace(currentSessionId);
  };

  const ensureAssistantContinuation = (currentSessionId: string) => {
    const runtime = getRuntime(currentSessionId);
    if (runtime.manualAbortRequested) return runtime;
    if (!activateSessionRuntimeTurn(runtime)) return runtime;
    if (runtime.processActive) return runtime;

    runtime.processActive = true;
    runtime.streamStarted = true;
    runtime.autoAbortReason = null;
    completeIdleNotice(currentSessionId);
    useChatStore.getState().startAssistantProcess(Date.now(), currentSessionId);
    if (currentSessionId === useProjectStore.getState().activeSessionId) setStreamingState(true);
    useProjectStore.getState().setAgentStatus(currentSessionId, "running");
    // Some plugins legitimately begin with a tool/thinking/process event and
    // omit message_start/stream_start. The dispatcher cannot schedule a
    // watchdog until this call opens the process, so arm it here as part of
    // the inactive -> active transition.
    refreshStreamWatchdog(currentSessionId);
    return runtime;
  };

  const appendContextCompactionDivider = (
    currentSessionId: string,
    eventId?: string,
    phase: "started" | "completed" | "interrupted" = "completed",
  ) => {
    const runtime = getRuntime(currentSessionId);
    const normalizedEventId = phase === "started"
      ? eventId || runtime.activeCompactionId || createProcessEntryId()
      : runtime.activeCompactionId || eventId || createProcessEntryId();
    const compactionState = phase === "started"
      ? "running"
      : phase === "interrupted"
        ? "interrupted"
        : "completed";

    if (phase === "started") {
      if (runtime.activeCompactionId && runtime.activeCompactionId !== normalizedEventId) {
        stopContextCompaction(currentSessionId);
      }
      const presentation = getContextCompactionPresentation(
        phase,
        runtime.processActive,
        runtime.activeCompactionPresentation,
      );
      runtime.activeCompactionId = normalizedEventId;
      runtime.activeCompactionPresentation = presentation;
      useChatStore.getState().setSessionCompacting(currentSessionId, true);
      completeIdleNotice(currentSessionId);
      finishAssistantProcessText(currentSessionId);
      finishThinkingEntry(currentSessionId);
      if (presentation === "process") {
        appendProcessEntry(currentSessionId, {
          id: normalizedEventId,
          type: "status",
          title: "上下文压缩中",
          state: "running",
          expanded: false,
        });
      } else {
        useChatStore.getState().appendContextCompactionDivider(
          normalizedEventId,
          currentSessionId,
          compactionState,
        );
      }
      if (currentSessionId === useProjectStore.getState().activeSessionId) setStreamingState(true);
      useProjectStore.getState().setAgentStatus(currentSessionId, "running");
      refreshStreamWatchdog(currentSessionId);
      return;
    }

    if (runtime.activeCompactionPresentation === "process") {
      useChatStore.getState().updateLastAssistantProcessEntry(normalizedEventId, {
        title: phase === "interrupted" ? "上下文压缩已中断" : "上下文已自动压缩",
        state: phase === "interrupted" ? "interrupted" : "completed",
        expanded: false,
      }, currentSessionId);
    } else {
      useChatStore.getState().appendContextCompactionDivider(
        normalizedEventId,
        currentSessionId,
        compactionState,
      );
    }
    rememberSettledCompactionEvent(runtime, normalizedEventId);
    useChatStore.getState().setSessionCompacting(currentSessionId, false);
    runtime.activeCompactionId = null;
    runtime.activeCompactionPresentation = null;
    if (!runtime.processActive && !hasOpenAssistantProcess(currentSessionId)) {
      clearStreamWatchdog(currentSessionId);
      if (currentSessionId === useProjectStore.getState().activeSessionId) setStreamingState(false);
      useProjectStore.getState().setAgentStatus(currentSessionId, "idle");
    }
  };

  const clearAllStreamWatchdogs = () => {
    Object.entries(sessionRuntimeRef.current).forEach(([sessionId, runtime]) => {
      streamWatchdogVersions.set(sessionId, (streamWatchdogVersions.get(sessionId) || 0) + 1);
      if (runtime.streamWatchdog) {
        clearTimeout(runtime.streamWatchdog);
        runtime.streamWatchdog = null;
      }
    });
    for (const sessionId of [...agentEndGraceTimers.keys()]) cancelAgentEndGrace(sessionId);
  };

  return {
    getPendingUIResponse,
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
    settleRuntimeTurnOnly,
    finishAbortedTurn,
    finishDisconnectedTurn,
    finishIdleBackendTurn,
    refreshStreamWatchdog,
    ensureAssistantContinuation,
    getActiveAgentId,
    isOpenProjectSession,
    discardRuntime,
    finishManualAbort,
    cancelAgentEndGrace,
    scheduleAgentEndGrace,
    appendContextCompactionDivider,
    clearAllStreamWatchdogs,
  };
}
