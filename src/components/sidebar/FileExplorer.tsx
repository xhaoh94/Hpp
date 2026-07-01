import { useState, useEffect, useCallback, memo } from "react";
import { useChatStore } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import { FilePreview } from "@/components/shared/FilePreview";
import type { FileEntry } from "@/types";
import "./FileTree.css";

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
  highlightedPath,
  onFileClick,
}: {
  entry: FileEntry;
  depth: number;
  highlightedPath?: string | null;
  onFileClick: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const [loadingFolder, setLoadingFolder] = useState(false);

  const handleToggle = useCallback(async () => {
    if (entry.type === "folder") {
      if (!expanded && children.length === 0) {
        setLoadingFolder(true);
        try {
          const loaded = await window.electronAPI.readDirectory(entry.path);
          setChildren(loaded);
        } finally {
          setLoadingFolder(false);
        }
      }
      setExpanded(!expanded);
    } else {
      onFileClick(entry.path);
    }
  }, [entry, expanded, children.length, onFileClick]);

  const isHighlighted = highlightedPath === entry.path;
  const fileInfo = entry.type === 'file' ? getFileIcon(entry.name) : null;

  return (
    <div>
      <div
        onClick={handleToggle}
        className={`file-tree-item ${entry.type === 'file' ? 'is-file' : ''} ${isHighlighted ? 'highlighted' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <span className="file-icon" style={{ color: fileInfo?.color || '#DCAB5F' }}>
          {entry.type === "folder" ? (
            expanded ? '📂' : (loadingFolder ? '⏳' : '📁')
          ) : (
            fileInfo?.icon || '📄'
          )}
        </span>
        <span className="file-name">{entry.name}</span>
      </div>
      {expanded && children.length > 0 && (
        <div className="file-tree-children">
          {children.map((child) => (
            <FileTreeItem key={child.path} entry={child} depth={depth + 1} highlightedPath={highlightedPath} onFileClick={onFileClick} />
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
  const { projects, activeProjectId } = useProjectStore();
  const { highlightedFile } = useChatStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const handleFileClick = useCallback((path: string) => {
    setPreviewFile(path);
  }, []);

  useEffect(() => {
    if (activeProject) {
      window.electronAPI.readDirectory(activeProject.path).then(setRootEntries);
    }
  }, [activeProject]);

  useEffect(() => {
    if (!search.trim() || !activeProject) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      const results = await window.electronAPI.searchFiles(activeProject.path, search);
      setSearchResults(results);
    }, 300);
    return () => clearTimeout(timer);
  }, [search, activeProject]);

  const displayEntries = search.trim() ? searchResults : rootEntries;

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span>资源管理器</span>
        {activeProject && (
          <div className="file-tree-header-actions">
            <button
              onClick={() => window.electronAPI.readDirectory(activeProject.path).then(setRootEntries)}
              className="btn-refresh"
              title="刷新"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M1 4v6h6M23 20v-6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
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

      <div className="file-tree-content">
        {!activeProject ? (
          <p className="placeholder-text">请先选择一个项目</p>
        ) : displayEntries.length === 0 ? (
          <p className="placeholder-text">{search ? "无匹配结果" : "空目录"}</p>
        ) : (
          displayEntries.map((entry) => (
            <FileTreeItem key={entry.path} entry={entry} depth={0} highlightedPath={highlightedFile} onFileClick={handleFileClick} />
          ))
        )}
      </div>

      <FilePreview filePath={previewFile} onClose={() => setPreviewFile(null)} />
    </div>
  );
}
