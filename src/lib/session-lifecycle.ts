import {
  getAssistantProcessLastActivityAt,
  hasOpenAssistantProcessState,
  useChatStore,
} from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";

/**
 * Move sessions whose main-process backends no longer exist into recoverable history.
 * Project sessions and messages are preserved; only live runtime/UI state is cleared.
 */
export function archiveSessionsAfterBackendRemoval(sessionIds: readonly string[]): string[] {
  const remaining = new Set(sessionIds.filter(Boolean));
  if (remaining.size === 0) return [];

  const archivedSessionIds: string[] = [];
  for (const project of useProjectStore.getState().projects) {
    for (const session of project.sessions) {
      if (!remaining.has(session.id)) continue;
      remaining.delete(session.id);

      // Backend removal is terminal for the renderer-side turn as well.  Close
      // every open process before the project store drops the live status so a
      // reopened/history session cannot keep an elapsed-time ticker forever.
      const chat = useChatStore.getState();
      const messages = chat.activeSessionId === session.id
        ? chat.messages
        : chat.sessionMessages[session.id] || [];
      const latestOpenAssistant = [...messages].reverse().find(hasOpenAssistantProcessState);
      // Backend removal may be discovered long after this turn last emitted
      // anything. Ending it at wall-clock "now" would turn that discovery
      // delay into a bogus multi-hour processing duration in history.
      const endedAt = latestOpenAssistant
        ? getAssistantProcessLastActivityAt(latestOpenAssistant)
        : undefined;
      chat.finishAllAssistantProcesses(endedAt, "interrupted", session.id);
      chat.interruptSessionCompaction(session.id);
      useProjectStore.getState().closeSession(project.id, session.id);

      chat.clearSessionQueue(session.id);
      if (chat.activeSessionId === session.id) {
        chat.switchSession(null);
        chat.setStreaming(false);
      }
      archivedSessionIds.push(session.id);
    }
  }
  return archivedSessionIds;
}

/**
 * 会话是否确实没有任何消息。渲染层按会话分页水合，`sessionMessages` 里没有条目
 * 不等于会话为空（可能只是没加载过），所以内存侧为空时还要确认磁盘上也没有消息：
 * 只有两边都空才算空。误判会把真实历史连同磁盘数据一起删掉。
 */
export async function hasNoSessionMessages(sessionId: string): Promise<boolean> {
  const chat = useChatStore.getState();
  const inMemory = [
    chat.sessionMessages[sessionId],
    chat.activeSessionId === sessionId ? chat.messages : undefined,
  ];
  if (inMemory.some((messages) => messages && messages.length > 0)) return false;

  const loadPage = window.electronAPI?.loadSessionMessagesPage;
  if (typeof loadPage !== "function") return false;
  const page = await loadPage(sessionId, undefined, 1).catch(() => null);
  // 读不到就当非空：宁可让它进历史，也不要因为一次 IPC 失败删掉真实历史。
  if (!page) return false;
  return (page.messages?.length ?? 0) === 0;
}
