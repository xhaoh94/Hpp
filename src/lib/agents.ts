import type { AgentDescriptor, AgentPlanModeSupport } from "@/types";

const nativeCaps = (planMode: AgentPlanModeSupport, guidance = false, fork = false) => ({
  planMode,
  guidance,
  fork,
  configuration: "openai-compatible" as const,
  providerActivation: "none" as const,
});

export const FALLBACK_AGENTS: AgentDescriptor[] = [
  {
    id: "codex",
    name: "Codex",
    desc: "OpenAI Codex CLI 编程助手",
    description: "OpenAI Codex CLI 编程助手",
    version: "seeded",
    runtime: "cli",
    command: "codex",
    packageName: "@openai/codex",
    capabilities: { ...nativeCaps("native", true, true), providerActivation: "single-active" },
    source: "plugin",
    removable: true,
    installHint: "npm install -g @openai/codex",
    updateCommand: "npm install -g @openai/codex@latest",
    shortName: "CX",
  },
  {
    id: "pi",
    name: "Pi",
    desc: "AI 编程助手",
    description: "AI 编程助手",
    version: "seeded",
    runtime: "sdk",
    packageName: "@earendil-works/pi-coding-agent",
    capabilities: nativeCaps("prompt", true, true),
    source: "plugin",
    removable: true,
    installHint: "在通用设置中更新 Pi SDK，或运行 npm install @earendil-works/pi-coding-agent@latest",
    updateCommand: "npm install @earendil-works/pi-coding-agent@latest",
    shortName: "PI",
  },
  {
    id: "opencode",
    name: "OpenCode",
    desc: "开源 AI 编程助手",
    description: "开源 AI 编程助手",
    version: "seeded",
    runtime: "cli",
    command: "opencode",
    packageName: "opencode-ai",
    capabilities: nativeCaps("native"),
    source: "plugin",
    removable: true,
    installHint: "npm install -g opencode-ai",
    updateCommand: "npm install -g opencode-ai@latest",
    shortName: "OC",
  },
  {
    id: "droid",
    name: "Factory Droid",
    desc: "Factory AI 编程助手",
    description: "Factory AI 编程助手",
    version: "seeded",
    runtime: "cli",
    command: "droid",
    packageName: "droid",
    capabilities: nativeCaps("native"),
    source: "plugin",
    removable: true,
    installHint: "npm install -g droid",
    updateCommand: "npm install -g droid@latest",
    shortName: "FD",
  },
];

let agentCatalog: AgentDescriptor[] = [];

export function normalizeAgentDisplayName<T extends { id: string; name: string }>(agent: T): T {
  return agent.id === "pi" && agent.name !== "Pi"
    ? { ...agent, name: "Pi" }
    : agent;
}

export function setAgentCatalog(agents: AgentDescriptor[]) {
  agentCatalog = agents.map(normalizeAgentDisplayName);
}

export function getAvailableAgents(): AgentDescriptor[] {
  return agentCatalog;
}

export function getAgentById(id: string): AgentDescriptor | undefined {
  return agentCatalog.find((agent) => agent.id === id) || FALLBACK_AGENTS.find((agent) => agent.id === id);
}

export function getAgentName(id: string): string {
  return getAgentById(id)?.name || id;
}

export function supportsNativePlanMode(id: string): boolean {
  return getAgentById(id)?.capabilities.planMode === "native";
}

export function supportsGuidance(id: string): boolean {
  return getAgentById(id)?.capabilities.guidance === true;
}

export function requiresProviderActivation(id: string): boolean {
  return getAgentById(id)?.capabilities.providerActivation === "single-active";
}

export function getAgentPlanModeTooltip(id: string): string {
  if (supportsNativePlanMode(id)) return "支持原生 Plan 模式";
  return "当前 Agent 不支持原生 Plan 模式，将通过提示词要求先规划并等待确认";
}

export function getInstallHint(agentOrCommand: AgentDescriptor | string): string {
  if (typeof agentOrCommand !== "string") {
    return agentOrCommand.installHint || (agentOrCommand.command ? `请安装 ${agentOrCommand.command}` : "请检查插件安装状态");
  }

  switch (agentOrCommand) {
    case "codex": return "npm install -g @openai/codex";
    case "pi": return "在通用设置中更新 Pi SDK，或运行 npm install @earendil-works/pi-coding-agent@latest";
    case "opencode": return "npm install -g opencode-ai";
    case "droid": return "npm install -g droid";
    default: return `请安装 ${agentOrCommand}`;
  }
}

export function getAgentUpdateCommand(agentId: string): string | null {
  return getAgentById(agentId)?.updateCommand || null;
}

export function normalizeAgentOrder(order?: string[], agents: AgentDescriptor[] = agentCatalog): string[] {
  const knownIds = new Set(agents.map((agent) => agent.id));
  const normalized = (Array.isArray(order) ? order : [])
    .filter((id) => knownIds.has(id));
  const seen = new Set<string>();
  const unique = normalized.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return [
    ...unique,
    ...agents.map((agent) => agent.id).filter((id) => !seen.has(id)),
  ];
}

export function orderAgents<T extends { id: string }>(agents: T[], order?: string[]): T[] {
  const normalizedOrder = normalizeAgentOrder(order, agents as unknown as AgentDescriptor[]);
  const indexById = new Map(normalizedOrder.map((id, index) => [id, index]));
  return [...agents].sort((a, b) => {
    const left = indexById.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const right = indexById.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}
