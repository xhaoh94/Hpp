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
  scrollToIndex: (index: number, behavior?: "auto" | "smooth") => void;
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
    // 换行长行会有少量偏差，由定位后的居中校正负责收敛。
    useImperativeHandle(ref, () => ({
      scrollToIndex: (index: number, behavior: "auto" | "smooth" = "auto") => {
        virtualizer.scrollToIndex(index, { align: "center", behavior });
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
  const pairs = useMemo((): FullDiffPair[] | null => {
    if (!active) return null;
    if (active.reverted) return [];
    const content = fileContent[active.displayFile];
    if (!active.canonical) return linesToPairs(active.lines);
    if (content === undefined) return linesToPairs(active.lines);
    if (content !== null && active.patch.trim()) return buildFullFileDiff(content, active.patch);
    return linesToPairs(active.lines);
  }, [active, fileContent]);

  const language = useMemo(
    () => (active ? getFilePreviewLanguage(active.file) || undefined : undefined),
    [active],
  );

  // 完整文件对比未就绪时先不展示 diff 区（也就不会先停在文件顶部再等一次跳转）。
  // 读取很快时静默等待，避免闪一下加载态。
  const needsFullContent = !!active && active.canonical && !active.reverted && active.patch.trim().length > 0;
  const activeContentReady = !!active && fileContent[active.displayFile] !== undefined;
  const waitingForContent = needsFullContent && !activeContentReady;
  const [showContentLoading, setShowContentLoading] = useState(false);
  useEffect(() => {
    if (!waitingForContent) {
      setShowContentLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowContentLoading(true), CONTENT_LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [waitingForContent, active?.displayFile]);

  // 虚拟列表按需渲染，只把前 MAX_RENDER_LINES 行交给它；高亮下沉到行组件，
  // 这里不再整份预计算。
  const renderPairs = useMemo(() => {
    if (!pairs) return [];
    return pairs.length > MAX_RENDER_LINES ? pairs.slice(0, MAX_RENDER_LINES) : pairs;
  }, [pairs]);

  const truncated = !!pairs && pairs.length > MAX_RENDER_LINES;

  // 修改点定位：连续的增删行合并为同一个修改点，只记录每个连续块的首个下标。
  // 直接算在未高亮的 pair 上，首次定位不必等高亮完成。
  const diffPairIndices = useMemo(() => {
    const indices: number[] = [];
    let prevIsDiff = false;
    renderPairs.forEach((pair, index) => {
      const isDiff = isDiffPair(pair);
      if (isDiff && !prevIsDiff) indices.push(index);
      prevIsDiff = isDiff;
    });
    return indices;
  }, [renderPairs]);

  const totalDiffs = diffPairIndices.length;
  diffPairIndicesRef.current = diffPairIndices;

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
   * 直接交给虚拟列表按行下标滚到居中位置，不再先查 DOM / 找 fallback 行：
   * 目标行在文件深处时一定没被渲染，查 DOM 必然失败，只能退回“按估算行高猜一个位置”，
   * 这一猜就是首次打开时那段看起来像延迟的无效滚动。
   */
  const scrollToDiff = (cursor: number, smooth = false) => {
    const container = diffScrollRef.current;
    const rows = rowsRef.current;
    if (!container || !rows) return;
    const pairIndex = diffPairIndicesRef.current[cursor];
    if (pairIndex === undefined) return;

    rows.scrollToIndex(pairIndex, smooth ? "smooth" : "auto");
    if (smooth) return;
    // 虚拟列表对尚未测量的行只能按固定行高估算，换行行会让位置略微偏移：
    // 下一帧目标行渲染出来后再居中一次，且只在明显偏离时校正，
    // 避免“到位后又跳一下”。
    requestAnimationFrame(() => {
      const scrollContainer = diffScrollRef.current;
      const target = scrollContainer?.querySelector(`[data-review-row-index="${pairIndex}"]`);
      if (!scrollContainer || !target) return;
      const containerRect = scrollContainer.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      if (targetRect.top >= containerRect.top + 24 && targetRect.bottom <= containerRect.bottom - 24) return;
      const relativeTop = targetRect.top - containerRect.top + scrollContainer.scrollTop;
      scrollContainer.scrollTo({
        top: Math.max(0, relativeTop - scrollContainer.clientHeight / 2 + targetRect.height / 2),
      });
    });
  };

  // 行集合是否已经稳定到可以定位：补丁视图（无法规范化/没有完整内容可用）
  // 或完整文件对比（规范化补丁 + 磁盘内容都就绪）。
  // 规范化状态（canonical）和文件内容都会异步到达，每变一次行下标就整体洗一次牌，
  // 提前定位只会先停在一个临时位置，等下一次变化再纠正 —— 这就是“延迟一会儿才跳”。
  const diffLayoutReady = !active
    || !active.canonical
    || activeContentReady
    || active.patch.trim().length === 0;
  // 视图模式也算行集合的一部分：unified/split 的行结构与行高不同，切换后要立即
  // 重新定位，而不是从旧偏移平滑滚过去。
  const diffLayoutKey = active
    ? `${active.displayFile}::${active.canonical ? "full" : "patch"}::${viewMode}`
    : "";

  // 默认定位到当前文件的第一个变化点。
  // 用 useLayoutEffect（commit 后、paint 前执行）：行集合稳定后的第一帧就已经
  // 在修改点上，没有可见的滚动过程。行集合变化（切换文件、规范化完成、文件内容
  // 读回、切换视图）会以 auto 重新定位；同一行集合内翻页仍沿用平滑滚动。
  useLayoutEffect(() => {
    if (!open || !active || pairs === null) return;
    if (!diffLayoutReady) return;
    if (diffPairIndices.length === 0) return;
    if (!rowsRef.current) return;
    const isFirst = scrolledRef.current !== diffLayoutKey;
    if (isFirst) scrolledRef.current = diffLayoutKey;
    // 用户可能已翻页，定位到当前游标而非总是第一个。
    const cursor = Math.min(diffCursor, diffPairIndices.length - 1);
    if (cursor !== diffCursor) setDiffCursor(cursor);
    scrollToDiff(cursor, !isFirst);
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
    scrollToDiff(next, true);
  };

  const goNextDiff = () => {
    const next = Math.min(totalDiffs - 1, diffCursor + 1);
    setDiffCursor(next);
    scrollToDiff(next, true);
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
                    ) : pairs === null || showContentLoading ? (
                      <div className="chat-review-loading">
                        <Loader2 className="chat-review-spin" size={16} />
                        <span>{uiText.review.loading}</span>
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
