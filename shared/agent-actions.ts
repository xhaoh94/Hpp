export const AGENT_ACTION_KINDS = ["skill", "command"] as const;

export type AgentActionKind = typeof AGENT_ACTION_KINDS[number];

export interface AgentActionCatalogEntry {
  kind: AgentActionKind;
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface AgentActionInvocation {
  kind: AgentActionKind;
  name: string;
}

export interface AgentActionListOptions {
  reload?: boolean;
}

const CLAUDE_ACTION_DESCRIPTIONS_ZH_CN: Record<string, string> = {
  "agent-sdk-dev": "开发和调试 Claude Agent SDK 集成。",
  "claude-api": "查阅 Claude API 与 Anthropic SDK，包括模型、价格、参数和使用方式。",
  doctor: "检查 Claude Code 的安装和配置，并诊断常见问题。",
  "fewer-permission-prompts": "扫描会话记录，识别常见的只读 Bash 和 MCP 工具调用，减少重复的权限确认。",
  "frontend-design": "优化前端界面的布局、视觉细节和交互体验。",
  loop: "按指定时间间隔重复运行提示词或斜杠命令。",
  review: "检查当前改动，重点发现错误、风险和缺失的测试。",
  run: "启动并操作当前项目，验证修改后的功能是否正常工作。",
  "run-skill-generator": "运行技能生成器，帮助创建或完善可复用技能。",
  "security-review": "检查代码中的安全风险并给出修复建议。",
  "skill-creator": "创建或更新可复用技能。",
  "skill-installer": "安装或管理技能。",
};

export function getAgentActionDisplayDescription(
  agentId: string | undefined,
  entry: Pick<AgentActionCatalogEntry, "name" | "description" | "argumentHint">,
): string {
  const localized = agentId === "claude"
    ? CLAUDE_ACTION_DESCRIPTIONS_ZH_CN[entry.name.trim().toLowerCase()]
    : undefined;
  const description = localized || entry.description?.trim() || "";
  const argumentHint = entry.argumentHint?.trim() || "";
  if (description && argumentHint) return `${description}（参数：${argumentHint}）`;
  if (description) return description;
  return argumentHint ? `参数：${argumentHint}` : "";
}

export function isAgentActionInvocation(value: unknown): value is AgentActionInvocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  return (action.kind === "skill" || action.kind === "command")
    && typeof action.name === "string"
    && action.name.trim().length > 0
    && action.name.trim().length <= 128;
}

export function sanitizeAgentActionCatalog(value: unknown): AgentActionCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item): AgentActionCatalogEntry[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const entry = item as Record<string, unknown>;
    const kind = entry.kind === "skill" || entry.kind === "command" ? entry.kind : null;
    const name = typeof entry.name === "string" ? entry.name.trim().slice(0, 128) : "";
    if (!kind || !name) return [];
    const key = `${kind}:${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const description = typeof entry.description === "string"
      ? entry.description.trim().slice(0, 2000)
      : "";
    const argumentHint = typeof entry.argumentHint === "string"
      ? entry.argumentHint.trim().slice(0, 256)
      : "";
    return [{
      kind,
      name,
      ...(description ? { description } : {}),
      ...(argumentHint ? { argumentHint } : {}),
    }];
  });
}
