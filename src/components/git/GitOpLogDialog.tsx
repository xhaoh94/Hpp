import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Copy,
  Eraser,
  X,
  XCircle,
} from "lucide-react";

export interface GitOpLogItem {
  id: number;
  title: string;
  tone: "success" | "warning" | "error";
  /** 摘要行，通常一两句；错误时取错误首行。 */
  message?: string;
  /** 完整输出（命令回显 / git 报错全文），点行展开。 */
  detail?: string;
  durationMs?: number;
  time: string;
}

export const formatOpDuration = (ms: number | undefined) => {
  if (ms === undefined) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(3)}s` : `${Math.round(ms)}ms`;
};

interface Props {
  entries: GitOpLogItem[];
  onClear: () => void;
  onClose: () => void;
}

/** 操作日志弹窗：居中宽幅，行可展开看完整输出，支持复制、清空。 */
export function GitOpLogDialog({ entries, onClear, onClose }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    // capture 阶段先于工作台的 Esc 处理，避免连工作台一起关掉。
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const copyEntry = async (entry: GitOpLogItem) => {
    const text = [`[${entry.time}] ${entry.title}`, entry.message, entry.detail]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板不可用时静默
    }
  };

  const toneIcon = (tone: GitOpLogItem["tone"]) => {
    if (tone === "success") return <CheckCircle2 className="git-log-tone ok" size={14} />;
    if (tone === "warning") return <AlertTriangle className="git-log-tone warn" size={14} />;
    return <XCircle className="git-log-tone err" size={14} />;
  };

  return (
    <div
      className="git-rebase-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="git-rebase-dialog git-log-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="操作日志"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="git-rebase-header">
          <div>
            <strong>操作日志</strong>
            <span>提交、推送、储藏等 git 操作的执行记录</span>
          </div>
          <button type="button" className="git-notice-console-tool" onClick={onClear} disabled={entries.length === 0}>
            <Eraser size={13} /> 清除
          </button>
          <button type="button" className="git-icon-btn" onClick={onClose} title="关闭">
            <X size={15} />
          </button>
        </div>

        <div className="git-log-list persistent-scroll">
          {entries.length === 0 ? (
            <div className="git-diff-empty">还没有日志。</div>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} className={`git-log-item ${entry.tone}${expanded === entry.id ? " expanded" : ""}`}>
                <div
                  className={`git-log-row${entry.detail ? " expandable" : ""}`}
                  onClick={entry.detail ? () => setExpanded(expanded === entry.id ? null : entry.id) : undefined}
                >
                  <span className="git-log-chevron-slot">
                    {entry.detail && (
                      <ChevronRight className={`git-log-chevron${expanded === entry.id ? " open" : ""}`} size={13} />
                    )}
                  </span>
                  {toneIcon(entry.tone)}
                  <strong>{entry.title}</strong>
                  {entry.message && <span className="git-log-message">{entry.message}</span>}
                  <button
                    type="button"
                    className="git-log-copy"
                    onClick={(event) => {
                      event.stopPropagation();
                      void copyEntry(entry);
                    }}
                    title="复制日志"
                  >
                    <Copy size={12} /> 复制
                  </button>
                  <span className="git-log-meta">
                    {entry.time}
                    {entry.durationMs !== undefined ? ` · ${formatOpDuration(entry.durationMs)}` : ""}
                  </span>
                </div>
                {expanded === entry.id && entry.detail && (
                  <pre className="git-log-detail">{entry.detail}</pre>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
