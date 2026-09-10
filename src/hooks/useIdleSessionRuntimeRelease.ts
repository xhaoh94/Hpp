import { useEffect } from "react";
import {
  getBackendSessionActivity,
  releaseIdleSessionRuntime,
} from "@/lib/session-command-coordinator";
import { getAssistantProcessLastActivityAt, useChatStore } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";

/**
 * 空闲多久后释放会话后端。释放不会关闭页签或丢消息，只是回收该会话的
 * worker/CLI 子进程；下次激活或发消息时会重新初始化（与应用重启后
 * 打开会话是同一条通路，从 sessionFilePath 恢复上下文）。
 */
export const IDLE_SESSION_RUNTIME_RELEASE_MS = 30 * 60_000;
export const IDLE_SESSION_RUNTIME_SCAN_INTERVAL_MS = 60_000;

export const getSessionLastActivityAt = (sessionId: string, lastActiveAt?: string): number => {
  const chat = useChatStore.getState();
  const messages = chat.activeSessionId === sessionId
    ? chat.messages
    : chat.sessionMessages[sessionId] || [];
  let latest = Date.parse(lastActiveAt || "");
  if (!Number.isFinite(latest)) latest = 0;
  for (const message of messages) {
    if (typeof message.timestamp === "number" && message.timestamp > latest) latest = message.timestamp;
  }
  // 只有最后一条消息可能刚刚还在更新，因此只需对它做进程级活跃度检查，
  // 避免每次扫描都要遍历整段历史里的所有 process/commentary 条目。
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === "assistant") {
    const processActivity = getAssistantProcessLastActivityAt(lastMessage);
    if (typeof processActivity === "number" && processActivity > latest) latest = processActivity;
  }
  return latest;
};

/**
 * 扫描并释放长时间空闲的会话后端。任何无法确认“确实空闲”的会话都会跳过，
 * 宁可不释放也不打断用户：正在运行、排队、压缩、有待答交互或不是当前
 * 页签的会话都由这里把住，最终由主进程的后端状态再次确认。
 */
export async function scanIdleSessionRuntimes(now = Date.now()): Promise<string[]> {
  if (typeof window === "undefined" || !window.electronAPI?.agentRemoveSession) return [];
  const projectState = useProjectStore.getState();
  const chat = useChatStore.getState();
  const released: string[] = [];
  for (const project of projectState.projects) {
    for (const session of project.sessions) {
      if (session.closed) continue;
      if (session.id === projectState.activeSessionId) continue;
      // 未初始化的会话本来就没有后端，不需要释放。
      if (!projectState.initializedSessionIds.has(session.id)) continue;
      if (projectState.agentStatuses[session.id] === "running") continue;
      if (chat.messageQueues[session.id]?.length) continue;
      if (chat.compactingSessions[session.id]) continue;
      if (now - getSessionLastActivityAt(session.id, session.lastActiveAt) < IDLE_SESSION_RUNTIME_RELEASE_MS) {
        continue;
      }
      if (await getBackendSessionActivity(session.id) !== "idle") continue;
      const result = await releaseIdleSessionRuntime(session.id);
      if (result.released) released.push(session.id);
    }
  }
  return released;
}

export function useIdleSessionRuntimeRelease(enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    let scanning = false;
    const runScan = () => {
      if (scanning) return;
      scanning = true;
      void scanIdleSessionRuntimes()
        .catch((error) => {
          console.warn("[hpp] 空闲会话后端回收失败:", error);
        })
        .finally(() => {
          scanning = false;
        });
    };
    const timer = setInterval(runScan, IDLE_SESSION_RUNTIME_SCAN_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled]);
}
