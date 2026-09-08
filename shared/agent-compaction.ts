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
  enabled: boolean;
  thinkingLevel: AgentCompactionThinkingLevel;
  modelMode: AgentCompactionModelMode;
  /**
   * 从已配置渠道选择的压缩模型，格式 `providerId/modelId`（与 SubAgent 一致）。
   * 仅 modelMode === "custom" 时有意义；渠道被删除导致解析失败时回退当前模型。
   */
  model?: string;
  customModel: AgentCompactionCustomModel;
}

export type AgentCompactionConfigByAgent = Record<string, AgentCompactionConfig>;

export const DEFAULT_AGENT_COMPACTION_CONFIG: AgentCompactionConfig = {
  enabled: true,
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

  const modelMode = record.modelMode === "custom" ? "custom" : "current";
  const model = typeof record.model === "string" ? record.model.trim() : "";

  return {
    // 存量配置没有 enabled 字段，缺省视为启用（!== false 而非 === true）。
    enabled: record.enabled !== false,
    thinkingLevel,
    modelMode,
    ...(modelMode === "custom" && model ? { model } : {}),
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

/** 拆分 `providerId/modelId` 形式的渠道模型引用（SubAgent 使用同一格式）。 */
export function parseAgentCompactionModelRef(value: unknown): { provider: string; modelId: string } | undefined {
  const ref = typeof value === "string" ? value.trim() : "";
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) return undefined;
  return { provider: ref.slice(0, separator), modelId: ref.slice(separator + 1) };
}

export function isCustomAgentCompactionModelConfigured(config: AgentCompactionConfig): boolean {
  if (config.modelMode !== "custom") return false;
  // 渠道模型引用（新）或手工填写的 OpenAI 兼容模型（旧，opencode/droid 仍走这条）。
  // 残缺的引用（没有 provider/ 分隔符）不算已配置。
  return !!parseAgentCompactionModelRef(config.model)
    || (!!config.customModel.baseUrl && !!config.customModel.modelId);
}
