import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, File, FolderOpen, LoaderCircle, RefreshCw } from "lucide-react";

import type { FileEntry } from "@/types";

export interface GitTreeContextTarget {
  entry: FileEntry;
  relativePath: string;
  /** 来源：目录树（默认）还是变更列表；两者菜单项不同。 */
  variant?: "tree" | "changes";
  /** 变更列表里这一行属于「待提交」区还是「变更」区，决定显示移出还是添加。 */
  stagedView?: boolean;
  /** 只有「变更」区的行会带：右键菜单里多一个「储藏此文件」。 */
  stashable?: boolean;
  x: number;
  y: number;
}

interface Props {
  repoRoot: string;
  /** 仓库相对路径 → porcelain 状态码，用来在树里标出改动。 */
  changes: Map<string, string>;
  selectedPath?: string;
  onSelectFile: (relativePath: string) => void;
  /** 点击文件时打开预览；不传则只选中。 */
  onPreviewFile?: (absolutePath: string) => void;
  onContextMenu: (target: GitTreeContextTarget) => void;
}

const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");

/** 绝对路径转仓库相对路径；不在仓库内时原样返回。 */
export function toRepoRelative(root: string, absolute: string) {
  const base = normalize(root);
  const full = normalize(absolute);
  return full.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? full.slice(base.length + 1) : full;
}

/** porcelain 状态下标：?? 未跟踪，M 修改，A 新增，D 删除，R 重命名。 */
const badgeOf = (status: string) => {
  if (status === "??") return { text: "U", tone: "untracked" };
  if (status.includes("A")) return { text: "A", tone: "A" };
  if (status.includes("D")) return { text: "D", tone: "D" };
  if (status.includes("R")) return { text: "R", tone: "R" };
  return { text: "M", tone: "M" };
};

const isHidden = (entry: FileEntry) => entry.type === "folder" && entry.name === ".git";

export function GitFileTree({ repoRoot, changes, selectedPath, onSelectFile, onPreviewFile, onContextMenu }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const loadRoot = useCallback(async () => {
    if (!repoRoot) return;
    setLoading(true);
    try {
      const loaded = await window.electronAPI.readDirectory(repoRoot);
      setEntries(loaded.filter((entry) => !isHidden(entry)));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot]);

  return (
    <section className="git-file-tree">
      <div className="git-file-section-title">
        <span className="git-file-section-label">目录树</span>
        <button type="button" className="git-file-section-action" title="重新读取目录" onClick={() => void loadRoot()}>
          {loading ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />}
        </button>
      </div>
      <div className="git-tree-scroll persistent-scroll">
        {entries.length === 0 && !loading ? (
          <div className="git-file-empty">目录为空或无法读取</div>
        ) : entries.map((entry) => (
          <TreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            repoRoot={repoRoot}
            changes={changes}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            onPreviewFile={onPreviewFile}
            onContextMenu={onContextMenu}
          />
        ))}
      </div>
    </section>
  );
}

interface NodeProps {
  entry: FileEntry;
  depth: number;
  repoRoot: string;
  changes: Map<string, string>;
  selectedPath?: string;
  onSelectFile: (relativePath: string) => void;
  onPreviewFile?: (absolutePath: string) => void;
  onContextMenu: (target: GitTreeContextTarget) => void;
}

function TreeNode({ entry, depth, repoRoot, changes, selectedPath, onSelectFile, onPreviewFile, onContextMenu }: NodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const loaded = useRef(false);
  const relativePath = toRepoRelative(repoRoot, entry.path);
  const badge = changes.get(relativePath);

  const toggle = async () => {
    if (entry.type === "file") {
      onSelectFile(relativePath);
      onPreviewFile?.(entry.path);
      return;
    }
    const next = !expanded;
    setExpanded(next);
    if (!next || loaded.current) return;
    const loadedEntries = await window.electronAPI.readDirectory(entry.path);
    loaded.current = true;
    setChildren(loadedEntries.filter((child) => !isHidden(child)));
  };

  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    onContextMenu({ entry, relativePath, x: event.clientX, y: event.clientY });
  };

  const info = badge ? badgeOf(badge) : null;

  return (
    <>
      <div
        className={`git-tree-row ${selectedPath === relativePath ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => void toggle()}
        onContextMenu={handleContextMenu}
        title={relativePath}
      >
        <span className="git-tree-caret">
          {entry.type === "folder" ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
        </span>
        {entry.type === "folder" ? <FolderOpen size={13} /> : <File size={13} />}
        <span className="git-tree-name">{entry.name}</span>
        {info && <span className={`git-tree-badge ${info.tone}`}>{info.text}</span>}
      </div>
      {expanded && children.map((child) => (
        <TreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          repoRoot={repoRoot}
          changes={changes}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          onPreviewFile={onPreviewFile}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  );
}
