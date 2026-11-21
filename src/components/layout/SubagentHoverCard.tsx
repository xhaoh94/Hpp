import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentSubagent } from "@/stores/chat-store";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import { formatProcessDuration } from "@shared/process-view";
import {
  formatSubagentModel,
  formatSubagentStatusLabel,
  formatSubagentUsage,
} from "./subagentMonitorModel";
import { getSubagentTitle } from "./processBlockUtils";
import "./SubagentHoverCard.css";

/** 悬停多久才弹出：太短会跟着鼠标划过一路闪。 */
const SHOW_DELAY_MS = 240;
/** 离开后留的缓冲：够鼠标跨过 chip 与卡片之间的空隙。 */
const HIDE_DELAY_MS = 160;
const VIEWPORT_GAP = 12;
const ANCHOR_GAP = 8;

type HoverAnchor = {
  subagentId: string;
  anchorRect: DOMRect;
};

export type SubagentHoverState = {
  active: HoverAnchor | null;
  open: (subagentId: string, anchor: HTMLElement) => void;
  scheduleClose: () => void;
  cancelClose: () => void;
  close: () => void;
};

/**
 * 子任务胶囊的悬停卡状态。
 *
 * 只记 id + 锚点矩形，不囤子任务快照：运行中的输出每秒都在变，
 * 渲染时按 id 从当前列表里取最新那份，卡片内容才会跟着长。
 */
export function useSubagentHoverCard(): SubagentHoverState {
  const [active, setActive] = useState<HoverAnchor | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current !== null) window.clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
  }, []);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const close = useCallback(() => {
    clearShowTimer();
    clearHideTimer();
    setActive(null);
  }, [clearHideTimer, clearShowTimer]);

  const open = useCallback((subagentId: string, anchor: HTMLElement) => {
    clearHideTimer();
    clearShowTimer();
    showTimerRef.current = window.setTimeout(() => {
      showTimerRef.current = null;
      setActive({ subagentId, anchorRect: anchor.getBoundingClientRect() });
    }, SHOW_DELAY_MS);
  }, [clearHideTimer, clearShowTimer]);

  const scheduleClose = useCallback(() => {
    clearShowTimer();
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setActive(null);
    }, HIDE_DELAY_MS);
  }, [clearHideTimer, clearShowTimer]);

  const cancelClose = useCallback(() => {
    clearHideTimer();
  }, [clearHideTimer]);

  useEffect(() => () => {
    clearShowTimer();
    clearHideTimer();
  }, [clearHideTimer, clearShowTimer]);

  // 聊天区是虚拟列表：一滚，锚点矩形就失效了。宁可收掉，也不要让它飘在别人头上。
  useEffect(() => {
    if (!active) return;
    const dismiss = () => {
      clearShowTimer();
      clearHideTimer();
      setActive(null);
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [active, clearHideTimer, clearShowTimer]);

  return { active, open, scheduleClose, cancelClose, close };
}

type SubagentHoverCardProps = {
  subagent: AgentSubagent;
  anchorRect: DOMRect;
  projectPath?: string;
  /** 上层处理过程的秒级 tick：运行中的耗时要跟着走，不能定格在弹出来那一刻。 */
  now?: number;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
};

/**
 * 子任务悬停卡：原本这里塞的是原生 title（label · 状态 · 模型 · 用量 · 整段 message），
 * markdown 在系统 tooltip 里只会摊成源码。改成自绘浮层后，正文按 markdown 渲染。
 */
export function SubagentHoverCard({
  subagent,
  anchorRect,
  projectPath,
  now,
  onPointerEnter,
  onPointerLeave,
}: SubagentHoverCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const title = subagent.title || getSubagentTitle(subagent.prompt, subagent.label);
  const statusLabel = formatSubagentStatusLabel(subagent.status, subagent.stopReason);
  const model = formatSubagentModel(subagent.model);
  const usage = formatSubagentUsage(subagent.usage);
  const elapsed = typeof subagent.startedAt === "number"
    ? formatProcessDuration((subagent.completedAt ?? now ?? Date.now()) - subagent.startedAt)
    : "";
  const prompt = subagent.prompt?.trim() || "";
  // message 才是胶囊 tooltip 原本要展示的那段（很多时候是完整产出），liveOutput 兜底。
  const output = (subagent.message?.trim() || subagent.liveOutput?.trim() || "");
  // prompt 常常就是 message 的开头（后端把任务说明一起回显），重复时只留正文。
  const task = prompt && !output.startsWith(prompt) ? prompt : "";

  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const maxLeft = Math.max(VIEWPORT_GAP, window.innerWidth - rect.width - VIEWPORT_GAP);
    const left = Math.min(Math.max(VIEWPORT_GAP, anchorRect.left), maxLeft);
    // 默认贴着 chip 下方；底部放不下就往上顶，高度还是会溢出时直接夹进视口。
    const below = anchorRect.bottom + ANCHOR_GAP;
    const above = anchorRect.top - ANCHOR_GAP - rect.height;
    const top = below + rect.height <= window.innerHeight - VIEWPORT_GAP
      ? below
      : above >= VIEWPORT_GAP
        ? above
        : Math.max(VIEWPORT_GAP, window.innerHeight - rect.height - VIEWPORT_GAP);
    setPosition((previous) => (
      previous && previous.top === top && previous.left === left ? previous : { top, left }
    ));
  }, [anchorRect, subagent.id, output, task]);

  return createPortal(
    <div
      ref={cardRef}
      className="subagent-hover-card"
      role="tooltip"
      aria-label={`${title} ${statusLabel}`.trim()}
      style={position
        ? { top: position.top, left: position.left }
        : { top: anchorRect.bottom + ANCHOR_GAP, left: anchorRect.left, visibility: "hidden" }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="subagent-hover-head">
        <span className="subagent-hover-title" title={subagent.label}>{title}</span>
        {statusLabel && (
          <span className={`subagent-hover-status status-${subagent.status || "unknown"}`}>
            {statusLabel}
          </span>
        )}
        <span className="subagent-hover-meta">
          {model && <span>{model}</span>}
          {usage && <span>{usage}</span>}
          {elapsed && <span>{elapsed}</span>}
        </span>
      </div>
      <div className="subagent-hover-body">
        {task && (
          <p className="subagent-hover-task">
            <span className="subagent-hover-task-label">任务</span>
            {task}
          </p>
        )}
        {output
          ? <MarkdownRenderer content={output} projectPath={projectPath} deferHighlight />
          : <p className="subagent-hover-empty">还没有输出，等它说点什么。</p>}
      </div>
    </div>,
    document.body,
  );
}
