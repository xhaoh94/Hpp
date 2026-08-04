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
