import { useChatStore, type AgentProcessEntry } from "@/stores/chat-store";
import type { AgentEvent } from "@/types";
import {
  createProcessEntryId,
  getQuestionTitle,
  normalizeProcessEntryState,
  normalizeToolKind,
} from "./agentEventUtils";
import type { AgentEventHandlerContext } from "./agentEventTypes";

const getQuestionEventIds = (event: AgentEvent) => (
  [event.id, event.requestId, event.toolCallId]
    .filter((value): value is string => typeof value === "string" && !!value.trim())
);

export const getQuestionEventId = (event: AgentEvent) => getQuestionEventIds(event)[0];

const normalizeQuestionLifecycleToken = (value: unknown) => (
  typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : ""
);

/**
 * Question adapters do not all use the same lifecycle field. Keep the
 * renderer-side pending state driven by one normalization path so a terminal
 * event cannot be mistaken for a second question merely because it reports
 * `status`, `phase`, or only `isError` instead of `state`.
 */
export function normalizeQuestionEventState(event: AgentEvent): AgentProcessEntry["state"] | undefined {
  if (event.isError === true) return "error";

  for (const value of [event.state, event.status, event.phase]) {
    const token = normalizeQuestionLifecycleToken(value);
    if (!token) continue;

    const normalizedState = normalizeProcessEntryState(token);
    if (normalizedState) return normalizedState;

    if (["active", "in_progress", "inprogress", "pending", "queued", "started", "starting", "working"].includes(token)) {
      return "running";
    }
    if (["complete", "done", "idle", "skipped", "success", "succeeded"].includes(token)) {
      return "completed";
    }
    if (["failed", "failure"].includes(token)) return "error";
    if (["cancelled", "canceled", "stopped"].includes(token)) return "interrupted";
  }

  return undefined;
}

export const isPendingQuestionEvent = (event: AgentEvent) => {
  const state = normalizeQuestionEventState(event);
  return !state || state === "running";
};

const getSessionQuestionEntries = (sessionId: string, currentTurnOnly = false) => {
  const chat = useChatStore.getState();
  const messages = chat.sessionMessages[sessionId] || (
    chat.activeSessionId === sessionId ? chat.messages : []
  );
  const entries: AgentProcessEntry[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (currentTurnOnly && message.role === "user") break;
    if (message.role !== "assistant" || !message.process) continue;
    entries.push(...message.process.entries.filter((entry) => entry.type === "question"));
  }
  return entries;
};

export function resolveTerminalQuestionEvent(
  event: AgentEvent,
  currentSessionId: string,
  ctx: AgentEventHandlerContext,
) {
  const pending = ctx.getPendingUIResponse(currentSessionId);
  const eventIds = getQuestionEventIds(event);
  if (!pending) return { entryId: eventIds[0], pendingToClear: null };

  const pendingIds = [pending.requestId, pending.entryId]
    .filter((value): value is string => typeof value === "string" && !!value.trim());
  if (eventIds.some((id) => pendingIds.includes(id))) {
    return { entryId: pending.entryId || eventIds[0], pendingToClear: pending };
  }

  const matchingExistingEntry = getSessionQuestionEntries(currentSessionId)
    .find((entry) => eventIds.includes(entry.id));
  if (matchingExistingEntry) {
    return {
      entryId: matchingExistingEntry.id,
      pendingToClear: matchingExistingEntry.id === pending.entryId ? pending : null,
    };
  }

  const hasAnotherRunningQuestion = getSessionQuestionEntries(currentSessionId, true).some((entry) => (
    entry.state === "running" && entry.id !== pending.entryId
  ));
  if (!hasAnotherRunningQuestion) {
    // A single pending question is unambiguous even when an adapter changes
    // the id between its start and end events.
    return { entryId: pending.entryId || eventIds[0], pendingToClear: pending };
  }

  // Multiple unresolved questions make an unmatched terminal ambiguous. Keep
  // the newest pending UI intact; closing it here could let a delayed end from
  // the previous question consume the user's next prompt.
  return { entryId: eventIds[0], pendingToClear: null };
}

export function clearResolvedPendingQuestion(
  currentSessionId: string,
  pendingToClear: Exclude<ReturnType<typeof resolveTerminalQuestionEvent>["pendingToClear"], null>,
  ctx: AgentEventHandlerContext,
) {
  ctx.setPendingUIResponse((current) => {
    if (current?.sessionId !== currentSessionId) return current;
    if (pendingToClear.entryId && current.entryId !== pendingToClear.entryId) return current;
    if (pendingToClear.requestId && current.requestId !== pendingToClear.requestId) return current;
    return null;
  });
}

export const isDirectQuestionEvent = (event: AgentEvent) =>
  event.type === "user_ask_question" ||
  event.type === "ask_user_question" ||
  event.type === "ask_user";

export function handleDirectQuestionEvent(
  event: AgentEvent,
  currentSessionId: string,
  ctx: AgentEventHandlerContext
) {
  // Question events can be the first observable event for SDK adapters. Open
  // the turn before appending so the question is visible and guarded by the
  // same watchdog/lifecycle barrier as stream and tool output.
  ctx.ensureAssistantContinuation(currentSessionId);
  ctx.finishAssistantProcessText(currentSessionId);
  ctx.finishThinkingEntry(currentSessionId);
  const eventId = getQuestionEventId(event);
  const pending = ctx.getPendingUIResponse(currentSessionId);
  const pendingMatches = !!pending && (
    !eventId || pending.requestId === eventId || pending.entryId === eventId
  );
  const entryId = (pendingMatches ? pending.entryId : undefined) || eventId || createProcessEntryId();
  ctx.setPendingUIResponse(ctx.getPendingUIFromEvent(event, currentSessionId, entryId));
  ctx.appendProcessEntry(currentSessionId, {
    id: entryId,
    type: "question",
    title: getQuestionTitle(true),
    state: "running",
    expanded: false,
  });
}

export function handleDefaultQuestionEvent(
  event: AgentEvent,
  currentSessionId: string,
  ctx: AgentEventHandlerContext
) {
  if (normalizeToolKind(event.mode || event.entryType || event.kind || event.toolKind) !== "question") {
    return false;
  }

  ctx.ensureAssistantContinuation(currentSessionId);
  ctx.finishThinkingEntry(currentSessionId);
  const eventState = normalizeQuestionEventState(event);
  const eventId = getQuestionEventId(event);
  const pending = ctx.getPendingUIResponse(currentSessionId);
  const pendingMatches = pending?.sessionId === currentSessionId && (
    !eventId || pending.requestId === eventId || pending.entryId === eventId
  );
  const questionIsPending = isPendingQuestionEvent(event);
  const terminalResolution = questionIsPending
    ? null
    : resolveTerminalQuestionEvent(event, currentSessionId, ctx);
  const entryId = questionIsPending
    ? (pendingMatches ? pending?.entryId : undefined) || eventId || createProcessEntryId()
    : terminalResolution?.entryId || eventId || createProcessEntryId();
  if (questionIsPending) {
    ctx.setPendingUIResponse(ctx.getPendingUIFromEvent(event, currentSessionId, entryId));
  } else if (terminalResolution?.pendingToClear) {
    clearResolvedPendingQuestion(currentSessionId, terminalResolution.pendingToClear, ctx);
  }
  ctx.appendProcessEntry(currentSessionId, {
    id: entryId,
    type: "question",
    title: getQuestionTitle(questionIsPending, eventState === "error" || eventState === "interrupted"),
    state: eventState || "running",
    expanded: false,
  });
  return true;
}
