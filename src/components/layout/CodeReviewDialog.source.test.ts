import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import dialogSource from "./CodeReviewDialog.tsx?raw";

const chatPanelStyles = readFileSync(
  resolve(process.cwd(), "src/components/layout/ChatPanel.css"),
  "utf8",
);

describe("code review dialog", () => {
  it("renders at the document level through a portal", () => {
    expect(dialogSource).toContain('import { createPortal } from "react-dom"');
    expect(dialogSource).toContain("document.body");
  });

  it("closes on Escape", () => {
    expect(dialogSource).toContain('event.key === "Escape"');
    expect(dialogSource).toContain("onClose()");
  });

  it("offers both split and unified view modes with a shared parser", () => {
    expect(dialogSource).toContain('"split"');
    expect(dialogSource).toContain('"unified"');
    expect(dialogSource).toContain("setViewMode(");
    expect(dialogSource).toContain("chat-review-split");
    expect(dialogSource).toContain("chat-review-unified");
  });

  it("defaults to unified view", () => {
    // 上面那条只证明「两个模式都有」，管不住默认值；这里单独钉住。
    expect(dialogSource).toContain(
      "useState<ReviewViewMode>(getStoredReviewViewMode)",
    );
    // 并排视图仍然可达，但由用户主动选择。
    expect(dialogSource).toContain('handleViewModeChange("split")');
  });

  it("persists and restores the user's selected view mode", () => {
    expect(dialogSource).toContain('CODE_REVIEW_VIEW_MODE_STORAGE_KEY = "hpp.codeReview.viewMode"');
    expect(dialogSource).toContain("window.localStorage.getItem(CODE_REVIEW_VIEW_MODE_STORAGE_KEY)");
    expect(dialogSource).toContain("window.localStorage.setItem(CODE_REVIEW_VIEW_MODE_STORAGE_KEY, viewMode)");
    // 打开 review 时不能再强制 setViewMode("split") 覆盖用户选择。
    expect(dialogSource).not.toContain('setViewMode("split")');
    expect(dialogSource).not.toContain('setViewMode("unified")');
  });

  it("renders a full-screen overlay above the chat area", () => {
    const overlay = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-review-overlay"),
      chatPanelStyles.indexOf(".chat-review-dialog {"),
    );
    expect(overlay).toContain("position: fixed");
    expect(overlay).toContain("inset: 0");
    expect(overlay).toContain("z-index: 2000");
  });

  it("uses the editor surface background for the review dialog", () => {
    const dialog = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-review-dialog {"),
      chatPanelStyles.indexOf(".chat-review-header {"),
    );
    expect(dialog).toContain("background-color: var(--bg-secondary)");
    expect(dialog).not.toContain("var(--diff-popover-bg)");
    // 弹窗内的 diff 背景（文件栏/代码区）与编辑器代码背景保持一致，
    // 而不是全局 --diff-bg 的深黑（暗色 #171717）。
    expect(dialog).toContain("--diff-bg: var(--bg-secondary)");
    expect(dialog).toContain(':root[data-theme="light"] .chat-review-dialog');
    expect(dialog).toContain("--diff-bg: #ffffff");
  });

  it("lets the file list collapse to give the diff more room", () => {
    expect(dialogSource).toContain("filesCollapsed");
    expect(chatPanelStyles).toContain(".chat-review-files.collapsed");
  });

  it("lets the file list resize from its right edge", () => {
    expect(dialogSource).toContain("handleFilesResizeStart");
    expect(dialogSource).toContain("handleFilesResizeKeyDown");
    expect(dialogSource).toContain('className="chat-review-files-resizer"');
    expect(dialogSource).toContain('role="separator"');
    expect(chatPanelStyles).toContain("cursor: col-resize");
    expect(chatPanelStyles).toContain(".chat-review-files.resizing");
  });

  it("keeps the diff content large and the chrome compact", () => {
    expect(chatPanelStyles).toContain(".chat-review-files {");
    expect(chatPanelStyles).toContain("flex: 0 0 220px");
    expect(chatPanelStyles).toContain(".chat-review-split {");
    expect(chatPanelStyles).toContain("font-size: 14px");
  });

  it("does not overflow horizontally: no min-width: max-content, long lines wrap", () => {
    expect(chatPanelStyles).not.toContain("chat-review-split {\n  display: flex;\n  flex-direction: column;\n  min-width: max-content");
    expect(chatPanelStyles).not.toContain("chat-review-unified {\n  display: flex;\n  flex-direction: column;\n  min-width: max-content");
    const codeRule = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-review-code {"),
      chatPanelStyles.indexOf(".chat-review-code-empty"),
    );
    expect(codeRule).toContain("white-space: pre-wrap");
    expect(codeRule).toContain("overflow-wrap: anywhere");
  });

  it("shows the full file by restoring content through the patch", () => {
    expect(dialogSource).toContain("buildFullFileDiff");
    expect(dialogSource).toContain("readFile");
    expect(dialogSource).toContain("linesToPairs");
  });

  it("routes file and all undo through one versioned review transaction", () => {
    expect(dialogSource).toContain("window.electronAPI.prepareReviewUndo({");
    expect(dialogSource).toContain("window.electronAPI.applyReviewUndo(");
    expect(dialogSource).toContain('{ kind: "file", file: active.file }');
    expect(dialogSource).toContain('void applyUndo({ kind: "all" }, "all")');
    expect(dialogSource).not.toContain("reverseApplyPatch(");
    expect(dialogSource).not.toContain("rebuildReviewFile(");
  });

  it("reverts a canonical change point through the same transaction", () => {
    expect(dialogSource).toContain('{ kind: "hunk", file: active.file, hunkIndex, changeIndex }');
    expect(dialogSource).toContain("reviewState.transactionId");
    expect(dialogSource).toContain("reviewState.version");
    expect(dialogSource).not.toContain("revertedBefore");
    expect(dialogSource).not.toContain("revertedAfter");
  });

  it("renders the undo button per change point, not per hunk", () => {
    // git 会把间距小于上下文窗口的多处修改合并成一个 hunk；按钮若只挂在 hunk
    // 首行（可能是上下文行），用户悬停在实际改动行上永远看不到按钮，且撤销
    // 粒度被迫扩大到整个 hunk。按钮必须挂在每个修改点（changeStart）的首个增删行上。
    expect(dialogSource).toContain("pair.changeIdx");
    expect(dialogSource).toContain("pair.changeStart");
    expect(dialogSource).toContain("pair.hunkIdx");
    expect(dialogSource).toContain("renderUndoButton");
    expect(dialogSource).not.toContain("pair.hunkStart");
    expect(dialogSource).not.toContain("hunkStartMap.get(index)");
    expect(dialogSource).not.toContain("hunkStartMap");
    expect(dialogSource).not.toContain("parsePatchHunks(active.patch)");
  });

  it("keeps canonical hunk fields and derives the reverted state from the transaction", () => {
    expect(dialogSource).toContain("const fileReverted = !!active?.reverted;");
    expect(dialogSource).toContain("if (pair.hunkIdx !== undefined) entry.hunkIdx = pair.hunkIdx;");
    expect(dialogSource).toContain("if (pair.changeIdx !== undefined) entry.changeIdx = pair.changeIdx;");
    expect(dialogSource).toContain("if (pair.changeStart) entry.changeStart = true;");
  });

  it("serializes every undo command and disables all undo controls while busy", () => {
    expect(dialogSource).toContain("activeOperationRef.current");
    expect(dialogSource).toContain("const undoBusy = preparingUndo || undoingKey !== null;");
    expect(dialogSource).toContain("disabled={undoBusy || !reviewState?.canUndoAll}");
    expect(dialogSource).toContain("disabled={undoBusy}");
  });

  it("ignores async results from an obsolete review generation", () => {
    expect(dialogSource).toContain("reviewGenerationRef.current += 1;");
    expect(dialogSource).toContain("reviewGenerationRef.current !== generation");
    expect(dialogSource).toContain("const isCurrentOperation = () =>");
    expect(dialogSource).toContain("setFileContent({});");
    expect(dialogSource).toContain("loadedRef.current.clear()");
  });

  it("reloads canonical content after each committed review version", () => {
    expect(dialogSource).toContain("reviewState?.version ?? -1");
    expect(dialogSource).toContain("[open, active, projectPath, reviewState?.version]");
    expect(dialogSource).toContain("setReviewState(result.state)");
    expect(dialogSource).toContain("prepared.patch");
  });

  it("navigates between diff points from the header toolbar", () => {
    expect(dialogSource).toContain("goNextDiff");
    expect(dialogSource).toContain("goPrevDiff");
    // 使用 container.scrollTo 手动居中（无平滑动画）定位到修改点。
    expect(dialogSource).toContain("container.scrollTo");
    expect(dialogSource).toContain("data-review-diff-index");
    expect(dialogSource).toContain("chat-review-nav");
  });

  it("keeps the diff navigation buttons usable when there is exactly one change point", () => {
    // 单修改点（如纯新增的新文件或单 hunk 插入）时，totalDiffs===1，
    // 两个按钮都不应禁用：点击后仍能 scrollToDiff 重新定位到唯一修改点。
    expect(dialogSource).toContain(
      "disabled={totalDiffs === 0 || (totalDiffs > 1 && diffCursor <= 0)}",
    );
    expect(dialogSource).toContain(
      "disabled={totalDiffs === 0 || (totalDiffs > 1 && diffCursor >= totalDiffs - 1)}",
    );
    // 点击逻辑本身对 totalDiffs===1 天然安全：next 被夹到 0，prev 被夹到 0。
    expect(dialogSource).toContain("Math.min(totalDiffs - 1, diffCursor + 1)");
    expect(dialogSource).toContain("Math.max(0, diffCursor - 1)");
  });

  it("merges consecutive diff lines into one navigation point", () => {
    expect(dialogSource).toContain("prevIsDiff");
    expect(dialogSource).toContain("if (isDiff && !prevIsDiff)");
  });

  it("keeps the left column as the clean original file and concentrates changes on the right", () => {
    expect(dialogSource).toContain("chat-review-col left");
    expect(dialogSource).toContain("chat-review-col right");
    // 虚拟行分别渲染左右 cell，左列只读取 pair.left，不依赖右列内容。
    expect(dialogSource).toContain('side === "left"');
    expect(dialogSource).toContain('pair.left');
    expect(chatPanelStyles).toContain(".chat-review-col.right .chat-review-col-line.del");
  });

  it("only the right column reacts to the deleted-lines toggle, the left stays untouched", () => {
    expect(dialogSource).toContain("showDeletedInRight");
    expect(dialogSource).toContain("EyeOff");
    expect(dialogSource).toContain("aria-pressed={showDeletedInRight}");
    // 虚拟行中右列仅在开关开启时复用被删除的左侧 cell。
    expect(dialogSource).toContain("showDeletedInRight && pair.left?.cell.type === \"del\"");
    expect(dialogSource).toContain("chat-review-split-row");
    expect(chatPanelStyles).toContain(".chat-review-split-row");
    expect(chatPanelStyles).toContain(".chat-review-col-line");
  });

  it("keys virtual rows by index, never by line number", () => {
    // 行号不是唯一标识：同一份补丁里旧行号与新行号会撞车（换位、多补丁合并时尤其常见）。
    // 重复 key 会让 React 把多行渲染到同一个 transform 上，同一行的文字叠在一起。
    expect(dialogSource).toContain("getItemKey: (index) => index");
    expect(dialogSource).not.toContain("cell.lineNo || pairs[index]");
  });

  it("preselects the file passed in via initialFile", () => {
    expect(dialogSource).toContain("initialFile");
    expect(dialogSource).toContain("file.displayFile === activeFileKey || file.file === activeFileKey");
    expect(dialogSource).toContain("setActiveFileKey(initialFile ?? null)");
  });

  it("scrolls to the first change point by default when a file is shown", () => {
    expect(dialogSource).toContain("scrolledRef");
    expect(dialogSource).toContain("scrollToDiff(cursor,");
    // useLayoutEffect：commit 后、paint 前同步定位，无帧延迟、无闪烁。
    expect(dialogSource).toContain("useLayoutEffect");
    expect(dialogSource).not.toContain("requestAnimationFrame(() => {");
    // 打开瞬间用补丁行对立即定位，不等文件内容读取完成；内容就绪后平滑过渡。
    expect(dialogSource).toContain("contentReady");
    expect(dialogSource).toContain("scrollToDiff(cursor, !isFirst && contentReady)");
    // 重新打开同一文件也会再次定位：依赖含 open，且打开时重置 scrolledRef。
    expect(dialogSource).toContain("if (!open || !active || pairs === null) return;");
    expect(dialogSource).toContain(
      "[open, active, pairs, diffPairIndices, fileContent, diffCursor]",
    );
  });
});
