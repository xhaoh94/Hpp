import { useChatStore, type AgentProcessEntry } from "@/stores/chat-store";
import type { AgentEvent } from "@/types";
import {
  createProcessEntryId,
  getQuestionTitle,
  getToolDetail,
  getToolKey,
  getToolName,
  getToolProcessFiles,
  getToolSummary,
  normalizeToolKind,
  type SessionRuntime,
} from "./agentEventUtils";
import type { AgentEventHandlerContext } from "./agentEventTypes";

export function handleToolStartEvent(
  event: AgentEvent,
  currentSessionId: string,
  runtime: SessionRuntime,
  ctx: AgentEventHandlerContext
) {
  ctx.ensureAssistantContinuation(currentSessionId);
  ctx.updateInferredPlanSteps(currentSessionId, "operate");
  ctx.finishAssistantProcessText(currentSessionId);
  ctx.finishThinkingEntry(currentSessionId);
  const key = getToolKey(event);
  if (normalizeToolKind(event.toolKind) === "question") {
    if (!runtime.activeToolEntry[key]) {
      const entryId = createProcessEntryId();
      runtime.activeToolEntry[key] = entryId;
      ctx.setPendingUIResponse(ctx.getPendingUIFromEvent(event, currentSessionId, entryId));
      ctx.appendProcessEntry(currentSessionId, {
        id: entryId,
        type: "question",
        title: getQuestionTitle(true),
        state: "running",
        expanded: false,
      });
    }
    return;
  }

  const existingEntryId = runtime.activeToolEntry[key];
  const toolFiles = getToolProcessFiles(event);
  if (toolFiles.length > 0) runtime.activeToolFile[key] = toolFiles;
  if (toolFiles.some((file) => file.action === "edited" || file.action === "written" || file.action === "modified")) {
    ctx.updateInferredPlanSteps(currentSessionId, "modify");
  }
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
    ctx.appendProcessEntry(currentSessionId, {
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

export function handleToolEndEvent(
  event: AgentEvent,
  currentSessionId: string,
  runtime: SessionRuntime,
  ctx: AgentEventHandlerContext
) {
  ctx.finishAssistantProcessText(currentSessionId);
  ctx.finishThinkingEntry(currentSessionId);
  const key = getToolKey(event);
  const entryId = runtime.activeToolEntry[key];
  if (normalizeToolKind(event.toolKind) === "question") {
    if (entryId && !ctx.pendingUIResponseRef.current) {
      useChatStore.getState().updateLastAssistantProcessEntry(entryId, {
        title: event.isError ? getQuestionTitle(false, true) : getQuestionTitle(false),
        state: event.isError ? "error" : "completed",
        expanded: false,
      }, currentSessionId);
    }
    delete runtime.activeToolEntry[key];
    delete runtime.activeToolFile[key];
    return;
  }

  const toolName = getToolName(event);
  const toolFiles = getToolProcessFiles(event);
  const preservedToolFiles = toolFiles.length > 0 ? toolFiles : runtime.activeToolFile[key] || [];
  const changedToolFiles = preservedToolFiles
    .filter((file) =>
      file.action === "edited" ||
      file.action === "written" ||
      file.action === "modified" ||
      typeof file.additions === "number" ||
      typeof file.deletions === "number"
    )
    .map((file) => ({
      ...file,
      changeKey: [
        "diff",
        file.file,
        typeof event.patch === "string" ? event.patch : "",
        typeof file.additions === "number" ? file.additions : "",
        typeof file.deletions === "number" ? file.deletions : "",
      ].join("|"),
    }));
  if (changedToolFiles.length > 0 && !event.isError) {
    ctx.recordProcessFiles(currentSessionId, changedToolFiles, "modify");
  } else {
    ctx.updateInferredPlanSteps(currentSessionId, event.isError ? "failed" : "operate");
  }
  const toolDetail = getToolDetail(event);
  const toolSummary = getToolSummary({
    ...event,
    files: preservedToolFiles.length > 0 ? preservedToolFiles : event.files,
  }, false);
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
    ctx.appendProcessEntry(currentSessionId, {
      type: entryType,
      title: patch.title || (event.isError ? `${toolName} 执行失败` : `已完成 ${toolName}`),
      detail: patch.detail,
      files: patch.files,
      state: patch.state,
      expanded: patch.expanded,
    });
  }
}
