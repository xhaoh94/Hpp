export const AGENT_PERMISSION_MODES = ["ask", "auto", "full-access"] as const;

export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];

export const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = "auto";

export const isAgentPermissionMode = (value: unknown): value is AgentPermissionMode =>
  typeof value === "string" && AGENT_PERMISSION_MODES.includes(value as AgentPermissionMode);

export const normalizeAgentPermissionMode = (
  value: unknown,
  fallback: AgentPermissionMode = DEFAULT_AGENT_PERMISSION_MODE,
): AgentPermissionMode => isAgentPermissionMode(value) ? value : fallback;

const LOW_RISK_ACTIONS = new Set([
  "find",
  "glob",
  "grep",
  "list",
  "ls",
  "read",
  "search",
  "stat",
]);

const HIGH_RISK_PATTERN = /(?:delete|remove|write|edit|patch|move|rename|execute|command|shell|terminal|network|fetch|http|install|publish|push|deploy|secret|credential|token|password|permission|outside|external|system)/i;

/**
 * Conservative classifier for native Agent permission requests. Unknown requests
 * are treated as high risk so the automatic mode never silently expands access.
 */
export const isHighRiskAgentPermissionRequest = (
  action: unknown,
  resources?: readonly unknown[],
): boolean => {
  const normalizedAction = String(action || "").trim().toLowerCase();
  if (!normalizedAction) return true;
  if (HIGH_RISK_PATTERN.test(normalizedAction)) return true;
  if (!LOW_RISK_ACTIONS.has(normalizedAction)) return true;
  return (resources || []).some((resource) => {
    const value = String(resource || "").trim();
    return value.startsWith("..") || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value) || /^[a-z]:[\\/]|^\//i.test(value);
  });
};
