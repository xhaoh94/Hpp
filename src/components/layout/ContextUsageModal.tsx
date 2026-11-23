import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { ListCollapse, X } from "lucide-react";
import type { SessionContextUsage } from "@/stores/chat-store";
import { formatContextTokenAmount } from "@shared/models";
import { useAnchoredOverlay } from "@shared/anchored-overlay";
import {
  CONTEXT_THRESHOLD_MAX,
  CONTEXT_THRESHOLD_MIN,
  DEFAULT_CONTEXT_COMPACTION_THRESHOLD,
  normalizeContextCompactionThreshold,
} from "@shared/context-compaction-threshold";
import {
  loadContextCompactionThreshold,
  saveContextCompactionThreshold,
} from "@/lib/context-compaction-threshold";
import "./ContextUsageModal.css";

// 与截图一致的分类配色：蓝、绿、黄、紫、粉、青，按明细顺序取用。
const BREAKDOWN_COLORS = ["#6b8afd", "#3ecf8e", "#f5a623", "#b06bff", "#ff6bd6", "#4dd0e1"];

// 精度 → 脚注说明：估算和"后端上报值"都不能当成独立测量的精确值来讲。
const SOURCE_NOTES: Record<SessionContextUsage["source"], string> = {
  exact: "精确统计",
  official: "后端上报",
  estimated: "估算",
  unknown: "来源未知",
};

/**
 * 上次读到的阈值，按「渠道 + 模型」缓存。
 *
 * 弹窗每次打开都是重新挂载：没有这份缓存时会先显示默认值、几十毫秒后再跳到
 * 真实值（一次可见的闪动）。缓存只负责首帧，随后仍会向主进程读一次。
 */
const thresholdCache = new Map<string, number>();
const thresholdCacheKey = (model: { provider: string; id: string } | null | undefined) =>
  model?.provider && model.id ? `${model.provider}:${model.id}` : "";

/** 阈值标记的落点：按指针的 clientX 换算成轨道内的百分比。 */
function percentFromTrack(track: HTMLElement | null, clientX: number): number {
  const rect = track?.getBoundingClientRect();
  if (!rect || rect.width <= 0) return CONTEXT_THRESHOLD_MIN;
  const percent = ((clientX - rect.left) / rect.width) * 100;
  return Math.round(Math.min(CONTEXT_THRESHOLD_MAX, Math.max(CONTEXT_THRESHOLD_MIN, percent)));
}

