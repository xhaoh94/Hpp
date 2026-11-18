import type { ProcessEntryView } from "@shared/process-view";
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
  /** 其中来自子 Agent 的部分（已计入 totals 与 byModel，单独留一份用于标注）。 */
  subagentTotals: TokenUsageTotals;
  /** 有用量记录的子任务个数。 */
  subagentCount: number;
}

type TokenUsageMessage = Pick<
  ChatMessage,
  "role" | "tokenUsage" | "modelProvider" | "modelId" | "modelLabel" | "process"
>;

type SubagentUsageView = NonNullable<ProcessEntryView["subagents"]>[number];

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
  /** 子 Agent 的用量不是「回合」，只累加数字、不占回合数。 */
  countsAsTurn = true,
) => {
  totals.input += input;
  totals.output += output;
  totals.cachedInput += cachedInput;
  totals.total += input + output;
  if (countsAsTurn) totals.messageCount += 1;
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
 * 收集子任务用量。
 *
 * 子 Agent 跑在独立进程里，它的 token 不会进主会话的 assistant 消息，只挂在
 * 过程条目的 subagents[].usage 上——不单独捞一遍，这部分消耗就是隐形的。
 *
 * 同一个子任务的 usage 是**累计值**、会随进度反复入账，所以按 id 只保留最后
 * 一份；直接求和会把同一批 token 加很多遍。
 */
const collectSubagentUsages = (messages: ReadonlyArray<TokenUsageMessage>): SubagentUsageView[] => {
  const byId = new Map<string, SubagentUsageView>();
  let anonymous = 0;
  for (const message of messages) {
    for (const entry of message.process?.entries ?? []) {
      for (const subagent of entry.subagents ?? []) {
        if (!subagent?.usage) continue;
        const id = subagent.id?.trim() || `#${anonymous++}`;
        byId.set(id, subagent);
      }
    }
  }
  return [...byId.values()];
};

/** 子任务的 model 是 `provider/modelId`；模型 id 本身可能带 `/`，只切第一段。 */
const splitSubagentModel = (value?: string) => {
  const raw = value?.trim() || "";
  const index = raw.indexOf("/");
  if (index <= 0) return { modelId: raw, provider: "" };
  return { provider: raw.slice(0, index), modelId: raw.slice(index + 1) };
};

const getSubagentUsage = (subagent: SubagentUsageView) => {
  const usage = subagent.usage;
  if (!usage) return null;
  const input = Math.max(0, Number(usage.inputTokens) || 0);
  const output = Math.max(0, Number(usage.outputTokens) || 0);
  if (input === 0 && output === 0) return null;
  const cachedInput = Math.min(input, Math.max(0, Number(usage.cacheReadTokens) || 0));
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

  // 子 Agent 的消耗单独算一遍再并入：它们跑在独立进程里，从来没有 assistant
  // 消息承载用量，不补这一步，换了模型的子任务就用「查无此账」的方式消失。
  const subagentTotals = createAccumulator();
  let subagentCount = 0;
  for (const subagent of collectSubagentUsages(messages)) {
    const usage = getSubagentUsage(subagent);
    if (!usage) continue;
    subagentCount += 1;
    addUsage(subagentTotals, usage.input, usage.output, usage.cachedInput, false);
    addUsage(totals, usage.input, usage.output, usage.cachedInput, false);

    const { modelId, provider } = splitSubagentModel(subagent.model);
    const modelName = modelId || UNKNOWN_TOKEN_MODEL;
    const model = models.get(modelName);
    if (model) {
      if (provider) model.providers.add(provider);
      addUsage(model.usage, usage.input, usage.output, usage.cachedInput);
    } else {
      const created = {
        name: modelName,
        providers: new Set(provider ? [provider] : []),
        labels: new Set<string>(),
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
    subagentTotals: toTotals(subagentTotals),
    subagentCount,
    byModel,
    messageCount: totals.messageCount,
  };
}
