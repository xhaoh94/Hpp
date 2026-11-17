import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
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
  XCircle,
} from "lucide-react";

import { parseGitPatch } from "@shared/git-hunks";
import { parseConflictFile } from "@shared/git-conflicts";
import type {
  GitBranch as GitBranchInfo,
  GitConflictChoice,
  GitFileChange,
  GitLogEntry,
  GitStashEntry,
  GitStashFile,
  GitStatus,
  GitWorktreeEntry,
} from "@shared/git-types";
import { showAppConfirm } from "@/lib/app-dialog";
import { showFloatingToastMessage } from "@/lib/floating-toast";
import { readCommitHistory, rememberCommitMessage } from "@/lib/git-commit-history";
import { useAnchoredOverlay } from "@shared/anchored-overlay";
import { GitConflictEditor } from "./GitConflictEditor";
import { GitRebaseDialog } from "./GitRebaseDialog";
import { GitStashDialog } from "./GitStashDialog";
import { GitStashRestoreDialog } from "./GitStashRestoreDialog";
import { GitFileHistoryDialog } from "./GitFileHistoryDialog";
import { GitOpLogDialog, type GitOpLogItem } from "./GitOpLogDialog";
import { GitBlamePanel } from "./GitBlamePanel";
import { GitDiffView } from "./GitDiffView";
import { GitChangesMenu } from "./GitChangesMenu";
import { GitFileTree, type GitTreeContextTarget } from "./GitFileTree";
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
// 操作日志长时间使用会一直累积，截住上限避免越滚越卡。
const MAX_OP_LOG_ENTRIES = 200;

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
  const [commitHistory, setCommitHistory] = useState<string[]>([]);
  const [commitHistoryOpen, setCommitHistoryOpen] = useState(false);
  const commitHistoryBtnRef = useRef<HTMLButtonElement>(null);
  const commitHistoryPopoverRef = useRef<HTMLDivElement>(null);
  const commitHistoryStyle = useAnchoredOverlay(
    commitHistoryOpen,
    commitHistoryBtnRef,
    commitHistoryPopoverRef,
    { gap: 6 },
  );
  const [amend, setAmend] = useState(false);
  // 提交后推送默认勾上：多数场景提交就是要推上去。
  const [pushAfterCommit, setPushAfterCommit] = useState(true);
  const [tab, setTab] = useState<"changes" | "history" | "branches" | "worktrees" | "stash">("changes");
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  // 所有储藏入口都先弹窗填说明；paths 为空表示储藏全部改动。
  const [stashDialog, setStashDialog] = useState<{ paths?: string[] } | null>(null);
  const [expandedStashRef, setExpandedStashRef] = useState<string | null>(null);
  const [stashFiles, setStashFiles] = useState<Record<string, GitStashFile[]>>({});
  const [stashFilesLoading, setStashFilesLoading] = useState("");
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
  const [treeMenu, setTreeMenu] = useState<GitTreeContextTarget | null>(null);
  const [blamePath, setBlamePath] = useState<string | null>(null);
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  // 恢复储藏时发生冲突：pop 不会删掉这条 stash，记下来等冲突解决后引导删除（入口在操作日志）。
  const [conflictStashRef, setConflictStashRef] = useState<string | null>(null);
  // 操作日志弹窗关闭后要聚焦到的冲突文件（视角带到冲突编辑器）。
  const [pendingConflictKey, setPendingConflictKey] = useState<string | null>(null);
  // 正在确认恢复的储藏（弹窗）。
  const [restoreStash, setRestoreStash] = useState<GitStashEntry | null>(null);
  // 操作日志：提交 / 推送 / 储藏等动作与错误都记在这里，底部状态条显示最新一条。
  const [opLog, setOpLog] = useState<GitOpLogItem[]>([]);
  const [logDialogOpen, setLogDialogOpen] = useState(false);
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
  const stagedItems = useMemo(() => filteredItems.filter((item) => item.stagedView), [filteredItems]);
  const unstagedItems = useMemo(() => filteredItems.filter((item) => !item.stagedView), [filteredItems]);
  const conflictedItems = useMemo(() => (status?.files || []).filter((file) => file.conflicted), [status?.files]);
  const selected = items.find((item) => changeKey(item) === selectedKey);
  const selectedConflict = conflictedItems.find((file) => `${file.path}:conflict` === selectedKey);
  const parsedDiff = useMemo(() => parseGitPatch(diff), [diff]);
  // diff 跟随选中项的身份（path + stagedView），而不是对象引用：自动刷新重建 items 时
  // 同一个文件的 diff 不该被清空重载。
  const diffSelectionKey = selected ? changeKey(selected) : "";
  const selectedKeyRef = useRef(selectedKey);
  selectedKeyRef.current = selectedKey;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // 报错统一进操作日志：error 写入后立刻转存并清空，同文案的下一次错误也能再次触发。
  const opLogSeqRef = useRef(0);
  const pushOpLog = useCallback((entry: Omit<GitOpLogItem, "id" | "time">) => {
    opLogSeqRef.current += 1;
    setOpLog((log) => [
      ...log,
      { ...entry, id: opLogSeqRef.current, time: new Date().toLocaleTimeString("zh-CN", { hour12: false }) },
    ].slice(-MAX_OP_LOG_ENTRIES));
  }, []);

  useEffect(() => {
    if (!error) return;
    pushOpLog({
      title: "错误",
      tone: "error",
      message: error.split("\n")[0],
      detail: error,
    });
    setError("");
  }, [error, pushOpLog]);

  // 操作日志弹窗关闭后，把视角带回待解决的冲突（选中文件让冲突编辑器出现）。
  useEffect(() => {
    if (logDialogOpen || !pendingConflictKey) return;
    const key = pendingConflictKey;
    setPendingConflictKey(null);
    setTab("changes");
    setSelectedKey(key);
  }, [logDialogOpen, pendingConflictKey]);

  // silent 用于定时 / 窗口聚焦的自动刷新：不动 busy、不清错误提示，避免界面闪。
  const loadStatus = useCallback(async (preferredKey?: string, silent = false) => {
    if (!silent) {
      setBusy("refresh");
      setError("");
    }
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
      return { conflictKeys };
    } finally {
      if (!silent) setBusy("");
    }
  }, [target.path]);

  const diffRequestRef = useRef(0);
  const loadDiff = useCallback(async (item: ChangeItem | undefined) => {
    const requestId = ++diffRequestRef.current;
    if (!item) {
      setDiff("");
      return;
    }
    setDiffLoading(true);
    setDiff("");
    try {
      const result = await window.electronAPI.gitDiff(target.path, item.path, item.stagedView);
      // 快速切换文件时旧请求可能后到，别让它覆盖最新选中项的 diff。
      if (requestId !== diffRequestRef.current) return;
      setDiff(result.success
        ? (result.patch || (result.binary ? "二进制文件，无法显示文本 diff。" : "没有可显示的 diff。"))
        : (result.error || "读取 diff 失败。"));
    } finally {
      if (requestId === diffRequestRef.current) setDiffLoading(false);
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
    // Stash 页签的角标要打开工作台就有，不能等切过去才加载；页面内容仍然按需渲染。
    void loadStashes();
  }, [loadStashes, loadStatus]);

  useEffect(() => {
    if (selectedConflict) {
      setDiff("");
      return;
    }
    void loadDiff(selected);
  }, [diffSelectionKey, loadDiff, selectedConflict]);

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

  // 自动刷新：外部改了文件 / 切回窗口时状态能跟上；操作进行中跳过，避免和 stage/commit 打架。
  useEffect(() => {
    const silentRefresh = () => {
      if (document.hidden || busyRef.current) return;
      void loadStatus(selectedKeyRef.current, true);
      if (tab === "stash") void loadStashes();
      else if (tab === "branches") void loadBranches();
      else if (tab === "history") void loadLog();
      else if (tab === "worktrees") void loadWorktrees();
    };
    const timer = window.setInterval(silentRefresh, 8000);
    // Alt+Tab 来回切会连发 focus，debounce 一下，避免每次都跑一整套 git 命令。
    let focusTimer = 0;
    const onFocus = () => {
      window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(silentRefresh, 300);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(focusTimer);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadBranches, loadLog, loadStashes, loadStatus, loadWorktrees, tab]);

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
      if (rebaseBase || changesMenu || pullMenu || treeMenu || logDialogOpen || restoreStash) return;
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, changesMenu, logDialogOpen, onClose, pullMenu, rebaseBase, restoreStash, treeMenu]);

  const refresh = async (preferredKey?: string, silent = false) => {
    // stash 角标也要刷新，和 status 无依赖 —— 并行发，少等一个 IPC 往返。
    const [outcome] = await Promise.all([
      loadStatus(preferredKey || selectedKey, silent),
      loadStashes(),
    ]);
    onChanged?.();
    return outcome;
  };

  const stage = async (paths: string[]) => {
    if (paths.length === 0) return;
    setBusy("stage");
    setError("");
    const result = await window.electronAPI.gitStage(target.path, paths);
    if (!result.success) setError(result.error || "添加到待提交失败。");
    else await refresh();
    setBusy("");
  };

  const unstage = async (paths: string[]) => {
    if (paths.length === 0) return;
    setBusy("unstage");
    setError("");
    const result = await window.electronAPI.gitUnstage(target.path, paths);
    if (!result.success) setError(result.error || "移出待提交失败。");
    else await refresh();
    setBusy("");
  };

  const discard = async (item: ChangeItem) => {
    const confirmed = await showAppConfirm(
      item.untracked
        ? `丢弃「${item.path}」？未跟踪文件会被直接删除，此操作不可撤销。`
        : `丢弃「${item.path}」的工作区改动？已加入待提交的内容会保留，但工作区的改动不可恢复。`,
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
      `放弃这 ${allUnstagedPaths.length} 个文件的工作区改动？已加入待提交的内容会保留，工作区的改动不可恢复。`,
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
    if (!result.success) setError(result.error || "按块添加待提交失败。");
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
    const startedAt = performance.now();
    const result = await window.electronAPI.gitCommit(target.path, message, amend);
    const durationMs = performance.now() - startedAt;
    if (!result.success) {
      pushOpLog({
        title: amend ? "修改上次提交" : "提交",
        tone: "error",
        message: (result.error || "提交失败。").split("\n")[0],
        detail: result.error,
        durationMs,
      });
    } else {
      pushOpLog({
        title: amend ? "修改上次提交" : "提交",
        tone: "success",
        message: result.commit ? `已提交 ${result.commit}` : undefined,
        detail: result.output,
        durationMs,
      });
      rememberCommitMessage(target.path, message);
      setMessage("");
      setAmend(false);
      if (pushAfterCommit) {
        const pushStartedAt = performance.now();
        const pushed = await window.electronAPI.gitPush(target.path);
        const pushDurationMs = performance.now() - pushStartedAt;
        if (!pushed.success) {
          pushOpLog({
            title: "推送",
            tone: "error",
            message: `已提交 ${result.commit || ""}，但推送失败：${(pushed.error || "未知错误").split("\n")[0]}`,
            detail: pushed.error,
            durationMs: pushDurationMs,
          });
        } else {
          pushOpLog({
            title: "推送",
            tone: "success",
            message: pushed.upstream ? `已推送到 ${pushed.upstream}` : undefined,
            detail: pushed.output,
            durationMs: pushDurationMs,
          });
          showFloatingToastMessage(`已提交并推送 ${result.commit || ""}`.trim());
        }
      } else {
        showFloatingToastMessage(`已提交 ${result.commit || ""}`.trim());
      }
      await refresh();
    }
    setBusy("");
  };

  const createStash = async (description: string, paths?: string[]) => {
    setBusy("stash");
    setError("");
    const startedAt = performance.now();
    const result = await window.electronAPI.gitStashCreate(target.path, description, paths);
    const durationMs = performance.now() - startedAt;
    setBusy("");
    if (!result.success) {
      pushOpLog({
        title: "储藏",
        tone: "error",
        message: (result.error || "创建储藏失败。").split("\n")[0],
        detail: result.error,
        durationMs,
      });
      return;
    }
    pushOpLog({
      title: "储藏",
      tone: "success",
      message: paths?.length ? `已储藏 ${paths.length} 个文件的改动` : "已储藏全部改动",
      detail: result.output,
      durationMs,
    });
    showFloatingToastMessage(paths?.length ? "已储藏所选文件" : "已储藏全部改动");
    setStashDialog(null);
    // 新建 stash 会插到 stash@{0}，旧记录的 ref 要整体后移一位。
    const shiftRef = (current: string | null) => {
      const match = current?.match(/^stash@\{(\d+)\}$/);
      return match ? `stash@{${Number(match[1]) + 1}}` : null;
    };
    setConflictStashRef(shiftRef);
    // 储藏完直接跳到储藏页，免得用户还要自己找刚存进去的那条。
    setTab("stash");
    setStashFiles({});
    setExpandedStashRef(null);
    await refresh();
  };

  const popStash = async (entry: GitStashEntry, overwrite: boolean, dropAfter: boolean) => {
    setRestoreStash(null);
    setBusy("stashPop");
    setError("");
    const startedAt = performance.now();
    const result = await window.electronAPI.gitStashPop(target.path, entry.ref, { overwrite, drop: dropAfter });
    const durationMs = performance.now() - startedAt;
    if (!result.success) {
      const text = result.error || "恢复 stash 失败。";
      const conflicted = /CONFLICT|Merge conflict/i.test(text);
      // 工作区还有未提交改动时 git 连合并都不会开始，直接拒绝；此时什么都没 apply，不能引导删 stash。
      const blocked = /would be overwritten by merge|Please commit your changes or stash them/i.test(text);
      if (conflicted) {
        setConflictStashRef(entry.ref);
        setTab("changes");
        pushOpLog({
          title: "恢复储藏",
          tone: "warning",
          message: `${entry.ref} 恢复时发生冲突，储藏已保留；解决冲突并加入待提交后可删除该储藏`,
          detail: text,
          durationMs,
          action: { label: "删除该储藏", run: () => void dropConflictStash() },
        });
      } else if (blocked) {
        // 引导走操作日志弹窗：警告条上带「合并恢复」按钮。
        pushOpLog({
          title: "恢复储藏",
          tone: "warning",
          message: `工作区有未提交改动，${entry.ref} 无法直接恢复，储藏已保留`,
          detail: text,
          durationMs,
          action: { label: "合并恢复", run: () => void mergeStash(entry.ref) },
        });
        setLogDialogOpen(true);
      } else {
        pushOpLog({ title: "恢复储藏", tone: "error", message: text.split("\n")[0], detail: text, durationMs });
      }
      // 静默刷新：非静默的 loadStatus 会 setError("")，把刚写的失败原因冲掉。
      const outcome = await refresh(undefined, true);
      if (conflicted && outcome?.conflictKeys.length) {
        setSelectedKey(outcome.conflictKeys[0]);
        // 冲突时主动关掉操作日志弹窗（入口在底部日志条仍可查看），视角聚焦到冲突编辑器。
        setLogDialogOpen(false);
        setPendingConflictKey(outcome.conflictKeys[0]);
      }
    } else {
      pushOpLog({
        title: "恢复储藏",
        tone: "success",
        message: `${entry.ref} 已恢复到工作区${dropAfter ? "" : "（储藏已保留）"}`,
        detail: result.output,
        durationMs,
      });
      showFloatingToastMessage(dropAfter ? "储藏已恢复" : "已恢复，储藏保留");
      setConflictStashRef(null);
      // pop 之后 stash@{n} 会整体前移，缓存的文件列表不能复用。
      setStashFiles({});
      setExpandedStashRef(null);
      await refresh();
    }
    setBusy("");
  };

  const dropStash = async (entry: GitStashEntry) => {
    const confirmed = await showAppConfirm(
      `删除 ${entry.ref}？\n\n${entry.message}\n\n删除后这个 stash 找不回来，未提交的改动也会一起丢掉。`,
      { title: "删除 Stash", confirmLabel: "删除" },
    );
    if (!confirmed) return;
    setBusy("stashDrop");
    setError("");
    const startedAt = performance.now();
    const result = await window.electronAPI.gitStashDrop(target.path, entry.ref);
    const durationMs = performance.now() - startedAt;
    if (!result.success) {
      pushOpLog({
        title: "删除储藏",
        tone: "error",
        message: (result.error || "删除 stash 失败。").split("\n")[0],
        detail: result.error,
        durationMs,
      });
    } else {
      pushOpLog({ title: "删除储藏", tone: "success", message: `${entry.ref} 已删除`, detail: result.output, durationMs });
      showFloatingToastMessage("stash 已删除");
      setConflictStashRef((current) => (current === entry.ref ? null : current));
      setStashFiles({});
      setExpandedStashRef(null);
      await loadStashes();
    }
    setBusy("");
  };

  const dropConflictStash = async () => {
    const ref = conflictStashRef;
    if (!ref) return;
    const entry = stashes.find((item) => item.ref === ref) || { ref, message: "引发冲突的储藏" };
    await dropStash(entry);
  };

  const mergeStash = async (ref: string) => {
    const confirmed = await showAppConfirm(
      `把 ${ref} 的改动合并进当前工作区？\n\n先把相关改动加入「待提交」，再做三方合并；改到同一处会留下冲突标记，可在冲突编辑器里解决。储藏会保留，确认结果后再删除。`,
      { title: "合并恢复储藏", confirmLabel: "合并恢复" },
    );
    if (!confirmed) return;
    setBusy("stashMerge");
    setError("");
    const startedAt = performance.now();
    const result = await window.electronAPI.gitStashMerge(target.path, ref);
    const durationMs = performance.now() - startedAt;
    setBusy("");
    if (!result.success) {
      pushOpLog({
        title: "合并恢复储藏",
        tone: "error",
        message: (result.error || "合并恢复失败。").split("\n")[0],
        detail: result.error,
        durationMs,
      });
      return;
    }
    pushOpLog({
      title: "合并恢复储藏",
      tone: "success",
      message: `${ref} 已三方合并进工作区，如有冲突标记请在变更页解决`,
      detail: result.output,
      durationMs,
    });
    showFloatingToastMessage("已合并储藏内容");
    setTab("changes");
    const outcome = await refresh();
    if (outcome?.conflictKeys.length) {
      setSelectedKey(outcome.conflictKeys[0]);
      setConflictStashRef(ref);
      // 冲突时主动关掉操作日志弹窗（合并恢复按钮就在弹窗里触发的），视角聚焦到冲突编辑器；
      // 「删除该储藏」入口仍在底部日志条上。
      setLogDialogOpen(false);
      setPendingConflictKey(outcome.conflictKeys[0]);
      pushOpLog({
        title: "解决冲突",
        tone: "warning",
        message: `${ref} 合并后存在冲突标记，解决并加入待提交后可删除该储藏`,
        action: { label: "删除该储藏", run: () => void dropConflictStash() },
      });
    } else {
      setConflictStashRef(null);
    }
  };

  const toggleStashFiles = async (entry: GitStashEntry) => {
    if (expandedStashRef === entry.ref) {
      setExpandedStashRef(null);
      return;
    }
    setExpandedStashRef(entry.ref);
    if (stashFiles[entry.ref]) return;
    setStashFilesLoading(entry.ref);
    const result = await window.electronAPI.gitStashFiles(target.path, entry.ref);
    if (result.success) {
      const files = result.files || [];
      setStashFiles((current) => ({ ...current, [entry.ref]: files }));
    } else {
      setError(result.error || "读取 stash 文件失败。");
    }
    setStashFilesLoading("");
  };

  // 搜索只影响列表展示；全部加入/移出待提交仍作用于全部改动。
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
    const startedAt = performance.now();
    const result = kind === "fetch"
      ? await window.electronAPI.gitFetch(target.path)
      : kind === "pull"
        ? await window.electronAPI.gitPull(target.path)
        : await window.electronAPI.gitPush(target.path);
    const durationMs = performance.now() - startedAt;
    const kindTitle = kind === "fetch" ? "获取" : kind === "pull" ? "拉取" : "推送";
    if (!result.success) {
      pushOpLog({
        title: kindTitle,
        tone: "error",
        message: (result.error || `${kind} 失败。`).split("\n")[0],
        detail: result.error,
        durationMs,
      });
    } else {
      pushOpLog({ title: kindTitle, tone: "success", message: (result.output || "").split("\n")[0] || undefined, detail: result.output, durationMs });
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

  const deleteBranch = async (branch: GitBranchInfo, force = false) => {
    if (branch.current) return;
    const confirmed = await showAppConfirm(
      force
        ? `强制删除本地分支 ${branch.name}？该分支尚未合并，未合并的改动会丢失。`
        : `删除本地分支 ${branch.name}？只允许删除已合并的分支。`,
      { title: force ? "强制删除分支" : "删除分支", confirmLabel: "删除" },
    );
    if (!confirmed) return;
    setBusy("branch");
    setError("");
    const result = await window.electronAPI.gitDeleteBranch(target.path, branch.name, force);
    if (!result.success) {
      const message = result.error || "删除分支失败。";
      // 安全删除被拒（典型是 stash 残留 / 未合并分支）：在日志里给出「强制删除」出口，
      // 默认仍走安全删除，不会不经确认就丢掉未合并的提交。
      if (!force && /not fully merged|not merged|未合并/i.test(message)) {
        pushOpLog({
          title: `删除 ${branch.name} 失败`,
          tone: "warning",
          message: "分支尚未合并，安全删除被 Git 拒绝",
          detail: message,
          action: { label: "强制删除", run: () => void deleteBranch(branch, true) },
        });
        setLogDialogOpen(true);
      } else {
        setError(message);
      }
    } else {
      pushOpLog({ title: `已删除分支 ${branch.name}`, tone: "success", message: force ? "强制删除" : "" });
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
    const confirmed = await showAppConfirm("继续当前合并 / rebase？请确认所有冲突已解决并已加入待提交。", {
      title: "继续操作",
      confirmLabel: "继续",
    });
    if (!confirmed) return;
    setBusy("continue");
    setError("");
    const result = await window.electronAPI.gitContinueOperation(target.path);
    if (!result.success) setError(result.error || "继续操作失败。");
    else {
      pushOpLog({ title: "继续操作", tone: "success", message: "合并 / rebase 已继续完成", detail: result.output });
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
      pushOpLog({ title: "中止操作", tone: "warning", message: "合并 / rebase 已中止", detail: result.output });
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

  /** 历史 = 本地记录过的提交信息 + git log 的最近标题，去重后最多 30 条。 */
  const openCommitHistory = async () => {
    if (commitHistoryOpen) {
      setCommitHistoryOpen(false);
      return;
    }
    const saved = readCommitHistory(target.path);
    const result = await window.electronAPI.gitLog(target.path, 30);
    const logged = result.success
      ? (result.entries || []).map((entry) => entry.subject.trim()).filter(Boolean)
      : [];
    setCommitHistory([...new Set([...saved, ...logged])].slice(0, 30));
    setCommitHistoryOpen(true);
  };

  /** 变更列表的右键菜单复用目录树那份，需要先把仓库相对路径拼成绝对路径。 */
  const openFileContextMenu = (item: ChangeItem, event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const repoRoot = (status?.repoRoot || target.path).replace(/[\\/]+$/, "");
    const separator = repoRoot.includes("\\") ? "\\" : "/";
    const absolute = `${repoRoot}${separator}${item.path.replace(/\//g, separator)}`;
    setTreeMenu({
      entry: { name: item.path.split("/").pop() || item.path, path: absolute, type: "file" },
      relativePath: item.path,
      variant: "changes",
      stagedView: item.stagedView,
      stashable: !item.stagedView,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const ignoreTreePath = async (relativePath: string) => {
    const confirmed = await showAppConfirm(
      `把「${relativePath}」写进 .gitignore？\n\n已经提交过的文件写进去不会生效，需要先从版本库移除。`,
      { title: "忽略路径", confirmLabel: "忽略" },
    );
    if (!confirmed) return;
    setBusy("ignore");
    setError("");
    const result = await window.electronAPI.gitIgnorePath(target.path, relativePath);
    setBusy("");
    if (!result.success) {
      setError(result.error || "忽略失败。");
      return;
    }
    showFloatingToastMessage(result.output || "已忽略");
    await loadStatus(selectedKey);
    onChanged?.();
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
        : `放弃「${relativePath}」的工作区改动？已加入待提交的内容会保留。`,
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
  const filteredLogEntries = useMemo(() => {
    const query = logSearch.trim().toLowerCase();
    if (!query) return logEntries;
    return logEntries.filter((entry) => (
      entry.subject.toLowerCase().includes(query)
      || entry.author.toLowerCase().includes(query)
      || entry.shortHash.toLowerCase().includes(query)
    ));
  }, [logEntries, logSearch]);
  // 选中的是 HEAD 时它后面没有提交，变基没有意义。
  const canRebase = !!selectedLogEntry && logEntries[0]?.hash !== selectedLogEntry.hash;
  const remoteName = status?.upstream ? status.upstream.split("/")[0] : "";
  // 目录树用：仓库相对路径 → porcelain 状态码
  const changeMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const file of status?.files || []) map.set(file.path, file.status);
    return map;
  }, [status?.files]);
  // 目录树右键只对真有改动的路径显示「放弃更改」。
  const treeMenuHasChanges = useMemo(() => {
    if (!treeMenu) return false;
    if (treeMenu.entry.type !== "folder") return changeMap.has(treeMenu.relativePath);
    const prefix = `${treeMenu.relativePath}/`;
    return [...changeMap.keys()].some((path) => path === treeMenu.relativePath || path.startsWith(prefix));
  }, [changeMap, treeMenu]);

  useMenuDismiss(!!pullMenu, () => setPullMenu(null), ".git-sync-menu, .git-sync-more");
  useMenuDismiss(commitHistoryOpen, () => setCommitHistoryOpen(false), ".git-commit-history-popover, .git-commit-history-trigger");

  // 底部状态条只显示最新一条；点它打开完整操作日志。
  const lastOpLog = opLog.length > 0 ? opLog[opLog.length - 1] : null;

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
              aria-selected={tab === "stash"}
              aria-label="Stash"
              data-label={`Stash${stashes.length > 0 ? ` (${stashes.length})` : ""}`}
              className={`git-nav-item ${tab === "stash" ? "active" : ""}`}
              onClick={() => setTab("stash")}
            >
              <Archive size={16} strokeWidth={1.8} />
              {stashes.length > 0 && <span className="git-nav-badge">{stashes.length}</span>}
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
                            onContextMenu={(event) => openFileContextMenu(item, event)}
                          >
                            <span className={`git-status-dot ${item.untracked ? "untracked" : item.status.trim().charAt(1) || "M"}`} />
                            <span className="git-file-path" title={item.path}>{item.path}</span>
                            <button
                              type="button"
                              className="git-file-action"
                              title="下移到待提交"
                              aria-label={`添加到待提交 ${item.path}`}
                              disabled={!!busy}
                              onClick={(event) => { event.stopPropagation(); void stage([item.path]); }}
                            >
                              <ArrowDown size={13} />
                            </button>
                            <button
                              type="button"
                              className="git-file-action danger"
                              title={item.untracked ? "删除未跟踪文件" : "丢弃工作区的改动"}
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
                          aria-label="全部移出待提交"
                          disabled={!!busy || allStagedPaths.length === 0}
                          onClick={() => void unstage(allStagedPaths)}
                        >
                          <ArrowUp size={13} />
                        </button>
                      </div>
                      <div className="git-file-lines persistent-scroll">
                        {stagedItems.length === 0 ? <div className="git-file-empty">加入待提交的变更会出现在这里</div> : stagedItems.map((item) => (
                          <div
                            key={changeKey(item)}
                            className={`git-file-row ${selectedKey === changeKey(item) ? "active" : ""}`}
                            onClick={() => setSelectedKey(changeKey(item))}
                            onContextMenu={(event) => openFileContextMenu(item, event)}
                          >
                            <span className={`git-status-dot ${item.status.trim().charAt(0) || "M"}`} />
                            <span className="git-file-path" title={item.path}>{item.path}</span>
                            <button
                              type="button"
                              className="git-file-action"
                              title="上移回变更（移出待提交）"
                              aria-label={`移出待提交 ${item.path}`}
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
                      <div className="git-commit-label">
                        <span>提交信息</span>
                        <button
                          type="button"
                          ref={commitHistoryBtnRef}
                          className="git-commit-history-trigger"
                          onClick={() => void openCommitHistory()}
                          disabled={!!busy}
                          title="从历史提交信息里选一条填入"
                        >
                          <History size={12} />
                          历史
                        </button>
                      </div>
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
                          title={hasStaged ? `提交到 ${status?.branch || "当前分支"}` : "先把变更加入待提交再提交"}
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
                              <span>{statusLabel(selected.status)} · {selected.stagedView ? "待提交" : "工作区"}</span>
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
                            showFloatingToastMessage("冲突已解决并已加入待提交");
                            await refresh();
                          }}
                        />
                      ) : diffLoading ? <div className="git-diff-empty"><LoaderCircle className="spin" size={16} /> 读取中…</div>
                        : diff && parsedDiff.hunks.length > 0 && !selected?.untracked ? (
                          <GitDiffView
                            parsed={parsedDiff}
                            stagedView={selected?.stagedView}
                            disabled={!!busy}
                            onApplyHunk={(index) => void applyHunks([index])}
                            onDiscardHunk={(index) => void discardHunks([index])}
                          />
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
                    {filteredLogEntries.map((entry) => (
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
                  <button
                    type="button"
                    className="git-stash-create-button"
                    onClick={() => setStashDialog({})}
                    disabled={!!busy}
                  >
                    <Archive size={14} /> 储藏当前改动
                  </button>
                </div>
                <div className="git-stash-list">
                  {stashes.length === 0 ? <div className="git-diff-empty">没有 stash。</div> : stashes.map((entry) => {
                    const files = stashFiles[entry.ref];
                    const expanded = expandedStashRef === entry.ref;
                    return (
                      <div className={`git-stash-row ${expanded ? "expanded" : ""}`} key={entry.ref}>
                        <div className="git-stash-row-head">
                          <button
                            type="button"
                            className="git-stash-toggle"
                            onClick={() => void toggleStashFiles(entry)}
                            title={expanded ? "收起文件列表" : "查看这个 stash 里的文件"}
                            aria-expanded={expanded}
                          >
                            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </button>
                          <div className="git-stash-meta">
                            <strong title={entry.message || entry.ref}>{entry.message || "（无说明）"}</strong>
                            <span className="git-stash-ref">
                              {entry.ref}
                              {entry.branch ? ` · ${entry.branch}` : ""}
                            </span>
                          </div>
                          <div className="git-stash-actions">
                            <button type="button" onClick={() => setRestoreStash(entry)} disabled={!!busy}>
                              <Undo2 size={14} /> 恢复
                            </button>
                            <button type="button" className="danger" onClick={() => void dropStash(entry)} disabled={!!busy}>
                              <Trash2 size={14} /> 删除
                            </button>
                          </div>
                        </div>
                        {expanded && (
                          <div className="git-stash-files">
                            {stashFilesLoading === entry.ref ? (
                              <div className="git-stash-files-empty">
                                <LoaderCircle className="spin" size={12} /> 读取中…
                              </div>
                            ) : !files || files.length === 0 ? (
                              <div className="git-stash-files-empty">没有文件记录</div>
                            ) : files.map((file) => (
                              <div className="git-stash-file" key={`${file.status}:${file.path}`} title={file.path}>
                                <span
                                  className={`git-stash-file-status ${file.status.startsWith("D") ? "D"
                                      : file.status.startsWith("A") || file.status.startsWith("?") ? "A"
                                        : file.status.startsWith("R") ? "R" : "M"
                                    }`}
                                >
                                  {file.status.startsWith("?") ? "U" : file.status.slice(0, 1)}
                                </span>
                                <span className="git-stash-file-path">{file.path}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
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

        {commitHistoryOpen && createPortal(
          <div
            ref={commitHistoryPopoverRef}
            className="git-commit-history-popover"
            style={commitHistoryStyle}
            role="dialog"
            aria-label="提交信息历史"
          >
            <div className="git-commit-history-head">
              <span>提交信息历史</span>
              <button type="button" onClick={() => setCommitHistoryOpen(false)} aria-label="关闭提交信息历史">
                <X size={13} />
              </button>
            </div>
            {commitHistory.length === 0 ? (
              <div className="git-commit-history-empty">还没有历史提交信息</div>
            ) : (
              <div className="git-commit-history-list persistent-scroll">
                {commitHistory.map((text) => (
                  <button
                    type="button"
                    key={text}
                    className="git-commit-history-item"
                    title={text}
                    onClick={() => {
                      setMessage(text);
                      setCommitHistoryOpen(false);
                    }}
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}

        {treeMenu && (
          <GitTreeMenu
            entry={treeMenu.entry}
            relativePath={treeMenu.relativePath}
            x={treeMenu.x}
            y={treeMenu.y}
            variant={treeMenu.variant || "tree"}
            hasChanges={treeMenuHasChanges}
            stagedView={treeMenu.stagedView}
            busy={!!busy}
            onIgnore={() => void ignoreTreePath(treeMenu.relativePath)}
            onHistory={() => setHistoryPath(treeMenu.relativePath)}
            onStage={() => void stage([treeMenu.relativePath])}
            onUnstage={() => void unstage([treeMenu.relativePath])}
            onStash={treeMenu.stashable
              ? () => setStashDialog({ paths: [treeMenu.relativePath] })
              : undefined}
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
            onStash={() => setStashDialog({})}
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
            onError={setError}
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

        {historyPath && (
          <GitFileHistoryDialog
            repoPath={status?.repoRoot || target.path}
            path={historyPath}
            onError={setError}
            onClose={() => setHistoryPath(null)}
          />
        )}

        {/* 常驻底部状态条：没日志时也占住这一行，避免布局跳动。 */}
        <div className={`git-log-bar${lastOpLog ? ` ${lastOpLog.tone}` : ""}`}>
          <button
            type="button"
            className="git-log-bar-main"
            onClick={() => setLogDialogOpen(true)}
            title="打开操作日志"
          >
            {lastOpLog?.tone === "success" && <CheckCircle2 size={13} className="git-log-tone ok" />}
            {lastOpLog?.tone === "warning" && <AlertTriangle size={13} className="git-log-tone warn" />}
            {lastOpLog?.tone === "error" && <XCircle size={13} className="git-log-tone err" />}
            <strong>{lastOpLog ? lastOpLog.title : "操作日志"}</strong>
            {lastOpLog?.message && <span className="git-log-bar-message">{lastOpLog.message}</span>}
            {!lastOpLog && <span className="git-log-bar-message">暂无记录，点这里查看提交、推送等执行记录</span>}
            {lastOpLog && <span className="git-log-meta">{lastOpLog.time}</span>}
          </button>
        </div>

        {logDialogOpen && (
          <GitOpLogDialog
            entries={opLog}
            busy={!!busy}
            onClear={() => setOpLog([])}
            onClose={() => setLogDialogOpen(false)}
          />
        )}

        {stashDialog && (
          <GitStashDialog
            busy={busy === "stash"}
            scope={stashDialog.paths}
            onCancel={() => setStashDialog(null)}
            onConfirm={(description) => void createStash(description, stashDialog.paths)}
          />
        )}

        {restoreStash && (
          <GitStashRestoreDialog
            busy={busy === "stashPop"}
            stashLabel={restoreStash.message || restoreStash.ref}
            onCancel={() => setRestoreStash(null)}
            onConfirm={({ overwrite, dropAfter }) => void popStash(restoreStash, overwrite, dropAfter)}
          />
        )}

        <LazyFilePreview filePath={previewFile} onClose={() => setPreviewFile(null)} zIndex={1350} />
      </div>
    </div>,
    document.body,
  );
}
