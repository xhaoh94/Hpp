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
  /** 允许 subagent 工具用 background:true 立即返回。 */
  backgroundEnabled: boolean;
  /** 同步与后台任务共享的并发上限。 */
  maxConcurrency: number;
  /** P2b：主 Agent 空闲时，后台结果自动唤醒并开新回合。 */
  autoWakeOnResult: boolean;
  /** 合并唤醒窗口：窗口内完成的任务合并成一条通知。 */
  autoWakeDebounceMs: number;
  /** 没有用户输入时，连续自动唤醒的上限。 */
  maxAutoWakeTurns: number;
  /** 后台任务的默认超时；同步任务默认不设超时（0 = 不限）。 */
  backgroundTimeoutMs: number;
};

export const MAX_AGENT_SUBAGENT_CONCURRENCY = 8;
export const MAX_AGENT_SUBAGENT_BACKGROUND_TIMEOUT_MS = 2 * 60 * 60 * 1000;

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
  backgroundEnabled: true,
  maxConcurrency: 4,
  autoWakeOnResult: true,
  autoWakeDebounceMs: 3000,
  maxAutoWakeTurns: 3,
  backgroundTimeoutMs: MAX_AGENT_SUBAGENT_BACKGROUND_TIMEOUT_MS,
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

const clampInteger = (value: unknown, min: number, max: number, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
};

export function normalizeAgentSubagentConfig(value: unknown): AgentSubagentConfig {
  const input = isRecord(value) ? value : {};
  return {
    enabled: input.enabled !== false,
    poolEnabled: input.poolEnabled !== false,
    pool: normalizeAgentSubagentPool(input.pool),
    backgroundEnabled: input.backgroundEnabled !== false,
    maxConcurrency: clampInteger(input.maxConcurrency, 1, MAX_AGENT_SUBAGENT_CONCURRENCY, 4),
    autoWakeOnResult: input.autoWakeOnResult !== false,
    autoWakeDebounceMs: clampInteger(input.autoWakeDebounceMs, 500, 60_000, 3000),
    maxAutoWakeTurns: clampInteger(input.maxAutoWakeTurns, 1, 10, 3),
    backgroundTimeoutMs: clampInteger(
      input.backgroundTimeoutMs,
      60_000,
      MAX_AGENT_SUBAGENT_BACKGROUND_TIMEOUT_MS,
      MAX_AGENT_SUBAGENT_BACKGROUND_TIMEOUT_MS,
    ),
  };
}

/**
 * 子 Agent 的模型。
 *
 * 只有两种结果：走池子（默认首项；只有视觉/长窗口/交叉审查等明确理由才单独指定），
 * 或者跟随主 Agent。
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
