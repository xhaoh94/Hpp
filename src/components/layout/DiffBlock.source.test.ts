import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import diffBlockSource from "./DiffBlock.tsx?raw";

const chatPanelStyles = readFileSync(
  resolve(process.cwd(), "src/components/layout/ChatPanel.css"),
  "utf8",
);

describe("diff popover viewport constraints", () => {
  it("renders the popover at the document level", () => {
    expect(diffBlockSource).toContain('import { createPortal } from "react-dom"');
    expect(diffBlockSource).toContain("document.body");
  });

  it("keeps the popover inside the visible application area", () => {
    const backdrop = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-diff-popover-backdrop"),
      chatPanelStyles.indexOf(".chat-diff-popover-header"),
    );
    expect(backdrop).toContain("position: fixed");
    expect(backdrop).toContain("inset: 32px 0 0");
    expect(backdrop).toContain("max-width: 100%");
    expect(backdrop).toContain("max-height: 100%");
    expect(backdrop).toContain("overflow: hidden");
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
