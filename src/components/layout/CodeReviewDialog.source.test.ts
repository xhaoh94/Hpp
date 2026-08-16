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

  it("renders a full-screen overlay above the chat area", () => {
    const overlay = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-review-overlay"),
      chatPanelStyles.indexOf(".chat-review-dialog {"),
    );
    expect(overlay).toContain("position: fixed");
    expect(overlay).toContain("inset: 32px 0 0");
    expect(overlay).toContain("z-index: 2000");
  });

  it("lets the file list collapse to give the diff more room", () => {
    expect(dialogSource).toContain("filesCollapsed");
    expect(chatPanelStyles).toContain(".chat-review-files.collapsed");
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

  it("navigates between diff points from the header toolbar", () => {
    expect(dialogSource).toContain("goNextDiff");
    expect(dialogSource).toContain("goPrevDiff");
    expect(dialogSource).toContain("scrollIntoView");
    expect(dialogSource).toContain("data-review-diff-index");
    expect(dialogSource).toContain("chat-review-nav");
  });

  it("merges consecutive diff lines into one navigation point", () => {
    expect(dialogSource).toContain("prevIsDiff");
    expect(dialogSource).toContain("if (isDiff && !prevIsDiff)");
  });

  it("keeps the left column as the clean original file and concentrates changes on the right", () => {
    expect(dialogSource).toContain("chat-review-col left");
    expect(dialogSource).toContain("chat-review-col right");
    // 左列只渲染原文件行，不含任何右栏判断。
    expect(dialogSource).toContain("if (!pair.left) return null");
    expect(chatPanelStyles).toContain(".chat-review-col.right .chat-review-col-line.del");
  });

  it("only the right column reacts to the deleted-lines toggle, the left stays untouched", () => {
    expect(dialogSource).toContain("showDeletedInRight");
    expect(dialogSource).toContain("EyeOff");
    expect(dialogSource).toContain("aria-pressed={showDeletedInRight}");
    // 右列：仅在开关开启时额外显示被删除的行，否则紧凑跳过。
    expect(dialogSource).toContain("showDeletedInRight && !pair.right");
    expect(dialogSource).toContain("if (!pair.right && !showDeleted) return null");
    expect(dialogSource).toContain("chat-review-split-cols");
    expect(chatPanelStyles).toContain(".chat-review-split-cols");
    expect(chatPanelStyles).toContain(".chat-review-col-line");
  });

  it("preselects the file passed in via initialFile", () => {
    expect(dialogSource).toContain("initialFile");
    expect(dialogSource).toContain("file.displayFile === activeFileKey || file.file === activeFileKey");
    expect(dialogSource).toContain("setActiveFileKey(initialFile ?? null)");
  });

  it("scrolls to the first change point by default when a file is shown", () => {
    expect(dialogSource).toContain("scrolledRef");
    expect(dialogSource).toContain("scrollToDiff(0)");
    expect(dialogSource).toContain("requestAnimationFrame");
  });
});
