import { flushSync } from "react-dom";
import { useChatStore } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import type { AgentEvent } from "@/types";
import {
  truncateProcessDetail,
  type SessionRuntime,
} from "./agentEventUtils";
import type { AgentEventHandlerContext } from "./agentEventTypes";

export function handleMessageStartEvent(
  event: AgentEvent,
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
  runtime.streamBuffer = "";
  runtime.thinkingBuffer = "";
  runtime.thinkingEntryId = null;
  runtime.streamStarted = false;
  runtime.activeToolEntry = {};
  runtime.activeToolFile = {};
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
  const messagePreview = event.content
    ? (event.content.length > 50 ? event.content.substring(0, 50) + "..." : event.content)
    : "用户消息";
  ctx.appendProcessEntry(currentSessionId, {
    type: "status",
    title: `收到消息: "${messagePreview}"`,
    detail: event.content ? truncateProcessDetail(String(event.content)) : undefined,
    state: "completed",
  });
  ctx.updateInferredPlanSteps(currentSessionId, "analyze");
}

export function handleStreamStartEvent(
  currentSessionId: string,
  runtime: SessionRuntime,
  ctx: AgentEventHandlerContext
) {
  const alreadyStarted = runtime.streamStarted;
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
  ctx.ensureAssistantContinuation(currentSessionId);
  ctx.finishAssistantProcessText(currentSessionId);
  ctx.appendThinkingDelta(currentSessionId, String(event.delta || ""));
}

export function handleStreamEndEvent(
  event: AgentEvent,
  currentSessionId: string,
  runtime: SessionRuntime,
  ctx: AgentEventHandlerContext
) {
  if (!runtime.processActive) {
    const eventContent = event.content ? String(event.content) : "";
    if (!eventContent.trim()) return;
    ctx.ensureAssistantContinuation(currentSessionId);
  }
  if (ctx.pendingUIResponseRef.current?.sessionId === currentSessionId && !event.force) return;
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
  if (!runtime.processActive) return;
  ctx.finishAssistantProcessText(currentSessionId);
  ctx.finishThinkingEntry(currentSessionId);
  ctx.completeAssistantStream(currentSessionId, undefined, true);
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
      } => (
        !!diff &&
        typeof diff === "object" &&
        typeof (diff as { file?: unknown }).file === "string"
      ))
      .map((diff) => ({
        file: diff.file,
        action: "modified" as const,
        additions: typeof diff.additions === "number" ? diff.additions : undefined,
        deletions: typeof diff.deletions === "number" ? diff.deletions : undefined,
        status: diff.status,
        changeKey: [
          "diff",
          diff.file,
          typeof diff.patch === "string" ? diff.patch : "",
          typeof diff.additions === "number" ? diff.additions : "",
          typeof diff.deletions === "number" ? diff.deletions : "",
        ].join("|"),
      }));
    ctx.recordProcessFiles(currentSessionId, files, "modify");
  }
}
