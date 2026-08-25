import type {
  AgentProcessEntry,
  AgentSubagent,
  AgentSubagentStatus,
} from "@/stores/chat-store";
import type { ProcessSubagentStopReason } from "@shared/process-view";
import type { AgentEvent } from "@/types";

type SubagentProcessEntryDraft = Omit<AgentProcessEntry, "id" | "timestamp"> & {
  id?: string;
  timestamp?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const getString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const getUsageNumber = (...values: unknown[]) => {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return undefined;
};

const parseSubagentUsage = (value: unknown): AgentSubagent["usage"] => {
  if (!isRecord(value)) return undefined;
  const usage = isRecord(value.usage) ? value.usage : value;
  const cost = isRecord(usage.cost) ? usage.cost : {};
  const parsed = {
    inputTokens: getUsageNumber(usage.inputTokens, usage.input, usage.promptTokens),
    outputTokens: getUsageNumber(usage.outputTokens, usage.output, usage.completionTokens),
    cacheReadTokens: getUsageNumber(usage.cacheReadTokens, usage.cacheRead, usage.cache_read),
    cacheWriteTokens: getUsageNumber(usage.cacheWriteTokens, usage.cacheWrite, usage.cache_write),
    totalTokens: getUsageNumber(usage.totalTokens, usage.total_tokens),
    cost: getUsageNumber(usage.cost, cost.total, cost.totalUsd, cost.usd),
    turns: getUsageNumber(usage.turns),
  };
  const compact = Object.fromEntries(Object.entries(parsed).filter(([, item]) => item !== undefined));
  return Object.keys(compact).length > 0 ? compact : undefined;
};

const getFirstString = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = getString(record[key]);
    if (value) return value;
  }
  return undefined;
};

export const normalizeSubagentStopReason = (value: unknown): ProcessSubagentStopReason | undefined => {
  const reason = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["timeout", "timed_out", "time_limit", "deadline_exceeded"].includes(reason)) return "timeout";
  if (["aborted", "abort", "cancelled", "canceled", "cancel", "interrupted"].includes(reason)) return "aborted";
  if (["error", "failed", "failure", "exception"].includes(reason)) return "error";
  return undefined;
};

export const normalizeSubagentStatus = (value: unknown): AgentSubagentStatus | undefined => {
  const status = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["pending", "queued", "not_started"].includes(status)) return "pending";
  if (["running", "active", "working", "in_progress", "inprogress"].includes(status)) return "running";
  if (["completed", "complete", "done", "success", "succeeded", "idle"].includes(status)) return "completed";
  if (["error", "failed", "failure", "errored"].includes(status)) return "error";
  if (["interrupted", "cancelled", "canceled", "stopped", "shutdown"].includes(status)) return "interrupted";
  return undefined;
};

const getSubagentLabel = (value: string) => {
  const pathPart = value.split(/[\\/]/).filter(Boolean).pop() || value;
  return pathPart.replace(/^agent[-_:]?/i, "").replace(/[_-]+/g, " ").trim() || "Subagent";
};

const parseSubagent = (
  value: unknown,
  index: number,
  fallbackStatus?: AgentSubagentStatus,
): AgentSubagent | null => {
  if (typeof value === "string" && value.trim()) {
    return {
      id: value.trim(),
      label: getSubagentLabel(value.trim()),
      status: fallbackStatus,
    };
  }
  if (!isRecord(value)) return null;

  const path = getFirstString(value, ["path", "agentPath", "agent_path"]);
  const id = getFirstString(value, ["id", "threadId", "thread_id", "agentThreadId", "receiverThreadId"])
    || path
    || `subagent-${index + 1}`;
  const label = getFirstString(value, ["label", "name", "taskName", "task_name", "agentName", "agent_name"])
    || (path ? getSubagentLabel(path) : getSubagentLabel(id));
  const usage = parseSubagentUsage(value.usage);
  const stopReason = normalizeSubagentStopReason(value.stopReason);
  const status = stopReason === "timeout"
    ? "error"
    : normalizeSubagentStatus(value.status ?? value.state) || fallbackStatus;

  return {
    id,
    label,
    status,
    model: getFirstString(value, ["model", "modelName", "model_name"]),
    path,
    message: getFirstString(value, ["message", "detail", "summary"]),
    prompt: getFirstString(value, ["prompt", "task", "request"]),
    ...(stopReason ? { stopReason } : {}),
    ...(usage ? { usage } : {}),
  };
};

const parseSubagentStateMap = (
  value: unknown,
  fallbackStatus?: AgentSubagentStatus,
): AgentSubagent[] => {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([id, state], index) => {
    const source = isRecord(state) ? { id, ...state } : { id, status: state };
    const parsed = parseSubagent(source, index, fallbackStatus);
    return parsed ? [parsed] : [];
  });
};

