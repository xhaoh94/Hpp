import type { ChatMessage } from "@/stores/chat-store";

export interface SessionStats {
  /** 有 token 记录的助手回合数。 */
  turns: number;
  /** 工具调用次数（过程条目里的 tool）。 */
  steps: number;
  /** 模型实际工作总时长（各回合 startedAt → endedAt 之和）。 */
  modelMs: number;
  /** 工具调用总耗时（条目 startedAt → completedAt 之和）。 */
  toolMs: number;
  outputTokens: number;
  /** 输出速度：输出 token / 模型工作秒数；没有时长时为空。 */
  tokensPerSecond?: number;
}

/**
 * 会话统计：轮次、工具步数、模型/工具耗时、输出速度。
 * 时长都来自过程条目的时间戳，老消息没记录就按 0 计（宁可少算，不编造）。
 */
export function summarizeSessionStats(messages: ChatMessage[], now = Date.now()): SessionStats {
  let turns = 0;
  let steps = 0;
  let modelMs = 0;
  let toolMs = 0;
  let outputTokens = 0;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (message.tokenUsage) {
      turns += 1;
      outputTokens += message.tokenUsage.output || 0;
    }
    const process = message.process;
    if (!process) continue;
    const startedAt = process.startedAt;
    if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
      const endedAt = typeof process.endedAt === "number" && process.endedAt > startedAt
        ? process.endedAt
        : message.isStreaming ? now : startedAt;
      modelMs += Math.max(0, endedAt - startedAt);
    }
    for (const entry of process.entries) {
      if (entry.type !== "tool") continue;
      steps += 1;
      const from = entry.startedAt;
      const to = entry.completedAt;
      if (typeof from === "number" && typeof to === "number" && to > from) toolMs += to - from;
    }
  }

  const seconds = modelMs / 1000;
  return {
    turns,
    steps,
    modelMs,
    toolMs,
    outputTokens,
    ...(seconds > 0 && outputTokens > 0 ? { tokensPerSecond: Math.round(outputTokens / seconds) } : {}),
  };
}

/** 17分27秒 / 1小时2分 / 43秒；不足 1 秒按 1 秒算。 */
export const formatSessionDuration = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${Math.max(totalSeconds, ms > 0 ? 1 : 0)}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}分${totalSeconds % 60}秒`;
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
};

/** 状态条上的紧凑摘要：`4 轮 147 步 · 193 token/s`。 */
export const formatSessionStatsSummary = (stats: SessionStats): string => {
  const rounds = [
    stats.turns > 0 ? `${stats.turns} 轮` : "",
    stats.steps > 0 ? `${stats.steps} 步` : "",
  ].filter(Boolean).join(" ");
  return [rounds, stats.tokensPerSecond ? `${stats.tokensPerSecond} token/s` : ""].filter(Boolean).join(" · ");
};
