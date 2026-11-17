import type { ChatMessage } from "@/stores/chat-store";

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
  /** 模型 ID。 */
  name: string;
  /** 模型行下方的渠道标注；跨渠道合并时用「 · 」拼接。 */
  detail?: string;
  messageCount: number;
  /** 名称来自旧消息的 modelLabel 回退，而不是真实记录的模型 ID。 */
  inferred?: boolean;
}

export interface SessionTokenUsageSummary {
  totals: TokenUsageTotals;
  byModel: TokenUsageGroup[];
  /** 参与统计的回合数。 */
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

/** 紧凑计数：1.2k / 3.4M，完整数字放 title 里。 */
export const formatTokenCount = (count: number): string => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(count);
};

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
 * 只按模型 ID 分组，同名模型跨渠道合并成一行；旧消息没有记录模型 ID 时
 * 回退到 modelLabel，再没有就归入“未记录模型”。
 */
export function summarizeTokenUsage(
  messages: ReadonlyArray<TokenUsageMessage>,
): SessionTokenUsageSummary {
  const totals = createAccumulator();
  const models = new Map<string, {
    name: string;
    /** 该模型出现过的渠道，跨渠道合并后按首次出现顺序拼接。 */
    providers: Set<string>;
    /** 旧消息只有 modelLabel 时的可读名称。 */
    labels: Set<string>;
    inferred?: boolean;
    usage: TotalsAccumulator;
  }>();

  for (const message of messages) {
    const usage = getMessageUsage(message);
    if (!usage) continue;

    addUsage(totals, usage.input, usage.output, usage.cachedInput);

    const provider = message.modelProvider?.trim() || "";
    const recordedModelId = message.modelId?.trim() || "";
    const fallbackLabel = message.modelLabel?.trim() || "";
    const modelName = recordedModelId || fallbackLabel || UNKNOWN_TOKEN_MODEL;
    const model = models.get(modelName);
    if (model) {
      if (provider) model.providers.add(provider);
      addUsage(model.usage, usage.input, usage.output, usage.cachedInput);
    } else {
      const created = {
        name: modelName,
        providers: new Set(provider ? [provider] : []),
        labels: new Set(fallbackLabel && fallbackLabel !== modelName ? [fallbackLabel] : []),
        inferred: !recordedModelId || undefined,
        usage: createAccumulator(),
      };
      addUsage(created.usage, usage.input, usage.output, usage.cachedInput);
      models.set(modelName, created);
    }
  }

  const byModel = [...models.entries()]
    .map(([key, group]): TokenUsageGroup => ({
      key,
      name: group.name,
      detail: [...group.providers, ...group.labels].join(" · ") || undefined,
      inferred: group.inferred,
      ...toTotals(group.usage),
      messageCount: group.usage.messageCount,
    }))
    .sort(compareGroups);

  return {
    totals: toTotals(totals),
    byModel,
    messageCount: totals.messageCount,
  };
}