type ContextUsageModalProps = {
  usage?: SessionContextUsage;
  /**
   * 模型目录里的上下文窗口。用量事件没来（新会话、刚切换模型）时拿它当分母，
   * 弹窗至少能显示「—/200K」和阈值对应的 token 数，而不是一片空白。
   */
  fallbackContextWindow?: number;
  /** 当前会话使用的渠道 + 模型；阈值按它分别保存，缺省时退回 usage.model。 */
  model?: { provider: string; id: string } | null;
  /** 当前会话 id：拖动阈值时立刻把这个值热更新到该会话，不必重开。 */
  sessionId?: string | null;
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
  fallbackContextWindow,
  model,
  sessionId,
  anchorRef,
  onClose,
  onCompact,
  compacting = false,
  compactDisabledReason,
}: ContextUsageModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const overlayStyle = useAnchoredOverlay(true, anchorRef, modalRef, { gap: 8 });
  const [compactRequested, setCompactRequested] = useState(false);
  const [draggingThreshold, setDraggingThreshold] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  // 阈值的作用域是「渠道 + 模型」：优先用当前选择，用量事件里带着模型时兜底。
  const thresholdModel = model ?? usage?.model ?? null;
  const thresholdEditable = !!thresholdModel?.provider && !!thresholdModel?.id;
  // 首帧用缓存值，避免「先 100% 再跳 60%」的闪动。
  const [threshold, setThreshold] = useState(() => {
    const key = thresholdCacheKey(thresholdModel);
    return (key ? thresholdCache.get(key) : undefined) ?? DEFAULT_CONTEXT_COMPACTION_THRESHOLD;
  });
  /** 用户已经动过滑块：迟到的读盘结果不能把他的手势覆盖回去。 */
  const thresholdTouchedRef = useRef(false);
  /** 拖动中的临时值：松手才落盘，避免拖动过程反复写 settings.json。 */
  const dragRef = useRef<{ active: boolean; value: number; start: number }>({
    active: false,
    value: threshold,
    start: threshold,
  });

  useEffect(() => {
    let alive = true;
    thresholdTouchedRef.current = false;
    // 阈值按渠道 + 模型分别保存：切换模型后要重新读，不能沿用上一个模型的值。
    const key = thresholdCacheKey(thresholdModel);
    // 有缓存就先用缓存顶上，避免切换模型时短暂显示上一个模型的阈值。
    setThreshold((key ? thresholdCache.get(key) : undefined) ?? DEFAULT_CONTEXT_COMPACTION_THRESHOLD);
    void loadContextCompactionThreshold(thresholdModel).then((loaded) => {
      if (!alive || thresholdTouchedRef.current) return;
      setThreshold(loaded);
      if (key) thresholdCache.set(key, loaded);
    });
    return () => { alive = false; };
  }, [thresholdModel?.provider, thresholdModel?.id]);

  const applyThreshold = (next: number) => {
    const normalized = normalizeContextCompactionThreshold(next);
    thresholdTouchedRef.current = true;
    setThreshold(normalized);
    const key = thresholdCacheKey(thresholdModel);
    if (key) thresholdCache.set(key, normalized);
    // 只写入触发点：主进程拿它判定，拖动本身不构成「到达阈值」，也不会压缩。
    void saveContextCompactionThreshold(thresholdModel, normalized, { sessionId });
  };

  // 整条进度条都是拖拽区：点哪阈值就跳到哪，按住可以直接拖走。
  // 只把小标记做成纯视觉元素（pointer-events: none），就不会出现「手柄太小抓不住」。
  const handleThresholdPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!thresholdEditable) return;
    const percent = percentFromTrack(trackRef.current, event.clientX);
    thresholdTouchedRef.current = true;
    dragRef.current = { active: true, value: percent, start: threshold };
    setDraggingThreshold(true);
    setThreshold(percent);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleThresholdPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    const percent = percentFromTrack(trackRef.current, event.clientX);
    dragRef.current.value = percent;
    setThreshold(percent);
  };

  // pointerup / pointercancel / 指针被系统收走（lostpointercapture）都走这里收尾，
  // 否则拖到窗口外松手后 drag 状态会卡住，表现为「拖动失灵」。
  const handleThresholdPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    setDraggingThreshold(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // 只是点了一下、阈值没变（比如点回原位）就不必写盘。
    if (dragRef.current.value !== dragRef.current.start) {
      applyThreshold(dragRef.current.value);
    }
  };

  const handleThresholdKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!thresholdEditable) return;
    const step = event.shiftKey ? 10 : 5;
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = threshold - step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = threshold + step;
        break;
      case "Home":
        next = CONTEXT_THRESHOLD_MIN;
        break;
      case "End":
        next = CONTEXT_THRESHOLD_MAX;
        break;
      default:
        return;
    }
    event.preventDefault();
    applyThreshold(next);
  };

  useEffect(() => {
    if (compacting) setCompactRequested(false);
  }, [compacting]);

  const isCompacting = compacting || compactRequested;
  const compactDisabled = isCompacting || !!compactDisabledReason || !onCompact;
  const compactTitle = isCompacting
    ? "正在压缩上下文"
    : compactDisabledReason || "手动压缩上下文";

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

  // 窗口优先用事件上报的，没有就退回模型目录里的静态配置。
  const contextWindow = usage?.contextWindow ?? fallbackContextWindow;
  const usedTokens = usage?.usedTokens;
  const usageRatio = contextWindow && usedTokens !== undefined
    ? Math.min(1, usedTokens / contextWindow)
    : undefined;
  // 没有用量时不拿 0.0% 冒充；也不要用破折号堆成一片横杠，直接说「暂无用量」。
  const percentText = usageRatio === undefined ? "" : `${(usageRatio * 100).toFixed(1)}%`;
  const usageSummary = usedTokens !== undefined
    ? `已使用 ${formatContextTokenAmount(usedTokens)}${contextWindow ? `/${formatContextTokenAmount(contextWindow)}` : ""}`
    : contextWindow
      ? `上下文窗口 ${formatContextTokenAmount(contextWindow)}`
      : "窗口未知";
  // 明细的 token 已按实际总量归一化，因此可直接换算成占窗口的比例。
  const segments = (usage?.breakdown || []).map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    tokens: entry.tokens,
    ratio: contextWindow ? Math.min(1, entry.tokens / contextWindow) : 0,
    color: BREAKDOWN_COLORS[index % BREAKDOWN_COLORS.length],
  }));
  const breakdownTotal = segments.reduce((sum, segment) => sum + segment.tokens, 0);

  // 阈值由主进程统一判定：所有 Agent 都用各自已有的 compact() 接口，
  // 不用改各家 CLI 配置，也不需要重开会话。判定只在回合结束时发生，
  // 所以拖动阈值本身不会触发压缩，要等下一次对话结束。
  // 提示统一成一行「上限 + 换算后的 token」：其它信息交给滑块位置和 tooltip。
  const thresholdTokens = contextWindow ? Math.round(contextWindow * threshold / 100) : undefined;
  const thresholdHint = thresholdTokens
    ? `上下文上限 · 约 ${formatContextTokenAmount(thresholdTokens)}`
    : "上下文上限";

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
          {usageRatio !== undefined
            ? <strong>{percentText}</strong>
            : <strong className="context-usage-summary-idle">暂无用量</strong>}
          <span>{usageSummary}</span>
        </div>

        <div className="context-threshold-row">
          <div
            className={`context-threshold-track${draggingThreshold ? " is-dragging" : ""}${thresholdEditable ? "" : " is-disabled"}`}
            ref={trackRef}
            role="slider"
            tabIndex={thresholdEditable ? 0 : -1}
            aria-label="自动压缩阈值"
            aria-valuemin={CONTEXT_THRESHOLD_MIN}
            aria-valuemax={CONTEXT_THRESHOLD_MAX}
            aria-valuenow={threshold}
            aria-valuetext={`${threshold}%`}
            aria-disabled={!thresholdEditable}
            title={thresholdEditable
              ? "拖动调整自动压缩阈值"
              : "选择模型后可调整"}
            onPointerDown={handleThresholdPointerDown}
            onPointerMove={handleThresholdPointerMove}
            onPointerUp={handleThresholdPointerUp}
            onPointerCancel={handleThresholdPointerUp}
            onLostPointerCapture={handleThresholdPointerUp}
            onKeyDown={handleThresholdKeyDown}
          >
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
            <span
              className="context-threshold-handle"
              style={{ left: `${threshold}%` }}
              aria-hidden="true"
            />
          </div>
          <strong className="context-threshold-value">{threshold}%</strong>
        </div>

        <p className="context-threshold-hint">{thresholdHint}</p>

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
          <p className="context-usage-empty">无明细</p>
        )}

        <div className="context-usage-footnote">
          {usage?.model ? `${usage.model.provider}/${usage.model.id} · ` : ""}
          {usageRatio === undefined
            ? "发送一次消息后显示用量"
            : usage
              ? SOURCE_NOTES[usage.source]
              : ""}
          {!contextWindow ? " · 窗口未知" : ""}
        </div>
      </div>
    </div>
  );
}
