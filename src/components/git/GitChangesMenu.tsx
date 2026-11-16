import { createPortal } from "react-dom";
import { Archive, ArrowDown, Trash2, Undo2 } from "lucide-react";

import { useMenuDismiss } from "./useMenuDismiss";

interface Props {
  x: number;
  y: number;
  /** 变更列表里的文件数（批量动作作用于全部变更，不受搜索过滤影响）。 */
  count: number;
  busy: boolean;
  onDiscard: () => void;
  onStash: () => void;
  onStage: () => void;
  onDelete: () => void;
  onClose: () => void;
}

/** 「变更」标题的右键菜单：批量放弃 / 储藏 / 加入待提交 / 删除文件。 */
export function GitChangesMenu({ x, y, count, busy, onDiscard, onStash, onStage, onDelete, onClose }: Props) {
  useMenuDismiss(true, onClose, ".git-context-menu");

  const disabled = busy || count === 0;
  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  return createPortal(
    <div
      className="git-context-menu"
      role="menu"
      style={{ left: Math.min(x, window.innerWidth - 260), top: Math.min(y, window.innerHeight - 200) }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button type="button" role="menuitem" disabled={disabled} onClick={run(onDiscard)}>
        <Undo2 size={14} />放弃 {count} 个文件的更改…
      </button>
      <button type="button" role="menuitem" disabled={disabled} onClick={run(onStash)} title="git stash push -u，会连同已加入待提交和未跟踪的改动一起储藏">
        <Archive size={14} />储藏全部改动
      </button>
      <button type="button" role="menuitem" disabled={disabled} onClick={run(onStage)}>
        <ArrowDown size={14} />添加 {count} 个文件至「待提交」
      </button>
      <div className="git-context-menu-separator" />
      <button type="button" role="menuitem" className="danger" disabled={disabled} onClick={run(onDelete)}>
        <Trash2 size={14} />删除 {count} 个文件…
      </button>
    </div>,
    document.body,
  );
}
