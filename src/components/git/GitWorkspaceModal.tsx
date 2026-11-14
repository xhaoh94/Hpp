import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Archive,
  Check,
  Download,
  ExternalLink,
  FolderGit2,
  GitBranch,
  History,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";

import { parseGitPatch } from "@shared/git-hunks";
import type {
  GitBranch as GitBranchInfo,
  GitConflictChoice,
  GitFileChange,
  GitLogEntry,
  GitStashEntry,
  GitStatus,
  GitWorktreeEntry,
} from "@shared/git-types";
import { showAppConfirm } from "@/lib/app-dialog";
import { showFloatingToastMessage } from "@/lib/floating-toast";
import "./GitWorkspaceModal.css";

export type GitWorkspaceTarget = {
  path: string;
  label: string;
};

interface Props {
  target: GitWorkspaceTarget;
  onClose: () => void;
  onChanged?: () => void;
}

type ChangeItem = GitFileChange & { stagedView: boolean };

const statusLabel = (code: string) => {
  if (code === "??") return "未跟踪";
  if (code.includes("A")) return "新增";
  if (code.includes("D")) return "删除";
  if (code.includes("R")) return "重命名";
  if (code.includes("C")) return "复制";
  if (code.includes("M")) return "修改";
  return code.trim() || "变更";
};

const formatGitDate = (value: string) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
};

const buildItems = (status: GitStatus | null): ChangeItem[] => {
  const files = status?.files || [];
  return files.flatMap((file) => {
    if (file.conflicted) return [];
    const items: ChangeItem[] = [];
    if (file.staged) items.push({ ...file, stagedView: true });
    if (file.unstaged || file.untracked) items.push({ ...file, stagedView: false });
    return items;
  });
};

