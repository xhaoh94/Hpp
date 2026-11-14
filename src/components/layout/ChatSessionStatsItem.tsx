import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, X } from "lucide-react";

import { useAnchoredOverlay } from "@shared/anchored-overlay";
import { useChatStore, type ChatMessage } from "@/stores/chat-store";
import {
  formatSessionDuration,
  formatSessionStatsSummary,
  summarizeSessionStats,
} from "@/lib/session-stats";

const EMPTY_MESSAGES: ChatMessage[] = [];

interface Props {
  sessionId: string;
  /** 当前时间：运行中的回合按它算已用时长。 */
  now?: number;
}

/**
 * 输入框下方的「会话统计」入口：轮次/步数 + 输出速度，点开看耗时明细。
 * 自己订阅会话消息，避免整块 ChatPanel 跟着流式刷新重渲染。
 */
export function ChatSessionStatsItem({ sessionId, now }: Props) {
  const messages = useChatStore((state) => state.sessionMessages[sessionId]) ?? EMPTY_MESSAGES;
  const stats = useMemo(() => summarizeSessionStats(messages, now ?? Date.now()), [messages, now]);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const summary = formatSessionStatsSummary(stats);
  if (!summary) return null;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="chat-session-stats-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="会话统计（轮次 / 步数 / 耗时 / 输出速度）"
      >
        <Activity size={12} strokeWidth={2} />
        <span>{summary}</span>
      </button>
      {open && (
        <SessionStatsPopover
          stats={stats}
          anchorRef={triggerRef}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

interface PopoverProps {
  stats: ReturnType<typeof summarizeSessionStats>;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

function SessionStatsPopover({ stats, anchorRef, onClose }: PopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredOverlay(true, anchorRef, popoverRef, { gap: 8 });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
  const rows = [
    {
      label: "会话统计",
      value: [stats.turns ? `${stats.turns} 轮` : "", stats.steps ? `${stats.steps} 步` : ""].filter(Boolean).join(" "),
      strong: true,
    },
    { label: "模型用时", value: formatSessionDuration(stats.modelMs) },
    { label: "工具调用用时", value: formatSessionDuration(stats.toolMs) },
    {
      label: "输出速度",
      value: stats.tokensPerSecond ? `${stats.tokensPerSecond} token/s` : "—",
    },
  ].filter((row) => row.value);

  return createPortal(
    <div className="session-stats-overlay" onMouseDown={onClose}>
      <div
        ref={popoverRef}
        className="session-stats-popover"
        style={style}
        role="dialog"
        aria-label="会话统计"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="session-stats-header">
          <span>会话统计</span>
          <button type="button" onClick={onClose} aria-label="关闭">
            <X size={13} />
          </button>
        </div>
        <div className="session-stats-rows">
          {rows.map((row) => (
            <div className={`session-stats-row ${row.strong ? "strong" : ""}`} key={row.label}>
              <span>{row.label}</span>
              <span>{row.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
