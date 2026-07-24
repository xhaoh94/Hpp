import { getAgentName } from "@/lib/agents";
import { useProjectStore } from "@/stores/project-store";
import {
  useChatStore,
  type AgentCommentary,
  type AgentProcessFile,
  type ChatMessage,
} from "@/stores/chat-store";
import type { AgentEvent } from "@/types";
import {
  createProcessEntryId,
  getToolProcessFiles,
  isPlanLikeProcessEvent,
  normalizePlanStepsFromEvent,
  normalizeProcessEntryState,
  normalizeProcessEntryType,
  normalizeToolKind,
  stringifyProcessValue,
  truncateProcessDetail,
} from "./agentEventUtils";
import {
  handleDefaultQuestionEvent,
  handleDirectQuestionEvent,
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
    completeIdleNotice,
    discardRuntime,
    ensureAssistantContinuation,
    failAssistantStream,
    finishAssistantProcessText,
    finishManualAbort,
    finishThinkingEntry,
    getPendingUIFromEvent,
    getRuntime,
    isOpenProjectSession,
    recordProcessFiles,
    refreshStreamWatchdog,
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
    discardRuntime(currentSessionId);
    return;
  }
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
    event.type !== "context_compaction" &&
    event.type !== "turn_metadata" &&
    event.type !== "history_snapshot"
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
      const eventDetail = event.detail ? truncateProcessDetail(stringifyProcessValue(event.detail)) : undefined;
      const eventState = normalizeProcessEntryState(event.state);
      const eventCommand = typeof event.command === "string" ? event.command : undefined;
      const processToolKind = eventType === "tool"
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
      const processEntryId = questionEntryId || (typeof event.id === "string" ? event.id : undefined);
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
      handleDefaultQuestionEvent(event, currentSessionId, handlerContext);
      break;
  }
}
