import {
  useState,
  useEffect,
  useCallback,
  memo,
  useRef,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useAppStore, type FileRevealRequest } from "@/stores/app-store";
import { useProjectStore } from "@/stores/project-store";
import { useChatStore } from "@/stores/chat-store";
import { FilePreview } from "@/components/shared/FilePreview";
import { useFileFilters } from "@/hooks/useFileFilters";
import { isFileTreePathWithin, isSameFileTreePath } from "@/lib/file-tree-paths";
import { writePathAttachmentDragData } from "@/lib/path-attachments";
import { scheduleAbortableTask } from "@/lib/abortable-task-scheduler";
import { invalidateProjectFileIndex, queryProjectFileIndex } from "@/lib/project-file-index";
import { replaceEmojiWithImages } from "@/lib/emoji";
import { showFloatingToastMessage } from "@/lib/floating-toast";
import { showAppAlert } from "@/lib/app-dialog";
import { getFileFilterKey, isFileEntryExcluded, type FileFilterConfig } from "@shared/file-filters";
import type { FileEntry } from "@/types";
import {
  ChevronDown,
  ChevronRight,
  Clipboard,
  CopyMinus,
  FolderOpen,
  MessageCirclePlus,
  RefreshCw,
} from "lucide-react";
import "./FileTree.css";

const FILE_EXPLORER_SEARCH_DEBOUNCE_MS = 100;

interface FileTreeCommand {
  requestId: number;
  scopeKey: string;
  mode: "collapse" | "refresh";
  handledPaths: Set<string>;
}

interface FileExplorerContextMenu {
  entries: FileEntry[];
  x: number;
  y: number;
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

function getFileIcon(name: string): { icon: string; color: string } {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  
  // Special filenames
  if (name === 'package.json') return { icon: '📦', color: '#cb3837' };
  if (name === 'tsconfig.json') return { icon: '⚙️', color: '#3178c6' };
  if (name === '.gitignore') return { icon: '🔧', color: '#f05032' };
  if (name === 'README.md') return { icon: '📖', color: '#083fa1' };
  
  // Extensions
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return { icon: '📄', color: '#f7df1e' };
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return { icon: '📘', color: '#3178c6' };
    case 'json':
      return { icon: '📋', color: '#5b5b5b' };
    case 'css':
    case 'scss':
    case 'less':
      return { icon: '🎨', color: '#264de4' };
    case 'html':
    case 'htm':
      return { icon: '🌐', color: '#e34c26' };
    case 'md':
    case 'mdx':
      return { icon: '📝', color: '#083fa1' };
    case 'py':
      return { icon: '🐍', color: '#3776ab' };
    case 'rs':
      return { icon: '🦀', color: '#dea584' };
    case 'go':
      return { icon: '🔷', color: '#00add8' };
    case 'java':
      return { icon: '☕', color: '#ed8b00' };
    case 'vue':
      return { icon: '💚', color: '#42b883' };
    case 'svelte':
      return { icon: '🔥', color: '#ff3e00' };
    case 'yaml':
    case 'yml':
      return { icon: '⚙️', color: '#cb171e' };
    case 'toml':
      return { icon: '⚙️', color: '#9c4121' };
    case 'xml':
      return { icon: '📰', color: '#0060ac' };
    case 'svg':
      return { icon: '🖼️', color: '#ffb13b' };
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return { icon: '🖼️', color: '#a855f7' };
    case 'sh':
    case 'bash':
    case 'zsh':
      return { icon: '🖥️', color: '#89e051' };
    case 'sql':
      return { icon: '🗄️', color: '#336791' };
    case 'env':
      return { icon: '🔐', color: '#ecd53f' };
    case 'lock':
      return { icon: '🔒', color: '#888' };
    case 'txt':
      return { icon: '📄', color: '#888' };
    default:
      return { icon: '📄', color: '#6D8098' };
  }
}

