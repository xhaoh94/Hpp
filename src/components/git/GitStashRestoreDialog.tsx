import { useEffect, useState } from "react";
import { LoaderCircle, Undo2, X } from "lucide-react";

interface Props {
  busy: boolean;
  /** 显示用的储藏名（备注或 stash@{n}）。 */
  stashLabel: string;
  onCancel: () => void;
  onConfirm: (options: { overwrite: boolean; dropAfter: boolean }) => void;
}

/** 恢复储藏弹窗：确认应用，可选覆盖本地文件 / 恢复后删除。 */
export function GitStashRestoreDialog({ busy, stashLabel, onCancel, onConfirm }: Props) {
  const [overwrite, setOverwrite] = useState(false);
  const [dropAfter, setDropAfter] = useState(true);

  useEffect(() => {
    // capture 阶段先于工作台的 Esc 处理，只关本弹窗。
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [busy, onCancel]);

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
        aria-label="恢复储藏"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="git-rebase-header">
          <div>
            <strong>恢复储藏</strong>
            <span title={stashLabel}>{stashLabel}</span>
          </div>
          <button type="button" className="git-icon-btn" onClick={onCancel} disabled={busy} title="关闭">
            <X size={15} />
          </button>
        </div>

        <div className="git-stash-restore-body">
          <p>确认将该储藏应用到工作区吗？</p>
          <label className="git-amend">
            <input
              type="checkbox"
              checked={overwrite}
              disabled={busy}
              onChange={(event) => setOverwrite(event.target.checked)}
            />
            覆盖本地文件
          </label>
          <span className="git-stash-restore-hint">
            勾选后先丢弃这些文件在当前工作区的改动，再应用储藏内容；不勾选则与本地改动做合并，冲突时储藏保留。
          </span>
          <label className="git-amend">
            <input
              type="checkbox"
              checked={dropAfter}
              disabled={busy}
              onChange={(event) => setDropAfter(event.target.checked)}
            />
            恢复后删除该储藏
          </label>
          <span className="git-stash-restore-hint">
            不勾选时恢复成功后储藏仍保留在列表里（git stash apply）。
          </span>
        </div>

        <div className="git-rebase-footer git-restore-footer">
          <span />
          <div>
            <button type="button" className="git-primary-btn" onClick={() => onConfirm({ overwrite, dropAfter })} disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={14} /> : <Undo2 size={14} />}
              确定
            </button>
            <button type="button" onClick={onCancel} disabled={busy}>取消</button>
          </div>
        </div>
      </div>
    </div>
  );
}
