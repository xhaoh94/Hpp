import { useEffect, useRef, useState, type RefObject } from "react";
import { ListCollapse, X } from "lucide-react";
import type { SessionContextUsage } from "@/stores/chat-store";
import { formatContextTokenAmount } from "@shared/models";
import { useAnchoredOverlay } from "@shared/anchored-overlay";
import "./ContextUsageModal.css";

// 与截图一致的分类配色：蓝、绿、黄、紫、粉、青，按明细顺序取用。
const BREAKDOWN_COLORS = ["#6b8afd", "#3ecf8e", "#f5a623", "#b06bff", "#ff6bd6", "#4dd0e1"];

// 精度 → 脚注说明：估算和"后端上报值"都不能当成独立测量的精确值来讲。
const SOURCE_NOTES: Record<SessionContextUsage["source"], string> = {
  exact: "用量来自后端精确统计",
  official: "用量来自后端上报值",
  estimated: "用量为估算值",
  unknown: "用量来源未知",
};

type ContextUsageModalProps = {
  usage?: SessionContextUsage;
  /** 标题栏的上下文圆环：弹窗锚定在它旁边，而不是贴在窗口左上角。 */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** 手动压缩一次上下文；所有 Agent 共用同一个命令，能力差异由后端决定。返回 false 表示未进入压缩。 */
  onCompact?: () => boolean | void | Promise<boolean | void>;
  /** 压缩进行中（含刚发出、事件尚未回来的短暂窗口）。 */
  compacting?: boolean;
  /** 不能压缩的原因（回合运行中／缺少会话）；有值时按钮置灰。 */
  compactDisabledReason?: string;
};

export function ContextUsageModal({
  usage,
  anchorRef,
  onClose,
  onCompact,
  compacting = false,
  compactDisabledReason,
}: ContextUsageModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const overlayStyle = useAnchoredOverlay(true, anchorRef, modalRef, { gap: 8 });
  const [compactRequested, setCompactRequested] = useState(false);

  useEffect(() => {
    if (compacting) setCompactRequested(false);
  }, [compacting]);

  const isCompacting = compacting || compactRequested;
  const compactDisabled = isCompacting || !!compactDisabledReason || !onCompact;
  const compactTitle = isCompacting
    ? "正在压缩上下文"
    : compactDisabledReason || "手动压缩上下文（对话太长时可先压缩再继续）";

  const handleCompact = () => {
    if (compactDisabled) return;
    setCompactRequested(true);
    void Promise.resolve(onCompact?.()).then(
      (started) => {
        // 压缩没启动（后端报错/会话忙）时立刻把按钮恢复，不让它卡在「压缩中」。
        if (started === false) setCompactRequested(false);
      },
      () => setCompactRequested(false),
    );
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const contextWindow = usage?.contextWindow;
  const usedTokens = usage?.usedTokens;
  const usageRatio = contextWindow && usedTokens !== undefined
    ? Math.min(1, usedTokens / contextWindow)
    : undefined;
  const percentText = `${((usageRatio ?? 0) * 100).toFixed(1)}%`;
  // 明细的 token 已按实际总量归一化，因此可直接换算成占窗口的比例。
  const segments = (usage?.breakdown || []).map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    tokens: entry.tokens,
    ratio: contextWindow ? Math.min(1, entry.tokens / contextWindow) : 0,
    color: BREAKDOWN_COLORS[index % BREAKDOWN_COLORS.length],
  }));
  const breakdownTotal = segments.reduce((sum, segment) => sum + segment.tokens, 0);

  return (
    <div className="context-usage-overlay" onMouseDown={onClose}>
      <div
        ref={modalRef}
        className="context-usage-modal"
        style={overlayStyle}
        role="dialog"
        aria-modal="true"
        aria-label="上下文用量"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="context-usage-header">
          <div className="context-usage-title-group">
            <h3>上下文用量</h3>
            <button
              type="button"
              className={`context-usage-compact${isCompacting ? " is-compacting" : ""}`}
              onClick={handleCompact}
              disabled={compactDisabled}
              title={compactTitle}
              aria-label={isCompacting ? "正在压缩上下文" : "压缩上下文"}
            >
              <ListCollapse size={13} />
              <span>{isCompacting ? "压缩中" : "压缩"}</span>
            </button>
          </div>
          <button type="button" className="context-usage-close" onClick={onClose} aria-label="关闭">
            <X size={15} />
          </button>
        </div>

        <div className="context-usage-summary">
          <strong>{percentText}</strong>
          <span>
            已使用 {usedTokens !== undefined ? formatContextTokenAmount(usedTokens) : "—"}
            {contextWindow ? `/${formatContextTokenAmount(contextWindow)}` : ""}
          </span>
        </div>

        <div className="context-usage-bar" aria-hidden="true">
          {segments.length > 0
            ? segments.map((segment) => (
                <span
                  key={segment.id}
                  className="context-usage-bar-segment"
                  style={{ width: `${segment.ratio * 100}%`, backgroundColor: segment.color }}
                />
              ))
            : usageRatio !== undefined
              ? <span className="context-usage-bar-segment used" style={{ width: `${usageRatio * 100}%` }} />
              : null}
        </div>

        {segments.length > 0 ? (
          <ul className="context-usage-list">
            {segments.map((segment) => (
              <li key={segment.id}>
                <span className="context-usage-dot" style={{ backgroundColor: segment.color }} />
                <span className="context-usage-label">{segment.label}</span>
                <span className="context-usage-value">
                  {contextWindow && breakdownTotal > 0
                    ? `${((segment.tokens / contextWindow) * 100).toFixed(1)}%`
                    : formatContextTokenAmount(segment.tokens)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="context-usage-empty">当前 Agent 未提供上下文构成明细。</p>
        )}

        <div className="context-usage-footnote">
          {usage?.model ? `${usage.model.provider}/${usage.model.id} · ` : ""}
          {!usage ? "暂无用量数据，发送一次消息后即可看到" : SOURCE_NOTES[usage.source]}
          {usage && !contextWindow ? " · 当前模型未提供上下文窗口" : ""}
        </div>
      </div>
    </div>
  );
}
