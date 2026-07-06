import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FileDiff as FileDiffIcon, Loader2, Undo2, X } from "lucide-react";
import type { FileDiff } from "@/stores/chat-store";

type DiffBlockProps = {
  diffs: FileDiff[];
  projectPath?: string;
};

type DiffFileAccumulator = {
  file: string;
  patchAdditions: number;
  patchDeletions: number;
  metaAdditions: number;
  metaDeletions: number;
  patches: string[];
  seenChanges: Set<string>;
};

type DiffFileSummary = {
  file: string;
  additions: number;
  deletions: number;
  patches: string[];
};

const DEFAULT_VISIBLE_FILES = 3;

const isReversiblePatch = (patch: string) => {
  const trimmed = patch.trim();
  if (!trimmed) return false;
  return /^diff --git\s+/m.test(trimmed) || (/^---\s+/m.test(trimmed) && /^\+\+\+\s+/m.test(trimmed));
};

const normalizeFilePath = (file: string) => file.replace(/\\/g, "/");

const countPatchChanges = (patch: string) => ({
  additions: (patch.match(/^\+[^+]/gm) || []).length,
  deletions: (patch.match(/^-[^-]/gm) || []).length,
});

const toProjectRelativePath = (file: string, projectPath?: string) => {
  const normalizedFile = normalizeFilePath(file);
  const normalizedProject = projectPath ? normalizeFilePath(projectPath).replace(/\/+$/, "") : "";
  if (!normalizedProject) return normalizedFile;

  const fileKey = normalizedFile.toLowerCase();
  const projectKey = normalizedProject.toLowerCase();
  if (fileKey === projectKey) return normalizedFile.split("/").pop() || normalizedFile;
  if (fileKey.startsWith(`${projectKey}/`)) {
    return normalizedFile.slice(normalizedProject.length + 1);
  }
  return normalizedFile;
};

const renderDiffLines = (file: string, patches: string[]) =>
  patches.join("\n").split("\n").map((line, index) => {
    let cls = "chat-diff-line";
    if (line.startsWith("@@") || line.startsWith("diff --git") || line.startsWith("---") || line.startsWith("+++")) {
      cls += " chat-diff-header-line";
    } else if (line.startsWith("+")) {
      cls += " chat-diff-add-line";
    } else if (line.startsWith("-")) {
      cls += " chat-diff-del-line";
    }
    return (
      <span key={`${file}-${index}`} className={cls}>
        {line || " "}
      </span>
    );
  });

const buildDiffSummary = (diffs: FileDiff[], projectPath?: string) => {
  const byFile = new Map<string, DiffFileAccumulator>();

  diffs.forEach((diff) => {
    const file = toProjectRelativePath(diff.file || "未命名文件", projectPath);
    const patch = typeof diff.patch === "string" ? diff.patch : "";
    const trimmedPatch = patch.trim();
    const countedPatch = trimmedPatch ? countPatchChanges(patch) : { additions: 0, deletions: 0 };
    const changeKey = trimmedPatch
      ? `patch:${patch}`
      : `meta:${diff.status || "modified"}:${diff.additions || 0}:${diff.deletions || 0}`;
    const existing = byFile.get(file) || {
      file,
      patchAdditions: 0,
      patchDeletions: 0,
      metaAdditions: 0,
      metaDeletions: 0,
      patches: [],
      seenChanges: new Set<string>(),
    };

    if (!existing.seenChanges.has(changeKey)) {
      existing.seenChanges.add(changeKey);
      if (trimmedPatch) {
        existing.patchAdditions += Math.max(0, diff.additions || countedPatch.additions || 0);
        existing.patchDeletions += Math.max(0, diff.deletions || countedPatch.deletions || 0);
        existing.patches.push(patch);
      } else {
        existing.metaAdditions = Math.max(existing.metaAdditions, Math.max(0, diff.additions || 0));
        existing.metaDeletions = Math.max(existing.metaDeletions, Math.max(0, diff.deletions || 0));
      }
    }

    byFile.set(file, existing);
  });

  const files = Array.from(byFile.values())
    .map(({ seenChanges, patchAdditions, patchDeletions, metaAdditions, metaDeletions, ...file }) => ({
      ...file,
      additions: file.patches.length > 0 ? patchAdditions : metaAdditions,
      deletions: file.patches.length > 0 ? patchDeletions : metaDeletions,
    }))
    .sort((a, b) => a.file.localeCompare(b.file));

  return {
    files,
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
    patchCount: files.reduce((sum, file) => sum + file.patches.length, 0),
    reversiblePatches: files.flatMap((file) => file.patches).filter(isReversiblePatch),
  };
};

export function DiffBlock({ diffs, projectPath }: DiffBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeFile, setActiveFile] = useState<DiffFileSummary | null>(null);
  const [revertState, setRevertState] = useState<"idle" | "reverting" | "reverted">("idle");
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
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
    if (!activeFile) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveFile(null);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeFile]);

  useEffect(() => {
    if (!activeFile) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".chat-diff-file-row")) return;
      setActiveFile(null);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [activeFile]);

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
      </div>

      <div className="chat-diff-file-list">
        {visibleFiles.map((file) => {
          const isActive = activeFile?.file === file.file;
          const hasPatch = file.patches.length > 0;
          return (
            <div key={file.file} className={`chat-diff-file-item ${isActive ? "active" : ""}`}>
              <button
                type="button"
                className="chat-diff-file-row"
                onClick={() => hasPatch && setActiveFile((current) => current?.file === file.file ? null : file)}
                disabled={!hasPatch}
                title={hasPatch ? file.file : `${file.file}（没有可查看的 diff）`}
                aria-haspopup={hasPatch ? "dialog" : undefined}
                aria-expanded={hasPatch ? isActive : undefined}
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
                    className={`chat-diff-file-chevron ${isActive ? "expanded" : ""}`}
                    aria-hidden="true"
                  />
                )}
              </button>
            </div>
          );
        })}
      </div>

      {activeFile && (
        <div
          className="chat-diff-popover-backdrop"
          onMouseDown={() => setActiveFile(null)}
        >
          <div
            ref={popoverRef}
            className="chat-diff-popover"
            role="dialog"
            aria-modal="false"
            aria-label={`${activeFile.file} diff`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="chat-diff-popover-header">
              <span className="chat-diff-popover-title">{activeFile.file}</span>
              <span className="chat-diff-popover-stats">
                <span className="chat-diff-add">+{activeFile.additions}</span>
                <span className="chat-diff-del">-{activeFile.deletions}</span>
              </span>
              <button
                type="button"
                className="chat-diff-popover-close"
                onClick={() => setActiveFile(null)}
                title="关闭 diff"
                aria-label="关闭 diff"
              >
                <X size={16} strokeWidth={2} />
              </button>
            </div>
            <pre className="chat-diff-popover-content">
              {renderDiffLines(activeFile.file, activeFile.patches)}
            </pre>
          </div>
        </div>
      )}

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
    </section>
  );
}
