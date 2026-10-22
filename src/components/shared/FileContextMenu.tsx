import { useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { Clipboard, Copy, FolderOpen, MessageCirclePlus } from "lucide-react";
import { useChatStore } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import { showFloatingToastMessage } from "@/lib/floating-toast";
import { showAppAlert } from "@/lib/app-dialog";
import "./FileContextMenu.css";

export interface FileContextMenuState {
  x: number;
  y: number;
  /** 已解析的绝对路径；右键菜单的所有动作都基于它。 */
  path: string;
}

interface FileContextMenuProps extends FileContextMenuState {
  /** 消息所属项目根；缺省时回退到当前激活项目。仅用于「复制相对路径」。 */
  projectPath?: string;
  onClose: () => void;
}

const getRelativeFilePath = (path: string, projectPath: string) => {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedProjectPath = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const comparePath = normalizedPath.toLowerCase();
  const compareProjectPath = normalizedProjectPath.toLowerCase();
  return comparePath.startsWith(`${compareProjectPath}/`)
    ? normalizedPath.slice(normalizedProjectPath.length + 1)
    : normalizedPath;
};

const getFileName = (path: string) => {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || path;
};

/**
 * 聊天内容里可点击文件的统一右键菜单，与文件资源管理器菜单保持同一组动作：
 * 在资源管理器打开 / 添加到聊天 / 复制路径 / 复制相对路径 / 复制名字。
 */
export function FileContextMenu({ x, y, path, projectPath, onClose }: FileContextMenuProps) {
  useEffect(() => {
    const handleMouseDown = (event: globalThis.MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.(".file-context-menu")) return;
      onClose();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const copyText = useCallback(async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showFloatingToastMessage(message);
    } catch {
      showAppAlert("复制失败");
    } finally {
      onClose();
    }
  }, [onClose]);

  const openInExplorer = useCallback(async () => {
    const result = await window.electronAPI.showItemInFolder(path);
    if (!result.success) showAppAlert(result.error || "无法打开所在位置");
    onClose();
  }, [path, onClose]);

  const addToChat = useCallback(async () => {
    const sessionId = useProjectStore.getState().activeSessionId;
    if (!sessionId) {
      showAppAlert("请先选择一个会话再添加到聊天");
      onClose();
      return;
    }
    const result = await window.electronAPI.statPath(path);
    if (!result.success || !result.attachment) {
      showAppAlert(result.error || `无法添加资源：${getFileName(path)}`);
      onClose();
      return;
    }
    useChatStore.getState().addPendingPathAttachment({ id: crypto.randomUUID(), ...result.attachment }, sessionId);
    showFloatingToastMessage("已添加到聊天");
    onClose();
  }, [path, onClose]);

  const activeProjectPath = useProjectStore(
    (state) => state.projects.find((project) => project.id === state.activeProjectId)?.path,
  );
  const relativeBase = projectPath || activeProjectPath;

  // 简单防溢出：与文件资源管理器菜单一致，贴住视口右下角。
  return createPortal(
    <div
      className="file-context-menu"
      role="menu"
      style={{
        left: Math.min(x, window.innerWidth - 210),
        top: Math.min(y, window.innerHeight - 200),
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button type="button" role="menuitem" onClick={() => void openInExplorer()}>
        <FolderOpen size={15} />在资源管理器打开
      </button>
      <button type="button" role="menuitem" onClick={() => void addToChat()}>
        <MessageCirclePlus size={15} />添加到聊天
      </button>
      <button type="button" role="menuitem" onClick={() => void copyText(path, "已复制路径")}>
        <Clipboard size={15} />复制路径
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => void copyText(relativeBase ? getRelativeFilePath(path, relativeBase) : path, "已复制相对路径")}
      >
        <Clipboard size={15} />复制相对路径
      </button>
      <button type="button" role="menuitem" onClick={() => void copyText(getFileName(path), "已复制名字")}>
        <Copy size={15} />复制名字
      </button>
    </div>,
    document.body,
  );
}
