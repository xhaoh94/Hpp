import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronUp,
  Columns2,
  Eye,
  EyeOff,
  FileDiff,
  FileMinus2,
  FilePlus2,
  FolderOpen,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Rows3,
  ScanSearch,
  Undo2,
  X,
} from "lucide-react";
import type { DiffLike } from "@shared/diff-summary";
import type {
  ReviewUndoState,
  ReviewUndoTarget,
} from "@shared/review-undo";
import {
  buildFullFileDiff,
  buildReviewDiff,
  linesToPairs,
  type FullDiffPair,
  type ReviewFileDiff,
} from "@shared/patch-split";
import { uiText } from "@/i18n/text";
import {
  buildHighlightedLines,
  getFilePreviewLanguage,
  type SyntaxToken,
} from "@/lib/file-preview-code";
import { resolveProjectFilePath } from "@/lib/project-file-path";

export type ReviewViewMode = "split" | "unified";

const CODE_REVIEW_VIEW_MODE_STORAGE_KEY = "hpp.codeReview.viewMode";

function getStoredReviewViewMode(): ReviewViewMode {
  try {
    if (typeof window === "undefined") return "unified";
    const value = window.localStorage.getItem(CODE_REVIEW_VIEW_MODE_STORAGE_KEY);
    return value === "split" || value === "unified" ? value : "unified";
  } catch {
    return "unified";
  }
}

