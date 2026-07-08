import type {
  AgentProcess,
  AgentProcessEntry,
  AgentProcessStep,
} from "@/stores/chat-store";
import {
  formatCompletedStepProgress,
  formatProcessCountSummary,
  formatStepProgress,
  formatThinkingSummary,
  uiText,
} from "@/i18n/text";

const THINKING_PREVIEW_CHAR_LIMIT = 240;

export const getThinkingPreview = (value?: string) => {
  const preview = value?.replace(/\s+/g, " ").trim();
  if (!preview) return uiText.process.thinking;
  return preview.length > THINKING_PREVIEW_CHAR_LIMIT
    ? `${preview.slice(0, THINKING_PREVIEW_CHAR_LIMIT)}...`
    : preview;
};

export const summarizeProcessEntries = (entries: AgentProcessEntry[]) => {
  if (entries.length === 0) return uiText.process.waitingEvent;

  if (entries.some((entry) => entry.state === "interrupted")) return uiText.process.interrupted;

  const toolCount = entries.filter((entry) => entry.type === "tool" || entry.type === "question" || entry.type === "error").length;
  const diffCount = entries.filter((entry) => entry.type === "diff").length;
  const isThinking = entries.some((entry) => entry.type === "thinking" && entry.state === "running");
  const thinkingEntry = entries.find((entry) => entry.type === "thinking" && entry.state === "running");
  const runningTool = entries.find((entry) => (entry.type === "tool" || entry.type === "question") && entry.state === "running");

  if (isThinking && thinkingEntry) {
    return formatThinkingSummary(getThinkingPreview(thinkingEntry.detail));
  }

  if (runningTool) {
    return runningTool.title;
  }

  return formatProcessCountSummary(toolCount, diffCount, entries.length);
};

export const getStepProgressText = (steps: AgentProcessStep[]) => {
  const total = steps.length;
  if (total === 0) return "";

  const terminalIndex = steps.findIndex((step) => step.status === "failed" || step.status === "cancelled");
  if (terminalIndex >= 0) return formatStepProgress(terminalIndex + 1, total);

  const completed = Math.min(total, steps.filter((step) => step.status === "completed").length);
  return formatCompletedStepProgress(completed, total);
};

const isTerminalStepStatus = (status?: AgentProcessStep["status"]) =>
  status === "failed" || status === "cancelled";

const getStepById = (steps: AgentProcessStep[], id: string) =>
  steps.find((step) => step.id === id);

const isActiveStepStatus = (status?: AgentProcessStep["status"]) =>
  !!status && status !== "pending";

export const normalizeInferredStepsForDisplay = (
  process: AgentProcess,
  steps: AgentProcessStep[]
): AgentProcessStep[] => {
  const hasInferredSteps = process.planStepsSource === "inferred" || steps.some((step) => step.id.startsWith("inferred-"));
  if (!hasInferredSteps) return steps;

  const analyze = getStepById(steps, "inferred-analyze");
  const operate = getStepById(steps, "inferred-operate");
  const modify = getStepById(steps, "inferred-modify");
  const verify = getStepById(steps, "inferred-verify");
  const hasChangedFiles = (process.changeSummary?.filesChanged || 0) > 0;
  const hasModifyStep = !!modify || hasChangedFiles;
  const hasLaterActiveStep = [operate, modify, verify].some((step) => isActiveStepStatus(step?.status));
  const hasVerifyActiveStep = isActiveStepStatus(verify?.status);

  const analyzeStatus: AgentProcessStep["status"] =
    isTerminalStepStatus(analyze?.status)
      ? analyze!.status
      : hasLaterActiveStep
        ? "completed"
        : analyze?.status || "pending";

  let operateStatus: AgentProcessStep["status"] = "pending";
  if (isTerminalStepStatus(operate?.status)) {
    operateStatus = operate!.status;
  } else if (hasModifyStep || hasVerifyActiveStep || verify?.status === "completed") {
    operateStatus = "completed";
  } else if (operate?.status && operate.status !== "pending") {
    operateStatus = operate.status;
  }

  const modifyStatus: AgentProcessStep["status"] =
    isTerminalStepStatus(modify?.status)
      ? modify!.status
      : hasVerifyActiveStep || verify?.status === "completed" || (hasChangedFiles && !!process.endedAt)
        ? "completed"
        : modify?.status && modify.status !== "pending"
          ? modify.status
          : hasChangedFiles
            ? "running"
            : "pending";
  const hasTerminalBeforeVerify =
    isTerminalStepStatus(analyzeStatus) ||
    isTerminalStepStatus(operateStatus) ||
    (hasModifyStep && isTerminalStepStatus(modifyStatus));
  const verifyStatus: AgentProcessStep["status"] =
    verify?.status && verify.status !== "pending"
      ? verify.status
      : process.endedAt && !hasTerminalBeforeVerify
        ? "completed"
        : "pending";

  const normalizedSteps: AgentProcessStep[] = [
    { id: "inferred-analyze", title: uiText.process.inferredSteps.analyze, status: analyzeStatus },
    { id: "inferred-operate", title: uiText.process.inferredSteps.operate, status: operateStatus },
  ];
  if (hasModifyStep) {
    normalizedSteps.push({ id: "inferred-modify", title: uiText.process.inferredSteps.modify, status: modifyStatus });
  }
  normalizedSteps.push({ id: "inferred-verify", title: uiText.process.inferredSteps.verify, status: verifyStatus });
  return normalizedSteps;
};
