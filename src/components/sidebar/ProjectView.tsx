import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { useProjectStore } from "@/stores/project-store";
import { useAppStore } from "@/stores/app-store";
import { useShallow } from "zustand/react/shallow";
import { useAgentCatalogStore } from "@/stores/agent-catalog-store";
import { useDragAutoScroll } from "@/hooks/useDragAutoScroll";
import { isDefaultWorkspaceProject } from "@/lib/default-workspace";
import { showFloatingToastMessage } from "@/lib/floating-toast";
import { GitWorkspaceModal, type GitWorkspaceRepo } from "@/components/git/GitWorkspaceModal";
import { ProjectCard } from "./ProjectCard";
import "./Sidebar.css";

type RepoState = { isRepo: boolean; branch?: string };

/**
 * git clone 的 stderr 混着大量 `remote: Compressing objects: N%` 进度，
 * 整段塞进弹窗会撑爆界面。挑出真正说明失败原因的一行做摘要，全文仍可从 title 看。
 */
export function summarizeCloneError(error: string): string {
  const lines = error.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "克隆失败。";
  const fatal = [...lines].reverse().find((line) => /^(fatal|error):/i.test(line));
  if (fatal) return fatal;
  // 没有 fatal 行时取最后一条非进度输出；全是进度就给个固定短句。
  const meaningful = [...lines].reverse().find((line) => !/^remote:\s+(Compressing|Counting|Receiving|Resolving)/i.test(line));
  return meaningful ? meaningful.slice(0, 160) : "克隆失败，请检查仓库地址与网络。";
}

