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

  it("uses distinct disclosure and folder icons for collapsed and expanded states", () => {
    const source = readSource();
    const styles = readStyles();

    expect(source).toContain("<ChevronRight");
    expect(source).toContain("<ChevronDown");
    expect(source).toContain("<FolderOpen");
    expect(source).toContain("<Folder size=");
    expect(source).toContain('data-expanded={entry.type === "folder" ? String(expanded) : undefined}');
    expect(styles).toContain('.file-tree-item[data-expanded="true"] .file-tree-disclosure');
  });

  it("centers revealed files and opens requested previews", () => {
    const source = readSource();
    const styles = readStyles();

    expect(source).toContain('scrollIntoView({ block: "center", inline: "nearest" })');
    expect(source).toContain("centeredRevealRequestIdRef");
    expect(source).toContain("onClaimRevealCenter(revealRequestId)");
    expect(source).toContain("[isHighlighted, onClaimRevealCenter, revealRequest?.requestId]");
    expect(source).not.toContain("[isHighlighted, loadingFolder, revealRequest?.requestId]");
    expect(source).toContain("setPreviewFile(revealRequest.preview ? revealRequest.path : null)");
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
});
