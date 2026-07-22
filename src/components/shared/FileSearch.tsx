import { useState, useEffect, useCallback, useRef, type DragEvent } from "react";
import { FileText, Folder } from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { useFileFilters } from "@/hooks/useFileFilters";
import { getFileSearchMatch } from "@/lib/file-search-ranking";
import { scheduleAbortableTask } from "@/lib/abortable-task-scheduler";
import {
  getProjectFileIndex,
  queryProjectFileIndex,
  type ProjectFileIndexItem,
} from "@/lib/project-file-index";
import { writePathAttachmentDragData } from "@/lib/path-attachments";
import { getFileFilterKey } from "@shared/file-filters";
import "./FileSearch.css";

const FILE_SEARCH_DEBOUNCE_MS = 100;

export interface FileSearchSelection {
  path: string;
  isDirectory: boolean;
}

interface FileSearchProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (selection: FileSearchSelection) => void;
}

interface FileSearchResultState {
  items: ProjectFileIndexItem[];
  query: string | null;
}

function highlightMatch(text: string, pattern: string): React.ReactNode {
  const match = getFileSearchMatch(text, pattern);
  if (!match) return text;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const idx of match.indices) {
    if (last < idx) parts.push(<span key={`p${idx}`}>{text.slice(last, idx)}</span>);
    parts.push(<span key={`m${idx}`} className="fs-highlight">{text[idx]}</span>);
    last = idx + 1;
  }
  if (last < text.length) parts.push(<span key="end">{text.slice(last)}</span>);
  return parts;
}

export function FileSearch({ isOpen, onClose, onSelect }: FileSearchProps) {
  const [query, setQuery] = useState("");
  const [resultState, setResultState] = useState<FileSearchResultState>({ items: [], query: null });
  const results = resultState.items;
  const resultsCurrent = resultState.query === query;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [draggingResult, setDraggingResult] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRequestRef = useRef(0);
  const projects = useProjectStore((state) => state.projects);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const filters = useFileFilters();
  const filterKey = getFileFilterKey(filters);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    if (!isOpen || !activeProject?.path) return;
    void getProjectFileIndex(activeProject.path, filters).catch(() => undefined);
  }, [isOpen, activeProject?.path, filterKey, filters]);

  useEffect(() => {
    searchRequestRef.current += 1;
    setResultState({ items: [], query: null });
    setLoading(false);
    setSearchError(false);
  }, [activeProject?.path, filterKey]);

  // Search when query changes
  useEffect(() => {
    if (!isOpen || !query.trim() || !activeProject) {
      searchRequestRef.current += 1;
      setResultState({ items: [], query: null });
      setLoading(false);
      setSearchError(false);
      return;
    }
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setLoading(true);
    setSearchError(false);
    const scheduledSearch = scheduleAbortableTask(async (signal) => {
      try {
        const matches = await queryProjectFileIndex({
          projectPath: activeProject.path,
          filters,
          query,
          signal,
        });
        if (searchRequestRef.current !== requestId || signal.aborted) return;
        setSelectedIndex(0);
        setResultState({ items: matches, query });
      } catch {
        if (searchRequestRef.current === requestId && !signal.aborted) {
          setResultState({ items: [], query });
          setSearchError(true);
        }
      } finally {
        if (searchRequestRef.current === requestId && !signal.aborted) setLoading(false);
      }
    }, FILE_SEARCH_DEBOUNCE_MS);
    return scheduledSearch.cancel;
  }, [query, isOpen, activeProject?.path, filterKey, filters]);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setResultState({ items: [], query: null });
      setSelectedIndex(0);
      setDraggingResult(false);
      setSearchError(false);
      const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(focusTimer);
    } else {
      searchRequestRef.current += 1;
      setLoading(false);
    }
  }, [isOpen]);

  const handleDragStart = useCallback((event: DragEvent<HTMLDivElement>, item: ProjectFileIndexItem) => {
    if (resultState.query !== query) {
      event.preventDefault();
      return;
    }
    writePathAttachmentDragData(event.dataTransfer, {
      name: item.name,
      path: item.path,
      kind: item.isDirectory ? "folder" : "file",
    });
    setDraggingResult(true);
  }, [query, resultState.query]);

  const handleDragEnd = useCallback((event: DragEvent<HTMLDivElement>) => {
    setDraggingResult(false);
    if (event.dataTransfer.dropEffect !== "none") onClose();
  }, [onClose]);

  const handleSelect = useCallback((item: ProjectFileIndexItem) => {
    if (resultState.query !== query) return;
    onSelect({ path: item.path, isDirectory: item.isDirectory });
    onClose();
  }, [onClose, onSelect, query, resultState.query]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (results.length === 0) break;
        setSelectedIndex((p) => Math.min(p + 1, results.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((p) => Math.max(p - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (results[selectedIndex]) handleSelect(results[selectedIndex]);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  }, [results, selectedIndex, handleSelect, onClose]);

  if (!isOpen) return null;

  return (
    <div className={`fs-overlay ${draggingResult ? "fs-dragging" : ""}`} onClick={onClose}>
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
                draggable={resultsCurrent}
                aria-disabled={!resultsCurrent}
                className={`fs-item ${resultsCurrent && index === selectedIndex ? "selected" : ""}`}
                onClick={() => handleSelect(item)}
                onMouseEnter={() => {
                  if (resultState.query === query) setSelectedIndex(index);
                }}
                onDragStart={(event) => handleDragStart(event, item)}
                onDragEnd={handleDragEnd}
              >
                {item.isDirectory
                  ? <Folder className="fs-item-icon folder" size={15} strokeWidth={1.8} fill="currentColor" fillOpacity={0.1} />
                  : <FileText className="fs-item-icon" size={15} strokeWidth={1.8} />}
                <div className="fs-item-info">
                  <span className="fs-item-name">{highlightMatch(item.name, query)}</span>
                  <span className="fs-item-path">{item.path}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {query && results.length === 0 && !loading && (
          <div className={`fs-empty ${searchError ? "error" : ""}`}>
            {searchError ? "无法读取项目内容" : "未找到匹配的文件"}
          </div>
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
