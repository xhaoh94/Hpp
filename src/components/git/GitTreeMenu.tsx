import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Clipboard, ExternalLink, FolderOpen, History, Undo2 } from "lucide-react";

import type { FileEntry } from "@/types";
import { useMenuDismiss } from "./useMenuDismiss";

interface Props {
  entry: FileEntry;
  relativePath: string;
  x: number;
  y: number;
  /** 该路径当前是否有暂存改动，决定显示「添加」还是「取消暂存」。 */
  staged: boolean;
  busy: boolean;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
  onBlame: () => void;
  onCopyPath: () => void;
  onReveal: () => void;
  onOpen: () => void;
  onClose: () => void;
}

/** 目录树右键菜单：只放工作台真正能做的事。 */
export function GitTreeMenu({
  entry, relativePath, x, y, staged, busy, onStage, onUnstage, onDiscard, onBlame, onCopyPath, onReveal, onOpen, onClose,
}: Props) {
  useMenuDismiss(true, onClose, ".git-context-menu");

  const isFolder = entry.type === "folder";
  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  return createPortal(
    <div
      className="git-context-menu git-tree-menu"
      role="menu"
      style={{ left: Math.min(x, window.innerWidth - 240), top: Math.min(y, window.innerHeight - 260) }}
      onContextMenu={(event) => event.preventDefault()}
      title={relativePath}
    >
      {isFolder ? (
        <>
          <button type="button" role="menuitem" disabled={busy} onClick={run(onStage)}>
            <ArrowDown size={14} />添加该目录至「待提交」
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={run(onUnstage)}>
            <ArrowUp size={14} />取消该目录的暂存
          </button>
        </>
      ) : (
        <>
          {staged ? (
            <button type="button" role="menuitem" disabled={busy} onClick={run(onUnstage)}>
              <ArrowUp size={14} />取消暂存
            </button>
          ) : (
            <button type="button" role="menuitem" disabled={busy} onClick={run(onStage)}>
              <ArrowDown size={14} />添加至「待提交」
            </button>
          )}
          <button type="button" role="menuitem" className="danger" disabled={busy} onClick={run(onDiscard)}>
            <Undo2 size={14} />放弃更改
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={run(onBlame)}>
            <History size={14} />追溯此文件
          </button>
        </>
      )}
      <div className="git-context-menu-separator" />
      <button type="button" role="menuitem" disabled={busy} onClick={run(onCopyPath)}>
        <Clipboard size={14} />复制相对路径
      </button>
      <button type="button" role="menuitem" disabled={busy} onClick={run(onReveal)}>
        <FolderOpen size={14} />在资源管理器中显示
      </button>
      {!isFolder && (
        <button type="button" role="menuitem" disabled={busy} onClick={run(onOpen)}>
          <ExternalLink size={14} />在外部应用中打开
        </button>
      )}
    </div>,
    document.body,
  );
}
