import { useChatStore, type AgentProcessEntry } from "@/stores/chat-store";
import type { AgentEvent } from "@/types";
import {
  createProcessEntryId,
  getQuestionTitle,
  getToolDetail,
  getToolKey,
  getToolName,
  getToolProcessFiles,
  getTodoPlanStepIdsFromToolResult,
  getToolSummary,
  isCommandNonZeroExit,
  isTodoPlanToolEvent,
  normalizePlanStepsFromToolResult,
  normalizeToolKind,
  type SessionRuntime,
} from "./agentEventUtils";
import type { AgentEventHandlerContext } from "./agentEventTypes";
import { normalizeQuestionEventState } from "./agentQuestionHandlers";

const normalizeToolFileKey = (filePath: string) => filePath.replace(/\\/g, "/").trim().toLowerCase();

export function resolveActiveToolKey(
  requestedKey: string,
  toolFiles: Array<{ file: string }>,
  toolKind: ReturnType<typeof normalizeToolKind>,
  runtime: Pick<SessionRuntime, "activeToolEntry" | "activeToolFile" | "activeToolKind">
) {
  if (runtime.activeToolEntry[requestedKey]) return requestedKey;
  const activeKeys = Object.keys(runtime.activeToolEntry);
  const sameKindKeys = activeKeys.filter(
    (key) => runtime.activeToolKind[key] === toolKind,
  );
  if (toolFiles.length > 0) {
    const completedFiles = new Set(toolFiles.map((file) => normalizeToolFileKey(file.file)));
    const matchingKeys = sameKindKeys.filter((key) => {
      const activeFiles = runtime.activeToolFile[key] || [];
      if (activeFiles.length !== completedFiles.size) return false;
      return activeFiles.every((file) => completedFiles.has(normalizeToolFileKey(file.file)));
    });
    if (matchingKeys.length === 1) return matchingKeys[0];
  }

  // Some providers omit the original call id and file arguments on tool_end.
  // Correlating is still unambiguous when exactly one tool of that kind is
  // active; with concurrent peers, keep the end event separate rather than
  // guessing and completing the wrong row.
  if (sameKindKeys.length === 1) return sameKindKeys[0];

  // A few adapters omit both the original id and toolKind on tool_end. The
  // single globally active tool is still an unambiguous match; its recorded
  // kind is recovered by handleToolEndEvent after resolving this key.
  return activeKeys.length === 1 ? activeKeys[0] : requestedKey;
}

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
    // Question adapters are subject to the same start/end id drift as file
    // tools. Record their kind as well so an otherwise unambiguous terminal
    // event can resolve the original running row instead of leaving the
    // question (and its pending UI state) open forever.
    runtime.activeToolKind[key] = "question";
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
  runtime.activeToolKind[key] = toolKind;
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
      expanded: false,
    });
  }
}

