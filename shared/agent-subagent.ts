export type AgentSubagentPoolEntry = {
  /** `provider/modelId`，与 `--model` / message.model 的口径一致。 */
  model: string;
  /** 显示名；模型从渠道里删掉后仍能显示一个可读名字。 */
  label?: string;
};

export type AgentSubagentConfig = {
  enabled: boolean;
  /**
   * 模型池总开关。
   *
   * 关掉后所有 subagent 都跟随主 Agent 当前模型，池内容保留但不再参与派发；
   * 再打开即恢复。没有池的旧配置读出来也是 true，等于「可以走池，但池是空的」。
   */
  poolEnabled: boolean;
  /** 候选模型池。首项是派发方没指定模型时的起点。 */
  pool: AgentSubagentPoolEntry[];
};

export type AgentSubagentCapabilities = {
  configurable: boolean;
  modelSelection: "inherit" | "custom" | "inherit-or-custom";
  /** 后端支持模型池（派发时按池指定模型）时为 true。 */
  modelPool?: boolean;
};

export const MAX_AGENT_SUBAGENT_POOL_ENTRIES = 8;

export const DEFAULT_AGENT_SUBAGENT_CONFIG: AgentSubagentConfig = {
  enabled: true,
  poolEnabled: true,
  pool: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * 模型池归一化。
 *
 * 池子是「用户勾选的候选集」，不是自由文本：重复模型合并、超长/空值丢弃、
 * 上限 8 条（并行任务最多 8 个，再多也只是让模型挑花眼）。
 */
export function normalizeAgentSubagentPool(value: unknown): AgentSubagentPoolEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: AgentSubagentPoolEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const model = nonEmptyString(raw.model);
    if (!model || model.length > 200 || seen.has(model)) continue;
    seen.add(model);
    const label = nonEmptyString(raw.label)?.slice(0, 80);
    entries.push({
      model,
      ...(label ? { label } : {}),
    });
    if (entries.length >= MAX_AGENT_SUBAGENT_POOL_ENTRIES) break;
  }
  return entries;
}

export function normalizeAgentSubagentConfig(value: unknown): AgentSubagentConfig {
  const input = isRecord(value) ? value : {};
  return {
    enabled: input.enabled !== false,
    poolEnabled: input.poolEnabled !== false,
    pool: normalizeAgentSubagentPool(input.pool),
  };
}

/**
 * 子 Agent 的模型。
 *
 * 只有两种结果：走池子（派发方按难度在池内挑，没挑就用首项），或者跟随主 Agent。
 * 模型在派发时定一次、整个子任务不变——同一段上下文里换模型会让 prompt 缓存全废，
 * 也会让一个任务的产出无法归因到某个模型。
 */
export function resolveAgentSubagentModel(
  config: AgentSubagentConfig,
  inheritedModel?: string,
): string | undefined {
  if (config.poolEnabled !== false) {
    const start = config.pool?.[0]?.model;
    if (start) return start;
  }
  return inheritedModel;
}
