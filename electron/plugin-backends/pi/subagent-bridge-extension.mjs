import { isSubagentPathWithinProject, isSafeSubagentShellCommand } from "./subagent-policy.mjs";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const HIGH_RISK_COMMAND_PATTERN = /(?:\b(?:rm|mv|cp|del|erase|format)\b|\bsudo\b|\b(?:chmod|chown)\b|\bgit\s+(?:commit|checkout|restore|reset|revert|merge|rebase|cherry-pick|stash|tag|push|clean)\b|\b(?:curl|wget|ssh|scp|rsync|docker|kubectl|terraform|make)\b|\b(?:python|python3|node|deno|bun|ruby|perl|php|powershell|pwsh|cmd)\b|\b(?:npm|pnpm|yarn|pip|cargo)\s+(?:install|add|publish)|invoke-webrequest|start-process|\bshutdown\b|\breboot\b|\btaskkill\b|[<>`]|&&|\|)/i;

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const normalizeToolName = (value) => String(value || "").trim().toLowerCase().replace(/-/g, "_");

const getToolInput = (event) => isRecord(event?.input) ? event.input : {};

const getToolPaths = (event) => {
  const input = getToolInput(event);
  return [input.path, input.filePath, input.file_path, input.cwd, input.directory]
    .filter((value) => typeof value === "string" && value.trim())
    .map(String);
};

const getProjectRoot = () => process.env.HPP_PI_SUBAGENT_PROJECT_ROOT || process.cwd();

const isOutsideProject = (filePath) => !isSubagentPathWithinProject(getProjectRoot(), filePath, process.cwd());

const describeTool = (event) => {
  const toolName = String(event?.toolName || "工具");
  const input = getToolInput(event);
  const detail = toolName === "bash"
    ? String(input.command || "")
    : getToolPaths(event).join("、") || JSON.stringify(input);
  return detail ? `${toolName}: ${detail}` : toolName;
};

const shouldRequestPermission = (event) => {
  const mode = process.env.HPP_PI_SUBAGENT_PERMISSION_MODE || "auto";
  if (mode === "full-access") return false;

  const toolName = normalizeToolName(event?.toolName);
  const outsideProject = getToolPaths(event).some(isOutsideProject);
  if (mode === "ask") return outsideProject || !READ_ONLY_TOOLS.has(toolName);
  if (outsideProject) return true;
  if (READ_ONLY_TOOLS.has(toolName)) return false;
  if (toolName === "bash") {
    const command = String(getToolInput(event).command || "");
    return !isSafeSubagentShellCommand(command) || HIGH_RISK_COMMAND_PATTERN.test(command);
  }
  // edit/write 以及未知扩展工具都要求确认；auto 不是信任任意工具的白名单。
  return true;
};

/**
 * 子 Agent 侧只保留权限确认，不注册任何“向用户提问”的工具。
 *
 * 子任务跑在隔离上下文里，向用户提问会打断主会话，而且宿主无法确定该由哪个
 * 子 agent 承担这次交互（并行子 agent 时尤其明显）。需要用户决策时，子 agent
 * 只能把问题写进结构化结果，由主 agent 转述给用户——与 Claude Code 的 Task
 * 子 agent 一致（AskUserQuestion 在子 agent 里不可用）。
 *
 * 注意：这里也不再需要跳过 question 类工具的权限判断，因为这些工具已经不存在；
 * 若自定义扩展仍注册了同名工具，会被当作“未知工具”要求确认，属安全侧行为。
 */
export default function hppSubagentBridgeExtension(pi) {
  if (!pi) return;

  pi.on("tool_call", async (event, ctx) => {
    if (!shouldRequestPermission(event)) return undefined;
    if (!ctx?.hasUI || typeof ctx.ui?.confirm !== "function") {
      return { block: true, reason: "Hpp permission approval is unavailable" };
    }
    const approved = await ctx.ui.confirm(
      "子 Agent 请求权限",
      `允许子 Agent 执行以下操作？\n\n${describeTool(event)}`,
    );
    return approved ? undefined : { block: true, reason: "用户拒绝了该操作" };
  });
}