export function ProjectView() {
  const { projects, activeSessionId, projectDataHydrated, addProject, reorderProjects } = useProjectStore(
    useShallow((state) => ({
      projects: state.projects,
      activeSessionId: state.activeSessionId,
      projectDataHydrated: state.projectDataHydrated,
      addProject: state.addProject,
      reorderProjects: state.reorderProjects,
    })),
  );
  const startupCollapseStateRef = useRef<Map<string, boolean> | null>(null);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dropProjectId, setDropProjectId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<"before" | "after">("before");
  const projectScrollRef = useRef<HTMLDivElement>(null);
  const { update: updateProjectAutoScroll, stop: stopProjectAutoScroll } = useDragAutoScroll(projectScrollRef);
  const agents = useAgentCatalogStore((state) => state.agents);
  const loadAgents = useAgentCatalogStore((state) => state.loadAgents);
  const { showAddProject, clearAddProject } = useAppStore(useShallow((state) => ({
    showAddProject: state.showAddProject,
    clearAddProject: state.clearAddProject,
  })));
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [addMode, setAddMode] = useState<"local" | "clone">("local");
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneParent, setCloneParent] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");
  // 每个项目的 Git 探测结果：决定卡片上是否出现工作台入口，以及页签显示的当前分支。
  const [repoStates, setRepoStates] = useState<Record<string, RepoState>>({});
  const [gitActiveId, setGitActiveId] = useState<string | null>(null);
  const [gitProbeVersion, setGitProbeVersion] = useState(0);

  // 只按「项目 id + 路径」重算，会话变化不触发重新探测（一次探测要起 git 子进程）。
  const projectsKey = projects.map((project) => `${project.id}\u0000${project.path}`).join("\u0001");
  const probeTargets = useMemo(
    () => projects.map((project) => ({ id: project.id, path: project.path })),
    [projectsKey],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all(probeTargets.map(async (target) => {
      const result = await window.electronAPI.gitProbe(target.path).catch(() => null);
      return [target.id, result] as const;
    })).then((entries) => {
      if (cancelled) return;
      const next: Record<string, RepoState> = {};
      for (const [id, result] of entries) {
        next[id] = { isRepo: !!result?.isRepo, ...(result?.branch ? { branch: result.branch } : {}) };
      }
      setRepoStates(next);
    });
    return () => { cancelled = true; };
  }, [probeTargets]);

  const gitRepos: GitWorkspaceRepo[] = useMemo(
    () => projects
      .filter((project) => repoStates[project.id]?.isRepo)
      .map((project) => ({
        id: project.id,
        path: project.path,
        label: project.name,
        branch: repoStates[project.id]?.branch,
      })),
    [projects, repoStates],
  );

  const handleGitChanged = useCallback((projectId: string) => {
    // 让 ProjectCard 传给新建会话弹窗的 probeVersion 变化，重新判断 worktree 可用性。
    setGitProbeVersion((value) => value + 1);
    const project = projects.find((item) => item.id === projectId);
    if (!project) return;
    void window.electronAPI.gitProbe(project.path)
      .then((result) => {
        setRepoStates((current) => ({
          ...current,
          [projectId]: { isRepo: !!result.isRepo, ...(result.branch ? { branch: result.branch } : {}) },
        }));
      })
      .catch(() => undefined);
  }, [projects]);

  // 只给“从未手动切换过展开状态”的项目算一个启动默认：默认只展开当前会话
  // 所在的项目。用户手动展开/收起后，项目上会记住 sessionsCollapsed，
  // 下次启动直接沿用（见 ProjectCard）。
  if (projectDataHydrated && startupCollapseStateRef.current === null) {
    const rememberedProjectId = projects.find((project) =>
      project.sessions.some((session) => session.id === activeSessionId)
    )?.id;
    startupCollapseStateRef.current = new Map(
      projects.map((project) => [project.id, project.id !== rememberedProjectId]),
    );
  }

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    if (showAddProject) {
      setShowAdd(true);
      clearAddProject();
    }
  }, [showAddProject]);

  useEffect(() => {
    if (!showAdd) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setShowAdd(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showAdd]);

  const handleAdd = () => {
    if (!name.trim() || !path.trim()) return;
    addProject(name.trim(), path.trim(), agents.map((agent) => agent.id));
    setName("");
    setPath("");
    setShowAdd(false);
  };

  const handleClone = async () => {
    const url = cloneUrl.trim();
    if (!url || addBusy) return;
    setAddBusy(true);
    setAddError("");
    try {
      const result = await window.electronAPI.gitClone(url, cloneParent.trim() || undefined, cloneName.trim() || undefined);
      if (!result.success || !result.path) {
        const error = result.error || "克隆失败。";
        setAddError(error);
        showFloatingToastMessage(summarizeCloneError(error), "error");
        return;
      }
      const folderName = result.path.split(/[/\\]/).filter(Boolean).pop() || cloneName.trim() || "repo";
      addProject(cloneName.trim() || folderName, result.path, agents.map((agent) => agent.id));
      setCloneUrl("");
      setCloneName("");
      setCloneParent("");
      setShowAdd(false);
    } finally {
      setAddBusy(false);
    }
  };

  const handleBrowseParent = async () => {
    const result = await window.electronAPI.openDirectory();
    if (!result.canceled && result.path) setCloneParent(result.path);
  };

  const handleBrowse = async () => {
    const result = await window.electronAPI.openDirectory();
    if (!result.canceled && result.path) {
      setPath(result.path);
      if (!name.trim()) {
        // Auto-fill name from directory name
        const dirName = result.path.split(/[/\\]/).pop() || "";
        setName(dirName);
      }
    }
  };

  const defaultWorkspaceProject = projects.find(isDefaultWorkspaceProject);
  const draggableProjects = projects.filter((project) => !isDefaultWorkspaceProject(project));

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>项目</span>
        <button onClick={() => setShowAdd(!showAdd)} className="btn-add">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {showAdd && createPortal(
        <div
          className="project-modal-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowAdd(false);
          }}
        >
          <form
            className="project-form project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-project-title"
            onSubmit={(event) => {
              event.preventDefault();
              if (addMode === "clone") void handleClone();
              else handleAdd();
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="project-modal-header">
              <div>
                <h2 id="add-project-title">添加项目</h2>
                <p>添加本地目录，或从 Git 地址克隆一个仓库</p>
              </div>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="project-modal-close"
                aria-label="关闭添加项目弹窗"
                title="关闭"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="project-modal-body">
              <div className="add-project-mode" role="tablist" aria-label="添加方式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={addMode === "local"}
                  className={addMode === "local" ? "active" : ""}
                  onClick={() => { setAddMode("local"); setAddError(""); }}
                  disabled={addBusy}
                >
                  本地目录
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={addMode === "clone"}
                  className={addMode === "clone" ? "active" : ""}
                  onClick={() => { setAddMode("clone"); setAddError(""); }}
                  disabled={addBusy}
                >
                  克隆 Git 仓库
                </button>
              </div>

              {addMode === "local" ? (
                <>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="项目名称"
                    aria-label="项目名称"
                    autoFocus
                    className="input-field"
                  />
                  <div className="path-input-row">
                    <input
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                      placeholder="项目路径"
                      aria-label="项目路径"
                      className="input-field path-input"
                    />
                    <button type="button" onClick={handleBrowse} className="btn-browse">浏览</button>
                  </div>
                </>
              ) : (
                <>
                  <input
                    value={cloneUrl}
                    onChange={(e) => setCloneUrl(e.target.value)}
                    placeholder="仓库地址，如 https://github.com/user/repo.git"
                    aria-label="Git 仓库地址"
                    autoFocus
                    className="input-field"
                    disabled={addBusy}
                  />
                  <div className="path-input-row">
                    <input
                      value={cloneParent}
                      onChange={(e) => setCloneParent(e.target.value)}
                      placeholder="克隆到哪个目录（留空用用户目录）"
                      aria-label="克隆父目录"
                      className="input-field path-input"
                      disabled={addBusy}
                    />
                    <button type="button" onClick={() => void handleBrowseParent()} className="btn-browse" disabled={addBusy}>浏览</button>
                  </div>
                  <input
                    value={cloneName}
                    onChange={(e) => setCloneName(e.target.value)}
                    placeholder="目录名 / 项目名（留空按仓库名）"
                    aria-label="克隆目录名"
                    className="input-field"
                    disabled={addBusy}
                  />
                </>
              )}
              {addError && (
                <div className="add-project-error" title={addError}>
                  {summarizeCloneError(addError)}
                </div>
              )}
              <div className="form-actions">
                <button type="button" onClick={() => setShowAdd(false)} className="btn btn-cancel" disabled={addBusy}>取消</button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={addBusy || (addMode === "clone" ? !cloneUrl.trim() : false)}
                >
                  {addBusy ? "克隆中…" : addMode === "clone" ? "克隆并添加" : "添加"}
                </button>
              </div>
            </div>
          </form>
        </div>,
        document.body,
      )}

      <div
        ref={projectScrollRef}
        className="sidebar-content"
        onDragOver={(event) => {
          if (draggedProjectId) updateProjectAutoScroll(event.clientY);
        }}
        onDrop={stopProjectAutoScroll}
      >
        {projects.length === 0 && !showAdd && (
          <div className="placeholder-text">暂无项目</div>
        )}
        <div className="project-list">
          {/* 内置默认工作区固定置顶：不参与拖拽排序，也不会被当作投放目标。
              启动时强制展开 —— 收起状态会把 Agent 快捷启动按钮一起藏掉。 */}
          {defaultWorkspaceProject && (
            <div className="project-card-pinned">
              <ProjectCard
                project={defaultWorkspaceProject}
                initialSessionsCollapsed={false}
                isGitRepo={!!repoStates[defaultWorkspaceProject.id]?.isRepo}
                gitBranch={repoStates[defaultWorkspaceProject.id]?.branch}
                onOpenGit={setGitActiveId}
                gitProbeVersion={gitProbeVersion}
              />
            </div>
          )}
          {draggableProjects.map((project) => (
            <div
              key={project.id}
              className={`project-card-drag-wrapper ${draggedProjectId === project.id ? "dragging" : ""} ${dropProjectId === project.id ? `drop-target ${dropPosition}` : ""}`}
              draggable={draggableProjects.length > 1}
              onDragStart={(event: DragEvent<HTMLDivElement>) => {
                stopProjectAutoScroll();
                setDraggedProjectId(project.id);
                setDropPosition("before");
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", project.id);
              }}
              onDragOver={(event) => {
                if (!draggedProjectId || draggedProjectId === project.id) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const sourceIndex = projects.findIndex((item) => item.id === draggedProjectId);
                const targetIndex = projects.findIndex((item) => item.id === project.id);
                const insertAfter = event.clientY >= rect.top + rect.height / 2;
                const rawInsertIndex = targetIndex + (insertAfter ? 1 : 0);
                const nextIndex = sourceIndex < rawInsertIndex ? rawInsertIndex - 1 : rawInsertIndex;
                if (sourceIndex < 0 || targetIndex < 0 || nextIndex === sourceIndex) {
                  setDropProjectId((current) => current === project.id ? null : current);
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropProjectId(project.id);
                setDropPosition(insertAfter ? "after" : "before");
              }}
              onDragLeave={(event) => {
                const relatedTarget = event.relatedTarget;
                if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
                setDropProjectId((current) => current === project.id ? null : current);
              }}
              onDrop={(event) => {
                event.preventDefault();
                stopProjectAutoScroll();
                const sourceId = event.dataTransfer.getData("text/plain") || draggedProjectId;
                if (sourceId && dropProjectId === project.id) {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const insertAfter = event.clientY >= rect.top + rect.height / 2;
                  reorderProjects(sourceId, project.id, insertAfter);
                }
                setDraggedProjectId(null);
                setDropProjectId(null);
                setDropPosition("before");
              }}
              onDragEnd={() => {
                stopProjectAutoScroll();
                setDraggedProjectId(null);
                setDropProjectId(null);
                setDropPosition("before");
              }}
            >
              <ProjectCard
                project={project}
                initialSessionsCollapsed={
                  project.sessionsCollapsed
                  ?? startupCollapseStateRef.current?.get(project.id)
                  ?? false
                }
                isGitRepo={!!repoStates[project.id]?.isRepo}
                gitBranch={repoStates[project.id]?.branch}
                onOpenGit={setGitActiveId}
                gitProbeVersion={gitProbeVersion}
              />
            </div>
          ))}
        </div>
      </div>

      {gitActiveId && gitRepos.length > 0 && (
        <GitWorkspaceModal
          repos={gitRepos}
          activeId={gitActiveId}
          onSelect={setGitActiveId}
          onClose={() => setGitActiveId(null)}
          onChanged={handleGitChanged}
        />
      )}
    </div>
  );
}
