import { useEffect } from "react";
import { releaseIdleSessionRuntime } from "@/lib/session-command-coordinator";
import { getAssistantProcessLastActivityAt, useChatStore } from "@/stores/chat-store";
import { useProjectStore, type ProjectSession } from "@/stores/project-store";

/**
 * 兜底 TTL：即使热池没满，超过这个时间完全没有活动的会话后端也会被回收。
 * 常驻策略由容量（WARM_SESSION_POOL_MAX）决定，而不是由时间决定：30 分钟
 * 一到就杀会让“过一会儿再切回来”必定冷启动。
 */
export const IDLE_SESSION_RUNTIME_RELEASE_MS = 8 * 60 * 60_000;
export const IDLE_SESSION_RUNTIME_SCAN_INTERVAL_MS = 60_000;
/** 最近使用的会话后端保持在内存里，切换时不用重新 spawn CLI/worker。 */
export const WARM_SESSION_POOL_MAX = 6;
/**
 * 容量溢出时的最短空闲时间。用户连续点过多个会话时，刚切换过的会落后端
 * 至少保留这么久，避免“点开 A→B→C 时 A 立刻被挤出、再点回 A 又冷启动”。
 */
export const WARM_SESSION_EVICT_GRACE_MS = 2 * 60_000;

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
 * 按 LRU 维护一个常驻热池：最近用过的会话保留后端，只有热池超过容量或
 * 超过兜底 TTL 时才回收最久未用的会话。正在运行、排队、压缩、有待答交互
 * 以及当前页签的会话永远不会被选中；主进程还会对“确实空闲”做二次确认。
 */
export async function scanIdleSessionRuntimes(now = Date.now()): Promise<string[]> {
  if (typeof window === "undefined" || !window.electronAPI?.agentRemoveSession) return [];
  const projectState = useProjectStore.getState();
  const chat = useChatStore.getState();
  const candidates: Array<{ session: ProjectSession; lastActivityAt: number }> = [];
  let warmSessionCount = 0;

  for (const project of projectState.projects) {
    for (const session of project.sessions) {
      if (session.closed) continue;
      // 未初始化的会话本来就没有后端，不计入热池也不需要释放。
      if (!projectState.initializedSessionIds.has(session.id)) continue;
      warmSessionCount += 1;
      if (session.id === projectState.activeSessionId) continue;
      if (projectState.agentStatuses[session.id] === "running") continue;
      if (chat.messageQueues[session.id]?.length) continue;
      if (chat.compactingSessions[session.id]) continue;
      candidates.push({
        session,
        lastActivityAt: getSessionLastActivityAt(session.id, session.lastActiveAt),
      });
    }
  }

  // 从最久未用的开始处理，保证“最近用过的”留在热池里。
  candidates.sort((left, right) => left.lastActivityAt - right.lastActivityAt);

  const released: string[] = [];
  for (const { session, lastActivityAt } of candidates) {
    const idleFor = now - lastActivityAt;
    const expired = idleFor >= IDLE_SESSION_RUNTIME_RELEASE_MS;
    const overCapacity = warmSessionCount > WARM_SESSION_POOL_MAX;
    // 溢出时只回收确实闲了一会儿的会话；刚切换过的会话先保留，避免在
    // 多个会话间快速轮换时互相把对方挤出热池。
    if (!expired && !(overCapacity && idleFor >= WARM_SESSION_EVICT_GRACE_MS)) continue;
    const result = await releaseIdleSessionRuntime(session.id);
    if (!result.released) {
      // 后端已经不存在时主进程会顺手清掉初始化标记；热池计数也要同步减一，
      // 否则会为了一个本来就不在池里的会话多回收一个健康会话。
      if (result.reason === "missing") warmSessionCount -= 1;
      continue;
    }
    released.push(session.id);
    warmSessionCount -= 1;
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
