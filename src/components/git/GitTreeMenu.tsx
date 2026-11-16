import { createPortal } from "react-dom";
import { Archive, ArrowDown, ArrowUp, Clipboard, ExternalLink, FolderOpen, History, Undo2 } from "lucide-react";

import type { FileEntry } from "@/types";
import { useMenuDismiss } from "./useMenuDismiss";

interface Props {
  entry: FileEntry;
  relativePath: string;
  x: number;
  y: number;
  /** changes：变更列表的行；tree：目录树。两者能做的事不同。 */
  variant: "changes" | "tree";
  /** 目录树下有没有工作区改动，决定是否显示「放弃更改」。 */
  hasChanges: boolean;
  /** 变更列表里这一行是不是「待提交」区。 */
  stagedView?: boolean;
  busy: boolean;
  onStage: () => void;
  onUnstage: () => void;
  /** 只有变更列表的行会传：储藏这个文件。 */
  onStash?: () => void;
  onIgnore: () => void;
  onHistory: () => void;
  onDiscard: () => void;
  onBlame: () => void;
  onCopyPath: () => void;
  onReveal: () => void;
  onOpen: () => void;
  onClose: () => void;
}

/**
 * 文件右键菜单。目录树只负责浏览（忽略 / 查看历史 / 追溯），
 * 待提交相关的动作只放在变更列表里，避免同一个操作散落在两处。
 */
export function GitTreeMenu({
  entry, relativePath, x, y, variant, hasChanges, stagedView, busy,
  onStage, onUnstage, onStash, onIgnore, onHistory, onDiscard, onBlame, onCopyPath, onReveal, onOpen, onClose,
}: Props) {
  useMenuDismiss(true, onClose, ".git-context-menu");

  const isFolder = entry.type === "folder";
  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  // 变更列表和目录树都要能忽略 / 看历史，抽出来避免两处菜单漂移。
  const ignoreHistoryActions = (
    <>
      <button type="button" role="menuitem" disabled={busy} onClick={run(onIgnore)}>
        <Undo2 size={14} />{isFolder ? "忽略此目录" : "忽略此文件"}
      </button>
      <button type="button" role="menuitem" disabled={busy} onClick={run(onHistory)}>
        <History size={14} />查看历史
      </button>
    </>
  );

  return createPortal(
    <div
      className="git-context-menu git-tree-menu"
      role="menu"
      style={{ left: Math.min(x, window.innerWidth - 240), top: Math.min(y, window.innerHeight - 260) }}
      onContextMenu={(event) => event.preventDefault()}
      title={relativePath}
    >
      {variant === "changes" ? (
        stagedView ? (
          <>
            <button type="button" role="menuitem" disabled={busy} onClick={run(onUnstage)}>
              <ArrowUp size={14} />从「待提交」移出
            </button>
            <button type="button" role="menuitem" disabled={busy} onClick={run(onBlame)}>
              <History size={14} />追溯此文件
            </button>
            <div className="git-context-menu-separator" />
            {ignoreHistoryActions}
          </>
        ) : (
          <>
            <button type="button" role="menuitem" disabled={busy} onClick={run(onStage)}>
              <ArrowDown size={14} />添加到「待提交」
            </button>
            <button type="button" role="menuitem" className="danger" disabled={busy} onClick={run(onDiscard)}>
              <Undo2 size={14} />放弃更改
            </button>
            <button type="button" role="menuitem" disabled={busy} onClick={run(onBlame)}>
              <History size={14} />追溯此文件
            </button>
            {onStash && (
              <button type="button" role="menuitem" disabled={busy} onClick={run(onStash)}>
                <Archive size={14} />储藏此文件…
              </button>
            )}
            <div className="git-context-menu-separator" />
            {ignoreHistoryActions}
          </>
        )
      ) : (
        <>
          {ignoreHistoryActions}
          {!isFolder && hasChanges && (
            <button type="button" role="menuitem" className="danger" disabled={busy} onClick={run(onDiscard)}>
              <Undo2 size={14} />放弃更改
            </button>
          )}
          {!isFolder && (
            <button type="button" role="menuitem" disabled={busy} onClick={run(onBlame)}>
              <History size={14} />追溯此文件
            </button>
          )}
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
