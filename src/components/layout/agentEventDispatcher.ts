import { getAgentName } from "@/lib/agents";
import { useProjectStore } from "@/stores/project-store";
import {
  useChatStore,
  type AgentCommentary,
  type AgentProcessFile,
  type ChatMessage,
} from "@/stores/chat-store";
import type { AgentEvent } from "@/types";
import { isAgentTurnContinuationEvidence } from "@shared/agent-event-lifecycle";
import {
  activateSessionRuntimeTurn,
  compareAgentTurnRevisions,
  createProcessEntryId,
  getToolProcessFiles,
  isPlanLikeProcessEvent,
  normalizePlanStepsFromEvent,
  normalizeAgentTurnRevision,
  normalizeProcessEntryState,
  normalizeProcessEntryType,
  normalizeToolKind,
  stringifyProcessValue,
  truncateProcessDetail,
  type SessionRuntime,
} from "./agentEventUtils";
import {
  clearResolvedPendingQuestion,
  getQuestionEventId,
  handleDefaultQuestionEvent,
  handleDirectQuestionEvent,
  isPendingQuestionEvent,
  normalizeQuestionEventState,
  resolveTerminalQuestionEvent,
} from "./agentQuestionHandlers";
import {
  handleAgentDisconnectedEvent,
  handleCommentaryDeltaEvent,
  handleCommentaryEndEvent,
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
import type { AgentEventRuntimeController } from "./agentEventTypes";
import { getSubagentProcessEntry } from "./subagentEvents";

const TURN_START_EVENT_TYPES = new Set(["turn_lifecycle", "message_start", "stream_start", "agent_start"]);
const TURN_TERMINAL_EVENT_TYPES = new Set([
  "stream_end",
  "agent_end",
  "agent_disconnected",
  "aborted",
  "turn_failed",
  "backend_idle",
]);
const TURN_ACTIVITY_EVENT_TYPES = new Set([
  "stream_delta",
  "stream_snapshot",
  "commentary_delta",
  "commentary_end",
  "thinking_delta",
  "thinking_end",
  "subagent_event",
  "user_ask_question",
  "ask_user_question",
  "ask_user",
  "tool_start",
  "tool_end",
  "diff_update",
  "plan_update",
  "process_event",
]);

const getLatestUserMessageId = (sessionId: string) => {
  const chatState = useChatStore.getState();
  const messages = chatState.sessionMessages[sessionId] || (
    chatState.activeSessionId === sessionId ? chatState.messages : []
  );
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index].id;
  }
  return null;
};

const getEventTurnRevision = (event: AgentEvent) => normalizeAgentTurnRevision(
  event.lifecycleRevision ?? event.turnRevision,
);

const isQuestionLikeEvent = (event: AgentEvent) =>
  normalizeToolKind(event.mode || event.entryType || event.kind || event.toolKind) === "question";

const isTurnScopedEvent = (event: AgentEvent) =>
  TURN_START_EVENT_TYPES.has(event.type) ||
  TURN_TERMINAL_EVENT_TYPES.has(event.type) ||
  TURN_ACTIVITY_EVENT_TYPES.has(event.type) ||
  isQuestionLikeEvent(event);

export function shouldAcceptTurnScopedAgentEvent(
  event: AgentEvent,
  sessionId: string,
  runtime: SessionRuntime,
) {
  const revision = getEventTurnRevision(event);
  if (TURN_START_EVENT_TYPES.has(event.type)) {
    return activateSessionRuntimeTurn(runtime, {
      revision,
      userMessageId: typeof event.clientUserMessageId === "string"
        ? event.clientUserMessageId
        : getLatestUserMessageId(sessionId),
    });
  }

  const isTerminal = TURN_TERMINAL_EVENT_TYPES.has(event.type);
  const isActivity = TURN_ACTIVITY_EVENT_TYPES.has(event.type) || isQuestionLikeEvent(event);
  if (!isTerminal && !isActivity) return true;

  // Once a turn has reached a terminal state, unscoped events are ambiguous
  // and must not reopen it. A host-stamped new revision is authoritative and
  // still lets adapters that omit stream_start recover on their next turn.
  if (runtime.turnEventState === "settled" && !revision) return false;
  return activateSessionRuntimeTurn(runtime, {
    revision,
    userMessageId: typeof event.clientUserMessageId === "string" ? event.clientUserMessageId : null,
  });
}

