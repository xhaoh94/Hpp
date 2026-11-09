import type { Project } from "@/stores/project-store";
import { GENERAL_SETTINGS_UPDATED_EVENT } from "@/lib/app-events";

/** 内置工作区的固定 id：跟着它走才不会在重排 / 升级后把会话丢掉。 */
export const DEFAULT_WORKSPACE_PROJECT_ID = "hpp-default-workspace";
export const DEFAULT_WORKSPACE_NAME = "默认工作区";
export const DEFAULT_WORKSPACE_DIR_NAME = "hpp";

export const isDefaultWorkspaceProject = (project: { id: string }) =>
  project.id === DEFAULT_WORKSPACE_PROJECT_ID;

export const normalizeDefaultWorkspacePath = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

/**
 * 未配置时回落到 <home>/hpp。拿不到 home（旧 preload 或测试环境）就返回空串，
 * 由调用方跳过注入 —— 空路径的项目会让 agent 起进程时直接 ENOENT。
 */
export function resolveDefaultWorkspacePath(homeDir: unknown, configured: unknown): string {
  const explicit = normalizeDefaultWorkspacePath(configured);
  if (explicit) return explicit;
  const home = normalizeDefaultWorkspacePath(homeDir).replace(/[\\/]+$/, "");
  if (!home) return "";
  return `${home}${home.includes("\\") ? "\\" : "/"}${DEFAULT_WORKSPACE_DIR_NAME}`;
}

/** 内置工作区固定在首位并同步路径；缺失时插入。路径为空时保留原卡片（会话还在里面）。 */
export function withDefaultWorkspace(projects: Project[], path: string): Project[] {
  const existing = projects.find(isDefaultWorkspaceProject);
  const rest = projects.filter((project) => !isDefaultWorkspaceProject(project));
  const targetPath = path || existing?.path || "";
  if (!existing && !targetPath) return projects;
  if (existing === projects[0] && existing.path === targetPath && existing.name === DEFAULT_WORKSPACE_NAME) {
    return projects;
  }
  return [
    {
      // 先把已有字段铺开：sessionsCollapsed 这类“卡片偏好”不能因为重建默认
      // 工作区就被抹掉，否则每次启动都会回落到默认展开状态。
      ...existing,
      id: DEFAULT_WORKSPACE_PROJECT_ID,
      name: DEFAULT_WORKSPACE_NAME,
      path: targetPath,
      createdAt: existing?.createdAt || new Date().toISOString(),
      agents: existing?.agents || [],
      sessions: existing?.sessions || [],
    },
    ...rest,
  ];
}

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

/** 只改 settings.general.defaultWorkspacePath，其余配置原样保留。 */
export async function saveDefaultWorkspacePath(path: string) {
  const settings = asRecord(await window.electronAPI.loadData("settings"));
  await window.electronAPI.saveData("settings", {
    ...settings,
    general: { ...asRecord(settings.general), defaultWorkspacePath: path },
  });
  window.dispatchEvent(new CustomEvent(GENERAL_SETTINGS_UPDATED_EVENT, {
    detail: { defaultWorkspacePath: path },
  }));
}

/** 配置在 settings.json 里的原始值（未解析默认目录）。 */
export const readDefaultWorkspacePathSetting = (settings: unknown): string =>
  normalizeDefaultWorkspacePath(asRecord(asRecord(settings).general).defaultWorkspacePath);