export function handleToolEndEvent(
  event: AgentEvent,
  currentSessionId: string,
  runtime: SessionRuntime,
  ctx: AgentEventHandlerContext
) {
  // A few adapters can recover an end/result event after their start event was
  // lost. Preserve that completed operation in a real turn instead of letting
  // appendProcessEntry silently no-op against an inactive runtime.
  ctx.ensureAssistantContinuation(currentSessionId);
  ctx.finishAssistantProcessText(currentSessionId);
  ctx.finishThinkingEntry(currentSessionId);
  const requestedKey = getToolKey(event);
  const incomingToolFiles = getToolProcessFiles(event);
  const incomingToolKind = normalizeToolKind(event.toolKind);
  const key = resolveActiveToolKey(requestedKey, incomingToolFiles, incomingToolKind, runtime);
  const entryId = runtime.activeToolEntry[key];
  const recordedToolKind = entryId ? runtime.activeToolKind[key] : undefined;
  const effectiveToolKind = incomingToolKind === "unknown" && recordedToolKind
    ? recordedToolKind
    : incomingToolKind;
  const effectiveEvent = effectiveToolKind !== incomingToolKind
    ? { ...event, toolKind: effectiveToolKind }
    : event;
  const toolFiles = getToolProcessFiles(effectiveEvent);
  if (effectiveToolKind === "question") {
    const pending = ctx.getPendingUIResponse(currentSessionId);
    const requestIds = [event.requestId, event.id, event.toolCallId]
      .filter((value): value is string => typeof value === "string" && !!value.trim());
    const pendingMatches = pending?.sessionId === currentSessionId && (
      (!!entryId && pending.entryId === entryId) ||
      (!!pending.requestId && requestIds.includes(pending.requestId))
    );
    const questionEntryId = entryId || (pendingMatches ? pending.entryId : undefined);
    const normalizedState = normalizeQuestionEventState(effectiveEvent);
    const terminalState = normalizedState && normalizedState !== "running"
      ? normalizedState
      : "completed";
    if (questionEntryId) {
      useChatStore.getState().updateLastAssistantProcessEntry(questionEntryId, {
        title: getQuestionTitle(false, terminalState === "error" || terminalState === "interrupted"),
        state: terminalState,
        expanded: false,
      }, currentSessionId);
    }
    if (pendingMatches) {
      ctx.setPendingUIResponse((current) => {
        if (current?.sessionId !== currentSessionId) return current;
        if (questionEntryId && current.entryId !== questionEntryId) return current;
        return null;
      });
    }
    delete runtime.activeToolEntry[key];
    delete runtime.activeToolFile[key];
    delete runtime.activeToolKind[key];
    return;
  }

  const toolName = getToolName(effectiveEvent);
  const commandExitWarning = isCommandNonZeroExit(effectiveEvent);
  const toolWarning = effectiveEvent.isError === true;
  const preservedToolFiles = toolFiles.length > 0 ? toolFiles : runtime.activeToolFile[key] || [];
  const displayedToolFiles = toolWarning
    ? preservedToolFiles.filter((file) =>
        file.action !== "edited" &&
        file.action !== "written" &&
        file.action !== "modified" &&
        typeof file.patch !== "string" &&
        typeof file.additions !== "number" &&
        typeof file.deletions !== "number"
      )
    : preservedToolFiles;
  const changedToolFiles = preservedToolFiles
    .filter((file) =>
      file.action === "edited" ||
      file.action === "written" ||
      file.action === "modified" ||
      typeof file.patch === "string" ||
      typeof file.additions === "number" ||
      typeof file.deletions === "number"
    )
    .map((file) => {
      const patch = typeof file.patch === "string"
        ? file.patch
        : typeof effectiveEvent.patch === "string" ? effectiveEvent.patch : "";
      return {
        ...file,
        patch: patch || undefined,
        statusExplicit: file.statusExplicit === true,
        changeKey: [
          "diff",
          file.file,
          patch,
          typeof file.additions === "number" ? file.additions : "",
          typeof file.deletions === "number" ? file.deletions : "",
          file.statusExplicit === true ? "explicit-status" : "inferred-status",
        ].join("|"),
      };
    });
  if (changedToolFiles.length > 0 && !toolWarning) {
    ctx.recordProcessFiles(currentSessionId, changedToolFiles, "modify");
  } else {
    ctx.updateInferredPlanSteps(currentSessionId, "operate");
  }

  // Some extensions expose a structured task snapshot in their tool result
  // instead of emitting a separate plan_update event. Promote that snapshot to
  // HPP's existing native plan UI. The parser is intentionally based on the
  // result shape (for example `{ details: { tasks } }`), not on a package name,
  // so other Pi extensions can integrate without an adapter.
  const allPlanSteps = normalizePlanStepsFromToolResult(effectiveEvent);
  if (allPlanSteps.length > 0) {
    let planSteps = allPlanSteps;
    if (isTodoPlanToolEvent(effectiveEvent)) {
      const changedIds = getTodoPlanStepIdsFromToolResult(effectiveEvent);
      if (changedIds.length === 0) {
        planSteps = [];
      } else {
        const currentTurnIds = new Set(runtime.nativeTodoPlanStepIds);
        for (const id of changedIds) currentTurnIds.add(id);
        runtime.nativeTodoPlanStepIds = Array.from(currentTurnIds);
        planSteps = allPlanSteps.filter((step) => currentTurnIds.has(step.id));
      }
    }
    if (planSteps.length > 0) ctx.updateProcessPlanSteps(currentSessionId, planSteps, true);
  }

  const toolDetail = getToolDetail(effectiveEvent);
  const toolSummary = getToolSummary({
    ...effectiveEvent,
    files: displayedToolFiles.length > 0 ? displayedToolFiles : undefined,
  }, false);
  const entryType: AgentProcessEntry["type"] = "tool";
  const patch = {
    title: toolSummary,
    detail: toolDetail || undefined,
    files: displayedToolFiles.length > 0 ? displayedToolFiles : undefined,
    toolKind: effectiveToolKind,
    command: typeof effectiveEvent.command === "string" ? effectiveEvent.command : undefined,
    exitCode: typeof effectiveEvent.exitCode === "number" ? effectiveEvent.exitCode : undefined,
    state: toolWarning || commandExitWarning ? "warning" : "completed",
    type: entryType,
    expanded: false,
  } satisfies Partial<Omit<AgentProcessEntry, "id">>;

  if (entryId) {
    useChatStore.getState().updateLastAssistantProcessEntry(entryId, patch, currentSessionId);
    delete runtime.activeToolEntry[key];
    delete runtime.activeToolFile[key];
    delete runtime.activeToolKind[key];
  } else {
    ctx.appendProcessEntry(currentSessionId, {
      type: entryType,
      title: patch.title || (toolWarning ? `${toolName} 执行未成功` : `已完成 ${toolName}`),
      detail: patch.detail,
      files: patch.files,
      toolKind: patch.toolKind,
      command: patch.command,
      exitCode: patch.exitCode,
      state: patch.state,
      expanded: patch.expanded,
    });
  }
}
