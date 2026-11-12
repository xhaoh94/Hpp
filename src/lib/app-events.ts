import type { AgentPermissionMode } from "@/types";
import type { OutputDetailLevel } from "@shared/output-detail";

/**
 * 桌面端内部的自定义事件（`window.dispatchEvent`）。
 *
 * 这几个名字之前分别硬编码在 ChatPanel、SettingsView、useRemoteBridge 里，
 * 改名时漏一处就会让设置改动静默不生效，所以统一收在这里。
 *
 * `agent-settings-updated`：计划模式 / 权限模式（远程端需要实时同步）。
 * `general-settings-updated`：通用设置里的输出内容详细等级、默认工作区路径。
 */
export const AGENT_SETTINGS_UPDATED_EVENT = "agent-settings-updated";
export const GENERAL_SETTINGS_UPDATED_EVENT = "general-settings-updated";
/** 点聊天里的 Subagent 胶囊时打开监视窗并对齐到该子任务。 */
export const SUBAGENT_MONITOR_OPEN_EVENT = "subagent-monitor-open";

export type AgentSettingsUpdatedDetail = {
  planModeEnabled?: boolean;
  permissionMode?: AgentPermissionMode;
};

export type GeneralSettingsUpdatedDetail = {
  outputDetailLevel?: OutputDetailLevel;
  /** 默认工作区路径变更；内置工作区卡片据此同步。 */
  defaultWorkspacePath?: string;
};
