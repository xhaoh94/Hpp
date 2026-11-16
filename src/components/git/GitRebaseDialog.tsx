import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, GitBranch, LoaderCircle, X } from "lucide-react";

import type { GitActionResult, GitLogEntry, GitRebaseAction, GitRebaseStep } from "@shared/git-types";

interface Props {
  repoPath: string;
  base: GitLogEntry;
  disabled: boolean;
  /** 传了就走工作台的通知控制台，不再在弹窗里插错误条。 */
  onError?: (message: string) => void;
  onClose: () => void;
  onFinished: (result: GitActionResult) => void;
}

const ACTIONS: { value: GitRebaseAction; label: string }[] = [
  { value: "pick", label: "pick · 保留" },
  { value: "reword", label: "reword · 改提交信息" },
  { value: "edit", label: "edit · 停下来改内容" },
  { value: "squash", label: "squash · 合到上一个并编辑信息" },
  { value: "fixup", label: "fixup · 合到上一个并丢弃信息" },
  { value: "drop", label: "drop · 丢弃这个提交" },
];

export function GitRebaseDialog({ repoPath, base, disabled, onError, onClose, onFinished }: Props) {
  const [loading, setLoading] = useState(true);
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [actions, setActions] = useState<Record<string, GitRebaseAction>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const reportError = useCallback(
    (message: string) => (onError ? onError(message) : undefined),
    [onError],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.electronAPI.gitRebasePlan(repoPath, base.hash).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.success) {
        reportError(result.error || "读取变基范围失败。");
        return;
      }
      const entries = result.commits || [];
      setCommits(entries);
      setActions(Object.fromEntries(entries.map((entry) => [entry.hash, "pick" as GitRebaseAction])));
      setMessages(Object.fromEntries(entries.map((entry) => [entry.hash, entry.subject])));
      if (entries.length === 0) reportError("这个提交之后没有提交，无法交互式变基。");
    });
    return () => { cancelled = true; };
  }, [base.hash, repoPath, reportError]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || running) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, running]);

  const invalid = useMemo(
    () => commits.filter((commit) => actions[commit.hash] === "reword" && !(messages[commit.hash] || "").trim()),
    [actions, commits, messages],
  );

  const run = useCallback(async () => {
    setRunning(true);
    const steps: GitRebaseStep[] = commits.map((commit) => {
      const action = actions[commit.hash] || "pick";
      return action === "reword"
        ? { hash: commit.hash, action, message: (messages[commit.hash] || "").trim() }
        : { hash: commit.hash, action };
    });
    const result = await window.electronAPI.gitInteractiveRebase(repoPath, base.hash, steps);
    setRunning(false);
    // 冲突时 rebase 已经停在那里了，交给工作台去显示横幅 + 变更页。
    if (!result.success && !result.conflict) {
      reportError(result.error || "交互式变基失败。");
      return;
    }
    onFinished(result);
  }, [actions, base.hash, commits, messages, onFinished, repoPath, reportError]);

  return (
    <div className="git-rebase-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !running) onClose();
    }}>
      <div className="git-rebase-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="git-rebase-header">
          <div>
            <strong>交互式变基</strong>
            <span>{base.shortHash} 之后的提交（从旧到新）</span>
          </div>
          <button type="button" className="git-icon-btn" onClick={onClose} disabled={running} title="关闭">
            <X size={15} />
          </button>
        </div>

        <div className="git-rebase-list persistent-scroll">
          {loading ? <div className="git-diff-empty"><LoaderCircle className="spin" size={15} /> 读取提交…</div>
            : commits.length === 0 ? <div className="git-diff-empty">没有可操作的提交。</div>
              : commits.map((commit, index) => {
                const action = actions[commit.hash] || "pick";
                const squashBlocked = index === 0;
                return (
                  <div className={`git-rebase-row ${action === "drop" ? "dropped" : ""}`} key={commit.hash}>
                    <span className="git-rebase-index">{index + 1}</span>
                    <div className="git-rebase-subject">
                      <strong title={commit.subject}>{commit.subject}</strong>
                      <span>{commit.shortHash} · {commit.author}</span>
                    </div>
                    <select
                      value={action}
                      disabled={disabled || running}
                      onChange={(event) => setActions((current) => ({ ...current, [commit.hash]: event.target.value as GitRebaseAction }))}
                    >
                      {ACTIONS.map((option) => (
                        <option key={option.value} value={option.value} disabled={squashBlocked && (option.value === "squash" || option.value === "fixup")}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {action === "reword" && (
                      <input
                        className="git-rebase-message"
                        value={messages[commit.hash] ?? ""}
                        placeholder="新的提交信息（必填）"
                        disabled={disabled || running}
                        onChange={(event) => setMessages((current) => ({ ...current, [commit.hash]: event.target.value }))}
                      />
                    )}
                  </div>
                );
              })}
        </div>

        <div className="git-rebase-footer">
          <span>
            <AlertTriangle size={13} /> 变基会重写这些提交的哈希；有冲突时会停下来，可在变更页解决。
          </span>
          <div>
            <button type="button" onClick={onClose} disabled={running}>取消</button>
            <button
              type="button"
              className="git-primary-btn"
              onClick={() => void run()}
              disabled={disabled || running || loading || commits.length === 0 || invalid.length > 0}
              title={invalid.length > 0 ? "reword 需要填写提交信息" : "开始变基"}
            >
              {running ? <LoaderCircle className="spin" size={13} /> : <GitBranch size={13} />} 开始变基
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
