export const AGENT_COMPACTION_THINKING_LEVELS = [
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AgentCompactionThinkingLevel = typeof AGENT_COMPACTION_THINKING_LEVELS[number];

/**
 * 压缩策略。模型不可配置：压缩一律走 Agent 自己的模型与流程，
 * 旧配置里的 `modelMode` / `model` 直接忽略。
 */
export interface AgentCompactionConfig {
  enabled: boolean;
  thinkingLevel: AgentCompactionThinkingLevel;
}

export type AgentCompactionConfigByAgent = Record<string, AgentCompactionConfig>;

export const DEFAULT_AGENT_COMPACTION_CONFIG: AgentCompactionConfig = {
  enabled: true,
  thinkingLevel: "low",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function normalizeAgentCompactionConfig(value: unknown): AgentCompactionConfig {
  const record = isRecord(value) ? value : {};
  const thinkingLevel = AGENT_COMPACTION_THINKING_LEVELS.includes(record.thinkingLevel as AgentCompactionThinkingLevel)
    ? record.thinkingLevel as AgentCompactionThinkingLevel
    : DEFAULT_AGENT_COMPACTION_CONFIG.thinkingLevel;

  return {
    // 存量配置没有 enabled 字段，缺省视为启用（!== false 而非 === true）。
    enabled: record.enabled !== false,
    thinkingLevel,
  };
}

export function normalizeAgentCompactionConfigByAgent(value: unknown): AgentCompactionConfigByAgent {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([agentId, config]) => {
    const normalizedAgentId = agentId.trim();
    return normalizedAgentId ? [[normalizedAgentId, normalizeAgentCompactionConfig(config)]] : [];
  }));
}

export function resolveStoredAgentCompactionConfig(
  agentId: string,
  byAgentValue: unknown,
  legacyValue?: unknown,
): AgentCompactionConfig | undefined {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) return undefined;
  const byAgent = isRecord(byAgentValue) ? byAgentValue : {};
  if (Object.prototype.hasOwnProperty.call(byAgent, normalizedAgentId)) {
    return normalizeAgentCompactionConfig(byAgent[normalizedAgentId]);
  }
  return legacyValue === undefined ? undefined : normalizeAgentCompactionConfig(legacyValue);
}

export function setStoredAgentCompactionConfig(
  byAgentValue: unknown,
  agentId: string,
  config: AgentCompactionConfig,
): AgentCompactionConfigByAgent {
  const normalizedAgentId = agentId.trim();
  const current = normalizeAgentCompactionConfigByAgent(byAgentValue);
  if (!normalizedAgentId) return current;
  return {
    ...current,
    [normalizedAgentId]: normalizeAgentCompactionConfig(config),
  };
}
