import { useState, useEffect, useCallback, useRef } from "react";
import { useProjectStore } from "@/stores/project-store";
import "./FileSearch.css";

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FileSearchProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (filePath: string) => void;
}

function fuzzyMatch(text: string, pattern: string): boolean {
  if (!pattern) return true;
  const lowerText = text.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  let pi = 0;
  for (let i = 0; i < lowerText.length && pi < lowerPattern.length; i++) {
    if (lowerText[i] === lowerPattern[pi]) pi++;
  }
  return pi === lowerPattern.length;
}

function highlightMatch(text: string, pattern: string): React.ReactNode {
  if (!pattern) return text;
  const lowerText = text.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  const indices: number[] = [];
  let pi = 0;
  for (let i = 0; i < lowerText.length && pi < lowerPattern.length; i++) {
    if (lowerText[i] === lowerPattern[pi]) {
      indices.push(i);
      pi++;
    }
  }
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const idx of indices) {
    if (last < idx) parts.push(<span key={`p${idx}`}>{text.slice(last, idx)}</span>);
    parts.push(<span key={`m${idx}`} className="fs-highlight">{text[idx]}</span>);
    last = idx + 1;
  }
  if (last < text.length) parts.push(<span key="end">{text.slice(last)}</span>);
  return parts;
}

const EXCLUDE_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".next", ".nuxt", "out"]);

export function FileSearch({ isOpen, onClose, onSelect }: FileSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);

  // Recursively collect files
  const collectFiles = useCallback(async (dirPath: string, depth = 0): Promise<FileItem[]> => {
    if (depth > 3) return [];
    try {
      const items = await window.electronAPI.readDirectory(dirPath);
      const files: FileItem[] = [];
      for (const item of items) {
        if (EXCLUDE_DIRS.has(item.name) || item.name.startsWith(".")) continue;
        files.push({ name: item.name, path: item.path, isDirectory: item.type === "folder" });
        if (item.type === "folder") {
          files.push(...await collectFiles(item.path, depth + 1));
        }
      }
      return files;
    } catch {
      return [];
    }
  }, []);

  // Search when query changes
  useEffect(() => {
    if (!isOpen || !query.trim() || !activeProject) {
      setResults([]);
      return;
    }
    const search = async () => {
      setLoading(true);
      try {
        const allFiles = await collectFiles(activeProject.path);
        const filtered = allFiles.filter((f) => fuzzyMatch(f.name, query));
        filtered.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.length - b.name.length;
        });
        setResults(filtered.slice(0, 50));
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    };
    const timer = setTimeout(search, 150);
    return () => clearTimeout(timer);
  }, [query, isOpen, collectFiles, activeProject]);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((p) => Math.min(p + 1, results.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((p) => Math.max(p - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (results[selectedIndex]) {
          onSelect(results[selectedIndex].path);
          onClose();
        }
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  }, [results, selectedIndex, onSelect, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fs-overlay" onClick={onClose}>
      <div className="fs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fs-input-wrapper">
          <svg className="fs-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2" />
            <path d="M21 21L16.65 16.65" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="fs-input"
            placeholder="搜索文件名..."
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            onKeyDown={handleKeyDown}
          />
          {loading && <span className="fs-loading">...</span>}
        </div>

        {results.length > 0 && (
          <div className="fs-results">
            {results.map((item, index) => (
              <div
                key={item.path}
                className={`fs-item ${index === selectedIndex ? "selected" : ""}`}
                onClick={() => { onSelect(item.path); onClose(); }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <svg className="fs-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
                  {item.isDirectory ? (
                    <path d="M2 6C2 4.89543 2.89543 4 4 4H9L11 6H20C21.1046 6 22 6.89543 22 8V18C22 19.1046 21.1046 20 20 20H4C2.89543 20 2 19.1046 2 18V6Z" stroke="currentColor" strokeWidth="1.5" />
                  ) : (
                    <>
                      <path d="M6 2H14L20 8V20C20 21.1046 19.1046 22 18 22H6C4.89543 22 4 21.1046 4 20V4C4 2.89543 4.89543 2 6 2Z" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M14 2V8H20" stroke="currentColor" strokeWidth="1.5" />
                    </>
                  )}
                </svg>
                <div className="fs-item-info">
                  <span className="fs-item-name">{highlightMatch(item.name, query)}</span>
                  <span className="fs-item-path">{item.path}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {query && results.length === 0 && !loading && (
          <div className="fs-empty">未找到匹配的文件</div>
        )}

        <div className="fs-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> 导航</span>
          <span><kbd>Enter</kbd> 选择</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  );
}
