import { useState } from "react";
import { Archive, LoaderCircle, X } from "lucide-react";

interface Props {
  busy: boolean;
  /** 给了就只储藏这些路径；为空表示储藏全部改动。 */
  scope?: string[];
  onCancel: () => void;
  onConfirm: (message: string) => void;
}

/** 储藏信息弹窗：储藏页按钮和变更列表右键菜单共用同一个入口。 */
export function GitStashDialog({ busy, scope, onCancel, onConfirm }: Props) {
  const [message, setMessage] = useState("");

  const submit = () => {
    if (!busy) onConfirm(message);
  };

  return (
    <div
      className="git-rebase-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="git-rebase-dialog git-stash-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="输入储藏信息"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="git-rebase-header">
          <div>
            <strong>输入储藏信息</strong>
            <span title={scope?.length ? scope.join("、") : undefined}>
              {scope?.length ? `仅储藏 ${scope.join("、")}；` : "储藏全部改动；"}
              留空时记为「Hpp: 临时储藏」
            </span>
          </div>
          <button type="button" className="git-icon-btn" onClick={onCancel} disabled={busy} title="关闭">
            <X size={15} />
          </button>
        </div>

        <div className="git-stash-dialog-body">
          <label htmlFor="git-stash-message">储藏信息</label>
          <input
            id="git-stash-message"
            value={message}
            autoFocus
            placeholder="Hpp: 临时储藏"
            disabled={busy}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
              if (event.key === "Escape") onCancel();
            }}
          />
        </div>

        <div className="git-rebase-footer">
          <span />
          <div>
            <button type="button" onClick={onCancel} disabled={busy}>取消</button>
            <button type="button" className="git-primary-btn" onClick={submit} disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={14} /> : <Archive size={14} />}
              储藏
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