const FileTreeItem = memo(function FileTreeItem({
  entry,
  depth,
  filters,
  filterKey,
  revealRequest,
  treeCommand,
  onClaimRevealCenter,
  onFileClick,
  onContextMenu,
  selectedPaths,
  onSelect,
  siblingEntries,
}: {
  entry: FileEntry;
  depth: number;
  filters: FileFilterConfig;
  filterKey: string;
  revealRequest: FileRevealRequest | null;
  treeCommand: FileTreeCommand | null;
  onClaimRevealCenter: (requestId: number) => boolean;
  onFileClick: (path: string) => void;
  onContextMenu: (entry: FileEntry, event: MouseEvent<HTMLDivElement>) => void;
  selectedPaths: Set<string>;
  onSelect: (entry: FileEntry, event: MouseEvent<HTMLDivElement>, siblings: FileEntry[]) => void;
  siblingEntries: FileEntry[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const childrenLoadedRef = useRef(false);
  const childrenLoadingRef = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const loadChildren = useCallback(async (force = false) => {
    if (entry.type !== "folder" || (!force && childrenLoadedRef.current) || childrenLoadingRef.current) return;
    childrenLoadingRef.current = true;
    try {
      const loaded = await window.electronAPI.readDirectory(entry.path, filters);
      setChildren(loaded);
      childrenLoadedRef.current = true;
    } finally {
      childrenLoadingRef.current = false;
    }
  }, [entry.path, entry.type, filters]);

  const handleToggle = useCallback(() => {
    if (entry.type !== "folder") {
      onFileClick(entry.path);
      return;
    }

    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded) void loadChildren();
  }, [entry.path, entry.type, expanded, loadChildren, onFileClick]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleToggle();
  }, [handleToggle]);

  const handleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    onSelect(entry, event, siblingEntries);
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) handleToggle();
  }, [entry, handleToggle, onSelect, siblingEntries]);

  const revealPath = revealRequest?.path || "";
  const shouldRevealFolder = entry.type === "folder"
    && !!revealRequest
    && isFileTreePathWithin(revealPath, entry.path);

  useEffect(() => {
    if (!shouldRevealFolder) return;
    setExpanded(true);
    void loadChildren();
  }, [loadChildren, revealRequest?.requestId, shouldRevealFolder]);

  useEffect(() => {
    if (entry.type !== "folder" || !treeCommand || treeCommand.handledPaths.has(entry.path)) return;
    treeCommand.handledPaths.add(entry.path);
    if (treeCommand.mode === "collapse") {
      setExpanded(false);
      return;
    }
    if (expanded) {
      childrenLoadedRef.current = false;
      void loadChildren(true);
    }
  }, [entry.path, entry.type, expanded, loadChildren, treeCommand]);

  const handleDragStart = useCallback((event: DragEvent<HTMLDivElement>) => {
    writePathAttachmentDragData(event.dataTransfer, {
      name: entry.name,
      path: entry.path,
      kind: entry.type,
    });
  }, [entry]);

  const isHighlighted = !!revealRequest && isSameFileTreePath(revealPath, entry.path);
  const fileInfo = entry.type === 'file' ? getFileIcon(entry.name) : null;

  useEffect(() => {
    const revealRequestId = revealRequest?.requestId;
    if (!isHighlighted || revealRequestId === undefined) return;
    const frame = requestAnimationFrame(() => {
      if (!rowRef.current || !onClaimRevealCenter(revealRequestId)) return;
      rowRef.current.scrollIntoView({ block: "center", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [isHighlighted, onClaimRevealCenter, revealRequest?.requestId]);

  return (
    <div>
      <div
        ref={rowRef}
        draggable
        onDragStart={handleDragStart}
        onClick={handleClick}
        onContextMenu={(event) => onContextMenu(entry, event)}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={0}
        className={`file-tree-item ${entry.type === 'file' ? 'is-file' : 'is-folder'} ${expanded ? 'expanded' : ''} ${isHighlighted ? 'highlighted' : ''} ${selectedPaths.has(entry.path) ? 'selected' : ''}`}
        data-expanded={entry.type === "folder" ? String(expanded) : undefined}
        aria-expanded={entry.type === "folder" ? expanded : undefined}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <span className="file-tree-disclosure" aria-hidden="true">
          {entry.type === "folder" && (
            expanded
              ? <ChevronDown size={14} strokeWidth={2.4} />
              : <ChevronRight size={14} strokeWidth={2.4} />
          )}
        </span>
        {entry.type === "file" && (
          <span
            className="file-icon file-icon-emoji"
            style={{ color: fileInfo?.color }}
            aria-hidden="true"
          >
            <span dangerouslySetInnerHTML={{ __html: replaceEmojiWithImages(fileInfo?.icon || '📄') }} />
          </span>
        )}
        <span className="file-name">{entry.name}</span>
      </div>
      {children.length > 0 && (
        <div className="file-tree-children" hidden={!expanded}>
          {children.map((child) => (
            <FileTreeItem
              key={`${filterKey}:${child.path}`}
              entry={child}
              depth={depth + 1}
              filters={filters}
              filterKey={filterKey}
              revealRequest={revealRequest}
              treeCommand={treeCommand}
              onClaimRevealCenter={onClaimRevealCenter}
              onFileClick={onFileClick}
              onContextMenu={onContextMenu}
              selectedPaths={selectedPaths}
              onSelect={onSelect}
              siblingEntries={children}
            />
          ))}
        </div>
      )}
    </div>
  );
});

export function FileExplorer() {
  const [search, setSearch] = useState("");
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [searchResults, setSearchResults] = useState<FileEntry[]>([]);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [treeCommand, setTreeCommand] = useState<FileTreeCommand | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [contextMenu, setContextMenu] = useState<FileExplorerContextMenu | null>(null);
  const [selectedEntries, setSelectedEntries] = useState<Map<string, FileEntry>>(() => new Map());
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(null);
  const rootRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  const centeredRevealRequestIdRef = useRef<number | null>(null);
  const { projects, activeProjectId } = useProjectStore();
  const revealRequest = useAppStore((state) => state.fileRevealRequest);
  const filters = useFileFilters();
  const filterKey = getFileFilterKey(filters);
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const treeScopeKey = `${activeProject?.path || ""}:${filterKey}`;
  const activeTreeCommand = treeCommand?.scopeKey === treeScopeKey ? treeCommand : null;

  const handleFileClick = useCallback((path: string) => {
    setPreviewFile(path);
  }, []);

  const handleSelect = useCallback((entry: FileEntry, event: MouseEvent<HTMLDivElement>, siblings: FileEntry[]) => {
    if (!event.shiftKey || !selectionAnchorPath) setSelectionAnchorPath(entry.path);
    setSelectedEntries((current) => {
      const isToggle = event.ctrlKey || event.metaKey;
      if (event.shiftKey && selectionAnchorPath) {
        const start = siblings.findIndex((item) => item.path === selectionAnchorPath);
        const end = siblings.findIndex((item) => item.path === entry.path);
        if (start >= 0 && end >= 0) {
          const range = siblings.slice(Math.min(start, end), Math.max(start, end) + 1);
          return new Map(range.map((item) => [item.path, item]));
        }
      }
      if (!isToggle) {
        return new Map([[entry.path, entry]]);
      }
      const next = new Map(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.set(entry.path, entry);
      return next;
    });
  }, [selectionAnchorPath]);

  const handleContextMenu = useCallback((entry: FileEntry, event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const entries = selectedEntries.has(entry.path) ? [...selectedEntries.values()] : [entry];
    if (!selectedEntries.has(entry.path)) setSelectedEntries(new Map([[entry.path, entry]]));
    setContextMenu({ entries, x: event.clientX, y: event.clientY });
  }, [selectedEntries]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const copyPath = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showFloatingToastMessage(value.includes("\n") ? "已复制多个路径" : "已复制路径");
    } catch {
      showAppAlert("复制失败");
    } finally {
      closeContextMenu();
    }
  }, [closeContextMenu]);

  const addToChat = useCallback(async (entries: FileEntry[]) => {
    const sessionId = useProjectStore.getState().activeSessionId;
    if (!sessionId) {
      showAppAlert("请先选择一个会话再添加到聊天");
      closeContextMenu();
      return;
    }
    let addedCount = 0;
    for (const entry of entries) {
      const result = await window.electronAPI.statPath(entry.path);
      if (!result.success || !result.attachment) {
        showAppAlert(result.error || `无法添加资源：${entry.name}`);
        continue;
      }
      useChatStore.getState().addPendingPathAttachment({ id: crypto.randomUUID(), ...result.attachment }, sessionId);
      addedCount += 1;
    }
    if (addedCount > 0) showFloatingToastMessage(addedCount === 1 ? "已添加到聊天" : `已添加 ${addedCount} 个资源到聊天`);
    closeContextMenu();
  }, [closeContextMenu]);

  const openInExplorer = useCallback(async (entries: FileEntry[]) => {
    for (const entry of entries) {
      const result = await window.electronAPI.showItemInFolder(entry.path);
      if (!result.success) showAppAlert(result.error || `无法打开：${entry.name}`);
    }
    closeContextMenu();
  }, [closeContextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => closeContextMenu();
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
    };
  }, [closeContextMenu, contextMenu]);

  const claimRevealCenter = useCallback((requestId: number) => {
    if (centeredRevealRequestIdRef.current === requestId) return false;
    centeredRevealRequestIdRef.current = requestId;
    return true;
  }, []);

  const collapseAllFolders = useCallback(() => {
    setSearch("");
    setTreeCommand((current) => ({
      requestId: (current?.requestId || 0) + 1,
      scopeKey: treeScopeKey,
      mode: "collapse",
      handledPaths: new Set<string>(),
    }));
  }, [treeScopeKey]);

  const loadRootEntries = useCallback(async () => {
    const projectPath = activeProject?.path;
    const requestId = rootRequestRef.current + 1;
    rootRequestRef.current = requestId;
    if (!projectPath) {
      setRootEntries([]);
      return;
    }
    const entries = await window.electronAPI.readDirectory(projectPath, filters);
    if (rootRequestRef.current === requestId) setRootEntries(entries);
  }, [activeProject?.path, filterKey, filters]);

  useEffect(() => {
    void loadRootEntries();
    return () => {
      rootRequestRef.current += 1;
    };
  }, [loadRootEntries]);

  const handleRefresh = useCallback(() => {
    const nextRequestId = (treeCommand?.requestId || 0) + 1;
    setTreeCommand({
      requestId: nextRequestId,
      scopeKey: treeScopeKey,
      mode: "refresh",
      handledPaths: new Set<string>(),
    });
    setRefreshVersion((current) => current + 1);
    if (activeProject?.path) invalidateProjectFileIndex(activeProject.path, filters);
    void loadRootEntries();
  }, [activeProject?.path, filters, loadRootEntries, treeCommand?.requestId, treeScopeKey]);

  useEffect(() => {
    if (revealRequest) setSearch("");
  }, [revealRequest?.requestId]);

  useEffect(() => {
    if (!revealRequest) return;
    setPreviewFile(revealRequest.preview ? revealRequest.path : null);
  }, [revealRequest?.requestId]);

  useEffect(() => {
    if (!search.trim() || !activeProject) {
      searchRequestRef.current += 1;
      setSearchResults([]);
      return;
    }
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    const scheduledSearch = scheduleAbortableTask((signal) => {
      void queryProjectFileIndex({
        projectPath: activeProject.path,
        filters,
        query: search,
        signal,
      }).then((results) => {
        if (searchRequestRef.current !== requestId || signal.aborted) return;
        setSearchResults(results.map((item): FileEntry => ({
          name: item.name,
          path: item.path,
          type: item.isDirectory ? "folder" : "file",
          ...(item.isDirectory ? { children: [] } : {}),
        })));
      }).catch(() => {
        if (searchRequestRef.current === requestId && !signal.aborted) setSearchResults([]);
      });
    }, FILE_EXPLORER_SEARCH_DEBOUNCE_MS);
    return scheduledSearch.cancel;
  }, [search, activeProject?.path, filterKey, filters, refreshVersion]);

  const displayEntries = (search.trim() ? searchResults : rootEntries)
    .filter((entry) => !isFileEntryExcluded(entry, filters));
  const activeRevealRequest = search.trim() ? null : revealRequest;

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span>资源管理器</span>
        {activeProject && (
          <div className="file-tree-header-actions">
            <button
              type="button"
              onClick={collapseAllFolders}
              className="file-tree-header-btn"
              title="收起全部目录"
              aria-label="收起全部目录"
            >
              <CopyMinus size={14} strokeWidth={1.9} />
            </button>
            <button
              type="button"
              onClick={handleRefresh}
              className="file-tree-header-btn"
              title="刷新"
              aria-label="刷新资源管理器"
            >
              <RefreshCw size={14} strokeWidth={2} />
            </button>
          </div>
        )}
      </div>

      <div className="file-tree-search">
        <svg className="file-tree-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2" />
          <path d="M21 21L16.65 16.65" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索文件..."
          className="file-tree-search-input"
        />
        {search && (
          <button onClick={() => setSearch("")} className="file-tree-search-clear">×</button>
        )}
      </div>

      <div className="file-tree-content overlay-scroll">
        {!activeProject ? (
          <p className="placeholder-text">请先选择一个项目</p>
        ) : displayEntries.length === 0 ? (
          <p className="placeholder-text">{search ? "无匹配结果" : "空目录"}</p>
        ) : (
          displayEntries.map((entry) => (
            <FileTreeItem
              key={`${filterKey}:${entry.path}`}
              entry={entry}
              depth={0}
              filters={filters}
              filterKey={filterKey}
              revealRequest={activeRevealRequest}
              treeCommand={activeTreeCommand}
              onClaimRevealCenter={claimRevealCenter}
              onFileClick={handleFileClick}
              onContextMenu={handleContextMenu}
              selectedPaths={new Set(selectedEntries.keys())}
              onSelect={handleSelect}
              siblingEntries={displayEntries}
            />
          ))
        )}
      </div>

      <FilePreview filePath={previewFile} onClose={() => setPreviewFile(null)} />
      {contextMenu && (
        <div
          className="file-tree-context-menu"
          style={{ left: Math.min(contextMenu.x, window.innerWidth - 210), top: Math.min(contextMenu.y, window.innerHeight - 180) }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => void openInExplorer(contextMenu.entries)}><FolderOpen size={15} />在资源管理器打开</button>
          <button type="button" onClick={() => void addToChat(contextMenu.entries)}><MessageCirclePlus size={15} />添加到聊天</button>
          <button type="button" onClick={() => void copyPath(contextMenu.entries.map((entry) => entry.path).join("\n"))}><Clipboard size={15} />复制路径</button>
          <button type="button" onClick={() => void copyPath(contextMenu.entries.map((entry) => activeProject ? getRelativeFilePath(entry.path, activeProject.path) : entry.path).join("\n"))}><Clipboard size={15} />复制相对路径</button>
        </div>
      )}
    </div>
  );
}
