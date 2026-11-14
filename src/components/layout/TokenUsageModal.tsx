import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import { formatContextTokenAmount } from "@shared/models";
import { useAnchoredOverlay } from "@shared/anchored-overlay";
import {
  hasOlderSessionMessages,
  parsePersistedChatMessage,
} from "@/hooks/useDataPersistence";
import type { ChatMessage } from "@/stores/chat-store";
import {
  formatTokenCacheRate,
  getTokenCacheRate,
  summarizeTokenUsage,
  UNKNOWN_TOKEN_CHANNEL,
  type TokenUsageGroup,
} from "@/lib/token-usage-stats";
import "./TokenUsageModal.css";

type TokenUsageModalProps = {
  sessionId: string;
  messages: ChatMessage[];
  /** 标题栏的 Token 统计按钮：弹窗锚定在它旁边。 */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
};

const fullTokenTitle = (count: number) => `${count.toLocaleString()} tokens`;

function TokenUsageTable({
  title,
  groups,
  nameHeading,
  emptyText,
}: {
  title: string;
  groups: TokenUsageGroup[];
  nameHeading: string;
  emptyText: string;
}) {
  return (
    <section className="token-usage-section">
      <div className="token-usage-section-head">
        <h4>{title}</h4>
        <span>{groups.length} 项</span>
      </div>
      {groups.length > 0 ? (
        <table className="token-usage-table">
          <thead>
            <tr>
              <th>{nameHeading}</th>
              <th>输入</th>
              <th>输出</th>
              <th>缓存</th>
              <th>缓存率</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr key={group.key}>
                <th scope="row" title={group.inferred ? "旧消息未记录模型 ID，按模型名称回退" : undefined}>
                  <span className="token-usage-name">{group.name}</span>
                  {group.detail && <span className="token-usage-detail">{group.detail}</span>}
                </th>
                <td title={fullTokenTitle(group.input)}>{formatContextTokenAmount(group.input)}</td>
                <td title={fullTokenTitle(group.output)}>{formatContextTokenAmount(group.output)}</td>
                <td title={fullTokenTitle(group.cachedInput)}>{formatContextTokenAmount(group.cachedInput)}</td>
                <td title={`${group.cachedInput.toLocaleString()} / ${group.input.toLocaleString()}`}>
                  {formatTokenCacheRate(getTokenCacheRate(group))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="token-usage-empty">{emptyText}</p>
      )}
    </section>
  );
}

export function TokenUsageModal({ sessionId, messages, anchorRef, onClose }: TokenUsageModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const overlayStyle = useAnchoredOverlay(true, anchorRef, modalRef, { gap: 8 });
  const [persistedMessages, setPersistedMessages] = useState<ChatMessage[] | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // 会话消息按页恢复，长时间会话可能只加载了最近 500 条。统计要覆盖完整
  // 历史，因此在存在更早分页时一次性读取 SQLite，再与内存中的实时消息按 ID 合并。
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
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const allMessages = useMemo(() => {
    if (!persistedMessages) return messages;
    const byId = new Map(persistedMessages.map((message) => [message.id, message]));
    for (const message of messages) byId.set(message.id, message);
    return [...byId.values()];
  }, [messages, persistedMessages]);

  const summary = useMemo(() => summarizeTokenUsage(allMessages), [allMessages]);
  const cacheRate = getTokenCacheRate(summary.totals);
  const uncachedInput = Math.max(0, summary.totals.input - summary.totals.cachedInput);

  return (
    <div className="token-usage-overlay" onMouseDown={onClose}>
      <div
        ref={modalRef}
        className="token-usage-modal"
        style={overlayStyle}
        role="dialog"
        aria-modal="true"
        aria-label="Token 统计"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="token-usage-header">
          <div className="token-usage-heading">
            <h3>Token 统计</h3>
            <span title={fullTokenTitle(summary.totals.total)}>
              累计 {formatContextTokenAmount(summary.totals.total)} · {summary.messageCount} 个助手回合
            </span>
          </div>
          <button type="button" className="token-usage-close" onClick={onClose} aria-label="关闭">
            <X size={15} />
          </button>
        </div>

        <div className="token-usage-summary">
          <div className="token-usage-summary-item">
            <span>输入</span>
            <strong title={fullTokenTitle(summary.totals.input)}>
              {formatContextTokenAmount(summary.totals.input)}
            </strong>
            <small title={fullTokenTitle(uncachedInput)}>未命中 {formatContextTokenAmount(uncachedInput)}</small>
          </div>
          <div className="token-usage-summary-item">
            <span>输出</span>
            <strong title={fullTokenTitle(summary.totals.output)}>
              {formatContextTokenAmount(summary.totals.output)}
            </strong>
            <small>助手生成</small>
          </div>
          <div className="token-usage-summary-item">
            <span>缓存</span>
            <strong title={fullTokenTitle(summary.totals.cachedInput)}>
              {formatContextTokenAmount(summary.totals.cachedInput)}
            </strong>
            <small>输入中命中缓存</small>
          </div>
          <div className="token-usage-summary-item">
            <span>缓存率</span>
            <strong>{formatTokenCacheRate(cacheRate)}</strong>
            <small title="输入中命中缓存的比例">缓存 / 输入</small>
          </div>
        </div>

        <div className="token-usage-scroll">
          <TokenUsageTable
            title="按渠道"
            groups={summary.byChannel}
            nameHeading="渠道"
            emptyText="当前会话还没有 token 消耗记录。"
          />
          <TokenUsageTable
            title="按模型 ID"
            groups={summary.byModel}
            nameHeading="模型"
            emptyText="当前会话还没有模型维度的 token 记录。"
          />
        </div>

        <div className="token-usage-footnote">
          共 {summary.messageCount} 个助手回合 · 缓存率为输入中命中缓存的比例
          {persistedMessages ? " · 已合并完整历史消息" : ""}
          {summary.byChannel.some((group) => group.name === UNKNOWN_TOKEN_CHANNEL)
            ? ` · 旧消息未记录渠道时归入“${UNKNOWN_TOKEN_CHANNEL}”`
            : ""}
        </div>
      </div>
    </div>
  );
}