export function shouldAcceptContextCompactionEvent(event: AgentEvent, runtime: SessionRuntime) {
  const eventId = typeof event.id === "string" && event.id.trim() ? event.id.trim() : null;
  const phase = event.phase === "started" || event.phase === "interrupted"
    ? event.phase
    : "completed";
  if (phase === "started") {
    if (eventId && (runtime.settledCompactionEventIds || []).includes(eventId)) return false;
    return runtime.turnEventState !== "settled" || runtime.turnTerminalReason === "completed";
  }
  if (runtime.activeCompactionId) return true;
  if (eventId && (runtime.settledCompactionEventIds || []).includes(eventId)) return false;
  return runtime.turnEventState !== "settled" || runtime.turnTerminalReason === "completed";
}

const parseHistoryCommentary = (value: unknown, fallbackTimestamp: number): AgentCommentary[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const commentary = item as Record<string, unknown>;
    const content = typeof commentary.content === "string"
      ? commentary.content
      : typeof commentary.message === "string"
        ? commentary.message
        : "";
    if (!content.trim()) return [];
    const timestamp = typeof commentary.timestamp === "number" && Number.isFinite(commentary.timestamp)
      ? commentary.timestamp
      : fallbackTimestamp;
    const id = typeof commentary.id === "string" && commentary.id.trim()
      ? commentary.id
      : typeof commentary.itemId === "string" && commentary.itemId.trim()
        ? commentary.itemId
        : `history-commentary-${fallbackTimestamp}-${index}`;
    return [{ id, content, timestamp, isStreaming: false }];
  });
};

export const parseHistorySnapshotMessages = (value: unknown): ChatMessage[] => {
  if (!Array.isArray(value)) return [];
  const messages: ChatMessage[] = [];
  let pendingCommentary: AgentCommentary[] = [];
  const flushPendingCommentary = () => {
    if (pendingCommentary.length === 0) return;
    messages.push({
      id: `history-commentary-message-${pendingCommentary[0].id}`,
      role: "assistant",
      content: "",
      timestamp: pendingCommentary[0].timestamp,
      commentary: pendingCommentary,
    });
    pendingCommentary = [];
  };

  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const message = item as Record<string, unknown>;
    const role = message.role;
    const timestamp = message.timestamp;
    if (
      typeof message.id !== "string" ||
      (role !== "user" && role !== "assistant" && role !== "system") ||
      typeof message.content !== "string" ||
      typeof timestamp !== "number" ||
      !Number.isFinite(timestamp)
    ) {
      continue;
    }

    if (message.phase === "commentary") {
      if (message.content.trim()) {
        pendingCommentary.push({
          id: typeof message.itemId === "string" && message.itemId.trim() ? message.itemId : message.id,
          content: message.content,
          timestamp,
          isStreaming: false,
        });
      }
      continue;
    }

    if (role !== "assistant") flushPendingCommentary();
    const directCommentary = role === "assistant"
      ? parseHistoryCommentary(message.commentary, timestamp)
      : [];
    const commentary = role === "assistant"
      ? [...pendingCommentary, ...directCommentary]
      : [];
    if (role === "assistant") pendingCommentary = [];
    messages.push({
      id: message.id,
      role,
      content: message.content,
      timestamp,
      nativeTurnId: typeof message.nativeTurnId === "string" ? message.nativeTurnId : undefined,
      commentary: commentary.length > 0 ? commentary : undefined,
    });
  }
  flushPendingCommentary();
  return messages;
};

