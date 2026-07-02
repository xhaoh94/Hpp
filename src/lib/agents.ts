export type AgentPlanModeSupport = "native" | "prompt";

export const AGENT_PLAN_MODE_SUPPORT: Record<string, AgentPlanModeSupport> = {
  codex: "native",
  pi: "prompt",
  opencode: "native",
  droid: "native",
};

// All available agents in the application
export const AVAILABLE_AGENTS = [
  { id: "codex", name: "Codex", desc: "OpenAI Codex CLI 编程助手", runtime: "sdk" },
  { id: "pi", name: "Pi Agent", desc: "AI 编程助手", runtime: "sdk" },
  { id: "opencode", name: "OpenCode", desc: "开源 AI 编程助手", runtime: "cli", command: "opencode" },
  { id: "droid", name: "Factory Droid", desc: "Factory AI 编程助手", runtime: "cli", command: "droid" },
];

export function getAgentName(id: string): string {
  return AVAILABLE_AGENTS.find((a) => a.id === id)?.name || id;
}

export function supportsNativePlanMode(id: string): boolean {
  return AGENT_PLAN_MODE_SUPPORT[id] === "native";
}

export function getAgentPlanModeTooltip(id: string): string {
  if (supportsNativePlanMode(id)) return "支持原生 Plan 模式";
  return "当前 Agent 不支持原生 Plan 模式，将通过提示词要求先计划并等待确认";
}

export function getInstallHint(command: string): string {
  switch (command) {
    case "codex": return "在通用设置中更新 Codex CLI，或运行 npm install @openai/codex@latest";
    case "pi": return "在通用设置中更新 Pi SDK，或运行 npm install @earendil-works/pi-coding-agent@latest";
    case "opencode": return "npm install -g opencode-ai";
    case "droid": return "npm install -g droid";
    default: return `请安装 ${command}`;
  }
}

export function getAgentUpdateCommand(agentId: string): string | null {
  switch (agentId) {
    case "codex": return "npm install @openai/codex@latest";
    case "pi": return "npm install @earendil-works/pi-coding-agent@latest";
    case "opencode": return "npm install -g opencode-ai@latest";
    case "droid": return "npm install -g droid@latest";
    default: return null;
  }
}

export const DEFAULT_AGENT_ORDER = AVAILABLE_AGENTS.map((agent) => agent.id);

export function normalizeAgentOrder(order?: string[]): string[] {
  const knownIds = new Set(DEFAULT_AGENT_ORDER);
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
    ...DEFAULT_AGENT_ORDER.filter((id) => !seen.has(id)),
  ];
}

export function orderAgents<T extends { id: string }>(agents: T[], order?: string[]): T[] {
  const normalizedOrder = normalizeAgentOrder(order);
  const indexById = new Map(normalizedOrder.map((id, index) => [id, index]));
  return [...agents].sort((a, b) => {
    const left = indexById.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const right = indexById.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}
