import type { AgentSubagent, ChatMessage } from "@/stores/chat-store";
import {
  getEffectiveProcessSubagents,
  type ProcessSubagentStopReason,
  type ProcessSubagentUsage,
} from "@shared/process-view";

export type MonitoredSubagent = AgentSubagent & {
  messageId: string;
  entryId: string;
};

const isActiveStatus = (subagent: AgentSubagent) =>
  subagent.status === "running" || subagent.status === "pending";

/**
 * 收集当前会话里仍在运行的子任务。同一子任务会随进度反复更新，
 * 以最后出现的进程条目为准（Map 覆盖即最新）。
 */
export const collectSubagents = (messages: ChatMessage[]): MonitoredSubagent[] => {
  const byId = new Map<string, MonitoredSubagent>();
  for (const message of messages) {
    const entries = message.process?.entries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      // 收进残留的占位项，就是永远收不到终态、永远空输出的那个页签。
      for (const subagent of getEffectiveProcessSubagents(entry.subagents, entry.state)) {
        byId.set(subagent.id, { ...subagent, messageId: message.id, entryId: entry.id });
      }
    }
  }
  return [...byId.values()];
};

export const collectRunningSubagents = (messages: ChatMessage[]): MonitoredSubagent[] => (
  collectSubagents(messages).filter(isActiveStatus)
);

export type SubagentModelCost = {
  model: string;
  tasks: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cost: number;
};

/**
 * 按模型汇总本会话子任务的消耗。后台派发常跨模型，用户需要一眼看出
 * 「挑了哪个模型、花了多少」，而不是逐个任务点开算。
 */
export const summarizeSubagentCosts = (subagents: MonitoredSubagent[]): SubagentModelCost[] => {
  const byModel = new Map<string, SubagentModelCost>();
  for (const subagent of subagents) {
    if (!subagent.usage) continue;
    const model = subagent.model?.trim() || "未知模型";
    const entry = byModel.get(model) || {
      model,
      tasks: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      cost: 0,
    };
    entry.tasks += 1;
    entry.inputTokens += subagent.usage.inputTokens ?? 0;
    entry.cacheReadTokens += subagent.usage.cacheReadTokens ?? 0;
    entry.outputTokens += subagent.usage.outputTokens ?? 0;
    entry.cost += subagent.usage.cost ?? 0;
    byModel.set(model, entry);
  }
  return [...byModel.values()].sort((left, right) => right.cost - left.cost || right.tasks - left.tasks);
};

export const formatSubagentCost = (cost: number): string => {
  if (!Number.isFinite(cost) || cost <= 0) return "";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
};

/** 紧凑计数：1.2k / 3.4M。 */
export const formatSubagentTokenCount = (value?: number): string => {
  if (!value || value <= 0) return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
};

/** 缓存命中率 = 缓存读 / 输入；没有输入数据时返回 undefined。 */
export const getSubagentCacheRate = (usage?: ProcessSubagentUsage): number | undefined => {
  const input = usage?.inputTokens;
  const cached = usage?.cacheReadTokens;
  if (!input || input <= 0 || !cached) return undefined;
  return Math.max(0, Math.min(cached, input)) / input;
};

/**
 * 一级卡片的模型名，原样放进 token 那行文本。
 * 后端 model 通常已是 `provider/modelId`（见 subagent-extension 的 getModelName），
 * 这里只做 trim，不加方括号 / 胶囊；老数据没有渠道也不编造。
 */
export const formatSubagentModel = (model?: string): string => model?.trim() || "";

/**
 * 子任务消耗摘要：`12.3k token · 缓存 87% · 3 轮`。
 * 没有 totalTokens 的后端（pi 只报 input/output）自己加一下，否则只会显示轮次。
 */
export const formatSubagentUsage = (usage?: ProcessSubagentUsage): string => {
  if (!usage) return "";
  const total = usage.totalTokens
    ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) || undefined);
  const tokens = formatSubagentTokenCount(total);
  const rate = getSubagentCacheRate(usage);
  return [
    tokens ? `${tokens} token` : "",
    rate !== undefined ? `缓存 ${Math.round(rate * 100)}%` : "",
    usage.turns ? `${usage.turns} 轮` : "",
  ].filter(Boolean).join(" · ");
};

/** 单个子任务的已运行时长；没有 startedAt 时返回 undefined（老后端）。 */
export const getSubagentElapsedMs = (subagent: AgentSubagent, now: number): number | undefined => {
  if (!subagent.startedAt) return undefined;
  return Math.max(0, (subagent.completedAt ?? now) - subagent.startedAt);
};

const SUBAGENT_STATUS_TEXT: Record<string, string> = {
  pending: "等待中",
  running: "工作中",
  completed: "已完成",
  error: "失败",
  interrupted: "已中断",
};

/** 状态文案：超时优先于状态本身，否则「失败」会把超时说成普通报错。 */
export const formatSubagentStatusLabel = (
  status?: AgentSubagent["status"],
  stopReason?: ProcessSubagentStopReason,
): string => {
  if (stopReason === "timeout") return "已超时";
  return (status && SUBAGENT_STATUS_TEXT[status]) || "";
};

/** 距最后一次活动多久没更新。 */
export const getSubagentIdleMs = (subagent: AgentSubagent, now: number): number | undefined => {
  const last = subagent.lastActivityAt || subagent.startedAt;
  return last ? Math.max(0, now - last) : undefined;
};

/** 超过这个时长没有任何活动就按"可能卡住"提示，别再让用户以为它在正常跑。 */
export const SUBAGENT_STALL_MS = 2 * 60 * 1000;
/** 后台任务更宽松：长推理和大文件读取期间可能很久没有新事件。 */
export const BACKGROUND_SUBAGENT_STALL_MS = 10 * 60 * 1000;

export const isSubagentStalled = (subagent: AgentSubagent, now: number): boolean => {
  if (subagent.status !== "running") return false;
  const idle = getSubagentIdleMs(subagent, now);
  const threshold = subagent.background ? BACKGROUND_SUBAGENT_STALL_MS : SUBAGENT_STALL_MS;
  return idle !== undefined && idle >= threshold;
};

export const formatIdleAgo = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
};
