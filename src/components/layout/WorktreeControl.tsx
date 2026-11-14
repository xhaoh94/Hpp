import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, GitBranch, LoaderCircle, RefreshCw } from "lucide-react";

import type { SessionWorkspace } from "@shared/session-workspace";
import { showAppAlert, showAppConfirm } from "@/lib/app-dialog";
import { showFloatingToastMessage } from "@/lib/floating-toast";

type WorktreeControlProps = {
  workspace: SessionWorkspace;
  running: boolean;
  onUpdate: (workspace: SessionWorkspace) => void;
};

export function WorktreeControl({ workspace, running, onUpdate }: WorktreeControlProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"checkpoint" | "merge" | "">("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const copyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(workspace.rootPath);
      showFloatingToastMessage("工作区路径已复制");
    } catch {
      showFloatingToastMessage("复制失败");
    }
  }, [workspace.rootPath]);

  const checkpoint = useCallback(async () => {
    setBusy("checkpoint");
    try {
      const result = await window.electronAPI.worktreeCheckpoint(workspace);
      if (!result.success) {
        showAppAlert(result.error || "创建检查点失败。");
        return;
      }
      if (result.workspace) onUpdate(result.workspace);
      showFloatingToastMessage(result.output || "检查点已创建");
    } finally {
      setBusy("");
    }
  }, [onUpdate, workspace]);

  const merge = useCallback(async () => {
    const confirmed = await showAppConfirm(
      `将 ${workspace.branch} 合并回主工作区？\n\n会先创建检查点，再执行 merge --no-ff。主工作区有未提交改动时会拒绝合并。`,
      { title: "合并工作区", confirmLabel: "合并" },
    );
    if (!confirmed) return;
    setBusy("merge");
    try {
      const checkpointResult = await window.electronAPI.worktreeCheckpoint(workspace);
      if (!checkpointResult.success) {
        showAppAlert(checkpointResult.error || "创建检查点失败，未合并。");
        return;
      }
      const mergeResult = await window.electronAPI.worktreeMerge(checkpointResult.workspace || workspace);
      if (!mergeResult.success) {
        showAppAlert(mergeResult.error || "合并失败。");
        return;
      }
      if (mergeResult.workspace) onUpdate(mergeResult.workspace);
      showFloatingToastMessage(mergeResult.output || "已合并回主工作区");
    } finally {
      setBusy("");
    }
  }, [onUpdate, workspace]);

  const branchLabel = workspace.branch.replace(/^hpp\//, "");

  return (
    <div className="worktree-control" ref={rootRef}>
      <button
        type="button"
        className={`chat-header-worktree ${workspace.status === "merged" ? "merged" : ""}`}
        onClick={() => setOpen((value) => !value)}
        title={`独立工作区：${workspace.rootPath}`}
        aria-label="工作区操作"
        aria-expanded={open}
      >
        <GitBranch size={12} />
        <span>{workspace.status === "merged" ? "已合并" : branchLabel}</span>
      </button>
      {open && (
        <div className="worktree-menu" role="menu">
          <div className="worktree-menu-head">
            <strong>独立工作区</strong>
            <span>{workspace.branch}</span>
            <code title={workspace.rootPath}>{workspace.rootPath}</code>
          </div>
          <button type="button" role="menuitem" onClick={() => void copyPath()}>
            <Copy size={13} /> 复制路径
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={running || !!busy || workspace.status === "merged"}
            onClick={() => void checkpoint()}
          >
            {busy === "checkpoint" ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}
            创建检查点
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={running || !!busy || workspace.status === "merged"}
            onClick={() => void merge()}
          >
            {busy === "merge" ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
            合并回主工作区
          </button>
          {running && <span className="worktree-menu-note">当前会话运行中，结束后才能检查点/合并。</span>}
          {workspace.status === "merged" && <span className="worktree-menu-note">已合并；可以关闭会话后用 git worktree 清理。</span>}
        </div>
      )}
    </div>
  );
}
