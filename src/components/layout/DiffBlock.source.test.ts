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

  it("opens the review dialog with the clicked file preselected", () => {
    expect(diffBlockSource).toContain("reviewInitialFile");
    expect(diffBlockSource).toContain("setReviewInitialFile(file.file)");
    expect(diffBlockSource).toContain("setReviewOpen(true)");
    expect(diffBlockSource).toContain('aria-haspopup="dialog"');
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
