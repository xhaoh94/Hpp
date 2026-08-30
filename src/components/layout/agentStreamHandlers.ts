import { flushSync } from "react-dom";
import { hasOpenAssistantProcessState, useChatStore } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import type { AgentEvent } from "@/types";
import type { SessionRuntime } from "./agentEventUtils";
import type { AgentEventHandlerContext } from "./agentEventTypes";

export function handleMessageStartEvent(
  _event: AgentEvent,
  currentSessionId: string,
  runtime: SessionRuntime,
  ctx: AgentEventHandlerContext
) {
  if (runtime.processActive) {
    ctx.clearStreamWatchdog(currentSessionId);
    ctx.appendOrRefreshAlreadyRunningNotice(currentSessionId);
    return;
  }
  if (runtime.streamStarted) {
    ctx.clearStreamWatchdog(currentSessionId);
    ctx.completeIdleNotice(currentSessionId);
    ctx.finishThinkingEntry(currentSessionId);
    useChatStore.getState().finishLastAssistantProcess(Date.now(), "completed", currentSessionId);
  }
  if (ctx.getPendingUIResponse(currentSessionId)) {
    ctx.finishAbortedTurn(currentSessionId);
  }
  runtime.streamBuffer = "";
  runtime.thinkingBuffer = "";
  runtime.thinkingEntryId = null;
  runtime.streamStarted = false;
  runtime.activeToolEntry = {};
  runtime.activeToolFile = {};
  runtime.activeToolKind = {};
  runtime.nativePlanSteps = false;
  runtime.inferredPlanStepsActive = false;
  runtime.inferredStepSignal = {
    analyzed: false,
    operated: false,
    modified: false,
    verified: false,
    failed: false,
    cancelled: false,
  };
  runtime.changeSummaryFiles = {};
  runtime.changeSummarySeenEvents = {};
  runtime.autoAbortReason = null;
  runtime.processTextEntryId = null;
  runtime.processTextEntryIds = [];
  runtime.processTextHistory = [];
  runtime.processTextBuffer = "";
  ctx.setPendingUIResponse((current) => current?.sessionId === currentSessionId ? null : current);
  useChatStore.getState().startAssistantProcess(Date.now(), currentSessionId);
  runtime.processActive = true;
  ctx.updateInferredPlanSteps(currentSessionId, "analyze");
  // Some adapters can fail after acknowledging the prompt but before they
  // emit stream_start. Start the same backend-state watchdog here so that
  // this partial lifecycle cannot leave an open process ticking forever.
  ctx.refreshStreamWatchdog(currentSessionId);
}

export function handleStreamStartEvent(
  currentSessionId: string,
  runtime: SessionRuntime,
  ctx: AgentEventHandlerContext
) {
  const alreadyStarted = runtime.streamStarted;
  if (
    !alreadyStarted &&
    !runtime.processActive &&
    ctx.getPendingUIResponse(currentSessionId)
  ) {
    ctx.finishAbortedTurn(currentSessionId);
  }
  ctx.completeIdleNotice(currentSessionId);
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
    if (currentSessionId === useProjectStore.getState().activeSessionId) ctx.setStreamingState(true);
    runtime.processActive = true;
    runtime.streamStarted = true;
    runtime.autoAbortReason = null;
    runtime.activeToolEntry = {};
    runtime.activeToolFile = {};
    runtime.activeToolKind = {};
    runtime.nativePlanSteps = false;
    runtime.inferredPlanStepsActive = false;
    runtime.inferredStepSignal = {
      analyzed: false,
      operated: false,
      modified: false,
      verified: false,
      failed: false,
      cancelled: false,
    };
    runtime.changeSummaryFiles = {};
    runtime.changeSummarySeenEvents = {};
    if (!alreadyStarted) {
      useChatStore.getState().startAssistantProcess(Date.now(), currentSessionId);
    }
    if (currentSessionId) useProjectStore.getState().setAgentStatus(currentSessionId, "running");
  });
  if (!alreadyStarted) {
    ctx.appendProcessEntry(currentSessionId, {
      type: "status",
      title: "正在分析请求并生成响应",
      state: "running",
    });
  }
  ctx.refreshStreamWatchdog(currentSessionId);
}

export function handleStreamDeltaEvent(
  event: AgentEvent,
  currentSessionId: string,
  ctx: AgentEventHandlerContext
) {
  if (!event.delta) return;
  ctx.ensureAssistantContinuation(currentSessionId);
  ctx.finishThinkingEntry(currentSessionId);
  ctx.appendAssistantProcessText(currentSessionId, String(event.delta));
  ctx.refreshStreamWatchdog(currentSessionId);
}

const getCommentaryItemId = (event: AgentEvent) =>
  String(event.itemId || event.id || "").trim();

export function handleCommentaryDeltaEvent(
  event: AgentEvent,
  currentSessionId: string,
  ctx: AgentEventHandlerContext
) {
  const itemId = getCommentaryItemId(event);
  const delta = typeof event.delta === "string" ? event.delta : "";
  if (!itemId || !delta) return;
  ctx.ensureAssistantContinuation(currentSessionId);
  ctx.finishAssistantProcessText(currentSessionId);
  ctx.finishThinkingEntry(currentSessionId);
  useChatStore.getState().appendLastAssistantCommentaryDelta(
    itemId,
    delta,
    Date.now(),
    currentSessionId
  );
  ctx.refreshStreamWatchdog(currentSessionId);
}

