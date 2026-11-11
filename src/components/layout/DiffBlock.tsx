import { useEffect, useMemo, useState } from "react";
import { ChevronDown, FileDiff as FileDiffIcon, ScanSearch } from "lucide-react";
import { buildDiffSummary, type DiffLike } from "@shared/diff-summary";
import { buildReviewDiff } from "@shared/patch-split";
import type { ReviewUndoState } from "@shared/review-undo";
import { uiText } from "@/i18n/text";
import { invalidateReviewUndoCache, loadReviewUndoState } from "@/lib/review-undo-cache";
import { resolveProjectFilePath } from "@/lib/project-file-path";
import { LazyCodeReviewDialog, preloadCodeReviewDialog } from "./LazyCodeReviewDialog";
import { DiffHoverCard, type DiffHoverFile } from "./DiffHoverCard";
import { LazyFilePreview } from "@/components/shared/LazyFilePreview";
import { FileContextMenu, type FileContextMenuState } from "@/components/shared/FileContextMenu";

type DiffBlockProps = {
  reviewId: string;
  diffs: DiffLike[];
  projectPath?: string;
  onOpenChange?: (open: boolean) => void;
};

const FilePreview = LazyFilePreview;
const CodeReviewDialog = LazyCodeReviewDialog;
const DEFAULT_VISIBLE_FILES = 3;

type DiffPreviewState = {
  file: DiffHoverFile;
  anchor: DOMRect;
};

