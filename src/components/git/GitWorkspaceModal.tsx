import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  Check,
  GitBranch,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";

import type { GitFileChange, GitStashEntry, GitStatus } from "@shared/git-types";
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

const buildItems = (status: GitStatus | null): ChangeItem[] => {
  const files = status?.files || [];
  return files.flatMap((file) => {
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
  const [tab, setTab] = useState<"changes" | "stash">("changes");
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [stashMessage, setStashMessage] = useState("Hpp: 临时暂存");
  const [search, setSearch] = useState("");

  const items = useMemo(() => buildItems(status), [status]);
  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? items.filter((item) => item.path.toLowerCase().includes(query)) : items;
  }, [items, search]);
  const stagedItems = filteredItems.filter((item) => item.stagedView);
  const unstagedItems = filteredItems.filter((item) => !item.stagedView);
  const selected = items.find((item) => `${item.path}:${item.stagedView}` === selectedKey);

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

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    void loadDiff(selected);
  }, [loadDiff, selected]);

  useEffect(() => {
    if (tab === "stash") void loadStashes();
  }, [loadStashes, tab]);

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
  const allUnstagedPaths = [...new Set(items.filter((item) => !item.stagedView).map((item) => item.path))];
  const allStagedPaths = [...new Set(items.filter((item) => item.stagedView).map((item) => item.path))];
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
          <button type="button" className={tab === "stash" ? "active" : ""} onClick={() => setTab("stash")}>
            Stash {stashes.length > 0 ? `(${stashes.length})` : ""}
          </button>
          <span className="git-workspace-path" title={status?.repoRoot || target.path}>{status?.repoRoot || target.path}</span>
        </div>

        {error && <div className="git-workspace-error">{error}</div>}

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
                  <div className="git-file-section-title">已暂存 <span>{stagedItems.length}</span></div>
                  {stagedItems.length === 0 ? <div className="git-file-empty">暂无</div> : stagedItems.map((item) => (
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
                  <div className="git-file-section-title">未暂存 <span>{unstagedItems.length}</span></div>
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
                </div>
              </aside>

              <section className="git-diff-pane">
                <div className="git-diff-header">
                  <span title={selected?.path}>{selected?.path || "选择一个文件查看 diff"}</span>
                  {selected && <span>{statusLabel(selected.status)} · {selected.stagedView ? "已暂存" : "工作区"}</span>}
                </div>
                <div className="git-diff-content">
                  {diffLoading ? <div className="git-diff-empty"><LoaderCircle className="spin" size={16} /> 读取中…</div>
                    : diff ? <pre>{diff}</pre>
                      : <div className="git-diff-empty">{selected ? "没有可显示的 diff。" : hasChanges ? "选择一个文件查看 diff" : "工作区干净，没有待处理改动。"}</div>}
                </div>
              </section>
            </div>

            <div className="git-commit-pane">
              <textarea
                value={message}
                rows={2}
                placeholder="提交信息"
                onChange={(event) => setMessage(event.target.value)}
                disabled={!!busy}
              />
              <div className="git-commit-actions">
                <label className="git-amend">
                  <input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} disabled={!!busy} />
                  修改上次提交
                </label>
                <button type="button" className="git-primary-btn" onClick={() => void commit()} disabled={!!busy || !message.trim()}>
                  {busy === "commit" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
                  提交暂存
                </button>
              </div>
            </div>
          </>
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
