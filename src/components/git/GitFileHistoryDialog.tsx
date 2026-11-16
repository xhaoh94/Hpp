import { useEffect, useState } from "react";
import { LoaderCircle, X } from "lucide-react";

import type { GitLogEntry } from "@shared/git-types";

interface Props {
  repoPath: string;
  path: string;
  /** 传了就走工作台的通知控制台，不再在弹窗里插错误条。 */
  onError?: (message: string) => void;
  onClose: () => void;
}

/** 目录树右键的「查看历史」：只看这个文件 / 目录的提交。 */
export function GitFileHistoryDialog({ repoPath, path, onError, onClose }: Props) {
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.electronAPI.gitFileHistory(repoPath, path, 50).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.success) onError?.(result.error || "读取历史失败。");
      else setEntries(result.entries || []);
    });
    return () => { cancelled = true; };
  }, [onError, path, repoPath]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="git-rebase-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="git-rebase-dialog git-history-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="提交历史"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="git-rebase-header">
          <div>
            <strong>提交历史</strong>
            <span title={path}>{path}</span>
          </div>
          <button type="button" className="git-icon-btn" onClick={onClose} title="关闭">
            <X size={15} />
          </button>
        </div>

        <div className="git-rebase-list persistent-scroll">
          {loading ? (
            <div className="git-diff-empty"><LoaderCircle className="spin" size={15} /> 读取提交…</div>
          ) : entries.length === 0 ? (
            <div className="git-diff-empty">这个路径还没有提交历史。</div>
          ) : entries.map((entry) => (
            <div className="git-history-row" key={entry.hash}>
              <strong title={entry.subject}>{entry.subject}</strong>
              <span>{entry.shortHash} · {entry.author} · {entry.date}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
