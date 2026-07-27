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
});
