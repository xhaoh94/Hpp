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
export type AgentCompactionModelMode = "current" | "custom";
export type AgentCompactionApi = "openai-completions" | "openai-responses";

export interface AgentCompactionCustomModel {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  api: AgentCompactionApi;
  reasoning: boolean;
}

export interface AgentCompactionConfig {
  thinkingLevel: AgentCompactionThinkingLevel;
  modelMode: AgentCompactionModelMode;
  customModel: AgentCompactionCustomModel;
}

export type AgentCompactionConfigByAgent = Record<string, AgentCompactionConfig>;

export const DEFAULT_AGENT_COMPACTION_CONFIG: AgentCompactionConfig = {
  thinkingLevel: "low",
  modelMode: "current",
  customModel: {
    baseUrl: "",
    apiKey: "",
    modelId: "",
    api: "openai-completions",
    reasoning: false,
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const normalizeString = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function normalizeAgentCompactionConfig(value: unknown): AgentCompactionConfig {
  const record = isRecord(value) ? value : {};
  const customModel = isRecord(record.customModel) ? record.customModel : {};
  const thinkingLevel = AGENT_COMPACTION_THINKING_LEVELS.includes(record.thinkingLevel as AgentCompactionThinkingLevel)
    ? record.thinkingLevel as AgentCompactionThinkingLevel
    : DEFAULT_AGENT_COMPACTION_CONFIG.thinkingLevel;

  return {
    thinkingLevel,
    modelMode: record.modelMode === "custom" ? "custom" : "current",
    customModel: {
      baseUrl: normalizeString(customModel.baseUrl),
      apiKey: normalizeString(customModel.apiKey),
      modelId: normalizeString(customModel.modelId),
      api: customModel.api === "openai-responses" ? "openai-responses" : "openai-completions",
      reasoning: customModel.reasoning === true,
    },
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

export function isCustomAgentCompactionModelConfigured(config: AgentCompactionConfig): boolean {
  return config.modelMode === "custom"
    && !!config.customModel.baseUrl
    && !!config.customModel.modelId;
}
