import { useEffect, useRef } from "react";
import { FileText, Folder } from "lucide-react";
import { getFileSearchMatch } from "@/lib/file-search-ranking";
import type { ProjectFileIndexItem } from "@/lib/project-file-index";

type ComposerFileMentionPickerProps = {
  error: boolean;
  id: string;
  interactive: boolean;
  loading: boolean;
  projectPath: string;
  query: string;
  results: ProjectFileIndexItem[];
  selectedIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (item: ProjectFileIndexItem) => void;
};

function highlightFileName(name: string, query: string) {
  const match = getFileSearchMatch(name, query);
  if (!match) return name;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const index of match.indices) {
    if (cursor < index) parts.push(<span key={`text-${index}`}>{name.slice(cursor, index)}</span>);
    parts.push(<mark key={`match-${index}`}>{name[index]}</mark>);
    cursor = index + 1;
  }
  if (cursor < name.length) parts.push(<span key="text-end">{name.slice(cursor)}</span>);
  return parts;
}

function getRelativePath(projectPath: string, filePath: string) {
  const normalizedProject = projectPath.replace(/[\\/]+$/, "");
  if (filePath.toLowerCase().startsWith(normalizedProject.toLowerCase())) {
    return filePath.slice(normalizedProject.length).replace(/^[\\/]+/, "") || filePath;
  }
  return filePath;
}

export function ComposerFileMentionPicker({
  error,
  id,
  interactive,
  loading,
  projectPath,
  query,
  results,
  selectedIndex,
  onHighlight,
  onSelect,
}: ComposerFileMentionPickerProps) {
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const emptyLabel = error
    ? "无法读取项目内容"
    : query.trim()
      ? "未找到匹配的文件或文件夹"
      : "项目中没有可引用的文件或文件夹";

  return (
    <div
      id={id}
      className="chat-file-mention-picker"
      role="listbox"
      aria-label="选择要引用的文件或文件夹"
      aria-busy={loading}
    >
      {results.length > 0 ? (
        <div className="chat-file-mention-list">
          {results.map((item, index) => {
            const selected = interactive && index === selectedIndex;
            return (
              <div
                key={item.path}
                ref={selected ? selectedRef : undefined}
                id={`${id}-option-${index}`}
                className={`chat-file-mention-item ${item.isDirectory ? "folder" : "file"} ${selected ? "selected" : ""}`}
                role="option"
                aria-selected={selected}
                aria-disabled={!interactive}
                title={item.path}
                onMouseEnter={() => onHighlight(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (interactive) onSelect(item);
                }}
              >
                {item.isDirectory
                  ? <Folder size={15} strokeWidth={1.8} fill="currentColor" fillOpacity={0.1} />
                  : <FileText size={15} strokeWidth={1.8} />}
                <span className="chat-file-mention-copy">
                  <span className="chat-file-mention-name">{highlightFileName(item.name, query)}</span>
                  <small>{getRelativePath(projectPath, item.path)}</small>
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className={`chat-file-mention-state ${error ? "error" : ""}`} role="status">
          {loading ? "正在加载项目内容..." : emptyLabel}
        </div>
      )}
      {loading && results.length > 0 && <div className="chat-file-mention-loading" aria-hidden="true" />}
    </div>
  );
}
