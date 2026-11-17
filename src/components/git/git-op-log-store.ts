import { useSyncExternalStore } from "react";
import type { GitOpLogItem } from "./GitOpLogDialog";

/**
 * 操作日志按 renderer 进程持有：关闭工作台不丢，切仓库/重开都还在。
 * 只有用户手动清空或 Hpp 退出才消失。
 * snapshot 保持引用稳定，push 时才换新数组，useSyncExternalStore 才不会死循环。
 */
const MAX_ENTRIES = 200;
let entries: GitOpLogItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export const subscribeOpLog = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getOpLogSnapshot = () => entries;

export const useGitOpLog = () => useSyncExternalStore(subscribeOpLog, getOpLogSnapshot, getOpLogSnapshot);

export const pushOpLog = (entry: Omit<GitOpLogItem, "id" | "time">) => {
  seq += 1;
  entries = [
    ...entries,
    {
      ...entry,
      id: seq,
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    },
  ].slice(-MAX_ENTRIES);
  emit();
};

export const clearOpLog = () => {
  if (entries.length === 0) return;
  entries = [];
  emit();
};
