import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import diffBlockSource from "./DiffBlock.tsx?raw";

const chatPanelStyles = readFileSync(
  resolve(process.cwd(), "src/components/layout/ChatPanel.css"),
  "utf8",
);

describe("diff block viewport constraints", () => {
  it("adds an audit button and mounts the full-screen review dialog", () => {
    expect(diffBlockSource).toContain('className="chat-diff-review-btn"');
    expect(diffBlockSource).toContain("ScanSearch");
    expect(diffBlockSource).toContain("<CodeReviewDialog");
    expect(diffBlockSource).toContain("reviewOpen");
    expect(diffBlockSource).toContain("initialFile");
  });

  it("opens the file preview (not the review dialog) when a file row is clicked", () => {
    expect(diffBlockSource).toContain("FilePreview");
    expect(diffBlockSource).toContain("setPreviewFile(");
    expect(diffBlockSource).toContain("filePath={previewFile}");
    expect(diffBlockSource).toContain('aria-haspopup="dialog"');
    // 点击文件不再直接弹审核弹窗；审核弹窗只由「审核」按钮触发。
    expect(diffBlockSource).not.toContain("setReviewInitialFile(file.file)");
  });

  it("keeps the audit button as the only entry to the review dialog", () => {
    expect(diffBlockSource).toContain('className="chat-diff-review-btn"');
    expect(diffBlockSource).toContain("ScanSearch");
    expect(diffBlockSource).toContain("<CodeReviewDialog");
    expect(diffBlockSource).toContain("setReviewOpen(true)");
    expect(diffBlockSource).toContain("reviewInitialFile");
  });

  it("uses the message id as the stable persisted review identity", () => {
    expect(diffBlockSource).toContain("reviewId: string");
    expect(diffBlockSource).toContain("reviewId={reviewId}");
    expect(diffBlockSource).toContain("window.electronAPI.loadReviewUndo({");
    expect(diffBlockSource).toContain("onUndoStateChange={setUndoState}");
    expect(diffBlockSource).not.toContain("reverseApplyPatch");
  });

  it("notifies the virtualized owner while the review dialog is open", () => {
    expect(diffBlockSource).toContain("onOpenChange?: (open: boolean) => void");
    expect(diffBlockSource).toContain("onOpenChange?.(reviewOpen)");
  });

  it("keeps the desktop summary header as compact as one visible file item", () => {
    const header = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-diff-card-header"),
      chatPanelStyles.indexOf(".chat-diff-icon-box"),
    );
    expect(header).toContain("min-height: 44px");
    expect(header).toContain("padding: 2px 16px");
    expect(chatPanelStyles).toContain(".chat-diff-file-list {");
    expect(chatPanelStyles).toContain("padding: 8px 0;");
    expect(chatPanelStyles).toContain("min-height: 28px;");
  });

  it("does not let a failed undo preparation erase the real change counts", () => {
    // 撤销状态在「准备失败」时带的是占位 0/0（rebuild-file buildState 的 error 分支）。
    // 若直接拿它覆盖，卡片会把 +4 -4 显示成 +0 -0 —— 把「无法安全撤销」
    // 误渲染成「没有改动」。有 error 时必须保留原始 diff 数据。
    expect(diffBlockSource).toContain("if (!undoFile || undoFile.error) return file;");
    expect(diffBlockSource).toContain("additions: undoFile.additions");
    expect(diffBlockSource).toContain("deletions: undoFile.deletions");
  });

  it("keeps the edited-file title and totals on one line", () => {
    const titleGroup = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-diff-title-group"),
      chatPanelStyles.indexOf(".chat-diff-title {"),
    );
    const totals = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-diff-total-stats"),
      chatPanelStyles.indexOf(".chat-diff-revert-btn"),
    );
    expect(titleGroup).toContain("display: flex");
    expect(titleGroup).toContain("align-items: center");
    expect(titleGroup).toContain("gap: 6px");
    expect(totals).toContain("margin-top: 0");
  });
});
