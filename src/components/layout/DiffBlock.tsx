import { useEffect, useMemo, useState } from "react";
import { ChevronDown, FileDiff as FileDiffIcon, Loader2, ScanSearch, Undo2 } from "lucide-react";
import { buildDiffSummary, type DiffLike } from "@shared/diff-summary";
import { uiText } from "@/i18n/text";
import { CodeReviewDialog } from "./CodeReviewDialog";

type DiffBlockProps = {
  diffs: DiffLike[];
  projectPath?: string;
  onOpenChange?: (open: boolean) => void;
};

const DEFAULT_VISIBLE_FILES = 3;

export function DiffBlock({ diffs, projectPath, onOpenChange }: DiffBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewInitialFile, setReviewInitialFile] = useState<string | null>(null);
  const [revertState, setRevertState] = useState<"idle" | "reverting" | "reverted">("idle");
  const [error, setError] = useState<string | null>(null);
  const summary = useMemo(() => buildDiffSummary(diffs, projectPath), [diffs, projectPath]);
  const hiddenCount = Math.max(0, summary.files.length - DEFAULT_VISIBLE_FILES);
  const visibleFiles = expanded ? summary.files : summary.files.slice(0, DEFAULT_VISIBLE_FILES);
  const canRevert =
    revertState === "idle" &&
    !!projectPath &&
    summary.reversiblePatches.length > 0;
  const showRevertButton =
    (!!projectPath && summary.reversiblePatches.length > 0) ||
    revertState !== "idle";
  const revertTitle = !projectPath
    ? "当前会话没有项目路径，无法撤销"
    : summary.patchCount === 0
      ? "当前变更没有可撤销补丁"
      : summary.reversiblePatches.length === 0
        ? "当前补丁格式无法自动撤销"
        : revertState === "reverted"
        ? "已撤销"
        : "撤销本次文件修改";

  useEffect(() => {
    onOpenChange?.(reviewOpen);
  }, [reviewOpen, onOpenChange]);

  const handleRevert = async () => {
    if (!canRevert || !projectPath) return;
    setError(null);
    setRevertState("reverting");
    try {
      const result = await window.electronAPI.reverseApplyPatch(projectPath, summary.reversiblePatches);
      if (!result.success) {
        setRevertState("idle");
        setError(result.error || "撤销失败");
        return;
      }
      setRevertState("reverted");
    } catch (err) {
      setRevertState("idle");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (summary.files.length === 0) return null;

  return (
    <section className={`chat-diff-card ${revertState === "reverted" ? "reverted" : ""}`}>
      <div className="chat-diff-card-header">
        <div className="chat-diff-icon-box" aria-hidden="true">
          <FileDiffIcon size={20} strokeWidth={1.9} />
        </div>
        <div className="chat-diff-title-group">
          <div className="chat-diff-title">
            {revertState === "reverted" ? "已撤销" : `已编辑 ${summary.files.length} 个文件`}
          </div>
          <div className="chat-diff-total-stats" aria-label={`新增 ${summary.totalAdditions} 行，删除 ${summary.totalDeletions} 行`}>
            <span className="chat-diff-add">+{summary.totalAdditions}</span>
            <span className="chat-diff-del">-{summary.totalDeletions}</span>
          </div>
        </div>
        {showRevertButton && (
        <button
          type="button"
          className="chat-diff-revert-btn"
          onClick={handleRevert}
          disabled={!canRevert}
          title={revertTitle}
          aria-label={revertTitle}
        >
          {revertState === "reverting" ? (
            <Loader2 className="chat-diff-spin" size={16} strokeWidth={2} />
          ) : (
            <Undo2 size={16} strokeWidth={2} />
          )}
          <span>{revertState === "reverted" ? "已撤销" : "撤销"}</span>
        </button>
        )}
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
                  if (!hasPatch) return;
                  setReviewInitialFile(file.file);
                  setReviewOpen(true);
                }}
                disabled={!hasPatch}
                title={hasPatch ? file.file : `${file.file}（没有可查看的 diff）`}
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

      {error && (
        <div className="chat-diff-error" role="status">
          {error}
        </div>
      )}

      <CodeReviewDialog
        open={reviewOpen}
        diffs={diffs}
        projectPath={projectPath}
        initialFile={reviewInitialFile ?? undefined}
        onClose={() => setReviewOpen(false)}
      />
    </section>
  );
}
