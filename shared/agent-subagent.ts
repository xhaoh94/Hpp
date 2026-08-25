export type AgentSubagentModelMode = "inherit" | "custom";

export type AgentSubagentProfileConfig = {
  modelMode: AgentSubagentModelMode;
  model?: string;
};

export type AgentSubagentConfig = {
  enabled: boolean;
  defaultModelMode: AgentSubagentModelMode;
  defaultModel?: string;
  profiles: Record<string, AgentSubagentProfileConfig>;
};

export type AgentSubagentProfileDescriptor = {
  name: string;
  label?: string;
  description?: string;
};

export type AgentSubagentCapabilities = {
  configurable: boolean;
  modelSelection: "inherit" | "custom" | "inherit-or-custom";
  profiles?: AgentSubagentProfileDescriptor[];
};

export const DEFAULT_AGENT_SUBAGENT_CONFIG: AgentSubagentConfig = {
  enabled: true,
  defaultModelMode: "inherit",
  profiles: {},
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const normalizeModelMode = (value: unknown): AgentSubagentModelMode =>
  value === "custom" ? "custom" : "inherit";

export function normalizeAgentSubagentConfig(value: unknown): AgentSubagentConfig {
  const input = isRecord(value) ? value : {};
  const rawProfiles = isRecord(input.profiles) ? input.profiles : {};
  const profiles: Record<string, AgentSubagentProfileConfig> = {};
  for (const [name, rawValue] of Object.entries(rawProfiles)) {
    if (!/^[A-Za-z0-9._:-]+$/.test(name) || !isRecord(rawValue)) continue;
    const modelMode = normalizeModelMode(rawValue.modelMode);
    const model = nonEmptyString(rawValue.model);
    profiles[name] = {
      modelMode,
      ...(modelMode === "custom" && model ? { model } : {}),
    };
  }
  const defaultModelMode = normalizeModelMode(input.defaultModelMode);
  const defaultModel = nonEmptyString(input.defaultModel);
  return {
    enabled: input.enabled !== false,
    defaultModelMode,
    ...(defaultModelMode === "custom" && defaultModel ? { defaultModel } : {}),
    profiles,
  };
}

export function getAgentSubagentProfileConfig(
  config: AgentSubagentConfig,
  profileName: string,
): AgentSubagentProfileConfig | undefined {
  return config.profiles[profileName];
}

export function resolveAgentSubagentModel(
  config: AgentSubagentConfig,
  profileName: string,
  inheritedModel?: string,
): string | undefined {
  const profile = getAgentSubagentProfileConfig(config, profileName);
  if (profile?.modelMode === "custom" && profile.model) return profile.model;
  if (config.defaultModelMode === "custom" && config.defaultModel) return config.defaultModel;
  return inheritedModel;
}
