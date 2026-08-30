import { useEffect, useMemo, useState } from "react";
import { ChevronDown, FileDiff as FileDiffIcon, ScanSearch } from "lucide-react";
import { buildDiffSummary, type DiffLike } from "@shared/diff-summary";
import { buildReviewDiff } from "@shared/patch-split";
import type { ReviewUndoState } from "@shared/review-undo";
import { uiText } from "@/i18n/text";
import { CodeReviewDialog } from "./CodeReviewDialog";
import { FilePreview } from "@/components/shared/FilePreview";

type DiffBlockProps = {
  reviewId: string;
  diffs: DiffLike[];
  projectPath?: string;
  onOpenChange?: (open: boolean) => void;
};

const DEFAULT_VISIBLE_FILES = 3;

export function DiffBlock({ reviewId, diffs, projectPath, onOpenChange }: DiffBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewInitialFile, setReviewInitialFile] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [undoState, setUndoState] = useState<ReviewUndoState | null>(null);
  const summary = useMemo(() => buildDiffSummary(diffs, projectPath), [diffs, projectPath]);
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

  useEffect(() => {
    setUndoState(null);
    if (!projectPath || reviewSources.length === 0) return;
    let cancelled = false;
    void window.electronAPI.loadReviewUndo({
      reviewId,
      projectPath,
      files: reviewSources,
    }).then((result) => {
      if (!cancelled && result.success && result.state) setUndoState(result.state);
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
            setReviewInitialFile(null);
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
                onClick={() => {
                  const base = projectPath ? projectPath.replace(/[\\/]+$/, "") : "";
                  setPreviewFile(base ? `${base}/${file.file}` : file.file);
                }}
                title={file.file}
                aria-haspopup="dialog"
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
                    className="chat-diff-file-chevron"
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

      <FilePreview filePath={previewFile} onClose={() => setPreviewFile(null)} />

      <CodeReviewDialog
        open={reviewOpen}
        reviewId={reviewId}
        diffs={diffs}
        projectPath={projectPath}
        initialFile={reviewInitialFile ?? undefined}
        onClose={() => setReviewOpen(false)}
        onUndoStateChange={setUndoState}
      />
    </section>
  );
}