export const mergeHistoryCommentary = (
  existingMessages: ChatMessage[],
  recoveredMessages: ChatMessage[],
): ChatMessage[] => {
  const recoveredByTurn = new Map(
    recoveredMessages
      .filter((message) => message.role === "assistant" && message.nativeTurnId && message.commentary?.length)
      .map((message) => [message.nativeTurnId!, message.commentary!] as const),
  );
  if (recoveredByTurn.size === 0) return existingMessages;

  let changed = false;
  const merged = existingMessages.map((message) => {
    if (message.role !== "assistant" || !message.nativeTurnId) return message;
    const recovered = recoveredByTurn.get(message.nativeTurnId);
    if (!recovered?.length) return message;

    const commentary = [...(message.commentary || [])];
    const seenIds = new Set(commentary.map((item) => item.id));
    const remainingContentMatches = new Map<string, number>();
    for (const item of commentary) {
      const key = item.content.trim();
      remainingContentMatches.set(key, (remainingContentMatches.get(key) || 0) + 1);
    }
    let messageChanged = false;
    for (const item of recovered) {
      const contentKey = item.content.trim();
      const matchingContentCount = remainingContentMatches.get(contentKey) || 0;
      if (seenIds.has(item.id) || matchingContentCount > 0) {
        if (matchingContentCount > 0) {
          remainingContentMatches.set(contentKey, matchingContentCount - 1);
        }
        continue;
      }
      commentary.push({ ...item, isStreaming: false });
      seenIds.add(item.id);
      messageChanged = true;
    }
    if (!messageChanged) return message;
    changed = true;
    commentary.sort((left, right) => left.timestamp - right.timestamp);
    return { ...message, commentary };
  });

  const existingAssistantTurns = new Set(
    existingMessages
      .filter((message) => message.role === "assistant" && message.nativeTurnId)
      .map((message) => message.nativeTurnId!),
  );
  for (const recovered of recoveredMessages) {
    if (
      recovered.role !== "assistant" ||
      recovered.content.trim() ||
      !recovered.nativeTurnId ||
      !recovered.commentary?.length ||
      existingAssistantTurns.has(recovered.nativeTurnId)
    ) {
      continue;
    }
    let insertAfter = -1;
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      if (merged[index].nativeTurnId === recovered.nativeTurnId) {
        insertAfter = index;
        break;
      }
    }
    if (insertAfter < 0) continue;
    merged.splice(insertAfter + 1, 0, recovered);
    existingAssistantTurns.add(recovered.nativeTurnId);
    changed = true;
  }

  return changed ? merged : existingMessages;
};