export function GitWorkspaceModal({ target, onClose, onChanged }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selectedKey, setSelectedKey] = useState("");
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [tab, setTab] = useState<"changes" | "history" | "branches" | "worktrees" | "stash">("changes");
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [stashMessage, setStashMessage] = useState("Hpp: 临时暂存");
  const [search, setSearch] = useState("");
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [newBranch, setNewBranch] = useState("");
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([]);
  const [logSearch, setLogSearch] = useState("");
  const [selectedCommit, setSelectedCommit] = useState("");
  const [commitDiff, setCommitDiff] = useState("");
  const [worktrees, setWorktrees] = useState<GitWorktreeEntry[]>([]);

  const items = useMemo(() => buildItems(status), [status]);
  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? items.filter((item) => item.path.toLowerCase().includes(query)) : items;
  }, [items, search]);
  const stagedItems = filteredItems.filter((item) => item.stagedView);
  const unstagedItems = filteredItems.filter((item) => !item.stagedView);
  const conflictedItems = (status?.files || []).filter((file) => file.conflicted);
  const selected = items.find((item) => `${item.path}:${item.stagedView}` === selectedKey);
  const parsedDiff = useMemo(() => parseGitPatch(diff), [diff]);

  const loadStatus = useCallback(async (preferredKey?: string) => {
    setBusy("refresh");
    setError("");
    try {
      const next = await window.electronAPI.gitStatus(target.path);
      if (!next.success) {
        setError(next.error || "读取 Git 状态失败。");
        return;
      }
      setStatus(next);
      const nextItems = buildItems(next);
      const key = preferredKey && nextItems.some((item) => `${item.path}:${item.stagedView}` === preferredKey)
        ? preferredKey
        : nextItems[0] ? `${nextItems[0].path}:${nextItems[0].stagedView}` : "";
      setSelectedKey(key);
    } finally {
      setBusy("");
    }
  }, [target.path]);

  const loadDiff = useCallback(async (item: ChangeItem | undefined) => {
    if (!item) {
      setDiff("");
      return;
    }
    setDiffLoading(true);
    setDiff("");
    try {
      const result = await window.electronAPI.gitDiff(target.path, item.path, item.stagedView);
      setDiff(result.success
        ? (result.patch || (result.binary ? "二进制文件，无法显示文本 diff。" : "没有可显示的 diff。"))
        : (result.error || "读取 diff 失败。"));
    } finally {
      setDiffLoading(false);
    }
  }, [target.path]);

  const loadStashes = useCallback(async () => {
    const result = await window.electronAPI.gitStashList(target.path);
    if (result.success) setStashes(result.stashes || []);
    else setError(result.error || "读取 stash 失败。");
  }, [target.path]);

  const loadBranches = useCallback(async () => {
    const result = await window.electronAPI.gitBranches(target.path);
    if (result.success) setBranches(result.branches || []);
    else setError(result.error || "读取分支失败。");
  }, [target.path]);

  const loadLog = useCallback(async () => {
    const result = await window.electronAPI.gitLog(target.path, 80);
    if (result.success) {
      const entries = result.entries || [];
      setLogEntries(entries);
      setSelectedCommit((current) => current && entries.some((entry) => entry.hash === current) ? current : (entries[0]?.hash || ""));
    } else setError(result.error || "读取提交历史失败。");
  }, [target.path]);

  const loadWorktrees = useCallback(async () => {
    const result = await window.electronAPI.gitWorktrees(target.path);
    if (result.success) setWorktrees(result.worktrees || []);
    else setError(result.error || "读取 worktree 失败。");
  }, [target.path]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    void loadDiff(selected);
  }, [loadDiff, selected]);

  useEffect(() => {
    if (tab === "stash") void loadStashes();
    else if (tab === "branches") void loadBranches();
    else if (tab === "history") void loadLog();
    else if (tab === "worktrees") void loadWorktrees();
  }, [loadBranches, loadLog, loadStashes, loadWorktrees, tab]);

  useEffect(() => {
    if (!selectedCommit) {
      setCommitDiff("");
      return;
    }
    let cancelled = false;
    void window.electronAPI.gitShowCommit(target.path, selectedCommit).then((result) => {
      if (cancelled) return;
      setCommitDiff(result.success ? (result.patch || "") : (result.error || "读取提交失败。"));
    });
    return () => { cancelled = true; };
  }, [selectedCommit, target.path]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose]);

  const refresh = async (preferredKey?: string) => {
    await loadStatus(preferredKey || selectedKey);
    if (tab === "stash") await loadStashes();
    onChanged?.();
  };

  const stage = async (paths: string[]) => {
    if (paths.length === 0) return;
    setBusy("stage");
    setError("");
    const result = await window.electronAPI.gitStage(target.path, paths);
    if (!result.success) setError(result.error || "暂存失败。");
    else await refresh();
    setBusy("");
  };

  const unstage = async (paths: string[]) => {
    if (paths.length === 0) return;
    setBusy("unstage");
    setError("");
    const result = await window.electronAPI.gitUnstage(target.path, paths);
    if (!result.success) setError(result.error || "取消暂存失败。");
    else await refresh();
    setBusy("");
  };

  const discard = async (item: ChangeItem) => {
    const confirmed = await showAppConfirm(
      `丢弃「${item.path}」${item.untracked ? "（未跟踪文件会被删除）" : "的改动"}？此操作不可撤销。`,
      { title: "丢弃改动", confirmLabel: "丢弃" },
    );
    if (!confirmed) return;
    setBusy("discard");
    setError("");
    const result = await window.electronAPI.gitDiscard(target.path, [item.path]);
    if (!result.success) setError(result.error || "丢弃失败。");
    else await refresh();
    setBusy("");
  };

  const applyHunks = async (indexes: number[]) => {
    if (!selected) return;
    setBusy("hunks");
    setError("");
    const result = await window.electronAPI.gitStageHunks(
      target.path,
      selected.path,
      indexes,
      selected.stagedView ? "unstage" : "stage",
    );
    if (!result.success) setError(result.error || "按块暂存失败。");
    else await refresh();
    setBusy("");
  };

  const discardHunks = async (indexes: number[]) => {
    if (!selected) return;
    const confirmed = await showAppConfirm(
      `丢弃「${selected.path}」中选中的 hunk？这会撤销工作区里的这部分改动，且不可恢复。`,
      { title: "丢弃 Hunk", confirmLabel: "丢弃" },
    );
    if (!confirmed) return;
    setBusy("hunks");
    setError("");
    const result = await window.electronAPI.gitDiscardHunks(target.path, selected.path, indexes);
    if (!result.success) setError(result.error || "丢弃 hunk 失败。");
    else await refresh();
    setBusy("");
  };

  const mergeBranch = async (branch: GitBranchInfo) => {
    if (branch.current) return;
    const confirmed = await showAppConfirm(
      `把 ${branch.name} 合并到当前分支？\n\n有冲突时会停留在 merge 状态，可在变更页解决。`,
      { title: "合并分支", confirmLabel: "合并" },
    );
    if (!confirmed) return;
    setBusy("merge");
    setError("");
    const result = await window.electronAPI.gitMerge(target.path, branch.name);
    await loadStatus();
    await loadBranches();
    await loadLog();
    onChanged?.();
    if (!result.success) {
      setError(result.error || "合并失败。");
      if (result.conflict) setTab("changes");
    } else {
      showFloatingToastMessage(result.output || "合并完成");
    }
    setBusy("");
  };

  const rebaseBranch = async (branch: GitBranchInfo) => {
    if (branch.current) return;
    const confirmed = await showAppConfirm(
      `将当前分支变基到 ${branch.name}？\n\n这会重写当前分支的提交历史；有冲突时会停留在 rebase 状态。`,
      { title: "变基", confirmLabel: "开始变基" },
    );
    if (!confirmed) return;
    setBusy("rebase");
    setError("");
    const result = await window.electronAPI.gitRebase(target.path, branch.name);
    await loadStatus();
    await loadBranches();
    await loadLog();
    onChanged?.();
    if (!result.success) {
      setError(result.error || "变基失败。");
      if (result.conflict) setTab("changes");
    } else {
      showFloatingToastMessage(result.output || "变基完成");
    }
    setBusy("");
  };

  const commit = async () => {
    setBusy("commit");
    setError("");
    const result = await window.electronAPI.gitCommit(target.path, message, amend);
    if (!result.success) {
      setError(result.error || "提交失败。");
    } else {
      setMessage("");
      setAmend(false);
      showFloatingToastMessage(`已提交 ${result.commit || ""}`.trim());
      await refresh();
    }
    setBusy("");
  };

  const createStash = async () => {
    setBusy("stash");
    setError("");
    const result = await window.electronAPI.gitStashCreate(target.path, stashMessage);
    if (!result.success) setError(result.error || "创建 stash 失败。");
    else {
      showFloatingToastMessage("已创建 stash");
      await refresh();
    }
    setBusy("");
  };

  const popStash = async (entry: GitStashEntry) => {
    const confirmed = await showAppConfirm(`恢复 ${entry.ref}？\n\n${entry.message}`, {
      title: "恢复 Stash",
      confirmLabel: "恢复",
    });
    if (!confirmed) return;
    setBusy("stashPop");
    setError("");
    const result = await window.electronAPI.gitStashPop(target.path, entry.ref);
    if (!result.success) setError(result.error || "恢复 stash 失败。");
    else {
      showFloatingToastMessage("stash 已恢复");
      await refresh();
    }
    setBusy("");
  };

  // 搜索只影响列表展示；全部暂存/取消暂存仍作用于全部改动。
  const remoteAction = async (kind: "fetch" | "pull" | "push") => {
    if (kind !== "fetch") {
      const confirmed = await showAppConfirm(
        kind === "pull"
          ? "执行 git pull --ff-only？只有快进合并时才会成功。"
          : "执行 git push？推送当前分支到已配置的 upstream。",
        { title: kind === "pull" ? "拉取更新" : "推送提交", confirmLabel: kind === "pull" ? "拉取" : "推送" },
      );
      if (!confirmed) return;
    }
    setBusy(kind);
    setError("");
    const result = kind === "fetch"
      ? await window.electronAPI.gitFetch(target.path)
      : kind === "pull"
        ? await window.electronAPI.gitPull(target.path)
        : await window.electronAPI.gitPush(target.path);
    if (!result.success) {
      setError(result.error || `${kind} 失败。`);
    } else {
      showFloatingToastMessage(result.output || `${kind} 完成`);
      await loadStatus(selectedKey);
      await loadBranches();
      await loadLog();
      onChanged?.();
    }
    setBusy("");
  };

  const createBranch = async () => {
    const name = newBranch.trim();
    if (!name) return;
    setBusy("branch");
    setError("");
    const result = await window.electronAPI.gitCreateBranch(target.path, name);
    if (!result.success) setError(result.error || "创建分支失败。");
    else {
      setNewBranch("");
      showFloatingToastMessage(result.output || "分支已创建");
      await loadBranches();
    }
    setBusy("");
  };

  const switchBranch = async (branch: GitBranchInfo) => {
    if (branch.current) return;
    const confirmed = await showAppConfirm(`切换到分支 ${branch.name}？\n\n工作区有未提交改动时 Git 可能拒绝切换。`, {
      title: "切换分支",
      confirmLabel: "切换",
    });
    if (!confirmed) return;
    setBusy("branch");
    setError("");
    const result = await window.electronAPI.gitSwitchBranch(target.path, branch.name);
    if (!result.success) setError(result.error || "切换分支失败。");
    else {
      showFloatingToastMessage(`已切换到 ${branch.name}`);
      await loadStatus();
      await loadBranches();
      await loadLog();
      onChanged?.();
    }
    setBusy("");
  };

  const deleteBranch = async (branch: GitBranchInfo) => {
    if (branch.current) return;
    const confirmed = await showAppConfirm(`删除本地分支 ${branch.name}？只允许删除已合并的分支。`, {
      title: "删除分支",
      confirmLabel: "删除",
    });
    if (!confirmed) return;
    setBusy("branch");
    setError("");
    const result = await window.electronAPI.gitDeleteBranch(target.path, branch.name);
    if (!result.success) setError(result.error || "删除分支失败。");
    else {
      showFloatingToastMessage(`已删除 ${branch.name}`);
      await loadBranches();
    }
    setBusy("");
  };

  const deleteWorktree = async (entry: GitWorktreeEntry) => {
    if (entry.current) return;
    const confirmed = await showAppConfirm(`强制删除 worktree？\n\n${entry.path}\n\n未提交的改动会丢失。`, {
      title: "删除 Worktree",
      confirmLabel: "删除",
    });
    if (!confirmed) return;
    setBusy("worktree");
    setError("");
    const result = await window.electronAPI.gitRemoveWorktree(target.path, entry.path);
    if (!result.success) setError(result.error || "删除 worktree 失败。");
    else {
      showFloatingToastMessage("worktree 已删除");
      await loadWorktrees();
      await loadStatus();
    }
    setBusy("");
  };

  const resolveConflict = async (file: GitFileChange, choice: GitConflictChoice) => {
    if (choice !== "mark") {
      const confirmed = await showAppConfirm(
        `对「${file.path}」使用${choice === "ours" ? "当前分支" : "对方分支"}版本？这会覆盖另一方的冲突内容。`,
        { title: "解决冲突", confirmLabel: "使用该版本" },
      );
      if (!confirmed) return;
    }
    setBusy("conflict");
    setError("");
    const result = await window.electronAPI.gitResolveConflict(target.path, file.path, choice);
    if (!result.success) setError(result.error || "解决冲突失败。");
    else {
      showFloatingToastMessage(result.output || "冲突已处理");
      await refresh();
    }
    setBusy("");
  };

  const continueOperation = async () => {
    const confirmed = await showAppConfirm("继续当前合并 / rebase？请确认所有冲突已解决并已暂存。", {
      title: "继续操作",
      confirmLabel: "继续",
    });
    if (!confirmed) return;
    setBusy("continue");
    setError("");
    const result = await window.electronAPI.gitContinueOperation(target.path);
    if (!result.success) setError(result.error || "继续操作失败。");
    else {
      showFloatingToastMessage("操作已继续");
      await refresh();
    }
    setBusy("");
  };

  const abortOperation = async () => {
    const confirmed = await showAppConfirm("中止当前合并 / rebase？本次操作中的解决进度会丢失。", {
      title: "中止操作",
      confirmLabel: "中止",
    });
    if (!confirmed) return;
    setBusy("abort");
    setError("");
    const result = await window.electronAPI.gitAbortOperation(target.path);
    if (!result.success) setError(result.error || "中止操作失败。");
    else {
      showFloatingToastMessage("操作已中止");
      await refresh();
    }
    setBusy("");
  };

  const openConflictFile = async (file: GitFileChange) => {
    if (!status?.repoRoot) return;
    const separator = status.repoRoot.includes("\\") ? "\\" : "/";
    const result = await window.electronAPI.openPathInShell(`${status.repoRoot}${separator}${file.path}`);
    if (!result.success) setError(result.error || "打开文件失败。");
  };

  const allUnstagedPaths = [...new Set(items.filter((item) => !item.stagedView).map((item) => item.path))];
  const allStagedPaths = [...new Set(items.filter((item) => item.stagedView).map((item) => item.path))];
  const hasStaged = items.some((item) => item.stagedView);
  const hasChanges = items.length > 0;

  return createPortal(
    <div
      className="git-workspace-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="git-workspace-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-workspace-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="git-workspace-header">
          <div className="git-workspace-title">
            <GitBranch size={16} />
            <div>
              <h2 id="git-workspace-title">Git · {target.label}</h2>
              <span>
                {status?.branch || "…"}
                {status?.upstream ? ` · ${status.upstream}` : ""}
                {status?.ahead ? ` · ↑${status.ahead}` : ""}
                {status?.behind ? ` · ↓${status.behind}` : ""}
                {status?.clean ? " · 工作区干净" : ""}
              </span>
            </div>
          </div>
          <div className="git-workspace-actions">
            <button type="button" className="git-remote-btn" onClick={() => void remoteAction("fetch")} disabled={!!busy} title="git fetch --prune">
              <Download size={13} /> Fetch
            </button>
            <button type="button" className="git-remote-btn" onClick={() => void remoteAction("pull")} disabled={!!busy} title="git pull --ff-only">
              <Download size={13} /> Pull
            </button>
            <button type="button" className="git-remote-btn" onClick={() => void remoteAction("push")} disabled={!!busy} title="git push">
              <Upload size={13} /> Push
            </button>
            <button type="button" className="git-icon-btn" onClick={() => void refresh()} title="刷新" disabled={!!busy}>
              <RefreshCw size={15} className={busy === "refresh" ? "spin" : ""} />
            </button>
            <button type="button" className="git-icon-btn" onClick={onClose} title="关闭" disabled={!!busy}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="git-workspace-tabs">
          <button type="button" className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
            变更 {items.length > 0 ? `(${items.length})` : ""}
          </button>
          <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
            <History size={13} /> 历史
          </button>
          <button type="button" className={tab === "branches" ? "active" : ""} onClick={() => setTab("branches")}>
            <GitBranch size={13} /> 分支
          </button>
          <button type="button" className={tab === "worktrees" ? "active" : ""} onClick={() => setTab("worktrees")}>
            <FolderGit2 size={13} /> 工作区
          </button>
          <button type="button" className={tab === "stash" ? "active" : ""} onClick={() => setTab("stash")}>
            <Archive size={13} /> Stash {stashes.length > 0 ? `(${stashes.length})` : ""}
          </button>
          <span className="git-workspace-path" title={status?.repoRoot || target.path}>{status?.repoRoot || target.path}</span>
        </div>

        {error && <div className="git-workspace-error">{error}</div>}

        {status?.operation && status.operation !== "none" && (
          <div className="git-conflict-banner">
            <AlertTriangle size={15} />
            <span>
              正在进行 {status.operation} 操作
              {conflictedItems.length > 0 ? `，还有 ${conflictedItems.length} 个冲突文件` : "，冲突已全部解决"}
            </span>
            <div className="git-conflict-actions">
              <button type="button" onClick={() => void continueOperation()} disabled={!!busy || conflictedItems.length > 0}>继续</button>
              <button type="button" className="danger" onClick={() => void abortOperation()} disabled={!!busy}>中止</button>
            </div>
          </div>
        )}

        {tab === "changes" ? (
          <>
            <div className="git-workspace-body">
              <aside className="git-files-pane">
                <label className="git-file-search">
                  <span>搜索</span>
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="筛选文件…" />
                </label>
                <div className="git-files-toolbar">
                  <button type="button" disabled={!!busy || allUnstagedPaths.length === 0} onClick={() => void stage(allUnstagedPaths)}>
                    全部暂存
                  </button>
                  <button type="button" disabled={!!busy || allStagedPaths.length === 0} onClick={() => void unstage(allStagedPaths)}>
                    全部取消暂存
                  </button>
                </div>
                <div className="git-file-sections">
                  {conflictedItems.length > 0 && (
                    <>
                      <div className="git-file-section-title conflict">冲突 <span>{conflictedItems.length}</span></div>
                      {conflictedItems.map((file) => (
                        <div className="git-conflict-row" key={file.path}>
                          <AlertTriangle size={13} />
                          <span className="git-file-path" title={file.path}>{file.path}</span>
                          <button type="button" onClick={() => void resolveConflict(file, "ours")} disabled={!!busy} title="使用当前分支版本">当前</button>
                          <button type="button" onClick={() => void resolveConflict(file, "theirs")} disabled={!!busy} title="使用对方分支版本">对方</button>
                          <button type="button" onClick={() => void resolveConflict(file, "mark")} disabled={!!busy} title="已手动解决，标记为已解决">已解决</button>
                          <button type="button" className="git-file-action" onClick={() => void openConflictFile(file)} disabled={!!busy} title="在外部应用打开">
                            <ExternalLink size={12} />
                          </button>
                        </div>
                      ))}
                    </>
                  )}
                  <div className="git-file-section-title">变更 <span>{unstagedItems.length}</span></div>
                  {unstagedItems.length === 0 ? <div className="git-file-empty">暂无</div> : unstagedItems.map((item) => (
                    <div
                      key={`${item.path}:unstaged`}
                      className={`git-file-row ${selectedKey === `${item.path}:unstaged` ? "active" : ""}`}
                      onClick={() => setSelectedKey(`${item.path}:unstaged`)}
                    >
                      <span className={`git-status-dot ${item.untracked ? "untracked" : item.status.trim().charAt(1) || "M"}`} />
                      <span className="git-file-path" title={item.path}>{item.path}</span>
                      <button
                        type="button"
                        className="git-file-action"
                        title="暂存"
                        disabled={!!busy}
                        onClick={(event) => { event.stopPropagation(); void stage([item.path]); }}
                      >
                        <Plus size={13} />
                      </button>
                      {!stagedItems.some((stagedItem) => stagedItem.path === item.path) && (
                        <button
                          type="button"
                          className="git-file-action danger"
                          title="丢弃改动"
                          disabled={!!busy}
                          onClick={(event) => { event.stopPropagation(); void discard(item); }}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  ))}

                  <div className="git-file-section-title">待提交 <span>{stagedItems.length}</span></div>
                  {stagedItems.length === 0 ? <div className="git-file-empty">暂存变更后会出现在这里</div> : stagedItems.map((item) => (
                    <div
                      key={`${item.path}:staged`}
                      className={`git-file-row ${selectedKey === `${item.path}:staged` ? "active" : ""}`}
                      onClick={() => setSelectedKey(`${item.path}:staged`)}
                    >
                      <span className={`git-status-dot ${item.status.trim().charAt(0) || "M"}`} />
                      <span className="git-file-path" title={item.path}>{item.path}</span>
                      <button
                        type="button"
                        className="git-file-action"
                        title="取消暂存"
                        disabled={!!busy}
                        onClick={(event) => { event.stopPropagation(); void unstage([item.path]); }}
                      >
                        <Minus size={13} />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="git-commit-pane">
                  <div className="git-commit-label">提交信息</div>
                  <textarea
                    value={message}
                    rows={2}
                    placeholder="输入提交信息（必填）"
                    onChange={(event) => setMessage(event.target.value)}
                    disabled={!!busy}
                  />
                  <div className="git-commit-actions">
                    <label className="git-amend">
                      <input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} disabled={!!busy} />
                      修改上次提交
                    </label>
                    <button
                      type="button"
                      className="git-primary-btn"
                      onClick={() => void commit()}
                      disabled={!!busy || !message.trim() || (!hasStaged && !amend)}
                      title={hasStaged ? `提交到 ${status?.branch || "当前分支"}` : "先暂存变更后再提交"}
                    >
                      {busy === "commit" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
                      提交到 {status?.branch || "当前分支"}
                    </button>
                  </div>
                </div>
              </aside>

              <section className="git-diff-pane">
                <div className="git-diff-header">
                  <span title={selected?.path}>{selected?.path || "选择一个文件查看 diff"}</span>
                  {selected && <span>{statusLabel(selected.status)} · {selected.stagedView ? "已暂存" : "工作区"}</span>}
                </div>
                <div className="git-diff-content">
                  {diffLoading ? <div className="git-diff-empty"><LoaderCircle className="spin" size={16} /> 读取中…</div>
                    : diff && parsedDiff.hunks.length > 0 && !selected?.untracked ? (
                      <div className="git-hunks">
                        {parsedDiff.hunks.map((hunk) => (
                          <div className="git-hunk-block" key={hunk.index}>
                            <div className="git-hunk-header">
                              <code>{hunk.header}</code>
                              <div className="git-hunk-actions">
                                <button
                                  type="button"
                                  onClick={() => void applyHunks([hunk.index])}
                                  disabled={!!busy}
                                >
                                  {selected?.stagedView ? "取消此块" : "暂存此块"}
                                </button>
                                {!selected?.stagedView && (
                                  <button
                                    type="button"
                                    className="danger"
                                    onClick={() => void discardHunks([hunk.index])}
                                    disabled={!!busy}
                                  >
                                    丢弃此块
                                  </button>
                                )}
                              </div>
                            </div>
                            <div className="git-hunk-lines">
                              {hunk.lines.map((line, index) => (
                                <div
                                  className={`git-hunk-line ${line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : ""}`}
                                  key={`${hunk.index}-${index}`}
                                >{line || " "}</div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : diff ? <pre>{diff}</pre>
                      : <div className="git-diff-empty">{selected ? "没有可显示的 diff。" : hasChanges ? "选择一个文件查看 diff" : "工作区干净，没有待处理改动。"}</div>}
                </div>
              </section>
            </div>
          </>
        ) : tab === "history" ? (
          <div className="git-workspace-body">
            <aside className="git-files-pane">
              <label className="git-file-search">
                <span>提交</span>
                <input value={logSearch} onChange={(event) => setLogSearch(event.target.value)} placeholder="搜索提交…" />
              </label>
              <div className="git-file-sections">
                {logEntries.filter((entry) => {
                  const query = logSearch.trim().toLowerCase();
                  return !query || entry.subject.toLowerCase().includes(query) || entry.author.toLowerCase().includes(query) || entry.shortHash.toLowerCase().includes(query);
                }).map((entry) => (
                  <div
                    key={entry.hash}
                    className={`git-commit-row ${selectedCommit === entry.hash ? "active" : ""}`}
                    onClick={() => setSelectedCommit(entry.hash)}
                    title={entry.hash}
                  >
                    <strong>{entry.subject}</strong>
                    <span>{entry.shortHash} · {entry.author} · {formatGitDate(entry.date)}</span>
                  </div>
                ))}
                {logEntries.length === 0 && <div className="git-file-empty">暂无提交记录</div>}
              </div>
            </aside>
            <section className="git-diff-pane">
              <div className="git-diff-header">
                <span>{logEntries.find((entry) => entry.hash === selectedCommit)?.subject || "选择提交查看详情"}</span>
                {selectedCommit && <span>{selectedCommit.slice(0, 8)}</span>}
              </div>
              <div className="git-diff-content">
                {commitDiff ? <pre>{commitDiff}</pre> : <div className="git-diff-empty">{selectedCommit ? "读取中…" : "选择一个提交查看详情"}</div>}
              </div>
            </section>
          </div>
        ) : tab === "branches" ? (
          <div className="git-simple-pane">
            <div className="git-stash-create">
              <input value={newBranch} onChange={(event) => setNewBranch(event.target.value)} placeholder="新分支名" disabled={!!busy} />
              <button type="button" onClick={() => void createBranch()} disabled={!!busy || !newBranch.trim()}>
                <GitBranch size={14} /> 创建分支
              </button>
            </div>
            <div className="git-branch-list">
              {branches.map((branch) => (
                <div className="git-simple-row" key={branch.name}>
                  <GitBranch size={14} />
                  <div>
                    <strong>{branch.name}{branch.current ? " · 当前分支" : ""}</strong>
                    <span>{branch.upstream || "没有 upstream"}</span>
                  </div>
                  <button type="button" onClick={() => void switchBranch(branch)} disabled={!!busy || branch.current}>
                    切换
                  </button>
                  <button type="button" onClick={() => void mergeBranch(branch)} disabled={!!busy || branch.current} title="git merge 此分支">
                    合并
                  </button>
                  <button type="button" onClick={() => void rebaseBranch(branch)} disabled={!!busy || branch.current} title="git rebase 此分支">
                    变基
                  </button>
                  <button type="button" className="danger" onClick={() => void deleteBranch(branch)} disabled={!!busy || branch.current}>
                    删除
                  </button>
                </div>
              ))}
              {branches.length === 0 && <div className="git-diff-empty">没有本地分支。</div>}
            </div>
            <p className="git-simple-note">切换分支前请确认工作区干净；删除只允许已合并的本地分支。</p>
          </div>
        ) : tab === "worktrees" ? (
          <div className="git-simple-pane">
            <div className="git-branch-list">
              {worktrees.map((entry) => (
                <div className="git-simple-row" key={entry.path}>
                  <FolderGit2 size={14} />
                  <div>
                    <strong>{entry.branch || (entry.detached ? "(detached)" : "(unknown)")}{entry.current ? " · 当前" : ""}</strong>
                    <span>{entry.path}{entry.head ? ` · ${entry.head.slice(0, 8)}` : ""}</span>
                  </div>
                  <button type="button" className="danger" onClick={() => void deleteWorktree(entry)} disabled={!!busy || entry.current} title="强制删除 worktree">
                    删除
                  </button>
                </div>
              ))}
              {worktrees.length === 0 && <div className="git-diff-empty">没有 worktree。</div>}
            </div>
            <p className="git-simple-note">删除 worktree 会同时丢弃其中未提交的改动，请先确认。</p>
          </div>
        ) : (
          <div className="git-stash-pane">
            <div className="git-stash-create">
              <input value={stashMessage} onChange={(event) => setStashMessage(event.target.value)} placeholder="Stash 说明" disabled={!!busy} />
              <button type="button" onClick={() => void createStash()} disabled={!!busy}>
                <Archive size={14} /> 暂存当前改动
              </button>
            </div>
            <div className="git-stash-list">
              {stashes.length === 0 ? <div className="git-diff-empty">没有 stash。</div> : stashes.map((entry) => (
                <div className="git-stash-row" key={entry.ref}>
                  <div><strong>{entry.ref}</strong><span>{entry.message}</span></div>
                  <button type="button" onClick={() => void popStash(entry)} disabled={!!busy}>
                    <Undo2 size={14} /> 恢复
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
