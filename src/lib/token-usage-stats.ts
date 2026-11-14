import type { ChatMessage } from "@/stores/chat-store";

export const UNKNOWN_TOKEN_CHANNEL = "未记录渠道";
export const UNKNOWN_TOKEN_MODEL = "未记录模型";

/** 一条消息或一组消息的 token 累计值。input 为总输入，cachedInput 是其中命中缓存的部分。 */
export interface TokenUsageTotals {
  input: number;
  output: number;
  cachedInput: number;
  /** input + output */
  total: number;
}

export interface TokenUsageGroup extends TokenUsageTotals {
  key: string;
  /** 渠道 ID 或模型 ID。 */
  name: string;
  /** 模型组的渠道；渠道组为空。 */
  detail?: string;
  messageCount: number;
  /** 名称来自旧消息的 modelLabel 回退，而不是真实记录的模型 ID。 */
  inferred?: boolean;
}

export interface SessionTokenUsageSummary {
  totals: TokenUsageTotals;
  byChannel: TokenUsageGroup[];
  byModel: TokenUsageGroup[];
  /** 参与统计的助手回合数。 */
  messageCount: number;
}

type TokenUsageMessage = Pick<
  ChatMessage,
  "role" | "tokenUsage" | "modelProvider" | "modelId" | "modelLabel"
>;

type TotalsAccumulator = TokenUsageTotals & { messageCount: number };

const createAccumulator = (): TotalsAccumulator => ({
  input: 0,
  output: 0,
  cachedInput: 0,
  total: 0,
  messageCount: 0,
});

const addUsage = (
  totals: TotalsAccumulator,
  input: number,
  output: number,
  cachedInput: number,
) => {
  totals.input += input;
  totals.output += output;
  totals.cachedInput += cachedInput;
  totals.total += input + output;
  totals.messageCount += 1;
};

const toTotals = (totals: TotalsAccumulator): TokenUsageTotals => ({
  input: totals.input,
  output: totals.output,
  cachedInput: totals.cachedInput,
  total: totals.total,
});

/** 缓存率 = 输入中命中缓存的部分 / 总输入；没有输入时返回 undefined。 */
export const getTokenCacheRate = (
  totals: Pick<TokenUsageTotals, "input" | "cachedInput">,
): number | undefined => {
  if (!Number.isFinite(totals.input) || totals.input <= 0) return undefined;
  const cached = Math.max(0, Math.min(totals.cachedInput, totals.input));
  return cached / totals.input;
};

export const formatTokenCacheRate = (rate: number | undefined): string => (
  rate === undefined ? "—" : `${(rate * 100).toFixed(1)}%`
);

const compareGroups = (left: TokenUsageGroup, right: TokenUsageGroup) => (
  right.total - left.total || left.name.localeCompare(right.name)
);

const getMessageUsage = (message: TokenUsageMessage) => {
  if (message.role !== "assistant" || !message.tokenUsage) return null;
  const input = Math.max(0, Number(message.tokenUsage.input) || 0);
  const output = Math.max(0, Number(message.tokenUsage.output) || 0);
  if (input === 0 && output === 0) return null;
  const cachedInput = Math.min(input, Math.max(0, Number(message.tokenUsage.cacheInput) || 0));
  return { input, output, cachedInput };
};

/**
 * 汇总当前会话的 token 消耗。
 *
 * 渠道按消息上的 modelProvider 分组；模型按 provider + 模型 ID 复合分组，
 * 避免不同渠道下的同名模型被误合并。旧消息没有记录这两项时，模型名回退
 * 到 modelLabel，并归入“未记录渠道 / 未记录模型”。
 */
export function summarizeTokenUsage(
  messages: ReadonlyArray<TokenUsageMessage>,
): SessionTokenUsageSummary {
  const totals = createAccumulator();
  const channels = new Map<string, { name: string; usage: TotalsAccumulator }>();
  const models = new Map<string, {
    name: string;
    detail?: string;
    inferred?: boolean;
    usage: TotalsAccumulator;
  }>();

  for (const message of messages) {
    const usage = getMessageUsage(message);
    if (!usage) continue;

    addUsage(totals, usage.input, usage.output, usage.cachedInput);

    const provider = message.modelProvider?.trim() || "";
    const channelName = provider || UNKNOWN_TOKEN_CHANNEL;
    const channel = channels.get(channelName);
    if (channel) {
      addUsage(channel.usage, usage.input, usage.output, usage.cachedInput);
    } else {
      const created = { name: channelName, usage: createAccumulator() };
      addUsage(created.usage, usage.input, usage.output, usage.cachedInput);
      channels.set(channelName, created);
    }

    const recordedModelId = message.modelId?.trim() || "";
    const fallbackLabel = message.modelLabel?.trim() || "";
    const modelName = recordedModelId || fallbackLabel || UNKNOWN_TOKEN_MODEL;
    const modelKey = `${channelName}\u0000${modelName}`;
    const model = models.get(modelKey);
    if (model) {
      addUsage(model.usage, usage.input, usage.output, usage.cachedInput);
    } else {
      const created = {
        name: modelName,
        // 模型行同时标出渠道与友好名称，便于区分同一模型 ID 的不同接入方式。
        detail: [provider, fallbackLabel && fallbackLabel !== modelName ? fallbackLabel : ""]
          .filter(Boolean)
          .join(" · ") || undefined,
        inferred: !recordedModelId || undefined,
        usage: createAccumulator(),
      };
      addUsage(created.usage, usage.input, usage.output, usage.cachedInput);
      models.set(modelKey, created);
    }
  }

  const byChannel = [...channels.entries()]
    .map(([key, group]): TokenUsageGroup => ({
      key,
      name: group.name,
      ...toTotals(group.usage),
      messageCount: group.usage.messageCount,
    }))
    .sort(compareGroups);

  const byModel = [...models.entries()]
    .map(([key, group]): TokenUsageGroup => ({
      key,
      name: group.name,
      detail: group.detail,
      inferred: group.inferred,
      ...toTotals(group.usage),
      messageCount: group.usage.messageCount,
    }))
    .sort(compareGroups);

  return {
    totals: toTotals(totals),
    byChannel,
    byModel,
    messageCount: totals.messageCount,
  };
}
