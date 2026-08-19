import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
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
import {
  buildFullFileDiff,
  buildReviewDiff,
  extractHunkPatch,
  linesToPairs,
  parsePatchHunks,
  type DiffLineCell,
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

type CodeReviewDialogProps = {
  open: boolean;
  diffs: DiffLike[];
  projectPath?: string;
  /** 打开时初始选中的文件（原始路径或展示路径），不传则选中第一个有补丁的文件。 */
  initialFile?: string;
  onClose: () => void;
  onOpenFile?: (path: string, options?: { preview?: boolean }) => void;
  onRevertAll?: () => void;
  revertState?: "idle" | "reverting" | "reverted";
  revertCanRevert?: boolean;
  revertTitle?: string;
  showRevertButton?: boolean;
};

const MAX_RENDER_LINES = 5000;
const MAX_HIGHLIGHT_CHARS = 2000;
const FILES_MIN_WIDTH = 180;
const FILES_MAX_WIDTH = 420;
const DIFF_MIN_WIDTH = 320;

type HighlightedCell = {
  cell: DiffLineCell;
  tokens: SyntaxToken[];
};

type HighlightedPair = {
  left?: HighlightedCell;
  right?: HighlightedCell;
};

const renderTokens = (tokens: SyntaxToken[]) => {
  if (tokens.length === 0) return <span className="chat-review-code-empty" />;
  return tokens.map((token, index) => (
    <span key={index} className={token.classNames.join(" ") || undefined}>
      {token.text}
    </span>
  ));
};

const highlightText = (text: string, language?: string): SyntaxToken[] => {
  if (!language || text.length > MAX_HIGHLIGHT_CHARS) return [{ text, classNames: [] }];
  return buildHighlightedLines(text, language)[0] || [];
};

const isDiffPair = (pair: HighlightedPair) =>
  !!(pair.left && pair.left.cell.type === "del") || !!(pair.right && pair.right.cell.type === "add");

function FileStatusIcon({ status }: { status: ReviewFileDiff["status"] }) {
  if (status === "added") return <FilePlus2 size={14} strokeWidth={2} />;
  if (status === "deleted") return <FileMinus2 size={14} strokeWidth={2} />;
  return <FileDiff size={14} strokeWidth={2} />;
}

export function CodeReviewDialog({
  open,
  diffs,
  projectPath,
  initialFile,
  onClose,
  onOpenFile,
  onRevertAll,
  revertState = "idle",
  revertCanRevert = false,
  revertTitle,
  showRevertButton = false,
}: CodeReviewDialogProps) {
  const [activeFileKey, setActiveFileKey] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ReviewViewMode>("split");
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
  const reviewBodyRef = useRef<HTMLDivElement | null>(null);
  const [revertedHunks, setRevertedHunks] = useState<Set<string>>(new Set());
  const [revertedFiles, setRevertedFiles] = useState<Set<string>>(new Set());
  const [undoingKey, setUndoingKey] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);

  const files = useMemo(() => buildReviewDiff(diffs, projectPath), [diffs, projectPath]);

  // 打开时回到初始选中的文件（或第一个有补丁的文件），保持视图为并排对比。
  // useLayoutEffect（声明靠前）确保在默认定位 useLayoutEffect 之前重置 scrolledRef，
  // 使重新打开同一文件时能再次以 auto 立即定位。
  useLayoutEffect(() => {
    if (!open) return;
    setActiveFileKey(initialFile ?? null);
    setViewMode("split");
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

  // 读取当前文件内容，用于还原「修改前 / 修改后」的完整文件对比。
  useEffect(() => {
    if (!open || !active) return;
    if (loadedRef.current.has(active.displayFile)) return;
    let cancelled = false;
    const path = resolveProjectFilePath(active.file, projectPath || "");
    loadedRef.current.add(active.displayFile);
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
  }, [open, active, projectPath]);

  // 完整文件对比行对；文件尚未读取完成时先用补丁内行立即显示，读取完成后自动升级。
  const pairs = useMemo((): FullDiffPair[] | null => {
    if (!active) return null;
    const content = fileContent[active.displayFile];
    if (content === undefined) return linesToPairs(active.lines);
    if (content !== null && active.patch.trim()) return buildFullFileDiff(content, active.patch);
    return linesToPairs(active.lines);
  }, [active, fileContent]);

  const language = useMemo(
    () => (active ? getFilePreviewLanguage(active.file) || undefined : undefined),
    [active],
  );

  const highlightedPairs = useMemo(() => {
    if (!pairs) return [];
    const result: HighlightedPair[] = [];
    const count = Math.min(pairs.length, MAX_RENDER_LINES);
    for (let index = 0; index < count; index += 1) {
      const pair = pairs[index];
      const entry: HighlightedPair = {};
      if (pair.left) entry.left = { cell: pair.left, tokens: highlightText(pair.left.text, language) };
      if (pair.right) entry.right = { cell: pair.right, tokens: highlightText(pair.right.text, language) };
      result.push(entry);
    }
    return result;
  }, [pairs, language]);

  const truncated = !!pairs && pairs.length > MAX_RENDER_LINES;

  // 修改点定位：连续的增删行合并为同一个修改点，只记录每个连续块的首个下标。
  const diffPairIndices = useMemo(() => {
    const indices: number[] = [];
    let prevIsDiff = false;
    highlightedPairs.forEach((pair, index) => {
      const isDiff = isDiffPair(pair);
      if (isDiff && !prevIsDiff) indices.push(index);
      prevIsDiff = isDiff;
    });
    return indices;
  }, [highlightedPairs]);

  const totalDiffs = diffPairIndices.length;
  diffPairIndicesRef.current = diffPairIndices;

  // 每个补丁 hunk 在 pairs 中的起始位置，用于定位局部 undo 按钮。
  const hunkStarts = useMemo(() => {
    if (!active?.hasPatch || !pairs) return [];
    const parsed = parsePatchHunks(active.patch);
    if (parsed.length === 0) return [];
    const result: { hunkIdx: number; pairIdx: number }[] = [];
    let searchFrom = 0;
    for (let h = 0; h < parsed.length; h++) {
      const hunk = parsed[h];
      const oldEnd = hunk.oldStart + Math.max(hunk.oldCount, 1);
      const newEnd = hunk.newStart + Math.max(hunk.newCount, 1);
      for (let i = searchFrom; i < pairs.length; i++) {
        const pair = pairs[i];
        const leftNo = pair.left?.lineNo ?? -1;
        const rightNo = pair.right?.lineNo ?? -1;
        if (
          (leftNo >= hunk.oldStart && leftNo < oldEnd) ||
          (rightNo >= hunk.newStart && rightNo < newEnd)
        ) {
          result.push({ hunkIdx: h, pairIdx: i });
          searchFrom = i + 1;
          break;
        }
      }
    }
    return result;
  }, [active, pairs]);

  const fileReverted = !!active && revertedFiles.has(active.displayFile);

  // pairIdx → hunkIdx 的查找表，用于在渲染时定位 hunk 起始行。
  const hunkStartMap = useMemo(() => {
    const map = new Map<number, number>();
    for (const { hunkIdx, pairIdx } of hunkStarts) map.set(pairIdx, hunkIdx);
    return map;
  }, [hunkStarts]);

  const handleFileUndo = async () => {
    if (!active || !projectPath || !active.hasPatch || fileReverted) return;
    const key = `file:${active.displayFile}`;
    setUndoingKey(key);
    setUndoError(null);
    try {
      const result = await window.electronAPI.reverseApplyPatch(projectPath, active.patches);
      if (!result.success) {
        setUndoError(result.error || "撤销失败");
      } else {
        setRevertedFiles((prev) => new Set(prev).add(active.displayFile));
      }
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : String(err));
    } finally {
      setUndoingKey(null);
    }
  };

  const handleHunkUndo = async (hunkIdx: number) => {
    if (!active || !projectPath) return;
    const hunkKey = `hunk:${active.displayFile}:${hunkIdx}`;
    if (revertedHunks.has(hunkKey)) return;
    const hunkPatch = extractHunkPatch(active.patch, hunkIdx);
    if (!hunkPatch) return;
    setUndoingKey(hunkKey);
    setUndoError(null);
    try {
      const result = await window.electronAPI.reverseApplyPatch(projectPath, [hunkPatch]);
      if (!result.success) {
        setUndoError(result.error || "撤销失败");
      } else {
        setRevertedHunks((prev) => new Set(prev).add(hunkKey));
      }
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : String(err));
    } finally {
      setUndoingKey(null);
    }
  };

  const isHunkReverted = (hunkIdx: number) =>
    !!active && revertedHunks.has(`hunk:${active.displayFile}:${hunkIdx}`);

  const isHunkUndoing = (hunkIdx: number) =>
    !!active && undoingKey === `hunk:${active.displayFile}:${hunkIdx}`;

  const fileUndoing = !!active && undoingKey === `file:${active.displayFile}`;

  const scrollToDiff = (cursor: number, smooth = false) => {
    const container = diffScrollRef.current;
    if (!container) return;
    const indices = diffPairIndicesRef.current;
    const pairIndex = indices[cursor];
    if (pairIndex === undefined) return;

    const scrollTargetToCenter = (el: Element) => {
      const containerRect = container.getBoundingClientRect();
      const targetRect = el.getBoundingClientRect();
      const relativeTop = targetRect.top - containerRect.top + container.scrollTop;
      const centerOffset = relativeTop - container.clientHeight / 2 + targetRect.height / 2;
      container.scrollTo({ top: Math.max(0, centerOffset), behavior: smooth ? "smooth" : "auto" });
    };

    // split 视图下左右两列行数不同，优先以右列（修改后内容）定位。
    const queryTarget = (idx: number): Element | null => {
      const right = container.querySelector(
        `.chat-review-col.right [data-review-diff-index="${idx}"]`,
      );
      return right ?? container.querySelector(`[data-review-diff-index="${idx}"]`);
    };

    const target = queryTarget(pairIndex);
    if (target) {
      scrollTargetToCenter(target);
      return;
    }
    // 目标行可能因「隐藏被删除行」而未渲染，向后找下一个可见的修改点。
    for (let index = cursor; index < indices.length; index += 1) {
      const fallback = queryTarget(indices[index]);
      if (fallback) {
        scrollTargetToCenter(fallback);
        return;
      }
    }
  };

  // 默认定位到当前文件的第一个变化点。
  // 用 useLayoutEffect（commit 后、paint 前同步执行）立即定位，无帧延迟、无闪烁。
  // 打开瞬间用补丁行对定位（不等文件内容读取完成），文件内容读取完成后若修改点位置
  // 变化则平滑过渡到完整对比的精确位置；文件已缓存时打开即精确、无延迟。
  // 依赖含 open：重新打开同一文件时 scrolledRef 已在打开时重置，会再次定位。
  useLayoutEffect(() => {
    if (!open || !active || pairs === null) return;
    if (diffPairIndices.length === 0) return;
    const key = active.displayFile;
    const contentReady = fileContent[key] !== undefined;
    const isFirst = scrolledRef.current !== key;
    if (isFirst) scrolledRef.current = key;
    // 用户可能在文件内容加载前已翻页，定位到当前游标而非总是第一个。
    const cursor = Math.min(diffCursor, diffPairIndices.length - 1);
    if (cursor !== diffCursor) setDiffCursor(cursor);
    // 首次（打开/切换文件）立即 auto 定位；内容升级为完整对比后平滑过渡，避免突兀跳动。
    scrollToDiff(cursor, !isFirst && contentReady);
  }, [open, active, pairs, diffPairIndices, fileContent, diffCursor]);

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
                onClick={() => setViewMode("split")}
                title={uiText.review.splitView}
                aria-pressed={viewMode === "split"}
              >
                <Columns2 size={14} strokeWidth={2} />
                <span>{uiText.review.splitView}</span>
              </button>
              <button
                type="button"
                className={viewMode === "unified" ? "active" : ""}
                onClick={() => setViewMode("unified")}
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
              {!filesCollapsed && showRevertButton && onRevertAll && (
                <div className="chat-review-files-footer">
                  <button
                    type="button"
                    className="chat-review-revert-all-btn"
                    onClick={onRevertAll}
                    disabled={!revertCanRevert}
                    title={revertTitle}
                    aria-label={revertTitle}
                  >
                    {revertState === "reverting" ? (
                      <Loader2 className="chat-review-spin" size={14} strokeWidth={2} />
                    ) : (
                      <Undo2 size={14} strokeWidth={2} />
                    )}
                    <span>{revertState === "reverted" ? "已撤销" : "撤销全部修改"}</span>
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
              {!active ? null : !active.hasPatch ? (
                <div className="chat-review-empty">{uiText.review.noPatch}</div>
              ) : (
                <>
                  <div className="chat-review-file-head">
                    <span className="chat-review-file-title" title={active.displayFile}>
                      <FileStatusIcon status={active.status} />
                      <span>{active.displayFile}</span>
                    </span>
                    {active.hasPatch && projectPath && !fileReverted && (
                      <button
                        type="button"
                        className="chat-review-file-undo"
                        onClick={handleFileUndo}
                        disabled={fileUndoing}
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
                    ) : pairs === null ? (
                      <div className="chat-review-loading">
                        <Loader2 className="chat-review-spin" size={16} />
                        <span>{uiText.review.loading}</span>
                      </div>
                    ) : viewMode === "split" ? (
                      <div className="chat-review-split">
                        <div className="chat-review-split-cols">
                          {/* 左列：原文件原文——被删除的行标红，始终完整显示 */}
                          <div className="chat-review-col left">
                            {highlightedPairs.map((pair, index) => {
                              if (!pair.left) return null;
                              const isDiff = pair.left.cell.type === "del";
                              const hunkIdx = hunkStartMap.get(index);
                              // 右列默认隐藏删除行时，hunk 起始的删除行在右列不可见，在左列补充撤销按钮。
                              const rightHidden =
                                !pair.right && !!pair.left && pair.left.cell.type === "del" && !showDeletedInRight;
                              return (
                                <div
                                  className={`chat-review-col-line ${pair.left.cell.type}${hunkIdx !== undefined && isHunkReverted(hunkIdx) ? " hunk-reverted" : ""}`}
                                  key={index}
                                  data-review-diff-index={isDiff ? index : undefined}
                                >
                                  <span className="chat-review-line-no">{pair.left.cell.lineNo}</span>
                                  <span className="chat-review-code">{renderTokens(pair.left.tokens)}</span>
                                  {hunkIdx !== undefined && rightHidden && (
                                    isHunkReverted(hunkIdx) ? (
                                      <span className="chat-review-hunk-badge reverted">已撤销</span>
                                    ) : (
                                      <button
                                        type="button"
                                        className="chat-review-hunk-undo"
                                        onClick={() => handleHunkUndo(hunkIdx)}
                                        disabled={isHunkUndoing(hunkIdx)}
                                        title="撤销此段修改"
                                      >
                                        {isHunkUndoing(hunkIdx) ? (
                                          <Loader2 className="chat-review-spin" size={11} />
                                        ) : (
                                          <Undo2 size={11} strokeWidth={2.2} />
                                        )}
                                        <span>撤销</span>
                                      </button>
                                    )
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          {/* 右列：修改后内容；开关开启时也显示被删除的行 */}
                          <div className="chat-review-col right">
                            {highlightedPairs.map((pair, index) => {
                              const showDeleted =
                                showDeletedInRight && !pair.right && !!pair.left && pair.left.cell.type === "del";
                              if (!pair.right && !showDeleted) return null;
                              const cell = pair.right ?? pair.left!;
                              const isDiff = pair.right ? pair.right.cell.type === "add" : cell.cell.type === "del";
                              const hunkIdx = hunkStartMap.get(index);
                              return (
                                <div
                                  className={`chat-review-col-line ${cell.cell.type}${hunkIdx !== undefined && isHunkReverted(hunkIdx) ? " hunk-reverted" : ""}`}
                                  key={index}
                                  data-review-diff-index={isDiff ? index : undefined}
                                >
                                  <span className="chat-review-line-no">{cell.cell.lineNo}</span>
                                  <span className="chat-review-code">{renderTokens(cell.tokens)}</span>
                                  {hunkIdx !== undefined && (
                                    isHunkReverted(hunkIdx) ? (
                                      <span className="chat-review-hunk-badge reverted">已撤销</span>
                                    ) : (
                                      <button
                                        type="button"
                                        className="chat-review-hunk-undo"
                                        onClick={() => handleHunkUndo(hunkIdx)}
                                        disabled={isHunkUndoing(hunkIdx)}
                                        title="撤销此段修改"
                                      >
                                        {isHunkUndoing(hunkIdx) ? (
                                          <Loader2 className="chat-review-spin" size={11} />
                                        ) : (
                                          <Undo2 size={11} strokeWidth={2.2} />
                                        )}
                                        <span>撤销</span>
                                      </button>
                                    )
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        {truncated && (
                          <div className="chat-review-truncated">{uiText.review.truncated(MAX_RENDER_LINES)}</div>
                        )}
                      </div>
                    ) : (
                      <div className="chat-review-unified">
                        {highlightedPairs.map((pair, index) => {
                          const type = pair.left?.cell.type === "del"
                            ? "del"
                            : pair.right?.cell.type === "add"
                              ? "add"
                              : "context";
                          const text = pair.left ?? pair.right;
                          const hunkIdx = hunkStartMap.get(index);
                          return (
                            <div
                              className={`chat-review-line ${type}${hunkIdx !== undefined && isHunkReverted(hunkIdx) ? " hunk-reverted" : ""}`}
                              key={index}
                              data-review-diff-index={isDiffPair(pair) ? index : undefined}
                            >
                              <span className="chat-review-line-no">
                                {type === "del"
                                  ? pair.left?.cell.lineNo ?? ""
                                  : pair.right?.cell.lineNo ?? pair.left?.cell.lineNo ?? ""}
                              </span>
                              <span className="chat-review-marker" aria-hidden="true">
                                {type === "del" ? "-" : type === "add" ? "+" : " "}
                              </span>
                              <span className="chat-review-code">
                                {text ? renderTokens(text.tokens) : <span className="chat-review-code-empty" />}
                              </span>
                              {hunkIdx !== undefined && (
                                isHunkReverted(hunkIdx) ? (
                                  <span className="chat-review-hunk-badge reverted">已撤销</span>
                                ) : (
                                  <button
                                    type="button"
                                    className="chat-review-hunk-undo"
                                    onClick={() => handleHunkUndo(hunkIdx)}
                                    disabled={isHunkUndoing(hunkIdx)}
                                    title="撤销此段修改"
                                  >
                                    {isHunkUndoing(hunkIdx) ? (
                                      <Loader2 className="chat-review-spin" size={11} />
                                    ) : (
                                      <Undo2 size={11} strokeWidth={2.2} />
                                    )}
                                    <span>撤销</span>
                                  </button>
                                )
                              )}
                            </div>
                          );
                        })}
                        {truncated && (
                          <div className="chat-review-truncated">{uiText.review.truncated(MAX_RENDER_LINES)}</div>
                        )}
                      </div>
                    )}
                  </div>
                  {undoError && (
                    <div className="chat-review-undo-error" role="status">{undoError}</div>
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