function persistReviewViewMode(viewMode: ReviewViewMode) {
  try {
    window.localStorage.setItem(CODE_REVIEW_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // localStorage 可能被禁用；内存中的本次选择仍然有效。
  }
}

export type CodeReviewDialogProps = {
  open: boolean;
  reviewId: string;
  diffs: DiffLike[];
  projectPath?: string;
  /** 打开时初始选中的文件（原始路径或展示路径），不传则选中第一个有补丁的文件。 */
  initialFile?: string;
  onClose: () => void;
  onOpenFile?: (path: string, options?: { preview?: boolean }) => void;
  onUndoStateChange?: (state: ReviewUndoState | null) => void;
};

const MAX_RENDER_LINES = 5000;
const MAX_HIGHLIGHT_CHARS = 2000;
const FILES_MIN_WIDTH = 180;
const FILES_MAX_WIDTH = 420;
const DIFF_MIN_WIDTH = 320;
/** 与 `.chat-review-unified` / `.chat-review-split` 的固定行高保持一致。 */
const REVIEW_ROW_HEIGHT = 22;
/** 完整文件对比读取慢于这个阈值才显示加载态，避免一闪而过的占位。 */
const CONTENT_LOADING_DELAY_MS = 120;
// 定位后盯住落点的窗口：虚拟列表首次测量、reviewState/撤销状态到达都会重排内容，
// 可能把刚设好的 scrollTop 顶掉（症状：“跳对了又滚回第一行”）。
const DIFF_SCROLL_GUARD_MS = 900;
// scrollTop 在这个值以内就算“回到顶部”。
const TOP_SNAP_PX = 2;
/** 诊断开关：在 devtools / e2e 脚本里设 window.__HPP_REVIEW_SCROLL_DEBUG__ = true。 */
const logScroll = (label: string, detail?: unknown) => {
  const enabled = typeof window !== "undefined"
    && (window as Window & { __HPP_REVIEW_SCROLL_DEBUG__?: boolean }).__HPP_REVIEW_SCROLL_DEBUG__ === true;
  if (!enabled) return;
  if (detail === undefined) console.log(`[review-scroll] ${label}`);
  else console.log(`[review-scroll] ${label} ${JSON.stringify(detail)}`);
};

type DialogReviewFile = ReviewFileDiff & {
  canonical: boolean;
  undoable: boolean;
  reverted: boolean;
  undoUnavailableReason?: string;
};

const renderTokens = (tokens: SyntaxToken[]) => {
  if (tokens.length === 0) return <span className="chat-review-code-empty" />;
  return tokens.map((token, index) => (
    <span key={index} className={token.classNames.join(" ") || undefined}>
      {token.text}
    </span>
  ));
};

const MAX_HIGHLIGHT_CACHE_ENTRIES = 2_000;
const highlightCache = new Map<string, SyntaxToken[]>();

const highlightText = (text: string, language?: string): SyntaxToken[] => {
  if (!language || text.length > MAX_HIGHLIGHT_CHARS) return [{ text, classNames: [] }];
  const cacheKey = `${language}\u0000${text}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) return cached;
  const tokens = buildHighlightedLines(text, language)[0] || [];
  highlightCache.set(cacheKey, tokens);
  if (highlightCache.size > MAX_HIGHLIGHT_CACHE_ENTRIES) {
    const oldestKey = highlightCache.keys().next().value;
    if (oldestKey !== undefined) highlightCache.delete(oldestKey);
  }
  return tokens;
};

const isDiffPair = (pair: FullDiffPair) =>
  pair.left?.type === "del" || pair.right?.type === "add";

/** 虚拟列表向父组件暴露的定位能力：按行下标精确滚动，不依赖 DOM 查询。 */
export type ReviewRowsHandle = {
  scrollToIndex: (
    index: number,
    behavior?: "auto" | "smooth",
    align?: "start" | "center" | "end" | "auto",
  ) => void;
  /** 把 [start, end) 这段行整体居中到视口，而不是只居中首行。 */
  scrollToRange: (start: number, end: number) => void;
};

type ReviewVirtualRowsProps = {
  pairs: FullDiffPair[];
  viewMode: ReviewViewMode;
  showDeletedInRight: boolean;
  language?: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  displayFile: string;
  undoable: boolean;
  undoBusy: boolean;
  undoingKey: string | null;
  onHunkUndoRef: RefObject<((hunkIndex: number, changeIndex: number) => void) | null>;
};

type ReviewRowProps = ReviewVirtualRowsProps & {
  pair: FullDiffPair;
  index: number;
};

const EMPTY_TOKENS: SyntaxToken[] = [];

/**
 * 单行惰性渲染。
 *
 * 高亮曾经在父组件里对整份 diff（最多 MAX_RENDER_LINES 行）一次性计算，
 * 打开审核时同步算几千行 —— 首次定位被高亮算力拖到几百毫秒之后，
 * 而且文件内容读回来后还要整份重算一次。虚拟列表实际只渲染几十行，
 * 把高亮下沉到行组件后，首帧与二次定位都只剩可见行的开销。
 */
const ReviewRow = memo(function ReviewRow({
  pair,
  index,
  viewMode,
  showDeletedInRight,
  language,
  displayFile,
  undoable,
  undoBusy,
  undoingKey,
  onHunkUndoRef,
}: ReviewRowProps) {
  const leftText = pair.left?.text;
  const rightText = pair.right?.text;
  const leftTokens = useMemo(
    () => (leftText === undefined ? EMPTY_TOKENS : highlightText(leftText, language)),
    [leftText, language],
  );
  const rightTokens = useMemo(
    () => (rightText === undefined ? EMPTY_TOKENS : highlightText(rightText, language)),
    [rightText, language],
  );

  const undoButton = pair.changeStart
    && pair.hunkIdx !== undefined
    && pair.changeIdx !== undefined
    && undoable
    ? (
      <button
        type="button"
        className="chat-review-hunk-undo"
        onClick={() => onHunkUndoRef.current?.(pair.hunkIdx!, pair.changeIdx!)}
        disabled={undoBusy}
        title="撤销此段修改"
      >
        {undoingKey === `hunk:${displayFile}:${pair.hunkIdx}:${pair.changeIdx}` ? (
          <Loader2 className="chat-review-spin" size={11} />
        ) : (
          <Undo2 size={11} strokeWidth={2.2} />
        )}
        <span>撤销</span>
      </button>
    )
    : null;

  if (viewMode === "unified") {
    const type = pair.left?.type === "del"
      ? "del"
      : pair.right?.type === "add"
        ? "add"
        : "context";
    const cell = pair.left ?? pair.right;
    const tokens = pair.left ? leftTokens : rightTokens;
    return (
      <div
        className={`chat-review-line ${type}`}
        data-review-diff-index={isDiffPair(pair) ? index : undefined}
        data-review-row-index={index}
      >
        <span className="chat-review-line-no">
          {type === "del"
            ? pair.left?.lineNo ?? ""
            : pair.right?.lineNo ?? pair.left?.lineNo ?? ""}
        </span>
        <span className="chat-review-marker" aria-hidden="true">
          {type === "del" ? "-" : type === "add" ? "+" : " "}
        </span>
        <span className="chat-review-code">
          {cell ? renderTokens(tokens) : <span className="chat-review-code-empty" />}
        </span>
        {undoButton}
      </div>
    );
  }

  const renderSide = (side: "left" | "right") => {
    const cell = side === "left"
      ? pair.left
      : pair.right || (showDeletedInRight && pair.left?.type === "del" ? pair.left : undefined);
    if (!cell) return <div className="chat-review-col-line empty" aria-hidden="true" />;
    const isDiff = cell.type === (side === "left" ? "del" : "add");
    const hiddenDeletedOnRight = side === "left"
      && !!pair.left
      && pair.left.type === "del"
      && !pair.right
      && !showDeletedInRight;
    return (
      <div
        className={`chat-review-col-line ${cell.type}`}
        data-review-diff-index={isDiff ? index : undefined}
      >
        <span className="chat-review-line-no">{cell.lineNo}</span>
        <span className="chat-review-code">
          {renderTokens(side === "left" ? leftTokens : rightTokens)}
        </span>
        {hiddenDeletedOnRight ? undoButton : side === "right" ? undoButton : null}
      </div>
    );
  };

  return (
    <div className="chat-review-split-row" data-review-row-index={index}>
      <div className="chat-review-col left">{renderSide("left")}</div>
      <div className="chat-review-col right">{renderSide("right")}</div>
    </div>
  );
});

const ReviewVirtualRows = forwardRef<ReviewRowsHandle, ReviewVirtualRowsProps>(
  function ReviewVirtualRows({
    pairs,
    viewMode,
    showDeletedInRight,
    language,
    scrollRef,
    displayFile,
    undoable,
    undoBusy,
    undoingKey,
    onHunkUndoRef,
  }, ref) {
    const getScrollElement = useCallback(() => scrollRef.current, [scrollRef]);
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
      count: pairs.length,
      getScrollElement,
      // 估算行高必须等于真实行高，否则定位到文件深处时会按行数累计出上千像素的偏移。
      estimateSize: () => REVIEW_ROW_HEIGHT,
      // 行 key 只能用下标。行号不是唯一标识：同一份补丁里旧/新行号会撞车（换位、合并补丁尤甚），
      // 撞车的 key 会让 React 把多行重复渲染到同一个 transform 上，视觉上就是同一行的文字叠在一起。
      getItemKey: (index) => index,
      overscan: 20,
      useAnimationFrameWithResizeObserver: true,
    });

    // 父组件直接按下标定位（不查 DOM）。虚拟列表在目标行尚未测量时按行高估算，
    // 换行长行会有少量偏差；默认对齐到顶部（start），滚动距离短、偏差小。
    useImperativeHandle(ref, () => ({
      scrollToIndex: (
        index: number,
        behavior: "auto" | "smooth" = "auto",
        align: "start" | "center" | "end" | "auto" = "center",
      ) => {
        virtualizer.scrollToIndex(index, { align, behavior });
      },
      // 变更块可能有很多行：只把首行放中间会让整块内容沉到视口下半部，
      // 所以按「首行上沿 ~ 尾后行上沿」的中线来对。
      scrollToRange: (start: number, end: number) => {
        const scrollEl = virtualizer.scrollElement;
        if (!scrollEl) return;
        const startInfo = virtualizer.getOffsetForIndex(start, "start");
        if (!startInfo) return;
        const blockTop = startInfo[0];
        // end 是变更块后的第一行，它的上沿就是块的结束边界；块在文件末尾或用
        // 未测量的行时退回估算。
        const endInfo = end > start && end < virtualizer.options.count
          ? virtualizer.getOffsetForIndex(end, "start")
          : undefined;
        const fallbackSize = virtualizer.options.estimateSize(end - 1);
        const blockBottom = endInfo ? endInfo[0] : blockTop + Math.max(1, end - start) * fallbackSize;
        // 变更块整块居中；但块比视口还高时居中会把首行推出可视线，
        // 此时改为对齐顶部，保证能先看到改动起点。
        const blockHeight = blockBottom - blockTop;
        const target = blockHeight <= scrollEl.clientHeight
          ? Math.max(0, (blockTop + blockBottom) / 2 - scrollEl.clientHeight / 2)
          : blockTop;
        // 直接跳：文件深处的改动点一翻要滑好几千像素，任何持续时间的动画
        // 都是在拖时间（用户明确要求不要动画）。
        scrollEl.scrollTo({ top: target, behavior: "auto" });
      },
    }), [virtualizer]);

    return (
      <div
        className={`chat-review-virtual-list ${viewMode === "split" ? "split" : "unified"}`}
        style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const pair = pairs[virtualRow.index];
          if (!pair) return null;
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className="chat-review-virtual-row"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <ReviewRow
                pair={pair}
                index={virtualRow.index}
                pairs={pairs}
                viewMode={viewMode}
                showDeletedInRight={showDeletedInRight}
                language={language}
                scrollRef={scrollRef}
                displayFile={displayFile}
                undoable={undoable}
                undoBusy={undoBusy}
                undoingKey={undoingKey}
                onHunkUndoRef={onHunkUndoRef}
              />
            </div>
          );
        })}
      </div>
    );
  },
);

function FileStatusIcon({ status }: { status: ReviewFileDiff["status"] }) {
  if (status === "added") return <FilePlus2 size={14} strokeWidth={2} />;
  if (status === "deleted") return <FileMinus2 size={14} strokeWidth={2} />;
  return <FileDiff size={14} strokeWidth={2} />;
}

export function CodeReviewDialog({
  open,
  reviewId,
  diffs,
  projectPath,
  initialFile,
  onClose,
  onOpenFile,
  onUndoStateChange,
}: CodeReviewDialogProps) {
  const [activeFileKey, setActiveFileKey] = useState<string | null>(null);
  // 首次默认统一视图；用户切换后保存偏好，后续打开 review 按用户上次选择恢复。
  const [viewMode, setViewMode] = useState<ReviewViewMode>(getStoredReviewViewMode);
  const handleViewModeChange = (next: ReviewViewMode) => {
    setViewMode(next);
    persistReviewViewMode(next);
  };
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [filesWidth, setFilesWidth] = useState(220);
  const [filesResizing, setFilesResizing] = useState(false);
  const [showDeletedInRight, setShowDeletedInRight] = useState(false);
  const [diffCursor, setDiffCursor] = useState(0);
  const [fileContent, setFileContent] = useState<Record<string, string | null>>({});
  const loadedRef = useRef<Set<string>>(new Set());
  const scrolledRef = useRef<string | null>(null);
  const diffPairIndicesRef = useRef<number[]>([]);
  const diffPairEndsRef = useRef<number[]>([]);
  const diffScrollRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<ReviewRowsHandle | null>(null);
  const onHunkUndoRef = useRef<((hunkIndex: number, changeIndex: number) => void) | null>(null);
  const reviewBodyRef = useRef<HTMLDivElement | null>(null);
  const reviewGenerationRef = useRef(0);
  const operationCounterRef = useRef(0);
  const activeOperationRef = useRef<{ id: number; generation: number } | null>(null);
  const [reviewState, setReviewState] = useState<ReviewUndoState | null>(null);
  const [preparingUndo, setPreparingUndo] = useState(false);
  const [undoingKey, setUndoingKey] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);

  const sourceFiles = useMemo(() => buildReviewDiff(diffs, projectPath), [diffs, projectPath]);
  const reviewSources = useMemo(
    () => sourceFiles.map((file) => ({
      file: file.file,
      patches: file.patches,
      status: file.status,
      statusExplicit: file.statusExplicit === true,
    })),
    [sourceFiles],
  );
  const reviewSourceFingerprint = useMemo(() => JSON.stringify(reviewSources), [reviewSources]);

  // 打开时回到初始选中的文件（或第一个有补丁的文件）。视图模式不在这里重置，
  // 这样用户选择的 unified/split 偏好会跨 review、关闭和重新打开保持。
  // useLayoutEffect（声明靠前）确保在默认定位 useLayoutEffect 之前重置 scrolledRef，
  // 使重新打开同一文件时能再次以 auto 立即定位。
  useLayoutEffect(() => {
    if (!open) return;
    setActiveFileKey(initialFile ?? null);
    setDiffCursor(0);
    setUndoError(null);
    scrolledRef.current = null;
  }, [open, initialFile]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const getMaxFilesWidth = () => {
    const bodyWidth = reviewBodyRef.current?.clientWidth ?? FILES_MAX_WIDTH + DIFF_MIN_WIDTH;
    return Math.max(FILES_MIN_WIDTH, Math.min(FILES_MAX_WIDTH, bodyWidth - DIFF_MIN_WIDTH));
  };

  const clampFilesWidth = (width: number) =>
    Math.max(FILES_MIN_WIDTH, Math.min(getMaxFilesWidth(), width));

  useEffect(() => {
    if (!filesResizing) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (event: PointerEvent) => {
      const body = reviewBodyRef.current;
      if (!body) return;
      const bodyRect = body.getBoundingClientRect();
      setFilesWidth(clampFilesWidth(event.clientX - bodyRect.left));
    };
    const handlePointerUp = () => setFilesResizing(false);

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [filesResizing]);

  const handleFilesResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setFilesCollapsed(false);
    setFilesResizing(true);
  };

  const handleFilesResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    setFilesCollapsed(false);
    setFilesWidth((width) => clampFilesWidth(width + (event.key === "ArrowRight" ? 16 : -16)));
  };

  useLayoutEffect(() => {
    reviewGenerationRef.current += 1;
    activeOperationRef.current = null;
    setUndoingKey(null);
    setReviewState(null);
    setPreparingUndo(false);
    setUndoError(null);
    setFileContent({});
    loadedRef.current.clear();
    scrolledRef.current = null;
    onUndoStateChange?.(null);
  }, [reviewId, projectPath, reviewSourceFingerprint]);

  useEffect(() => {
    const generation = reviewGenerationRef.current;
    if (!open) {
      setPreparingUndo(false);
      return;
    }
    if (!projectPath || reviewSources.length === 0) {
      setReviewState(null);
      setPreparingUndo(false);
      return;
    }
    let cancelled = false;
    setReviewState(null);
    setPreparingUndo(true);
    setUndoError(null);
    void window.electronAPI.prepareReviewUndo({
      reviewId,
      projectPath,
      files: reviewSources,
    }).then(
      (result) => {
        if (cancelled || reviewGenerationRef.current !== generation) return;
        if (!result.success) {
          setUndoError(result.error || "无法准备安全撤销");
          return;
        }
        setReviewState(result.state);
        onUndoStateChange?.(result.state);
      },
      (error) => {
        if (!cancelled && reviewGenerationRef.current === generation) {
          setUndoError(error instanceof Error ? error.message : String(error));
        }
      },
    ).finally(() => {
      if (!cancelled && reviewGenerationRef.current === generation) setPreparingUndo(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, reviewId, projectPath, reviewSourceFingerprint]);

  const files = useMemo<DialogReviewFile[]>(() => {
    const preparedByFile = new Map(reviewState?.files.map((file) => [file.file, file]) || []);
    return sourceFiles.map((source) => {
      const prepared = preparedByFile.get(source.file);
      if (!prepared) {
        return {
          ...source,
          canonical: false,
          undoable: false,
          reverted: false,
        };
      }
      if (prepared.error) {
        return {
          ...source,
          canonical: false,
          undoable: false,
          reverted: false,
          undoUnavailableReason: prepared.error,
        };
      }
      const parsed = prepared.patch.trim()
        ? buildReviewDiff([{
            file: source.file,
            patch: prepared.patch,
            status: prepared.status,
            statusExplicit: true,
          }], projectPath)[0]
        : undefined;
      return {
        ...source,
        status: prepared.status,
        additions: prepared.additions,
        deletions: prepared.deletions,
        hasPatch: !!prepared.patch.trim(),
        patch: prepared.patch,
        patches: prepared.patch.trim() ? [prepared.patch] : [],
        lines: parsed?.lines || [],
        canonical: true,
        undoable: prepared.undoable,
        reverted: prepared.reverted,
      };
    });
  }, [sourceFiles, reviewState, projectPath]);

  const active = useMemo(() => {
    if (files.length === 0) return null;
    const selected = activeFileKey
      ? files.find((file) => file.displayFile === activeFileKey || file.file === activeFileKey)
      : undefined;
    return selected || files.find((file) => file.hasPatch) || files[0];
  }, [files, activeFileKey]);

  // 切换文件时重置差异游标。
  useEffect(() => {
    setDiffCursor(0);
    setUndoError(null);
  }, [active?.displayFile]);

  const resolvedPath = useMemo(() => {
    if (!active) return "";
    return resolveProjectFilePath(active.file, projectPath || "");
  }, [active, projectPath]);

  // 当前版本参与缓存键。局部或文件撤销成功后版本递增，文件内容会立即重新读取。
  useEffect(() => {
    if (!open || !active) return;
    const version = reviewState?.version ?? -1;
    const cacheKey = `${projectPath || ""}\0${active.displayFile}\0${version}`;
    if (loadedRef.current.has(cacheKey)) return;
    let cancelled = false;
    const path = resolveProjectFilePath(active.file, projectPath || "");
    loadedRef.current.add(cacheKey);
    void window.electronAPI.readFile(path).then(
      (result) => {
        if (cancelled) return;
        setFileContent((prev) => ({
          ...prev,
          [active.displayFile]: result.success ? result.content ?? "" : null,
        }));
      },
      () => {
        if (cancelled) return;
        setFileContent((prev) => ({ ...prev, [active.displayFile]: null }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, active, projectPath, reviewState?.version]);

  // 规范化补丁始终表示「基线 → 当前磁盘内容」，因此每次撤销后都能重新构建真实剩余 diff。
  // 无法安全规范化的原始补丁仅使用 patch-only 回退视图，不参与写盘。
  // 依赖只列真正影响行集合的字段：undoState（本次审阅的撤销状态）到达会让
  // active 对象重建，但行集合并不变——如果依赖整个 active，pairs 会换一个新数组，
  // 虚拟列表重建后 scrollTop 归零，就是「跳对了又滚回第一行」。
  const pairs = useMemo((): FullDiffPair[] | null => {
    if (!active) return null;
    if (active.reverted) return [];
    const content = fileContent[active.displayFile];
    if (!active.canonical) return linesToPairs(active.lines);
    if (content === undefined) return linesToPairs(active.lines);
    if (content !== null && active.patch.trim()) return buildFullFileDiff(content, active.patch);
    return linesToPairs(active.lines);
  }, [
    active?.displayFile,
    active?.canonical,
    active?.reverted,
    active?.patch,
    active?.lines,
    fileContent,
  ]);

  const language = useMemo(
    () => (active ? getFilePreviewLanguage(active.file) || undefined : undefined),
    [active],
  );

  // 完整文件对比未就绪时先不展示 diff 区（也就不会先停在文件顶部再等一次跳转）。
  // 读取很快时静默等待，避免闪一下加载态。
  const needsFullContent = !!active && active.canonical && !active.reverted && active.patch.trim().length > 0;
  const activeContentReady = !!active && fileContent[active.displayFile] !== undefined;
  // 规范化补丁（reviewState）还在路上：此时 active.canonical=false 只是暂时状态，
  // 不能拿它当成“最终行集合”，否则定位会先落在 patch 视图的错位置上。
  const waitingForCanonical = !!projectPath && reviewSources.length > 0 && !reviewState && !undoError;
  const waitingForContent = needsFullContent && !activeContentReady;
  const [showContentLoading, setShowContentLoading] = useState(false);
  useEffect(() => {
    if (!waitingForContent && !waitingForCanonical) {
      setShowContentLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowContentLoading(true), CONTENT_LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [waitingForContent, waitingForCanonical, active?.displayFile]);

  // 虚拟列表按需渲染，只把前 MAX_RENDER_LINES 行交给它；高亮下沉到行组件，
  // 这里不再整份预计算。
  const renderPairs = useMemo(() => {
    if (!pairs) return [];
    return pairs.length > MAX_RENDER_LINES ? pairs.slice(0, MAX_RENDER_LINES) : pairs;
  }, [pairs]);

  const truncated = !!pairs && pairs.length > MAX_RENDER_LINES;

  // 修改点定位：连续的增删行合并为同一个修改点，记录每个连续块的「首行」和「尾后行」。
  // 首行用于 cursor 导航，两者一起用于「整块居中」（只居中首行时，
  // 一个 30 行的变更块会把内容全推到视口下半部）。
  const { diffPairIndices, diffPairEnds } = useMemo(() => {
    const starts: number[] = [];
    const ends: number[] = [];
    let prevIsDiff = false;
    renderPairs.forEach((pair, index) => {
      const isDiff = isDiffPair(pair);
      if (isDiff && !prevIsDiff) starts.push(index);
      if (!isDiff && prevIsDiff) ends.push(index);
      prevIsDiff = isDiff;
    });
    // 最后一个块一直到行集合末尾。
    while (ends.length < starts.length) ends.push(renderPairs.length);
    return { diffPairIndices: starts, diffPairEnds: ends };
  }, [renderPairs]);

  const totalDiffs = diffPairIndices.length;
  diffPairIndicesRef.current = diffPairIndices;
  diffPairEndsRef.current = diffPairEnds;

  const fileReverted = !!active?.reverted;
  const undoBusy = preparingUndo || undoingKey !== null;

  const applyUndo = async (target: ReviewUndoTarget, key: string) => {
    if (!reviewState || activeOperationRef.current) return;
    const generation = reviewGenerationRef.current;
    const operationId = operationCounterRef.current + 1;
    operationCounterRef.current = operationId;
    activeOperationRef.current = { id: operationId, generation };
    const isCurrentOperation = () =>
      reviewGenerationRef.current === generation
      && activeOperationRef.current?.id === operationId;
    setUndoingKey(key);
    setUndoError(null);
    try {
      const result = await window.electronAPI.applyReviewUndo(
        reviewState.transactionId,
        reviewState.version,
        target,
      );
      if (!isCurrentOperation()) return;
      if (!result.success) {
        if (result.stale && projectPath) {
          const refreshed = await window.electronAPI.prepareReviewUndo({
            reviewId,
            projectPath,
            files: reviewSources,
          });
          if (refreshed.success && isCurrentOperation()) {
            setReviewState(refreshed.state);
            onUndoStateChange?.(refreshed.state);
          }
        }
        if (isCurrentOperation()) setUndoError(result.error || "撤销失败");
        return;
      }
      setFileContent({});
      setReviewState(result.state);
      onUndoStateChange?.(result.state);
      scrolledRef.current = null;
    } catch (error) {
      if (isCurrentOperation()) {
        setUndoError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (activeOperationRef.current?.id === operationId) {
        activeOperationRef.current = null;
        setUndoingKey(null);
      }
    }
  };

  const handleFileUndo = () => {
    if (!active?.undoable) return;
    void applyUndo(
      { kind: "file", file: active.file },
      `file:${active.displayFile}`,
    );
  };

  const handleHunkUndo = (hunkIndex: number, changeIndex: number) => {
    if (!active?.undoable) return;
    void applyUndo(
      { kind: "hunk", file: active.file, hunkIndex, changeIndex },
      `hunk:${active.displayFile}:${hunkIndex}:${changeIndex}`,
    );
  };

  const handleUndoAll = () => {
    if (!reviewState?.canUndoAll) return;
    void applyUndo({ kind: "all" }, "all");
  };

  const fileUndoing = !!active && undoingKey === `file:${active.displayFile}`;
  const allUndoing = undoingKey === "all";

  // 行组件通过 ref 拿到撤销回调：函数引用不再参与 memo 比较，
  // 否则每次父组件重渲染都会让所有可见行失效。
  useLayoutEffect(() => {
    onHunkUndoRef.current = handleHunkUndo;
  });

  /**
   * 定位到第 cursor 个修改点。
   *
   * 直接交给虚拟列表按行下标滚动，不再先查 DOM / 找 fallback 行：
   * 目标行在文件深处时一定没被渲染，查 DOM 必然失败，只能退回“按估算行高猜一个位置”，
   * 这一猜就是首次打开时那段看起来像延迟的无效滚动。
   */
  const scrollToDiff = (cursor: number) => {
    const container = diffScrollRef.current;
    const rows = rowsRef.current;
    if (!container || !rows) {
      logScroll("scrollToDiff:skip", { hasContainer: !!container, hasRows: !!rows });
      return;
    }
    const pairIndex = diffPairIndicesRef.current[cursor];
    if (pairIndex === undefined) {
      logScroll("scrollToDiff:no-pair", { cursor, pairs: diffPairIndicesRef.current.length });
      return;
    }
    const pairEnd = diffPairEndsRef.current[cursor] ?? pairIndex + 1;

    // 整块居中：把「变更首行上沿 ~ 尾后行上沿」的中线对到视口中线。
    // 只居中首行的话，一个 30 行的变更块会整体沉到视口下半部。
    rows.scrollToRange(pairIndex, pairEnd);
    logScroll("scrollToDiff:done", {
      cursor,
      pairIndex,
      pairEnd,
      blockRows: pairEnd - pairIndex,
      scrollTop: Math.round(container.scrollTop),
      scrollHeight: Math.round(container.scrollHeight),
      clientHeight: Math.round(container.clientHeight),
    });
    // 不再自己算 relativeTop 再 scrollTo：虚拟列表测量中时目标元素可能还停在
    // 上一帧的位置，"目标在视口上方 + scrollTop 不足" 会把 top 算成负数，
    // clamp 到 0 就是“滚回第一行”。改成盯住落点，被顶掉了才用同一接口重定位。
    guardDiffScroll(cursor);
  };

  /**
   * 定位后的短窗口守护。
   *
   * 录屏确认的时序：打开停在改动处约 250ms，然后 scrollTop 被归零回到第 1 行。
   * 根源是打开后陆续到达的异步状态（文件内容、undoState、审阅状态）引起重渲染，
   * 虚拟列表重新测量后把滚动位置丢了。这里只在“真的回到顶部”时补一次，
   * 并按最新的行下标重定位（行集合可能已经洗过牌）；用户一旦自己滚动/按键就停手。
   */
  const guardDiffScroll = (cursor: number) => {
    const container = diffScrollRef.current;
    if (!container) return;
    const startedAt = performance.now();
    let canceled = false;
    let attempts = 0;
    const cancel = () => { canceled = true; };
    container.addEventListener("wheel", cancel, { passive: true });
    container.addEventListener("touchstart", cancel, { passive: true });
    container.addEventListener("pointerdown", cancel);
    const stop = () => {
      container.removeEventListener("wheel", cancel);
      container.removeEventListener("touchstart", cancel);
      container.removeEventListener("pointerdown", cancel);
    };
    const tick = () => {
      if (canceled || performance.now() - startedAt > DIFF_SCROLL_GUARD_MS) {
        stop();
        return;
      }
      const rows = rowsRef.current;
      const scrollContainer = diffScrollRef.current;
      if (!rows || !scrollContainer || !scrollContainer.isConnected) {
        stop();
        return;
      }
      // 只处理“被打回顶部”；部分偏移不动，避免和测量误差打架。
      // 最多补 6 次（改动本来就在第 1 行时这里不会反复重试）。
      if (scrollContainer.scrollTop <= TOP_SNAP_PX && attempts < 6) {
        const pairIndex = diffPairIndicesRef.current[cursor];
        if (pairIndex === undefined) {
          stop();
          return;
        }
        attempts += 1;
        logScroll("guard:re-pin", {
          cursor,
          pairIndex,
          attempt: attempts,
          t: Math.round(performance.now() - startedAt),
        });
        rows.scrollToRange(pairIndex, diffPairEndsRef.current[cursor] ?? pairIndex + 1);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  // 行集合是否已经稳定到可以定位：补丁视图（无法规范化/没有完整内容可用）
  // 或完整文件对比（规范化补丁 + 磁盘内容都就绪）。
  const diffLayoutReady = !active
    || active.patch.trim().length === 0
    // canonical=true：等磁盘内容读回（行集合才完整）；
    // canonical=false：只有“不再等 reviewState”时才把 patch 视图当成最终形态。
    || (active.canonical ? activeContentReady : !waitingForCanonical);
  // 视图模式也算行集合的一部分：unified/split 的行结构与行高不同，切换后要立即
  // 重新定位，而不是从旧偏移平滑滚过去。
  // canonical 必须包含在 key 里：patch 视图的行下标和完整文件完全不同，规范化
  // 结果（reviewState 到达）是一次真正的行集合重建，必须重新定位；否则会停在
  // 一个按 patch 算出来的错位置，而且因为“只定位一次”永远不会再纠。
  const diffLayoutKey = active
    ? `${active.displayFile}::${active.canonical ? "full" : "patch"}::${viewMode}`
    : "";

  // 默认定位到当前文件的第一个变化点；同一个「文件 + 行集合形态 + 视图」只走一次。
  // useLayoutEffect：commit 后、paint 前执行，第一眼就在变更处。
  useLayoutEffect(() => {
    if (!open || !active || pairs === null) {
      logScroll("effect:skip", { open, hasActive: !!active, pairs: pairs === null ? "null" : pairs.length });
      return;
    }
    if (!diffLayoutReady) {
      logScroll("effect:not-ready", {
        canonical: active.canonical,
        contentReady: activeContentReady,
        waitingForCanonical,
        hasReviewState: !!reviewState,
        undoError,
        preparingUndo,
      });
      return;
    }
    if (diffPairIndices.length === 0) {
      logScroll("effect:no-diff");
      return;
    }
    if (!rowsRef.current) {
      logScroll("effect:no-rows-ref");
      return;
    }
    // 已经为这个文件（+视图）定过位：后续行集合变化不再自动滚动，
    // 翻页只由 goPrevDiff / goNextDiff 触发。
    if (scrolledRef.current === diffLayoutKey) {
      logScroll("effect:already-scrolled", diffLayoutKey);
      return;
    }
    scrolledRef.current = diffLayoutKey;
    // 用户可能已翻页，定位到当前游标而非总是第一个。
    const cursor = Math.min(diffCursor, diffPairIndices.length - 1);
    if (cursor !== diffCursor) setDiffCursor(cursor);
    logScroll("effect:scroll", {
      key: diffLayoutKey,
      cursor,
      pairs: pairs.length,
      diffs: diffPairIndices.length,
      waitingForCanonical,
      hasReviewState: !!reviewState,
      undoError,
      contentReady: activeContentReady,
    });
    scrollToDiff(cursor);
  }, [
    open,
    active,
    pairs,
    diffPairIndices,
    fileContent,
    diffCursor,
    diffLayoutReady,
    diffLayoutKey,
  ]);

  const goPrevDiff = () => {
    const next = Math.max(0, diffCursor - 1);
    setDiffCursor(next);
    scrollToDiff(next);
  };

  const goNextDiff = () => {
    const next = Math.min(totalDiffs - 1, diffCursor + 1);
    setDiffCursor(next);
    scrollToDiff(next);
  };

  if (!open) return null;

  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);

  const handleReveal = () => {
    if (!active || !projectPath) return;
    void window.electronAPI.showItemInFolder(resolvedPath);
  };

  const handleOpen = () => {
    if (!active || !onOpenFile) return;
    onClose();
    onOpenFile(resolvedPath, { preview: true });
  };

  return createPortal(
    <div className="chat-review-overlay" onMouseDown={onClose}>
      <div
        className="chat-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={uiText.review.audit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="chat-review-header">
          <div className="chat-review-header-title">
            <span className="chat-review-header-icon" aria-hidden="true">
              <ScanSearch size={18} strokeWidth={1.9} />
            </span>
            <span className="chat-review-header-name">{uiText.review.audit}</span>
            <span className="chat-review-header-stats">
              {files.length > 0 && (
                <>
                  <span>{uiText.review.fileCount(files.length)}</span>
                  <span className="chat-diff-add">+{totalAdditions}</span>
                  <span className="chat-diff-del">-{totalDeletions}</span>
                </>
              )}
            </span>
          </div>
          <div className="chat-review-toolbar">
            <div className="chat-review-nav" role="group" aria-label={uiText.review.diffNav}>
              <button
                type="button"
                className="chat-review-tool-btn"
                onClick={goPrevDiff}
                disabled={totalDiffs === 0 || (totalDiffs > 1 && diffCursor <= 0)}
                title={uiText.review.prevDiff}
                aria-label={uiText.review.prevDiff}
              >
                <ChevronUp size={15} strokeWidth={2} />
              </button>
              <span className="chat-review-nav-count">
                {totalDiffs === 0 ? "0/0" : `${Math.min(diffCursor + 1, totalDiffs)}/${totalDiffs}`}
              </span>
              <button
                type="button"
                className="chat-review-tool-btn"
                onClick={goNextDiff}
                disabled={totalDiffs === 0 || (totalDiffs > 1 && diffCursor >= totalDiffs - 1)}
                title={uiText.review.nextDiff}
                aria-label={uiText.review.nextDiff}
              >
                <ChevronDown size={15} strokeWidth={2} />
              </button>
            </div>
            {viewMode === "split" && (
              <button
                type="button"
                className={`chat-review-tool-btn ${showDeletedInRight ? "active" : ""}`}
                onClick={() => setShowDeletedInRight((value) => !value)}
                title={showDeletedInRight ? uiText.review.hideDeleted : uiText.review.showDeleted}
                aria-label={showDeletedInRight ? uiText.review.hideDeleted : uiText.review.showDeleted}
                aria-pressed={showDeletedInRight}
              >
                {showDeletedInRight ? (
                  <Eye size={15} strokeWidth={1.9} />
                ) : (
                  <EyeOff size={15} strokeWidth={1.9} />
                )}
              </button>
            )}
            <div className="chat-review-mode-toggle" role="group" aria-label={uiText.review.viewMode}>
              <button
                type="button"
                className={viewMode === "split" ? "active" : ""}
                onClick={() => handleViewModeChange("split")}
                title={uiText.review.splitView}
                aria-pressed={viewMode === "split"}
              >
                <Columns2 size={14} strokeWidth={2} />
                <span>{uiText.review.splitView}</span>
              </button>
              <button
                type="button"
                className={viewMode === "unified" ? "active" : ""}
                onClick={() => handleViewModeChange("unified")}
                title={uiText.review.unifiedView}
                aria-pressed={viewMode === "unified"}
              >
                <Rows3 size={14} strokeWidth={2} />
                <span>{uiText.review.unifiedView}</span>
              </button>
            </div>
            <button
              type="button"
              className="chat-review-tool-btn"
              onClick={handleReveal}
              disabled={!active || !projectPath}
              title={uiText.review.locate}
              aria-label={uiText.review.locate}
            >
              <FolderOpen size={15} strokeWidth={1.9} />
            </button>
            {onOpenFile && (
              <button
                type="button"
                className="chat-review-tool-btn"
                onClick={handleOpen}
                disabled={!active || !projectPath}
                title={uiText.review.open}
                aria-label={uiText.review.open}
              >
                <Eye size={15} strokeWidth={1.9} />
              </button>
            )}
            <button
              type="button"
              className="chat-review-tool-btn"
              onClick={onClose}
              title={uiText.review.close}
              aria-label={uiText.review.close}
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        </div>

        {files.length === 0 ? (
          <div className="chat-review-empty">{uiText.review.noChanges}</div>
        ) : (
          <div ref={reviewBodyRef} className="chat-review-body">
            <aside
              className={`chat-review-files ${filesCollapsed ? "collapsed" : ""} ${filesResizing ? "resizing" : ""}`}
              style={filesCollapsed ? undefined : { flexBasis: `${filesWidth}px` }}
            >
              <div className="chat-review-files-head">
                {!filesCollapsed && <span className="chat-review-files-title">{uiText.review.files}</span>}
                <button
                  type="button"
                  className="chat-review-files-collapse"
                  onClick={() => setFilesCollapsed((value) => !value)}
                  title={filesCollapsed ? uiText.review.expandFiles : uiText.review.collapseFiles}
                  aria-label={filesCollapsed ? uiText.review.expandFiles : uiText.review.collapseFiles}
                >
                  {filesCollapsed ? (
                    <PanelLeftOpen size={15} strokeWidth={1.9} />
                  ) : (
                    <PanelLeftClose size={15} strokeWidth={1.9} />
                  )}
                </button>
              </div>
              <div className="chat-review-files-list">
                {files.map((file) => {
                  const isActive = file.displayFile === active?.displayFile;
                  return (
                    <button
                      type="button"
                      key={file.file}
                      className={`chat-review-file-item ${isActive ? "active" : ""}`}
                      onClick={() => setActiveFileKey(file.displayFile)}
                      title={file.displayFile}
                    >
                      <span className="chat-review-file-status" aria-hidden="true">
                        <FileStatusIcon status={file.status} />
                      </span>
                      <span className="chat-review-file-path">{file.displayFile}</span>
                      <span className="chat-review-file-stats">
                        <span className="chat-diff-add">+{file.additions}</span>
                        <span className="chat-diff-del">-{file.deletions}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {!filesCollapsed && projectPath && (
                <div className="chat-review-files-footer">
                  <button
                    type="button"
                    className="chat-review-revert-all-btn"
                    onClick={handleUndoAll}
                    disabled={undoBusy || !reviewState?.canUndoAll}
                    title={reviewState?.undoAllReason || "撤销本次全部修改"}
                    aria-label={reviewState?.undoAllReason || "撤销本次全部修改"}
                  >
                    {preparingUndo || allUndoing ? (
                      <Loader2 className="chat-review-spin" size={14} strokeWidth={2} />
                    ) : (
                      <Undo2 size={14} strokeWidth={2} />
                    )}
                    <span>{reviewState?.allReverted ? "已撤销" : "撤销全部修改"}</span>
                  </button>
                </div>
              )}
              <div
                className="chat-review-files-resizer"
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label={uiText.review.resizeFiles}
                aria-valuemin={FILES_MIN_WIDTH}
                aria-valuemax={getMaxFilesWidth()}
                aria-valuenow={filesCollapsed ? 40 : Math.round(filesWidth)}
                title={uiText.review.resizeFiles}
                onPointerDown={handleFilesResizeStart}
                onKeyDown={handleFilesResizeKeyDown}
              />
            </aside>

            <div className="chat-review-content">
              {!active ? null : !active.hasPatch && !active.reverted ? (
                <>
                  <div className="chat-review-empty">{preparingUndo ? uiText.review.loading : uiText.review.noPatch}</div>
                  {active.undoUnavailableReason && (
                    <div className="chat-review-undo-error" role="status">
                      此文件无法安全撤销：{active.undoUnavailableReason}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="chat-review-file-head">
                    <span className="chat-review-file-title" title={active.displayFile}>
                      <FileStatusIcon status={active.status} />
                      <span>{active.displayFile}</span>
                    </span>
                    {active.undoable && projectPath && (
                      <button
                        type="button"
                        className="chat-review-file-undo"
                        onClick={handleFileUndo}
                        disabled={undoBusy}
                        title="撤销此文件的所有修改"
                      >
                        {fileUndoing ? (
                          <Loader2 className="chat-review-spin" size={14} />
                        ) : (
                          <Undo2 size={14} strokeWidth={2} />
                        )}
                        <span>撤销文件</span>
                      </button>
                    )}
                    {fileReverted && (
                      <span className="chat-review-file-reverted">已撤销</span>
                    )}
                  </div>
                  <div className="chat-review-diff" ref={diffScrollRef}>
                    {fileReverted ? (
                      <div className="chat-review-empty">已撤销此文件的所有修改</div>
                    ) : pairs === null || waitingForCanonical || waitingForContent ? (
                      // 行集合还没确定（规范化补丁或文件内容在路上）时不渲染行区：
                      // 先画 patch 视图会“停在顶部 → 过一会跳到改动处”。超过 120ms
                      // 再显示加载态，快速路径下就是空白一下然后直接到位。
                      <div className="chat-review-loading">
                        {(pairs === null || showContentLoading) && (
                          <>
                            <Loader2 className="chat-review-spin" size={16} />
                            <span>{uiText.review.loading}</span>
                          </>
                        )}
                      </div>
                    ) : viewMode === "split" ? (
                      <div className="chat-review-split">
                        <ReviewVirtualRows
                          ref={rowsRef}
                          pairs={renderPairs}
                          viewMode="split"
                          showDeletedInRight={showDeletedInRight}
                          language={language}
                          scrollRef={diffScrollRef}
                          displayFile={active.displayFile}
                          undoable={!!active.undoable}
                          undoBusy={undoBusy}
                          undoingKey={undoingKey}
                          onHunkUndoRef={onHunkUndoRef}
                        />
                        {truncated && (
                          <div className="chat-review-truncated">{uiText.review.truncated(MAX_RENDER_LINES)}</div>
                        )}
                      </div>
                    ) : (
                      <div className="chat-review-unified">
                        <ReviewVirtualRows
                          ref={rowsRef}
                          pairs={renderPairs}
                          viewMode="unified"
                          showDeletedInRight={false}
                          language={language}
                          scrollRef={diffScrollRef}
                          displayFile={active.displayFile}
                          undoable={!!active.undoable}
                          undoBusy={undoBusy}
                          undoingKey={undoingKey}
                          onHunkUndoRef={onHunkUndoRef}
                        />
                        {truncated && (
                          <div className="chat-review-truncated">{uiText.review.truncated(MAX_RENDER_LINES)}</div>
                        )}
                      </div>
                    )}
                  </div>
                  {(undoError || active.undoUnavailableReason) && (
                    <div className="chat-review-undo-error" role="status">
                      {undoError || `此文件无法安全撤销：${active.undoUnavailableReason}`}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
