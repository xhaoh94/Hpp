import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CloudDownload,
  ExternalLink,
  FileDiff,
  FolderGit2,
  GitBranch,
  History,
  LoaderCircle,
  RefreshCw,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";

import type { FileEntry } from "@/types";
import { parseGitPatch } from "@shared/git-hunks";
import { parseConflictFile } from "@shared/git-conflicts";
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
import { GitConflictEditor } from "./GitConflictEditor";
import { GitRebaseDialog } from "./GitRebaseDialog";
import { GitBlamePanel } from "./GitBlamePanel";
import { GitChangesMenu } from "./GitChangesMenu";
import { GitFileTree } from "./GitFileTree";
import { LazyFilePreview } from "@/components/shared/LazyFilePreview";
import { GitTreeMenu } from "./GitTreeMenu";
import { useMenuDismiss } from "./useMenuDismiss";
import "./GitWorkspaceModal.css";

export type GitWorkspaceTarget = {
  path: string;
  label: string;
};

/** 工作台顶部页签对应的仓库。 */
export type GitWorkspaceRepo = {
  id: string;
  path: string;
  label: string;
  branch?: string;
};

interface Props {
  target: GitWorkspaceTarget;
  onClose: () => void;
  onChanged?: () => void;
  /** 顶部仓库页签，由外层塞进来，切仓库时整块面板重挂载。 */
  repoSwitcher?: ReactNode;
}

type ChangeItem = GitFileChange & { stagedView: boolean };

/** 左侧面板三块的高度权重：变更 / 待提交 / 提交，拖分割线时按比例重新分配。 */
type PaneRatio = { changes: number; staged: number; commit: number };

const DEFAULT_PANE_RATIO: PaneRatio = { changes: 5, staged: 2, commit: 2 };
const MIN_PANE_PX = 56;

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

/** 行选中和 diff 查询必须用同一个 key：之前行里写死 :unstaged，查询用 :false，永远对不上。 */
const changeKey = (item: ChangeItem) => `${item.path}:${item.stagedView ? "staged" : "unstaged"}`;

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