export function DiffBlock({ reviewId, diffs, projectPath, onOpenChange }: DiffBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewInitialFile, setReviewInitialFile] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null);
  const [undoState, setUndoState] = useState<ReviewUndoState | null>(null);
  const [diffPreview, setDiffPreview] = useState<DiffPreviewState | null>(null);
  const summary = useMemo(() => buildDiffSummary(diffs, projectPath), [diffs, projectPath]);

  // 空闲时预取审核弹窗，点“审核”时不必再等 chunk 下载/解析才开始定位。
  useEffect(() => {
    const idle = (window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof idle === "function") {
      const handle = idle(() => preloadCodeReviewDialog(), { timeout: 1500 });
      return () => {
        (window as Window & { cancelIdleCallback?: (handle: number) => void })
          .cancelIdleCallback?.(handle);
      };
    }
    const timer = window.setTimeout(() => preloadCodeReviewDialog(), 300);
    return () => window.clearTimeout(timer);
  }, []);
  const reviewSources = useMemo(
    () => buildReviewDiff(diffs, projectPath).map((file) => ({
      file: file.file,
      patches: file.patches,
      status: file.status,
      statusExplicit: file.statusExplicit === true,
    })),
    [diffs, projectPath],
  );
  const reviewSourceFingerprint = useMemo(() => JSON.stringify(reviewSources), [reviewSources]);
  const undoFilesByPath = useMemo(
    () => new Map(undoState?.files.map((file) => [file.file, file]) || []),
    [undoState],
  );
  const displayFiles = useMemo(
    () => summary.files.map((file) => {
      const undoFile = undoFilesByPath.get(file.file);
      // 准备失败时，撤销状态里的 additions/deletions 只是 rebuild-file 不支持分支
      // 写出的占位 0（见 buildState 的 error 分支）。拿它覆盖会把「无法安全撤销」
      // 误渲染成「没有改动」——卡片应从 +4 -4 变成 +0 -0，而改动其实一直在。
      if (!undoFile || undoFile.error) return file;
      return { ...file, additions: undoFile.additions, deletions: undoFile.deletions };
    }),
    [summary.files, undoFilesByPath],
  );
  const hiddenCount = Math.max(0, displayFiles.length - DEFAULT_VISIBLE_FILES);
  const visibleFiles = expanded ? displayFiles : displayFiles.slice(0, DEFAULT_VISIBLE_FILES);
  const allReverted = undoState?.allReverted === true;

  // 预览卡片改成点击打开：不再用悬停延迟，也没了「从行移进浮层」的关闭计时。
  const closeDiffPreview = () => setDiffPreview(null);

  const toggleDiffPreview = (file: DiffHoverFile, element: HTMLElement) => {
    setDiffPreview((current) => (
      current?.file.file === file.file
        ? null
        : { file, anchor: element.getBoundingClientRect() }
    ));
  };

  /** 打开完整文件：统一弹文件预览。 */
  const openDiffFile = (file: DiffHoverFile) => {
    const base = projectPath ? projectPath.replace(/[\\/]+$/, "") : "";
    const fullPath = base ? `${base}/${file.file}` : file.file;
    setPreviewFile(fullPath);
  };

  // 卡片按打开时的行坐标定位：滚动、缩放、Esc、点击外部都要收起，
  // 否则它会浮在一个已经移走的行旁边。卡片内部滚动与点文件行不算。
  useEffect(() => {
    if (!diffPreview) return;
    const dismiss = () => setDiffPreview(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    const handleScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-diff-hover-card]")) return;
      dismiss();
    };
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // 文件行自己负责切换（捕获阶段先于 click，不能抢先关掉）。
      if (target.closest("[data-diff-hover-card]") || target.closest(".chat-diff-file-row")) return;
      dismiss();
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("mousedown", handlePointerDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("mousedown", handlePointerDown, true);
    };
  }, [diffPreview]);

  useEffect(() => {
    setUndoState(null);
    if (!projectPath || reviewSources.length === 0) return;
    let cancelled = false;
    // 走缓存：虚拟列表反复挂载时不再每次 IPC + 主进程重算 diff。
    void loadReviewUndoState({
      reviewId,
      projectPath,
      files: reviewSources,
    }).then((state) => {
      if (!cancelled && state) setUndoState(state);
    });
    return () => {
      cancelled = true;
    };
  }, [reviewId, projectPath, reviewSourceFingerprint]);

  useEffect(() => {
    onOpenChange?.(reviewOpen);
  }, [reviewOpen, onOpenChange]);

  if (summary.files.length === 0) return null;

  return (
    <section className={`chat-diff-card ${allReverted ? "reverted" : ""}`}>
      <div className="chat-diff-card-header">
        <div className="chat-diff-icon-box" aria-hidden="true">
          <FileDiffIcon size={20} strokeWidth={1.9} />
        </div>
        <div className="chat-diff-title-group">
          <div className="chat-diff-title">
            {allReverted ? "已撤销" : `${summary.files.length} 个文件`}
          </div>
        </div>
        <button
          type="button"
          className="chat-diff-review-btn"
          onClick={() => {
            // 从某个文件的预览面板里点「审核」，就定位到那个文件；
            // 否则保持原先的「第一个有补丁的文件」。
            setReviewInitialFile(diffPreview?.file.file ?? null);
            setReviewOpen(true);
          }}
          title={uiText.review.audit}
          aria-label={uiText.review.audit}
        >
          <ScanSearch size={16} strokeWidth={2} />
          <span>{uiText.review.audit}</span>
        </button>
      </div>

      <div className="chat-diff-file-list">
        {visibleFiles.map((file) => {
          const hasPatch = file.patches.length > 0;
          return (
            <div key={file.file} className="chat-diff-file-item">
              <button
                type="button"
                className="chat-diff-file-row"
                // 点击文件行 = 就地展开该文件的 diff 预览。之前这里是直接打开文件预览/
                // 编辑器，反而把「看改动」这个主要意图藏在了悬停里。
                onClick={(event) => {
                  if (!hasPatch) {
                    openDiffFile(file);
                    return;
                  }
                  toggleDiffPreview(file, event.currentTarget);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  closeDiffPreview();
                  setFileContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    path: resolveProjectFilePath(file.file, projectPath || ""),
                  });
                }}
                title={hasPatch ? undefined : file.file}
                aria-expanded={hasPatch ? diffPreview?.file.file === file.file : undefined}
              >
                <span className="chat-diff-file-path">
                  {file.file}
                </span>
                <span className="chat-diff-file-stats">
                  <span className="chat-diff-add">+{file.additions}</span>
                  <span className="chat-diff-del">-{file.deletions}</span>
                </span>
                {hasPatch && (
                  <ChevronDown
                    size={14}
                    strokeWidth={2}
                    className={`chat-diff-file-chevron${diffPreview?.file.file === file.file ? " expanded" : ""}`}
                    aria-hidden="true"
                  />
                )}
              </button>
            </div>
          );
        })}
      </div>

      {hiddenCount > 0 && (
        <button
          type="button"
          className="chat-diff-more-btn"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <span>{expanded ? "收起文件" : `再显示 ${hiddenCount} 个文件`}</span>
          <ChevronDown
            size={16}
            strokeWidth={2}
            className={expanded ? "expanded" : ""}
            aria-hidden="true"
          />
        </button>
      )}

      {diffPreview && (
        <DiffHoverCard
          file={diffPreview.file}
          anchorRect={diffPreview.anchor}
          onClose={closeDiffPreview}
          onOpenFile={() => {
            closeDiffPreview();
            openDiffFile(diffPreview.file);
          }}
        />
      )}

      <FilePreview filePath={previewFile} onClose={() => setPreviewFile(null)} />

      {fileContextMenu && (
        <FileContextMenu
          x={fileContextMenu.x}
          y={fileContextMenu.y}
          path={fileContextMenu.path}
          projectPath={projectPath}
          onClose={() => setFileContextMenu(null)}
        />
      )}

      <CodeReviewDialog
        open={reviewOpen}
        reviewId={reviewId}
        diffs={diffs}
        projectPath={projectPath}
        initialFile={reviewInitialFile ?? undefined}
        onClose={() => setReviewOpen(false)}
        onUndoStateChange={(state) => {
          // 撤销已改写磁盘文件：作废该 review 的缓存，否则滚动回来时
          // 卡片会拿着过期的「可撤销」摘要。
          invalidateReviewUndoCache(reviewId, projectPath);
          setUndoState(state);
        }}
      />
    </section>
  );
}
