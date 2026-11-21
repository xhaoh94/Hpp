import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, X } from "lucide-react";
import { formatProcessDuration } from "@shared/process-view";
import { useChatStore, type ChatMessage } from "@/stores/chat-store";
import { SUBAGENT_MONITOR_OPEN_EVENT } from "@/lib/app-events";
import {
  collectRunningSubagents,
  formatIdleAgo,
  formatSubagentUsage,
  getSubagentIdleMs,
  isSubagentStalled,
  type MonitoredSubagent,
} from "./subagentMonitorModel";
import { getSubagentTitle } from "./processBlockUtils";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import "./SubagentMonitor.css";

const EMPTY_MESSAGES: ChatMessage[] = [];

const STATUS_TEXT: Record<string, string> = {
  running: "运行中",
  pending: "等待启动",
  completed: "已完成",
  error: "失败",
  interrupted: "已中断",
};

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
  const outputRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [outputExpanded, setOutputExpanded] = useState(false);

  // activity 固定一行，显示最后一行非空文字（实时进展总在末尾，且行高恒定不抖）。
  const activityLines = (selected?.message || "").split(/\r?\n/).filter((line) => line.trim());
  const activityLine = activityLines.length > 0 ? activityLines[activityLines.length - 1] : "正在等待第一段输出…";
  // 切换子任务时收起上一条的展开输出。
  useEffect(() => setOutputExpanded(false), [selected?.id]);

  useEffect(() => {
    const node = outputRef.current;
    if (node && outputExpanded) node.scrollTop = node.scrollHeight;
  }, [selected?.liveOutput, selected?.id, outputExpanded]);

  // 点面板和胶囊之外（页面空白处）关掉浮层。只认 mousedown，不碰滚动/resize，
  // 详情区本来就滚，不能像菜单那样一滚就关。
  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (pillRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open, onClose]);

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
        ref={pillRef}
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
        <div ref={panelRef} className="subagent-monitor-panel" role="dialog" aria-label="Subagent 运行状态">
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
                const itemStalled = isSubagentStalled(subagent, now);
                return (
                  <li key={subagent.id}>
                    <button
                      type="button"
                      className={`subagent-monitor-item ${subagent.id === selected.id ? "active" : ""} ${itemStalled ? "stalled" : ""}`}
                      onClick={() => onSelect(subagent.id)}
                    >
                      <span className={`subagent-monitor-dot ${itemStalled ? "stalled" : subagent.status || ""}`} />
                      {/* 页签显示任务标题（prompt 首句），身份标签 Scout/Worker 放 tooltip。 */}
                      <span className="subagent-monitor-item-label" title={subagent.label}>
                        {subagent.title || getSubagentTitle(subagent.prompt, subagent.label)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="subagent-monitor-detail">
              {/* 固定头：标题 / 状态 / 模型 / 消耗 / 最后活动。内容再长也不滚出视野。 */}
              <div className="subagent-monitor-detail-head">
                <strong title={selected.label}>{selected.title || getSubagentTitle(selected.prompt, selected.label)}</strong>
                <span>{STATUS_TEXT[selected.status || ""] || selected.status}</span>
                {selected.model && <span className="subagent-monitor-model">{selected.model}</span>}
              </div>
              <div className="subagent-monitor-detail-meta">
                {formatSubagentUsage(selected.usage) && (
                  <span className="subagent-monitor-usage">{formatSubagentUsage(selected.usage)}</span>
                )}
                {idle !== undefined && (
                  <span className={`subagent-monitor-idle ${stalled ? "stalled" : ""}`}>
                    最后活动 {formatIdleAgo(idle)}{stalled ? "（可能已卡住）" : ""}
                  </span>
                )}
              </div>
              {/* 活动固定一行；输出固定一行、点一下展开全文。高度恒定，面板不抖。 */}
              <div className="subagent-monitor-detail-scroll">
                {/* 这里只放最后一行进展当悬停提示：整段 message 是 markdown，
                    塞进原生 title 会变成一大坨源码，完整内容看下面的展开输出。 */}
                <div className="subagent-monitor-activity" title={activityLine}>
                  {activityLine}
                </div>
                {selected.liveOutput && (
                  <div
                    className={`subagent-monitor-output ${outputExpanded ? "expanded" : ""}`}
                    ref={outputRef}
                    role="button"
                    tabIndex={0}
                    onClick={() => setOutputExpanded((v) => !v)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOutputExpanded((v) => !v);
                      }
                    }}
                    title={outputExpanded ? "点击收起" : "点击展开完整输出（Markdown）"}
                    aria-expanded={outputExpanded}
                  >
                    {outputExpanded
                      ? <MarkdownRenderer content={selected.liveOutput} deferHighlight />
                      : <span className="subagent-monitor-output-line">{selected.liveOutput.split(/\r?\n/).filter((line) => line.trim()).slice(-1)[0] || "展开查看输出"}</span>}
                  </div>
                )}
              </div>
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
