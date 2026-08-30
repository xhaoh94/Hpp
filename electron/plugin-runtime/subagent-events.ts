import type { UnknownRecord } from "../../src/types/ipc";

export type NativeSubagentStatus = "pending" | "running" | "completed" | "error" | "interrupted";
export type NativeSubagentStopReason = "timeout" | "aborted" | "cancelled" | "error";
export type NativeSubagentAction = "spawnAgent" | "resumeAgent";

export interface NativeSubagentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  turns?: number;
}

export interface NativeSubagentSnapshot {
  toolCallId: string;
  subagentId: string;
  label: string;
  status: NativeSubagentStatus;
  action: NativeSubagentAction;
  model?: string;
  detail?: string;
  prompt?: string;
  message?: string;
  stopReason?: NativeSubagentStopReason;
  startedAt?: number;
  background?: boolean;
  usage?: NativeSubagentUsage;
}

const SUBAGENT_TOOL_NAMES = new Set([
  "agent",
  "delegate",
  "delegate_agent",
  "delegate_task",
  "run_agent",
  "run_subagent",
  "spawn_agent",
  "spawn_subagent",
  "spawnagent",
  "subagent",
  "task",
]);

export function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getFirstNonEmptyString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = getNonEmptyString(record[key]);
    if (value) return value;
  }
  return undefined;
}

export function isNativeSubagentToolName(value: unknown): boolean {
  const name = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return SUBAGENT_TOOL_NAMES.has(name);
}

export function humanizeSubagentLabel(value: string): string {
  const label = value.replace(/^agent[-_:]?/i, "").replace(/[_-]+/g, " ").trim();
  return label ? `${label.charAt(0).toUpperCase()}${label.slice(1)}` : "Subagent";
}

export function formatSubagentModel(value: unknown): string | undefined {
  const direct = getNonEmptyString(value);
  if (direct) return direct;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const model = value as UnknownRecord;
  const provider = getFirstNonEmptyString(model, ["providerID", "providerId", "provider", "modelProvider"]);
  const modelId = getFirstNonEmptyString(model, ["modelID", "modelId", "id", "name"]);
  if (provider && modelId) return `${provider}/${modelId}`;
  return modelId || provider;
}

export function normalizeNativeSubagentStopReason(value: unknown): NativeSubagentStopReason | undefined {
  const reason = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["timeout", "timed_out", "time_limit", "deadline_exceeded"].includes(reason)) return "timeout";
  if (["aborted", "abort", "cancelled", "canceled", "cancel", "interrupted"].includes(reason)) return "aborted";
  if (["error", "failed", "failure", "exception"].includes(reason)) return "error";
  return undefined;
}

export function normalizeNativeSubagentStatus(value: unknown): NativeSubagentStatus | undefined {
  const status = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["pending", "queued", "not_started", "starting"].includes(status)) return "pending";
  if (["running", "active", "working", "in_progress", "inprogress", "executing", "started"].includes(status)) return "running";
  if (["completed", "complete", "done", "success", "succeeded", "finished", "idle"].includes(status)) return "completed";
  if (["error", "failed", "failure", "errored"].includes(status)) return "error";
  if (["interrupted", "cancelled", "canceled", "stopped", "aborted", "shutdown"].includes(status)) return "interrupted";
  return undefined;
}

export function isTerminalNativeSubagentStatus(status: NativeSubagentStatus): boolean {
  return status === "completed" || status === "error" || status === "interrupted";
}

export function getSubagentTitle(snapshot: Pick<NativeSubagentSnapshot, "status" | "action" | "stopReason">): string {
  if (snapshot.stopReason === "timeout") return "已超时";
  if (snapshot.status === "error") return "工作失败";
  if (snapshot.status === "interrupted") return "已中断";
  return snapshot.action === "resumeAgent" ? "已继续工作" : "已开始工作";
}

export function buildNativeSubagentEvent(
  snapshot: NativeSubagentSnapshot,
  source: string,
  completedAt?: number,
): UnknownRecord {
  const terminal = isTerminalNativeSubagentStatus(snapshot.status);
  return {
    type: "subagent_event",
    id: snapshot.toolCallId,
    toolCallId: snapshot.toolCallId,
    phase: terminal ? "completed" : "started",
    action: snapshot.action,
    tool: snapshot.action,
    title: getSubagentTitle(snapshot),
    detail: snapshot.detail,
    stopReason: snapshot.stopReason,
    prompt: snapshot.prompt,
    state: snapshot.status === "pending" || snapshot.status === "running" ? "running" : snapshot.status,
    subagents: [{
      id: snapshot.subagentId,
      label: snapshot.label,
      status: snapshot.status,
      model: snapshot.model,
      message: snapshot.message,
      prompt: snapshot.prompt,
      stopReason: snapshot.stopReason,
      ...(snapshot.usage ? { usage: snapshot.usage } : {}),
    }],
    timestamp: snapshot.startedAt,
    startedAt: snapshot.startedAt,
    completedAt: terminal ? completedAt : undefined,
    ...(snapshot.background === true ? { background: true } : {}),
    agentThreadId: snapshot.subagentId,
    receiverThreadIds: [snapshot.subagentId],
    source,
  };
}
