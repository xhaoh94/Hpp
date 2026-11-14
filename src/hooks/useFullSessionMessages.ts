import { useEffect, useMemo, useState } from "react";

import { hasOlderSessionMessages, parsePersistedChatMessage } from "@/hooks/useDataPersistence";
import type { ChatMessage } from "@/stores/chat-store";
import { getTokenCacheRate, summarizeTokenUsage } from "@/lib/token-usage-stats";

/**
 * 会话消息是按页恢复的，长会话可能只加载了最近 500 条。
 * Token 统计要覆盖完整历史：存在更早分页时一次性读出来，再按 ID 与内存消息合并。
 */
export function useFullSessionMessages(sessionId: string, messages: ChatMessage[]) {
  const [persistedMessages, setPersistedMessages] = useState<ChatMessage[] | null>(null);

  useEffect(() => {
    if (!hasOlderSessionMessages(sessionId)) {
      setPersistedMessages(null);
      return;
    }
    const loadAll = window.electronAPI?.loadSessionMessages;
    if (typeof loadAll !== "function") return;
    let cancelled = false;
    void Promise.resolve(loadAll(sessionId)).then((value) => {
      if (cancelled || !Array.isArray(value)) return;
      const parsed = value.flatMap((item) => {
        const message = parsePersistedChatMessage(item);
        return message ? [message] : [];
      });
      setPersistedMessages(parsed);
    }).catch(() => {
      // 读取失败时退回当前已加载的消息，统计仍可用。
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  return useMemo(() => {
    if (!persistedMessages) return messages;
    const byId = new Map(persistedMessages.map((message) => [message.id, message]));
    for (const message of messages) byId.set(message.id, message);
    return [...byId.values()];
  }, [messages, persistedMessages]);
}

/** 完整历史的 token 汇总（缓存率单独返回一份，省得每处再算）。 */
export function useSessionTokenSummary(sessionId: string, messages: ChatMessage[]) {
  const allMessages = useFullSessionMessages(sessionId, messages);
  const summary = useMemo(() => summarizeTokenUsage(allMessages), [allMessages]);
  return {
    summary,
    cacheRate: getTokenCacheRate(summary.totals),
    /** 是否并入了尚未加载进内存的历史消息。 */
    mergedHistory: allMessages.length > messages.length,
  };
}
