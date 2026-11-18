import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { GitBranch, LoaderCircle, X } from "lucide-react";

import type { AgentDescriptor } from "@/types";
import type { Project } from "@/stores/project-store";
import { isDefaultWorkspaceProject } from "@/lib/default-workspace";
import type { WorktreeProbeResult } from "@shared/session-workspace";

interface Props {
  project: Project;
  agent: AgentDescriptor;
  onClose: () => void;
  onConfirm: (input: { workspaceMode: "shared" | "worktree" }) => Promise<void>;
  onOpenGit: () => void;
  probeVersion?: number;
}

export function NewSessionModal({ project, agent, onClose, onConfirm, onOpenGit, probeVersion = 0 }: Props) {
  const defaultWorkspace = isDefaultWorkspaceProject(project);
  const [probe, setProbe] = useState<WorktreeProbeResult | null>(null);
  const [probeLoading, setProbeLoading] = useState(!defaultWorkspace);
  const [useWorktree, setUseWorktree] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (defaultWorkspace) {
      setProbe({ supported: false, isGitRepo: false, clean: true, error: "默认工作区不需要独立 worktree。" });
      setProbeLoading(false);
      return;
    }
    let cancelled = false;
    setProbeLoading(true);
    window.electronAPI.worktreeProbe(project.path)
      .then((result) => {
        if (cancelled) return;
        setProbe(result);
        if (!result.supported || !result.clean) setUseWorktree(false);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setProbe({
          supported: false,
          isGitRepo: false,
          clean: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      })
      .finally(() => {
        if (!cancelled) setProbeLoading(false);
      });
    return () => { cancelled = true; };
  }, [defaultWorkspace, project.path, probeVersion]);

  const canUseWorktree = !!probe?.supported && probe.clean;
  const worktreeHint = useMemo(() => {
    if (defaultWorkspace) return "默认工作区使用共享目录，不创建 worktree。";
    if (probeLoading) return "正在检查 Git 仓库…";
    if (!probe) return "无法检查 Git 仓库。";
    if (!probe.supported) return probe.error || "当前目录不是 Git 仓库，不能创建 worktree。";
    if (!probe.clean) return "主工作区有未提交改动。先提交或储藏后，才能创建独立工作区。";
    return "主工作区保持干净；Agent 会在独立分支和目录中工作。";
  }, [defaultWorkspace, probe, probeLoading]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // 会话页签会立刻建好，弹窗不必等 agent 启动：点创建就关闭。
    // 创建/启动的失败由 onConfirm 侧自己上报（showAppAlert），不再堵在这里。
    onClose();
    void onConfirm({ workspaceMode: useWorktree && canUseWorktree ? "worktree" : "shared" });
  };

  return createPortal(
    <div
      className="project-modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="project-form project-modal new-session-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="project-modal-header">
          <div>
            <h2 id="new-session-title">新建 {agent.name} 会话</h2>
            <p>{project.name} · {project.path}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="project-modal-close"
            aria-label="关闭新建会话弹窗"
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>
        <div className="project-modal-body">
          {!defaultWorkspace && (
            <label className={`new-session-worktree ${canUseWorktree ? "" : "disabled"}`}>
              <input
                type="checkbox"
                checked={useWorktree && canUseWorktree}
                onChange={(event) => setUseWorktree(event.target.checked)}
                disabled={!canUseWorktree}
              />
              <GitBranch size={14} />
              <span>
                <strong>在独立 Git worktree 中运行</strong>
                <small>{worktreeHint}</small>
              </span>
              {probeLoading && <LoaderCircle className="spin" size={14} />}
            </label>
          )}
          {!defaultWorkspace && probe?.supported && !probe.clean && (
            <div className="new-session-git-hint">
              <span>需要先让主工作区变干净，才能创建独立工作区。</span>
              <button type="button" className="btn btn-secondary" onClick={onOpenGit}>
                打开 Git 工作台
              </button>
            </div>
          )}
          <div className="form-actions">
            <button type="button" onClick={onClose} className="btn btn-cancel">取消</button>
            <button type="submit" className="btn btn-primary">创建会话</button>
          </div>
        </div>
      </form>
    </div>,
    document.body,
  );
}
