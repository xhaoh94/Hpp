/**
 * 新建会话时是否跳过确认弹窗。
 *
 * 弹窗里唯一的选项是"是否用独立 worktree"，没有 Git 环境时这个选项根本用不了，
 * 直接建共享工作区会话更省一步。`probe` 为 null 表示探测失败——此时保留弹窗，
 * 不要因为一次 IPC 抖动就悄悄改变有 worktree 可用时的行为。
 */
export const shouldCreateSessionDirectly = (
  defaultWorkspace: boolean,
  probe: { supported?: boolean } | null,
): boolean => defaultWorkspace || probe?.supported === false;
