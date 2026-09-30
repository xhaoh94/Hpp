import { purgeDeletedSessionData } from "@/hooks/useDataPersistence";
import { SessionCommandCoordinator } from "@/lib/session-command-coordinator";
import { useChatStore } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";

/**
 * 关后端，并把会话从项目列表与磁盘上彻底删除（不进历史）。
 *
 * 关后端失败的会话由 allSettled 吞掉：调用方若要求"后端确实没了才删"，必须先自己严格
 * close 再调用这里。purge 失败会抛出（会话已从列表移除，只是磁盘没清干净），由调用方决定怎么提示。
 */
export async function discardSessionsCompletely(sessionIds: readonly string[]): Promise<string[]> {
  const uniqueSessionIds = [...new Set(sessionIds)].filter(Boolean);
  if (uniqueSessionIds.length === 0) return [];

  await Promise.allSettled(uniqueSessionIds.map((sessionId) =>
    SessionCommandCoordinator.closeSession(sessionId)
  ));
  useChatStore.getState().deleteSessionsMessages(uniqueSessionIds);

  const projectState = useProjectStore.getState();
  for (const sessionId of uniqueSessionIds) {
    const owner = projectState.projects.find((project) =>
      project.sessions.some((session) => session.id === sessionId)
    );
    if (owner) projectState.removeSession(owner.id, sessionId);
  }

  await purgeDeletedSessionData(uniqueSessionIds);
  return uniqueSessionIds;
}