export function GitWorkspaceModal({ repos, activeId, onSelect, onClose, onChanged }: {
  repos: GitWorkspaceRepo[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  onChanged?: (id: string) => void;
}) {
  const active = repos.find((repo) => repo.id === activeId) || repos[0];
  if (!active) return null;
  return (
    <GitWorkspacePane
      key={active.id}
      target={{ path: active.path, label: active.label }}
      onClose={onClose}
      onChanged={() => onChanged?.(active.id)}
      repoSwitcher={(
        <div className="git-repo-tabs" role="tablist" aria-label="Git 仓库">
          {repos.map((repo) => (
            <button
              key={repo.id}
              type="button"
              role="tab"
              aria-selected={repo.id === active.id}
              className={`git-repo-tab ${repo.id === active.id ? "active" : ""}`}
              title={repo.path}
              onClick={() => onSelect(repo.id)}
            >
              <GitBranch size={12} />
              <span className="git-repo-tab-name">{repo.label}</span>
              {repo.branch && <span className="git-repo-tab-branch">{repo.branch}</span>}
            </button>
          ))}
          <span className="git-repo-tabs-spacer" />
          <button type="button" className="git-repo-tabs-close" onClick={onClose} title="关闭">
            <X size={15} />
          </button>
        </div>
      )}
    />
  );
}

function GitWorkspacePane({ target, onClose, onChanged, repoSwitcher }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selectedKey, setSelectedKey] = useState("");
  // 目录树点击文件时的预览；自身 portal 到 body，需要压在工作台上（z-index 1300）。
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  // 提交后推送默认勾上：多数场景提交就是要推上去。
  const [pushAfterCommit, setPushAfterCommit] = useState(true);
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
  const [rebaseBase, setRebaseBase] = useState<GitLogEntry | null>(null);
  const [changesMenu, setChangesMenu] = useState<{ x: number; y: number } | null>(null);
  const [pullMenu, setPullMenu] = useState<{ left: number; top: number } | null>(null);
  const [treeMenu, setTreeMenu] = useState<{ entry: FileEntry; relativePath: string; x: number; y: number } | null>(null);
  const [blamePath, setBlamePath] = useState<string | null>(null);
  const [paneRatio, setPaneRatio] = useState<PaneRatio>(DEFAULT_PANE_RATIO);
  const [paneDrag, setPaneDrag] = useState<{
    kind: "changes" | "commit";
    startY: number;
    area: number;
    ratio: PaneRatio;
  } | null>(null);
  const paneRefs = useRef<{
    changes: HTMLElement | null;
    staged: HTMLElement | null;
    commit: HTMLElement | null;
  }>({ changes: null, staged: null, commit: null });

  useEffect(() => {
    if (!paneDrag) return;
    const { kind, startY, area, ratio } = paneDrag;
    const total = ratio.changes + ratio.staged + ratio.commit;
    const minRatio = (MIN_PANE_PX / Math.max(area, 1)) * total;
    // 提交区有最小高度（126px），拖到那儿就该停住，否则状态和实际渲染会对不上。
    const minCommitRatio = (126 / Math.max(area, 1)) * total;
    const handleMove = (event: PointerEvent) => {
      const delta = ((event.clientY - startY) / Math.max(area, 1)) * total;
      if (kind === "changes") {
        const maxChanges = total - Math.max(ratio.commit, minCommitRatio) - minRatio;
        const changes = Math.min(Math.max(ratio.changes + delta, minRatio), maxChanges);
        setPaneRatio({ changes, staged: total - ratio.commit - changes, commit: ratio.commit });
        return;
      }
      const staged = Math.min(Math.max(ratio.staged + delta, minRatio), total - ratio.changes - minCommitRatio);
      setPaneRatio({ changes: ratio.changes, staged, commit: total - ratio.changes - staged });
    };
    const stop = () => setPaneDrag(null);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [paneDrag]);

  const beginPaneResize = (kind: "changes" | "commit") => (event: ReactPointerEvent<HTMLDivElement>) => {
    const { changes, staged, commit } = paneRefs.current;
    if (!changes || !staged || !commit) return;
    event.preventDefault();
    setPaneDrag({
      kind,
      startY: event.clientY,
      area: changes.offsetHeight + staged.offsetHeight + commit.offsetHeight,
      ratio: paneRatio,
    });
  };

  const items = useMemo(() => buildItems(status), [status]);
  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? items.filter((item) => item.path.toLowerCase().includes(query)) : items;
  }, [items, search]);
  const stagedItems = filteredItems.filter((item) => item.stagedView);
  const unstagedItems = filteredItems.filter((item) => !item.stagedView);
  const conflictedItems = (status?.files || []).filter((file) => file.conflicted);
  const selected = items.find((item) => changeKey(item) === selectedKey);
  const selectedConflict = conflictedItems.find((file) => `${file.path}:conflict` === selectedKey);
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
      const conflictKeys = (next.files || []).filter((file) => file.conflicted).map((file) => `${file.path}:conflict`);
      const itemKeys = nextItems.map(changeKey);
      const key = preferredKey && [...itemKeys, ...conflictKeys].includes(preferredKey)
        ? preferredKey
        : conflictKeys[0] || itemKeys[0] || "";
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
    if (selectedConflict) {
      setDiff("");
      return;
    }
    void loadDiff(selected);
  }, [loadDiff, selected, selectedConflict]);

  // 换选中文件就离开追溯视图，避免看着 A 的追溯在 B 的行上操作。
  useEffect(() => {
    setBlamePath(null);
  }, [selectedKey]);

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
      // 变基计划对话框和右键菜单自己处理 Esc，别连带关掉整个工作台。
      if (rebaseBase || changesMenu || pullMenu || treeMenu) return;
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, changesMenu, onClose, pullMenu, rebaseBase, treeMenu]);

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
      item.untracked
        ? `丢弃「${item.path}」？未跟踪文件会被直接删除，此操作不可撤销。`
        : `丢弃「${item.path}」中未暂存的改动？已暂存的内容会保留，但工作区的改动不可恢复。`,
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

  const discardAllChanges = async () => {
    if (allUnstagedPaths.length === 0) return;
    const confirmed = await showAppConfirm(
      `放弃这 ${allUnstagedPaths.length} 个文件的未暂存改动？已暂存的内容会保留，工作区的改动不可恢复。`,
      { title: "放弃全部更改", confirmLabel: "放弃" },
    );
    if (!confirmed) return;
    setBusy("discard");
    setError("");
    const result = await window.electronAPI.gitDiscard(target.path, allUnstagedPaths);
    if (!result.success) setError(result.error || "放弃更改失败。");
    else await refresh();
    setBusy("");
  };

  const deleteAllChanges = async () => {
    if (allUnstagedPaths.length === 0) return;
    const confirmed = await showAppConfirm(
      `从磁盘删除这 ${allUnstagedPaths.length} 个文件？\n\n未跟踪的文件删掉后无法恢复；已跟踪的文件还能用 git 找回。`,
      { title: "删除文件", confirmLabel: "删除" },
    );
    if (!confirmed) return;
    setBusy("delete");
    setError("");
    const result = await window.electronAPI.gitDeleteFiles(target.path, allUnstagedPaths);
    if (!result.success) setError(result.error || "删除文件失败。");
    else {
      showFloatingToastMessage(`${allUnstagedPaths.length} 个文件已删除`);
      await refresh();
    }
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
      if (pushAfterCommit) {
        const pushed = await window.electronAPI.gitPush(target.path);
        if (!pushed.success) {
          setError(`已提交 ${result.commit || ""}，但推送失败：${pushed.error || "未知错误"}`);
        } else {
          showFloatingToastMessage(`已提交并推送 ${result.commit || ""}`.trim());
        }
      } else {
        showFloatingToastMessage(`已提交 ${result.commit || ""}`.trim());
      }
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
          : "执行 git push？当前分支还没有 upstream 时会自动推送并设为 origin/<分支>。",
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

  const rebasePull = async () => {
    const confirmed = await showAppConfirm(
      "拉取并变基？本地提交会被重放到远程最新提交之上，提交哈希会变。",
      { title: "拉取并变基", confirmLabel: "拉取并变基" },
    );
    if (!confirmed) return;
    setBusy("pull");
    setError("");
    const result = await window.electronAPI.gitPullRebase(target.path);
    if (!result.success) {
      setError(result.error || "拉取并变基失败。");
      if (result.conflict) setTab("changes");
    } else {
      showFloatingToastMessage(result.output || "已拉取并变基");
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
    if (choice === "mark") {
      // 「已解决」只是 git add，git 不会校验内容：留着标记就点会把半成品提交进去。
      const detail = await window.electronAPI.gitConflictFile(target.path, file.path);
      const blocks = detail.success ? parseConflictFile(detail.content || "").blocks.length : 0;
      if (blocks > 0) {
        const confirmed = await showAppConfirm(
          `「${file.path}」里还有 ${blocks} 处冲突标记（<<<<<<< / ======= / >>>>>>>），标记为已解决会把它们一起提交。确定继续？`,
          { title: "仍有未解决的冲突", confirmLabel: "仍然标记" },
        );
        if (!confirmed) return;
      }
    } else {
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

  const selectTreeFile = (relativePath: string) => {
    const item = items.find((entry) => entry.path === relativePath && !entry.stagedView)
      || items.find((entry) => entry.path === relativePath);
    if (item) setSelectedKey(changeKey(item));
  };

  const copyTreePath = async (relativePath: string) => {
    try {
      await navigator.clipboard.writeText(relativePath);
      showFloatingToastMessage(`已复制 ${relativePath}`);
    } catch {
      setError("复制路径失败。");
    }
  };

  const revealTreeEntry = async (absolutePath: string) => {
    const result = await window.electronAPI.showItemInFolder(absolutePath);
    if (!result.success) setError(result.error || "无法打开所在位置。");
  };

  const openTreeEntry = async (absolutePath: string) => {
    const result = await window.electronAPI.openPathInShell(absolutePath);
    if (!result.success) setError(result.error || "打开文件失败。");
  };

  const discardTreeEntry = async (relativePath: string) => {
    const untracked = !!status?.files?.find((file) => file.path === relativePath)?.untracked;
    const confirmed = await showAppConfirm(
      untracked
        ? `删除未跟踪文件「${relativePath}」？删除后无法恢复。`
        : `放弃「${relativePath}」未暂存的改动？已暂存的内容会保留。`,
      { title: untracked ? "删除文件" : "放弃改动", confirmLabel: untracked ? "删除" : "放弃" },
    );
    if (!confirmed) return;
    setBusy("discard");
    setError("");
    const result = await window.electronAPI.gitDiscard(target.path, [relativePath]);
    if (!result.success) setError(result.error || "操作失败。");
    else await refresh();
    setBusy("");
  };

  const allUnstagedPaths = [...new Set(items.filter((item) => !item.stagedView).map((item) => item.path))];
  const allStagedPaths = [...new Set(items.filter((item) => item.stagedView).map((item) => item.path))];
  const hasStaged = items.some((item) => item.stagedView);
  const hasChanges = items.length > 0;
  const selectedLogEntry = logEntries.find((entry) => entry.hash === selectedCommit);
  // 选中的是 HEAD 时它后面没有提交，变基没有意义。
  const canRebase = !!selectedLogEntry && logEntries[0]?.hash !== selectedLogEntry.hash;
  const remoteName = status?.upstream ? status.upstream.split("/")[0] : "";
  // 目录树用：仓库相对路径 → porcelain 状态码
  const changeMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const file of status?.files || []) map.set(file.path, file.status);
    return map;
  }, [status?.files]);
  const stagedPathSet = useMemo(
    () => new Set(items.filter((item) => item.stagedView).map((item) => item.path)),
    [items],
  );

  useMenuDismiss(!!pullMenu, () => setPullMenu(null), ".git-sync-menu, .git-sync-more");

  return createPortal(
    <div
      className="git-workspace-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className={`git-workspace-modal ${paneDrag ? "resizing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-workspace-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {repoSwitcher}
        <div className="git-workspace-header">
          <div className="git-workspace-title">
            <GitBranch size={16} />
            <div>
              <div className="git-title-row">
                <h2 id="git-workspace-title">Git · {target.label}</h2>
                <span className="git-workspace-path" title={status?.repoRoot || target.path}>
                  {status?.repoRoot || target.path}
                </span>
              </div>
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
            <div className="git-sync-actions">
              <button
                type="button"
                className="git-sync-card"
                onClick={() => void remoteAction("fetch")}
                disabled={!!busy}
                title="git fetch --prune"
              >
                <span className="git-sync-caption">{remoteName || "远程"}</span>
                <span className="git-sync-label"><CloudDownload size={13} />获取</span>
              </button>
              <div className="git-sync-group">
                <button
                  type="button"
                  className="git-sync-main"
                  onClick={() => void remoteAction("pull")}
                  disabled={!!busy || !status?.upstream}
                  title="git pull --ff-only"
                >
                  <span className="git-sync-caption">
                    {status?.upstream ? (status.behind ? `落后 ${status.behind}` : "无更新") : "无 upstream"}
                  </span>
                  <span className="git-sync-label"><ArrowDown size={13} />拉取</span>
                </button>
                <button
                  type="button"
                  className="git-sync-more"
                  aria-haspopup="menu"
                  aria-expanded={!!pullMenu}
                  disabled={!!busy || !status?.upstream}
                  title="更多拉取方式"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setPullMenu((current) => current ? null : { left: Math.max(8, rect.right - 180), top: rect.bottom + 4 });
                  }}
                >
                  <ChevronDown size={13} />
                </button>
              </div>
              <button
                type="button"
                className="git-sync-card"
                onClick={() => void remoteAction("push")}
                disabled={!!busy}
                title="git push"
              >
                <span className="git-sync-caption">{status?.ahead ? `领先 ${status.ahead}` : "无待推送"}</span>
                <span className="git-sync-label"><Upload size={13} />推送</span>
              </button>
            </div>
            <button type="button" className="git-icon-btn" onClick={() => void refresh()} title="刷新状态" disabled={!!busy}>
              <RefreshCw size={15} className={busy === "refresh" ? "spin" : ""} />
            </button>
          </div>
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

        <div className="git-workspace-main">
          <nav className="git-workspace-nav" role="tablist" aria-orientation="vertical" aria-label="Git 视图">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "changes"}
              aria-label="变更"
              data-label={`变更${items.length > 0 ? ` (${items.length})` : ""}`}
              className={`git-nav-item ${tab === "changes" ? "active" : ""}`}
              onClick={() => setTab("changes")}
            >
              <FileDiff size={16} strokeWidth={1.8} />
              {items.length > 0 && <span className="git-nav-badge">{items.length > 99 ? "99+" : items.length}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "history"}
              aria-label="历史"
              data-label="历史"
              className={`git-nav-item ${tab === "history" ? "active" : ""}`}
              onClick={() => setTab("history")}
            >
              <History size={16} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "branches"}
              aria-label="分支"
              data-label="分支"
              className={`git-nav-item ${tab === "branches" ? "active" : ""}`}
              onClick={() => setTab("branches")}
            >
              <GitBranch size={16} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "worktrees"}
              aria-label="工作区"
              data-label="工作区"
              className={`git-nav-item ${tab === "worktrees" ? "active" : ""}`}
              onClick={() => setTab("worktrees")}
            >
              <FolderGit2 size={16} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "stash"}
              aria-label="Stash"
              data-label={`Stash${stashes.length > 0 ? ` (${stashes.length})` : ""}`}
              className={`git-nav-item ${tab === "stash" ? "active" : ""}`}
              onClick={() => setTab("stash")}
            >
              <Archive size={16} strokeWidth={1.8} />
              {stashes.length > 0 && <span className="git-nav-badge">{stashes.length}</span>}
            </button>
          </nav>

          <div className="git-workspace-content">
        {tab === "changes" ? (
          <>
            <div className="git-workspace-body with-tree">
              <GitFileTree
                repoRoot={status?.repoRoot || target.path}
                changes={changeMap}
                selectedPath={selected?.path}
                onSelectFile={selectTreeFile}
                onPreviewFile={setPreviewFile}
                onContextMenu={setTreeMenu}
              />
              <aside className="git-files-pane">
                <label className="git-file-search">
                  <span>搜索</span>
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="筛选文件…" />
                </label>
                {conflictedItems.length > 0 && (
                  <section className="git-file-block conflicts">
                    <div className="git-file-section-title conflict">
                      <AlertTriangle size={12} />
                      <span className="git-file-section-label">冲突</span>
                      <span className="git-file-section-count">{conflictedItems.length}</span>
                    </div>
                    <div className="git-file-lines persistent-scroll">
                      {conflictedItems.map((file) => (
                        <div
                          className={`git-conflict-row ${selectedKey === `${file.path}:conflict` ? "active" : ""}`}
                          key={file.path}
                          onClick={() => setSelectedKey(`${file.path}:conflict`)}
                        >
                          <AlertTriangle size={13} />
                          <span className="git-file-path" title={file.path}>{file.path}</span>
                          <button type="button" onClick={(event) => { event.stopPropagation(); void resolveConflict(file, "ours"); }} disabled={!!busy} title="使用当前分支版本">当前</button>
                          <button type="button" onClick={(event) => { event.stopPropagation(); void resolveConflict(file, "theirs"); }} disabled={!!busy} title="使用对方分支版本">对方</button>
                          <button type="button" onClick={(event) => { event.stopPropagation(); void resolveConflict(file, "mark"); }} disabled={!!busy} title="已手动解决，标记为已解决">已解决</button>
                          <button type="button" className="git-file-action" onClick={(event) => { event.stopPropagation(); void openConflictFile(file); }} disabled={!!busy} title="在外部应用打开">
                            <ExternalLink size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <section
                  className="git-file-block changes"
                  ref={(element) => { paneRefs.current.changes = element; }}
                  style={{ flexGrow: paneRatio.changes }}
                >
                  <div
                    className="git-file-section-title"
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setChangesMenu({ x: event.clientX, y: event.clientY });
                    }}
                  >
                    <span className="git-file-section-label">变更</span>
                    <span className="git-file-section-count">{unstagedItems.length}</span>
                    <button
                      type="button"
                      className="git-file-section-action"
                      title="全部下移到待提交"
                      aria-label="全部下移到待提交"
                      disabled={!!busy || allUnstagedPaths.length === 0}
                      onClick={() => void stage(allUnstagedPaths)}
                    >
                      <ArrowDown size={13} />
                    </button>
                  </div>
                  <div className="git-file-lines persistent-scroll">
                    {unstagedItems.length === 0 ? <div className="git-file-empty">暂无</div> : unstagedItems.map((item) => (
                      <div
                        key={changeKey(item)}
                        className={`git-file-row ${selectedKey === changeKey(item) ? "active" : ""}`}
                        onClick={() => setSelectedKey(changeKey(item))}
                      >
                        <span className={`git-status-dot ${item.untracked ? "untracked" : item.status.trim().charAt(1) || "M"}`} />
                        <span className="git-file-path" title={item.path}>{item.path}</span>
                        <button
                          type="button"
                          className="git-file-action"
                          title="下移到待提交"
                          aria-label={`暂存 ${item.path}`}
                          disabled={!!busy}
                          onClick={(event) => { event.stopPropagation(); void stage([item.path]); }}
                        >
                          <ArrowDown size={13} />
                        </button>
                        <button
                          type="button"
                          className="git-file-action danger"
                          title={item.untracked ? "删除未跟踪文件" : "丢弃未暂存的改动"}
                          disabled={!!busy}
                          onClick={(event) => { event.stopPropagation(); void discard(item); }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>

                <div
                  className="git-pane-resizer"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="拖动调整变更列表高度"
                  onPointerDown={beginPaneResize("changes")}
                />

                <section
                  className="git-file-block staged"
                  ref={(element) => { paneRefs.current.staged = element; }}
                  style={{ flexGrow: paneRatio.staged }}
                >
                  <div className="git-file-section-title">
                    <span className="git-file-section-label">待提交</span>
                    <span className="git-file-section-count">{stagedItems.length}</span>
                    <button
                      type="button"
                      className="git-file-section-action"
                      title="全部上移回变更"
                      aria-label="全部取消暂存"
                      disabled={!!busy || allStagedPaths.length === 0}
                      onClick={() => void unstage(allStagedPaths)}
                    >
                      <ArrowUp size={13} />
                    </button>
                  </div>
                  <div className="git-file-lines persistent-scroll">
                    {stagedItems.length === 0 ? <div className="git-file-empty">暂存变更后会出现在这里</div> : stagedItems.map((item) => (
                      <div
                        key={changeKey(item)}
                        className={`git-file-row ${selectedKey === changeKey(item) ? "active" : ""}`}
                        onClick={() => setSelectedKey(changeKey(item))}
                      >
                        <span className={`git-status-dot ${item.status.trim().charAt(0) || "M"}`} />
                        <span className="git-file-path" title={item.path}>{item.path}</span>
                        <button
                          type="button"
                          className="git-file-action"
                          title="上移回变更（取消暂存）"
                          aria-label={`取消暂存 ${item.path}`}
                          disabled={!!busy}
                          onClick={(event) => { event.stopPropagation(); void unstage([item.path]); }}
                        >
                          <ArrowUp size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>

                <div
                  className="git-pane-resizer"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="拖动调整待提交列表与提交区高度"
                  onPointerDown={beginPaneResize("commit")}
                />

                <div
                  className="git-commit-pane"
                  ref={(element) => { paneRefs.current.commit = element; }}
                  style={{ flexGrow: paneRatio.commit }}
                >
                  <div className="git-commit-label">提交信息</div>
                  <textarea
                    value={message}
                    rows={2}
                    placeholder="输入提交信息（必填）"
                    onChange={(event) => setMessage(event.target.value)}
                    disabled={!!busy}
                  />
                  <div className="git-commit-actions">
                    <div className="git-commit-switches">
                      <label className="git-amend" title="git commit --amend：改写上一次提交，只在本地生效，不会推送">
                        <input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} disabled={!!busy} />
                        修改上次提交
                      </label>
                      <label className="git-amend" title="提交成功后自动 git push；没有 upstream 时会自动设置">
                        <input type="checkbox" checked={pushAfterCommit} onChange={(event) => setPushAfterCommit(event.target.checked)} disabled={!!busy} />
                        提交后推送
                      </label>
                    </div>
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
                  <span title={blamePath || selectedConflict?.path || selected?.path}>
                    {blamePath || selectedConflict?.path || selected?.path || "选择一个文件查看 diff"}
                  </span>
                  {blamePath ? null
                    : selectedConflict ? <span>冲突 · 三方合并</span>
                      : selected ? (
                        <span className="git-diff-header-actions">
                          <span>{statusLabel(selected.status)} · {selected.stagedView ? "已暂存" : "工作区"}</span>
                          {!selected.untracked && (
                            <button
                              type="button"
                              className="git-diff-blame-btn"
                              title="逐行追溯这个文件的历史"
                              onClick={() => setBlamePath(selected.path)}
                            >
                              追溯
                            </button>
                          )}
                        </span>
                      ) : null}
                </div>
                <div className="git-diff-content persistent-scroll">
                  {blamePath ? (
                    <GitBlamePanel
                      repoPath={status?.repoRoot || target.path}
                      file={blamePath}
                      onClose={() => setBlamePath(null)}
                    />
                  ) : selectedConflict ? (
                    <GitConflictEditor
                      repoPath={target.path}
                      file={selectedConflict.path}
                      disabled={!!busy}
                      onError={setError}
                      onResolved={async () => {
                        showFloatingToastMessage("冲突已解决并暂存");
                        await refresh();
                      }}
                    />
                  ) : diffLoading ? <div className="git-diff-empty"><LoaderCircle className="spin" size={16} /> 读取中…</div>
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
                      : <div className="git-diff-empty">{selected ? "没有可显示的 diff。" : hasChanges || conflictedItems.length > 0 ? "选择一个文件查看 diff" : "工作区干净，没有待处理改动。"}</div>}
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
              <div className="git-files-toolbar">
                <button
                  type="button"
                  disabled={!!busy || !canRebase}
                  title={canRebase ? `把 ${selectedLogEntry?.shortHash} 之后的提交做交互式变基（不含该提交）` : "选中一个更早的提交作为变基基点"}
                  onClick={() => { if (selectedLogEntry) setRebaseBase(selectedLogEntry); }}
                >
                  交互式变基
                </button>
              </div>
              <div className="git-file-sections persistent-scroll">
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
              <div className="git-diff-content persistent-scroll">
                {commitDiff ? <pre>{commitDiff}</pre> : <div className="git-diff-empty">{selectedCommit ? "读取中…" : "选择一个提交查看详情"}</div>}
              </div>
            </section>
          </div>
        ) : tab === "branches" ? (
          <div className="git-simple-pane persistent-scroll">
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
          <div className="git-simple-pane persistent-scroll">
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
          <div className="git-stash-pane persistent-scroll">
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
        </div>

        {pullMenu && createPortal(
          <div className="git-context-menu git-sync-menu" role="menu" style={{ left: pullMenu.left, top: pullMenu.top }}>
            <button type="button" role="menuitem" onClick={() => { setPullMenu(null); void remoteAction("pull"); }}>
              <ArrowDown size={14} />仅快进拉取
            </button>
            <button type="button" role="menuitem" onClick={() => { setPullMenu(null); void rebasePull(); }}>
              <GitBranch size={14} />拉取并变基
            </button>
          </div>,
          document.body,
        )}

        {treeMenu && (
          <GitTreeMenu
            entry={treeMenu.entry}
            relativePath={treeMenu.relativePath}
            x={treeMenu.x}
            y={treeMenu.y}
            staged={stagedPathSet.has(treeMenu.relativePath)}
            busy={!!busy}
            onStage={() => void stage([treeMenu.relativePath])}
            onUnstage={() => void unstage([treeMenu.relativePath])}
            onDiscard={() => void discardTreeEntry(treeMenu.relativePath)}
            onBlame={() => setBlamePath(treeMenu.relativePath)}
            onCopyPath={() => void copyTreePath(treeMenu.relativePath)}
            onReveal={() => void revealTreeEntry(treeMenu.entry.path)}
            onOpen={() => void openTreeEntry(treeMenu.entry.path)}
            onClose={() => setTreeMenu(null)}
          />
        )}

        {changesMenu && (
          <GitChangesMenu
            x={changesMenu.x}
            y={changesMenu.y}
            count={allUnstagedPaths.length}
            busy={!!busy}
            onDiscard={() => void discardAllChanges()}
            onStash={() => void createStash()}
            onStage={() => void stage(allUnstagedPaths)}
            onDelete={() => void deleteAllChanges()}
            onClose={() => setChangesMenu(null)}
          />
        )}

        {rebaseBase && (
          <GitRebaseDialog
            repoPath={target.path}
            base={rebaseBase}
            disabled={!!busy}
            onClose={() => setRebaseBase(null)}
            onFinished={async (result) => {
              setRebaseBase(null);
              if (!result.success) {
                setError(result.error || "交互式变基未完成。");
                setTab("changes");
              } else {
                showFloatingToastMessage(result.output || "变基完成");
              }
              await loadStatus();
              await loadBranches();
              await loadLog();
              onChanged?.();
            }}
          />
        )}

        <LazyFilePreview filePath={previewFile} onClose={() => setPreviewFile(null)} zIndex={1350} />
      </div>
    </div>,
    document.body,
  );
}