export function handleCommentaryEndEvent(
  event: AgentEvent,
  currentSessionId: string,
  ctx: AgentEventHandlerContext
) {
  const itemId = getCommentaryItemId(event);
  if (!itemId) return;
  ctx.ensureAssistantContinuation(currentSessionId);
  ctx.finishAssistantProcessText(currentSessionId);
  ctx.finishThinkingEntry(currentSessionId);
  useChatStore.getState().finishLastAssistantCommentary(
    itemId,
    typeof event.content === "string" ? event.content : undefined,
    Date.now(),
    currentSessionId
  );
  ctx.refreshStreamWatchdog(currentSessionId);
}

export function handleStreamSnapshotEvent(
  event: AgentEvent,
  currentSessionId: string,
  ctx: AgentEventHandlerContext
) {
  const content = String(event.content || "");
  if (!content) return;
  ctx.completeIdleNotice(currentSessionId);
  ctx.ensureAssistantContinuation(currentSessionId);
  ctx.finishThinkingEntry(currentSessionId);
  ctx.replaceAssistantProcessText(currentSessionId, content);
  ctx.refreshStreamWatchdog(currentSessionId);
}

export function handleThinkingDeltaEvent(
  event: AgentEvent,
  currentSessionId: string,
  ctx: AgentEventHandlerContext
) {
  if (!event.delta) return;
  ctx.ensureAssistantContinuation(currentSessionId);
  ctx.finishAssistantProcessText(currentSessionId);
  ctx.appendThinkingDelta(currentSessionId, String(event.delta));
}

export function handleStreamEndEvent(
  event: AgentEvent,
  currentSessionId: string,
  runtime: SessionRuntime,
  ctx: AgentEventHandlerContext
) {
  if (!runtime.processActive) {
    const eventContent = event.content ? String(event.content) : "";
    const sessionMarkedRunning = useProjectStore.getState().agentStatuses[currentSessionId] === "running";
    const chatState = useChatStore.getState();
    const sessionMessages = chatState.sessionMessages[currentSessionId] || (
      chatState.activeSessionId === currentSessionId ? chatState.messages : []
    );
    const storeHasOpenProcess = sessionMessages.some(hasOpenAssistantProcessState);
    if (!eventContent.trim() && !storeHasOpenProcess && !sessionMarkedRunning) {
      // shouldAcceptTurnScopedAgentEvent has already attached this terminal
      // revision to the runtime. Even without a visible process, preserve a
      // terminal tombstone so a delayed event cannot reopen the same turn.
      ctx.settleRuntimeTurnOnly(currentSessionId, "completed");
      return;
    }
    if (!storeHasOpenProcess && eventContent.trim()) ctx.ensureAssistantContinuation(currentSessionId);
  }
  if (ctx.getPendingUIResponse(currentSessionId) && !event.force) return;
  ctx.finishAssistantProcessText(currentSessionId);
  ctx.finishThinkingEntry(currentSessionId);
  const eventContent = event.content ? String(event.content) : "";
  ctx.completeAssistantStream(currentSessionId, eventContent, false);
  ctx.setPendingUIResponse((current) => current?.sessionId === currentSessionId ? null : current);
}

export function handleAgentDisconnectedEvent(
  currentSessionId: string,
  runtime: SessionRuntime,
  ctx: AgentEventHandlerContext
) {
  void runtime;
  ctx.finishDisconnectedTurn(currentSessionId);
  ctx.setPendingUIResponse((current) => current?.sessionId === currentSessionId ? null : current);
}

export function handleDiffUpdateEvent(
  event: AgentEvent,
  currentSessionId: string,
  ctx: AgentEventHandlerContext
) {
  ctx.ensureAssistantContinuation(currentSessionId);
  if (Array.isArray(event.diffs) && event.diffs.length > 0) {
    ctx.finishAssistantProcessText(currentSessionId);
    ctx.finishThinkingEntry(currentSessionId);
    useChatStore.getState().appendLastAssistantDiffs(event.diffs, currentSessionId);
    const files = event.diffs
      .filter((diff): diff is {
        file: string;
        patch?: string;
        additions?: number;
        deletions?: number;
        status?: "added" | "deleted" | "modified";
        statusExplicit?: boolean;
      } => (
        !!diff &&
        typeof diff === "object" &&
        typeof (diff as { file?: unknown }).file === "string"
      ))
      .map((diff) => ({
        file: diff.file,
        action: "modified" as const,
        patch: typeof diff.patch === "string" ? diff.patch : undefined,
        additions: typeof diff.additions === "number" ? diff.additions : undefined,
        deletions: typeof diff.deletions === "number" ? diff.deletions : undefined,
        status: diff.status,
        statusExplicit: diff.statusExplicit === true,
        changeKey: [
          "diff",
          diff.file,
          typeof diff.patch === "string" ? diff.patch : "",
          typeof diff.additions === "number" ? diff.additions : "",
          typeof diff.deletions === "number" ? diff.deletions : "",
          diff.statusExplicit === true ? "explicit-status" : "inferred-status",
        ].join("|"),
      }));
    ctx.recordProcessFiles(currentSessionId, files, "modify");
  }
}
