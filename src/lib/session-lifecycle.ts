import { useChatStore } from "@/stores/chat-store";
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
      useProjectStore.getState().closeSession(project.id, session.id);

      const chat = useChatStore.getState();
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
