import type { RefObject } from "react";
import { ChartColumn } from "lucide-react";

import { useChatStore } from "@/stores/chat-store";
import { useSessionTokenSummary } from "@/hooks/useFullSessionMessages";
import { formatTokenCacheRate, formatTokenCount } from "@/lib/token-usage-stats";
import type { ChatMessage } from "@/stores/chat-store";

const EMPTY_MESSAGES: ChatMessage[] = [];

interface Props {
  sessionId: string;
  itemRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpen: () => void;
}

/**
 * 聊天框下方的 token 摘要。
 * 自己订阅本会话消息：整块 ChatPanel 不订阅 messages，否则流式期间每个 chunk 都会重渲染整个面板。
 */
export function ChatTokenUsageItem({ sessionId, itemRef, open, onOpen }: Props) {
  const messages = useChatStore((state) => state.sessionMessages[sessionId]) ?? EMPTY_MESSAGES;
  const { summary, cacheRate } = useSessionTokenSummary(sessionId, messages);
  const total = summary.totals.input + summary.totals.output;

  return (
    <button
      type="button"
      ref={itemRef}
      className="chat-header-token-usage chat-status-item"
      onClick={onOpen}
      title={total > 0
        ? `Token 统计：输入 ${summary.totals.input.toLocaleString()} / 输出 ${summary.totals.output.toLocaleString()} / 缓存命中 ${summary.totals.cachedInput.toLocaleString()}`
        : "还没有 token 统计"}
      aria-label="Token 统计"
      aria-haspopup="dialog"
      aria-expanded={open}
    >
      <ChartColumn size={12} strokeWidth={2} />
      <span>
        {total > 0
          ? `${formatTokenCount(total)} token · 缓存命中 ${formatTokenCacheRate(cacheRate)}`
          : "暂无 token 统计"}
      </span>
    </button>
  );
}
