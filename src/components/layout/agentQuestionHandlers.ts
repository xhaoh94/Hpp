import type { AgentEvent } from "@/types";
import {
  createProcessEntryId,
  getQuestionTitle,
  normalizeProcessEntryState,
  normalizeToolKind,
} from "./agentEventUtils";
import type { AgentEventHandlerContext } from "./agentEventTypes";

export const isDirectQuestionEvent = (event: AgentEvent) =>
  event.type === "user_ask_question" ||
  event.type === "ask_user_question" ||
  event.type === "ask_user";

export function handleDirectQuestionEvent(
  event: AgentEvent,
  currentSessionId: string,
  ctx: AgentEventHandlerContext
) {
  ctx.finishAssistantProcessText(currentSessionId);
  ctx.finishThinkingEntry(currentSessionId);
  const entryId = createProcessEntryId();
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

  ctx.finishThinkingEntry(currentSessionId);
  const entryId = createProcessEntryId();
  ctx.setPendingUIResponse(ctx.getPendingUIFromEvent(event, currentSessionId, entryId));
  ctx.appendProcessEntry(currentSessionId, {
    id: entryId,
    type: "question",
    title: getQuestionTitle(true),
    state: normalizeProcessEntryState(event.state) || "running",
    expanded: false,
  });
  return true;
}
