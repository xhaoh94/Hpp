import type { AgentDescriptor, AgentProviderConfiguration } from "@/types";

let agentCatalog: AgentDescriptor[] = [];

export function setAgentCatalog(agents: AgentDescriptor[]) {
  agentCatalog = agents;
}

export function getAvailableAgents(): AgentDescriptor[] {
  return agentCatalog;
}

export function getAgentById(id: string): AgentDescriptor | undefined {
  return agentCatalog.find((agent) => agent.id === id);
}

export function getAgentName(id: string): string {
  return getAgentById(id)?.name || id;
}

export function supportsNativePlanMode(id: string): boolean {
  return getAgentById(id)?.capabilities.planMode === "native";
}

export function supportsPermissionModes(id: string): boolean {
  return getAgentById(id)?.capabilities.permissions === true;
}

export function supportsGuidance(id: string): boolean {
  return getAgentById(id)?.capabilities.guidance === true;
}

export function supportsNativeFork(id: string): boolean {
  return getAgentById(id)?.capabilities.fork === true;
}

export function supportsAgentActions(id: string): boolean {
  return getAgentById(id)?.capabilities.actions === true;
}

export function getAgentProviderConfiguration(id: string): AgentProviderConfiguration | undefined {
  const configuration = getAgentById(id)?.capabilities.configuration;
  return configuration && configuration !== "none" ? configuration : undefined;
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

  return `请安装 ${agentOrCommand}`;
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

/**
 * 项目卡片上的快捷按钮只显示 Agent 设置里勾选启用的 Agent。
 *
 * `enabledIds` 为 undefined/null 表示用户从未保存过启用列表（旧安装），
 * 此时保持旧行为：全部显示。一旦保存过，就以保存值为准 —— 否则新装的插件
 * 会绕过勾选自己冒出来。
 */
export function filterEnabledAgents<T extends { id: string }>(agents: T[], enabledIds?: string[] | null): T[] {
  if (!enabledIds) return agents;
  const enabled = new Set(enabledIds);
  return agents.filter((agent) => enabled.has(agent.id));
}
