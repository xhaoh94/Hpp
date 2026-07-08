import { getAgentName } from "@/lib/agents";
import { useProjectStore } from "@/stores/project-store";
import type { AgentProcessFile } from "@/stores/chat-store";
import type { AgentEvent } from "@/types";
import {
  createProcessEntryId,
  getToolProcessFiles,
  isPlanLikeProcessEvent,
  normalizePlanStepsFromEvent,
  normalizeProcessEntryState,
  normalizeProcessEntryType,
  stringifyProcessValue,
  truncateProcessDetail,
} from "./agentEventUtils";
import {
  handleDefaultQuestionEvent,
  handleDirectQuestionEvent,
} from "./agentQuestionHandlers";
import {
  handleAgentDisconnectedEvent,
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
    isAlreadyRunningError,
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
    event.type !== "context_compaction"
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
    case "stream_snapshot":
      handleStreamSnapshotEvent(event, currentSessionId, handlerContext);
      break;
    case "thinking_delta":
      handleThinkingDeltaEvent(event, currentSessionId, handlerContext);
      break;
    case "thinking_end":
      finishThinkingEntry(currentSessionId);
      break;
    case "user_ask_question":
    case "ask_user_question":
    case "ask_user":
    case "droid.ask_user":
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
        state: eventType === "question" ? eventState || "running" : eventState,
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
    default:
      handleDefaultQuestionEvent(event, currentSessionId, handlerContext);
      break;
  }
}