export const parseSubagentsFromEvent = (
  event: AgentEvent,
  fallbackStatus?: AgentSubagentStatus,
): AgentSubagent[] => {
  const source = Array.isArray(event.subagents)
    ? event.subagents
    : Array.isArray(event.agents)
      ? event.agents
      : null;
  let subagents = source
    ? source.flatMap((item, index) => {
        const parsed = parseSubagent(item, index, fallbackStatus);
        return parsed ? [parsed] : [];
      })
    : parseSubagentStateMap(event.agentsStates, fallbackStatus);

  if (subagents.length === 0) {
    const individual = parseSubagent({
      id: event.agentThreadId || event.threadId,
      label: event.agentName,
      path: event.agentPath,
      status: event.status || event.state,
      model: event.model,
      message: event.message,
      prompt: event.prompt,
      usage: event.usage,
      stopReason: event.stopReason,
    }, 0, fallbackStatus);
    if (individual && (event.agentThreadId || event.agentPath || event.agentName)) {
      subagents = [individual];
    }
  }

  if (subagents.length === 0 && Array.isArray(event.receiverThreadIds)) {
    subagents = event.receiverThreadIds.flatMap((item, index) => {
      const parsed = parseSubagent(item, index, fallbackStatus);
      return parsed ? [parsed] : [];
    });
  }

  if (subagents.length === 0) {
    const id = getString(event.toolCallId) || getString(event.id) || "subagent";
    subagents = [{ id, label: "Subagent", status: fallbackStatus }];
  }

  const seen = new Set<string>();
  return subagents.filter((subagent) => {
    if (seen.has(subagent.id)) return false;
    seen.add(subagent.id);
    return true;
  });
};

const getEntryState = (event: AgentEvent, subagents: AgentSubagent[]): AgentProcessEntry["state"] => {
  const direct = normalizeSubagentStatus(event.state ?? event.status);
  if (normalizeSubagentStopReason(event.stopReason) === "timeout") return "error";
  if (direct === "pending" || direct === "running") return "running";
  if (direct === "completed" || direct === "error" || direct === "interrupted") return direct;
  if (subagents.some((subagent) => subagent.stopReason === "timeout" || subagent.status === "error")) return "error";
  if (subagents.some((subagent) => subagent.status === "interrupted")) return "interrupted";
  if (subagents.some((subagent) => subagent.status === "pending" || subagent.status === "running")) return "running";
  return event.phase === "completed" ? "completed" : "running";
};

const getFallbackTitle = (event: AgentEvent, state: AgentProcessEntry["state"]) => {
  const activity = String(event.activityKind || event.tool || "").trim().toLowerCase();
  if (normalizeSubagentStopReason(event.stopReason) === "timeout") return "已超时";
  if (state === "error") return "工作失败";
  if (state === "interrupted") return "已中断";
  if (activity.includes("spawn")) return event.phase === "completed" ? "已开始工作" : "正在启动";
  if (activity.includes("resume")) return "已继续工作";
  if (activity.includes("close")) return "已停止";
  if (activity.includes("message") || activity.includes("update") || activity.includes("followup")) return "已更新";
  return state === "completed" ? "已完成" : "正在工作";
};

export const getSubagentProcessEntry = (event: AgentEvent): SubagentProcessEntryDraft => {
  const directStatus = normalizeSubagentStatus(event.state ?? event.status);
  const eventStopReason = normalizeSubagentStopReason(event.stopReason);
  const fallbackStatus = eventStopReason === "timeout"
    ? "error"
    : directStatus || (event.phase === "completed" ? "completed" : "running");
  const subagents = parseSubagentsFromEvent(event, fallbackStatus);
  const state = getEntryState(event, subagents);
  const timestamp = [event.timestamp, event.startedAt].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  const detail = getString(event.detail);
  const prompt = getString(event.prompt);
  const phase = event.phase === "started" || event.phase === "completed" ? event.phase : undefined;
  const action = [
    "spawnAgent",
    "sendInput",
    "resumeAgent",
    "wait",
    "closeAgent",
    "started",
    "interacted",
    "interrupted",
  ].includes(String(event.action))
    ? event.action as AgentProcessEntry["action"]
    : undefined;
  const startedAt = typeof event.startedAt === "number" && Number.isFinite(event.startedAt)
    ? event.startedAt
    : undefined;
  const completedAt = typeof event.completedAt === "number" && Number.isFinite(event.completedAt)
    ? event.completedAt
    : undefined;
  const tool = ["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"].includes(String(event.tool))
    ? event.tool as AgentProcessEntry["tool"]
    : undefined;
  const activityKind = ["started", "interacted", "interrupted"].includes(String(event.activityKind))
    ? event.activityKind as AgentProcessEntry["activityKind"]
    : undefined;

  return {
    id: getString(event.id) || getString(event.itemId) || getString(event.toolCallId),
    type: "subagent",
    title: getString(event.title) || getFallbackTitle(event, state),
    detail,
    prompt,
    timestamp,
    state,
    expanded: false,
    stopReason: eventStopReason,
    subagents,
    phase,
    action,
    tool,
    activityKind,
    startedAt,
    completedAt,
  };
};
