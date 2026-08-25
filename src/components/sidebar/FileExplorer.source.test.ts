import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = () => readFileSync(
  resolve(process.cwd(), "src/components/sidebar/FileExplorer.tsx"),
  "utf8",
);

const readStyles = () => readFileSync(
  resolve(process.cwd(), "src/components/sidebar/FileTree.css"),
  "utf8",
);

describe("file explorer tree commands", () => {
  it("provides a recursive collapse-all control", () => {
    const source = readSource();

    expect(source).toContain('aria-label="收起全部目录"');
    expect(source).not.toContain('aria-label="展开全部目录"');
    expect(source).toContain("collapseAllFolders");
    expect(source).toContain("<CopyMinus");
    expect(source).toContain("treeCommand.handledPaths.has(entry.path)");
    expect(source).toContain("treeCommand.handledPaths.add(entry.path)");
    expect(source).toContain("treeCommand={treeCommand}");
    expect(source).toContain("treeCommand={activeTreeCommand}");
  });

  it("keeps loaded descendants mounted when a folder is manually collapsed", () => {
    const source = readSource();
    const styles = readStyles();

    expect(source).toContain("{children.length > 0 && (");
    expect(source).toContain('className="file-tree-children" hidden={!expanded}');
    expect(source).not.toContain("{expanded && children.length > 0 && (");
    expect(styles).toContain(".file-tree-children[hidden]");
    expect(styles).toContain("display: none");
  });

  it("uses only disclosure triangles for collapsed and expanded folders", () => {
    const source = readSource();
    const treeItemSource = source.slice(
      source.indexOf("const FileTreeItem"),
      source.indexOf("export function FileExplorer"),
    );
    const styles = readStyles();

    expect(treeItemSource).toContain("<ChevronRight");
    expect(treeItemSource).toContain("<ChevronDown");
    expect(treeItemSource).not.toContain("<FolderOpen");
    expect(treeItemSource).not.toContain("<Folder size=");
    expect(treeItemSource).not.toContain("<LoaderCircle");
    expect(source).toContain('{entry.type === "file" && (');
    expect(source).toContain('data-expanded={entry.type === "folder" ? String(expanded) : undefined}');
    expect(styles).toContain('.file-tree-item[data-expanded="true"] .file-tree-disclosure');
    expect(styles).not.toContain(".file-icon-folder");
    expect(styles).not.toContain(".file-tree-folder-loading");
  });

  it("centers revealed files and opens requested previews", () => {
    const source = readSource();
    const styles = readStyles();

    expect(source).toContain('scrollIntoView({ block: "center", inline: "nearest" })');
    expect(source).toContain("centeredRevealRequestIdRef");
    expect(source).toContain("onClaimRevealCenter(revealRequestId)");
    expect(source).toContain("[isHighlighted, onClaimRevealCenter, revealRequest?.requestId]");
    expect(source).not.toContain("[isHighlighted, loadingFolder, revealRequest?.requestId]");
    expect(source).toContain("useEditorStore.getState().openFile(revealRequest.path)");
    expect(source).toContain("setPreviewFile(revealRequest.path)");
    expect(source).toContain("setPreviewFile(null)");
    expect(styles).not.toContain(".file-tree-content::after");
    expect(styles).not.toContain("height: calc(50% - 12px)");
  });

  it("uses the shared relevance ranking for explorer searches", () => {
    const source = readSource();

    expect(source).toContain("queryProjectFileIndex({");
    expect(source).toContain("FILE_EXPLORER_SEARCH_DEBOUNCE_MS = 100");
    expect(source).toContain("signal.aborted");
    expect(source).not.toContain("window.electronAPI.searchFiles");
    expect(source).toContain('type: item.isDirectory ? "folder" : "file"');
  });

  it("refreshes the root, expanded descendants, and active search results", () => {
    const source = readSource();

    expect(source).toContain('mode: "collapse" | "refresh"');
    expect(source).toContain('mode: "refresh"');
    expect(source).toContain("childrenLoadedRef.current = false");
    expect(source).toContain("loadChildren(true)");
    expect(source).toContain("setRefreshVersion((current) => current + 1)");
    expect(source).toContain("refreshVersion");
    expect(source).toContain("invalidateProjectFileIndex(activeProject.path, filters)");
  });

  it("watches the project only while the visible file explorer is open", () => {
    const source = readSource();

    expect(source).toContain('const explorerVisible = sidebarTab === "files" && !sidebarCollapsed');
    expect(source).toContain("onFileSystemChange");
    expect(source).toContain("watchPath(projectPath, true)");
    expect(source).toContain("unwatchPath(projectPath, true)");
    expect(source).toContain("startFallbackPolling");
    expect(source).toContain("[activeProject?.path, explorerVisible, filterKey]");
  });

  it("portals the right-click menu to the body so collapsed sidebar styles can't occlude it", () => {
    const source = readSource();

    expect(source).toContain('import { createPortal } from "react-dom"');
    expect(source).toContain("createPortal(");
    expect(source).toContain("document.body");
    expect(source).toContain('className="file-tree-context-menu"');
  });

  it("exposes a copy-name entry that copies just the file basename", () => {
    const source = readSource();

    expect(source).toContain("复制名字");
    expect(source).toContain("entry.name");
    expect(source).toContain("copyName(");
    expect(source).toContain("<Copy");
    expect(source).toContain("已复制名字");
  });
});