export function dispatchAgentEvent(event: AgentEvent, controller: AgentEventRuntimeController) {
  const handlerContext = controller;
  const {
    appendContextCompactionDivider,
    appendOrRefreshAlreadyRunningNotice,
    appendProcessEntry,
    cancelAgentEndGrace,
    completeIdleNotice,
    discardRuntime,
    ensureAssistantContinuation,
    finishAbortedTurn,
    finishAssistantProcessText,
    finishManualAbort,
    finishThinkingEntry,
    getPendingUIFromEvent,
    getRuntime,
    isOpenProjectSession,
    recordProcessFiles,
    refreshStreamWatchdog,
    scheduleAgentEndGrace,
    setPendingUIResponse,
    updateInferredPlanSteps,
    updateProcessPlanSteps,
  } = controller;
  // Always read from store to avoid stale closure (useEffect deps=[])
  const currentSessionId = typeof event.sessionId === "string"
    ? event.sessionId
    : useProjectStore.getState().activeSessionId;
  if (!currentSessionId) return;
  if (!isOpenProjectSession(currentSessionId)) {
    discardRuntime(currentSessionId, event);
    return;
  }
  const runtime = getRuntime(currentSessionId);
  const eventRevision = getEventTurnRevision(event);
  const eventUserMessageId = typeof event.clientUserMessageId === "string" && event.clientUserMessageId.trim()
    ? event.clientUserMessageId.trim()
    : null;
  if (
    event.type !== "context_compaction" &&
    isTurnScopedEvent(event) &&
    runtime.turnEventState === "active" &&
    eventRevision &&
    runtime.activeTurnRevision &&
    eventRevision !== runtime.activeTurnRevision &&
    compareAgentTurnRevisions(eventRevision, runtime.activeTurnRevision) !== -1 &&
    eventUserMessageId &&
    eventUserMessageId === getLatestUserMessageId(currentSessionId) &&
    runtime.activeTurnUserMessageId &&
    eventUserMessageId !== runtime.activeTurnUserMessageId
  ) {
    // A new host-stamped send is authoritative. If store reconciliation has
    // already closed a stale renderer turn (for example a send initiated by
    // the mobile client), close its in-memory runtime before accepting the new
    // revision instead of treating the new start as an "already running" retry.
    finishAbortedTurn(currentSessionId);
  }
  if (event.type === "context_compaction") {
    if (!shouldAcceptContextCompactionEvent(event, runtime)) return;
  } else if (!shouldAcceptTurnScopedAgentEvent(event, currentSessionId, runtime)) {
    return;
  }
  if (
    runtime.manualAbortRequested &&
    event.type !== "aborted" &&
    event.type !== "agent_disconnected" &&
    event.type !== "agent_end"
  ) {
    return;
  }
  const turnContinuationEvidence = isAgentTurnContinuationEvidence(event);
  const authoritativeTerminal = TURN_TERMINAL_EVENT_TYPES.has(event.type)
    && event.type !== "agent_end";
  const compactionStarted = event.type === "context_compaction" && event.phase === "started";
  if (turnContinuationEvidence || authoritativeTerminal || compactionStarted) {
    // Only real turn activity can invalidate an agent_end reconciliation.
    // Model/config/metadata notifications may arrive concurrently but do not
    // mean the Agent resumed; cancelling here would postpone settlement until
    // the 45-second watchdog.
    cancelAgentEndGrace(currentSessionId);
  }
  if (
    turnContinuationEvidence &&
    event.type !== "message_start" &&
    event.type !== "stream_start" &&
    event.type !== "stream_snapshot" &&
    event.type !== "stream_end"
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
    case "commentary_delta":
      handleCommentaryDeltaEvent(event, currentSessionId, handlerContext);
      break;
    case "commentary_end":
      handleCommentaryEndEvent(event, currentSessionId, handlerContext);
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
    case "subagent_event":
      ensureAssistantContinuation(currentSessionId);
      finishAssistantProcessText(currentSessionId);
      finishThinkingEntry(currentSessionId);
      updateInferredPlanSteps(currentSessionId, "operate");
      appendProcessEntry(currentSessionId, getSubagentProcessEntry(event));
      break;
    case "user_ask_question":
    case "ask_user_question":
    case "ask_user":
      handleDirectQuestionEvent(event, currentSessionId, handlerContext);
      break;
    case "stream_end":
      handleStreamEndEvent(event, currentSessionId, runtime, handlerContext);
      break;
    case "agent_end":
      // Some backends emit agent_end between automatic retries. Reconcile the
      // backend's generic idle state after a short grace period so a real final
      // end cannot leave the renderer process open when stream_end is missing.
      scheduleAgentEndGrace(currentSessionId);
      break;
    case "agent_disconnected":
      if (runtime.manualAbortRequested) {
        finishManualAbort(currentSessionId);
        break;
      }
      handleAgentDisconnectedEvent(currentSessionId, runtime, handlerContext);
      break;
    case "aborted":
      finishAbortedTurn(currentSessionId);
      break;
    case "turn_failed":
      finishAbortedTurn(currentSessionId);
      break;
    case "backend_idle":
      controller.finishIdleBackendTurn(currentSessionId);
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
      appendContextCompactionDivider(
        currentSessionId,
        typeof event.id === "string" ? event.id : undefined,
        event.phase === "started" || event.phase === "interrupted" ? event.phase : "completed",
      );
      break;
    case "turn_metadata":
      {
        const nativeTurnId = typeof event.nativeTurnId === "string"
          ? event.nativeTurnId
          : typeof event.turnId === "string"
            ? event.turnId
            : "";
        const clientUserMessageId = typeof event.clientUserMessageId === "string" ? event.clientUserMessageId : "";
        if (nativeTurnId && clientUserMessageId) {
          useChatStore.getState().setNativeTurnIdForTurn(clientUserMessageId, nativeTurnId, currentSessionId);
        }
      }
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
      const rawProcessToolKind = typeof event.toolKind === "string" ? event.toolKind.trim() : "";
      const isGuidanceEvent = rawProcessToolKind === "guidance_message" || rawProcessToolKind === "guidance";
      const eventDetail = event.detail
        ? (isGuidanceEvent ? stringifyProcessValue(event.detail) : truncateProcessDetail(stringifyProcessValue(event.detail)))
        : undefined;
      const eventState = eventType === "question"
        ? normalizeQuestionEventState(event)
        : normalizeProcessEntryState(event.state);
      const eventCommand = typeof event.command === "string" ? event.command : undefined;
      const processToolKind = isGuidanceEvent
        ? rawProcessToolKind
        : eventType === "tool"
        ? (normalizeToolKind(event.toolKind) === "unknown" && eventCommand
            ? "run_command"
            : normalizeToolKind(event.toolKind))
        : undefined;
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
        event.reason === "already-running" &&
        (runtime.processActive || useProjectStore.getState().agentStatuses[currentSessionId] === "running")
      ) {
        if (!runtime.processActive) ensureAssistantContinuation(currentSessionId);
        appendOrRefreshAlreadyRunningNotice(currentSessionId);
        break;
      }
      if (eventType === "subagent") {
        ensureAssistantContinuation(currentSessionId);
        finishAssistantProcessText(currentSessionId);
        finishThinkingEntry(currentSessionId);
        updateInferredPlanSteps(currentSessionId, "operate");
        appendProcessEntry(currentSessionId, getSubagentProcessEntry(event));
        break;
      }
      ensureAssistantContinuation(currentSessionId);
      finishAssistantProcessText(currentSessionId);
      finishThinkingEntry(currentSessionId);
      if (eventType !== "question" && (eventType === "error" || eventState === "error")) {
        // A process/tool error is an entry-level failure, not an authoritative
        // turn terminal. Several agents can recover from a failed tool and
        // continue with more thinking, tools, or a final answer. The plugin
        // host will emit backend_idle when the backend really becomes idle;
        // explicit stream/abort/disconnect events remain terminal as well.
        appendProcessEntry(currentSessionId, {
          id: typeof event.id === "string" ? event.id : undefined,
          type: "error",
          title: eventTitle,
          detail: eventDetail,
          state: "error",
          expanded: false,
        });
        break;
      }
      let questionEntryId: string | undefined;
      const questionIsPending = eventType === "question" && isPendingQuestionEvent(event);
      if (questionIsPending) {
        const eventQuestionId = getQuestionEventId(event);
        const pending = handlerContext.getPendingUIResponse(currentSessionId);
        const pendingMatches = !!pending && (
          !eventQuestionId || pending.requestId === eventQuestionId || pending.entryId === eventQuestionId
        );
        questionEntryId = (pendingMatches ? pending.entryId : undefined)
          || eventQuestionId
          || createProcessEntryId();
        setPendingUIResponse(getPendingUIFromEvent(event, currentSessionId, questionEntryId));
      } else if (eventType === "question") {
        const resolution = resolveTerminalQuestionEvent(event, currentSessionId, handlerContext);
        questionEntryId = resolution.entryId;
        if (resolution.pendingToClear) {
          clearResolvedPendingQuestion(currentSessionId, resolution.pendingToClear, handlerContext);
        }
      }
      const processEntryId = questionEntryId || getQuestionEventId(event);
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
        id: processEntryId,
        type: eventType,
        kind: isGuidanceEvent ? "user_guidance" : undefined,
        title: processedTitle,
        detail: eventType === "question" ? undefined : eventDetail,
        files: processFiles,
        toolKind: processToolKind,
        command: eventCommand,
        state: eventType === "question" ? eventState || "running" : eventState,
        expanded: false,
      });
      break;
    case "agent_ready":
      const agentName = getAgentName(String(event.agentId || controller.getActiveAgentId()));
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
    case "history_snapshot":
      {
        const chatState = useChatStore.getState();
        const storedMessages = chatState.sessionMessages[currentSessionId] || [];
        const visibleMessages = chatState.activeSessionId === currentSessionId ? chatState.messages : [];
        const recoveredMessages = parseHistorySnapshotMessages(event.messages);
        if (recoveredMessages.length === 0) break;
        const existingMessages = visibleMessages.length > 0 ? visibleMessages : storedMessages;
        if (existingMessages.length === 0) {
          chatState.loadSessionMessages(currentSessionId, recoveredMessages);
          break;
        }
        const mergedMessages = mergeHistoryCommentary(existingMessages, recoveredMessages);
        if (mergedMessages !== existingMessages) {
          chatState.loadSessionMessages(currentSessionId, mergedMessages);
        }
      }
      break;
    default:
      if (handleDefaultQuestionEvent(event, currentSessionId, handlerContext)) break;
      break;
  }
}
