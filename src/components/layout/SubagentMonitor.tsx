import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, X } from "lucide-react";
import { formatProcessDuration } from "@shared/process-view";
import { useChatStore, type ChatMessage } from "@/stores/chat-store";
import { SUBAGENT_MONITOR_OPEN_EVENT } from "@/lib/app-events";
import {
  collectRunningSubagents,
  formatIdleAgo,
  getSubagentElapsedMs,
  getSubagentIdleMs,
  isSubagentStalled,
  type MonitoredSubagent,
} from "./subagentMonitorModel";
import "./SubagentMonitor.css";

const EMPTY_MESSAGES: ChatMessage[] = [];

const STATUS_TEXT: Record<string, string> = {
  running: "运行中",
  pending: "等待启动",
  completed: "已完成",
  error: "失败",
  interrupted: "已中断",
};

function formatTokens(value?: number): string {
  if (!value || value <= 0) return "";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function usageLabel(subagent: MonitoredSubagent): string {
  const turns = subagent.usage?.turns;
  const tokens = formatTokens(subagent.usage?.totalTokens);
  return [turns ? `${turns} 轮` : "", tokens ? `${tokens} tokens` : ""].filter(Boolean).join(" · ");
}

type SubagentMonitorViewProps = {
  subagents: MonitoredSubagent[];
  now: number;
  open: boolean;
  selectedId: string | null;
  onToggle: () => void;
  onClose: () => void;
  onSelect: (id: string) => void;
};

/** 纯展示层：不读 store，便于直接渲染测试。 */
export function SubagentMonitorView({
  subagents,
  now,
  open,
  selectedId,
  onToggle,
  onClose,
  onSelect,
}: SubagentMonitorViewProps) {
  const selected = subagents.find((subagent) => subagent.id === selectedId) || subagents[0];
  const outputRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const node = outputRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [selected?.liveOutput, selected?.id]);

  if (subagents.length === 0 || !selected) return null;

  const startedAtList = subagents
    .map((subagent) => subagent.startedAt)
    .filter((value): value is number => typeof value === "number");
  const totalElapsed = startedAtList.length > 0 ? now - Math.min(...startedAtList) : undefined;
  const idle = getSubagentIdleMs(selected, now);
  const stalled = isSubagentStalled(selected, now);

  return (
    <>
      <button
        type="button"
        className={`subagent-monitor-pill ${open ? "open" : ""}`}
        onClick={onToggle}
        aria-expanded={open}
        title="查看 Subagent 运行状态"
      >
        <Activity size={14} />
        <span>{subagents.length} 个 Subagent 运行中</span>
        {totalElapsed !== undefined && (
          <span className="subagent-monitor-pill-time">{formatProcessDuration(totalElapsed)}</span>
        )}
      </button>

      {open && (
        <div className="subagent-monitor-panel" role="dialog" aria-label="Subagent 运行状态">
          <div className="subagent-monitor-header">
            <span className="subagent-monitor-title">
              <Activity size={14} /> Subagent 监视
            </span>
            <button
              type="button"
              className="subagent-monitor-close"
              onClick={onClose}
              aria-label="关闭"
              title="关闭"
            >
              <X size={14} />
            </button>
          </div>

          <div className="subagent-monitor-body">
            <ul className="subagent-monitor-list">
              {subagents.map((subagent) => {
                const elapsed = getSubagentElapsedMs(subagent, now);
                const itemStalled = isSubagentStalled(subagent, now);
                return (
                  <li key={subagent.id}>
                    <button
                      type="button"
                      className={`subagent-monitor-item ${subagent.id === selected.id ? "active" : ""} ${itemStalled ? "stalled" : ""}`}
                      onClick={() => onSelect(subagent.id)}
                    >
                      <span className={`subagent-monitor-dot ${itemStalled ? "stalled" : subagent.status || ""}`} />
                      <span className="subagent-monitor-item-label">{subagent.label}</span>
                      <span className="subagent-monitor-item-time">
                        {elapsed !== undefined ? formatProcessDuration(elapsed) : "—"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="subagent-monitor-detail">
              <div className="subagent-monitor-detail-head">
                <strong>{selected.label}</strong>
                <span>{STATUS_TEXT[selected.status || ""] || selected.status}</span>
                {selected.model && <span className="subagent-monitor-model">{selected.model}</span>}
              </div>
              {usageLabel(selected) && (
                <div className="subagent-monitor-usage">{usageLabel(selected)}</div>
              )}
              <div className="subagent-monitor-activity">
                {selected.message || "正在等待第一段输出…"}
              </div>
              {idle !== undefined && (
                <div className={`subagent-monitor-idle ${stalled ? "stalled" : ""}`}>
                  最后活动 {formatIdleAgo(idle)}
                  {stalled ? "（可能已卡住）" : ""}
                </div>
              )}
              {selected.liveOutput && (
                <pre className="subagent-monitor-output" ref={outputRef}>
                  {selected.liveOutput}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * 子任务监视窗：胶囊入口 + 浮层详情。
 *
 * 常驻展示会让界面噪声过大，所以默认只给一个"N 个运行中"的胶囊，
 * 点开才看列表与实时输出；全部结束后整体消失。
 */
export function SubagentMonitor({ sessionId }: { sessionId: string | null }) {
  const messages = useChatStore((state) => {
    if (!sessionId) return EMPTY_MESSAGES;
    if (state.activeSessionId === sessionId) return state.messages;
    return state.sessionMessages[sessionId] || EMPTY_MESSAGES;
  });
  const running = useMemo(() => collectRunningSubagents(messages), [messages]);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (running.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running.length]);

  // 任务全部结束就收起浮层，否则会留一个空壳挡住聊天。
  useEffect(() => {
    if (running.length === 0 && open) setOpen(false);
  }, [open, running.length]);

  // 聊天里的胶囊是入口：点哪颗就展开监视窗并对齐到那颗。
  useEffect(() => {
    const handleOpen = (event: Event) => {
      const subagentId = (event as CustomEvent<{ subagentId?: string }>).detail?.subagentId;
      if (subagentId) setSelectedId(subagentId);
      setOpen(true);
    };
    window.addEventListener(SUBAGENT_MONITOR_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(SUBAGENT_MONITOR_OPEN_EVENT, handleOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open]);

  return (
    <SubagentMonitorView
      subagents={running}
      now={now}
      open={open}
      selectedId={selectedId}
      onToggle={() => setOpen((value) => !value)}
      onClose={() => setOpen(false)}
      onSelect={setSelectedId}
    />
  );
}
