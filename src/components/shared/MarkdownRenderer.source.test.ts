import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve("src/components/shared/MarkdownRenderer.css"), "utf8");

describe("MarkdownRenderer code block layout", () => {
  it("shrinks short code blocks to their content while keeping long blocks bounded", () => {
    const blockStyles = styles.slice(
      styles.indexOf(".md-content .md-code-block {"),
      styles.indexOf(".md-content .md-code-block pre {"),
    );
    expect(blockStyles).toContain("width: fit-content");
    expect(blockStyles).toContain("min-width: min(240px, 100%)");
    expect(blockStyles).toContain("max-width: 100%");
  });

  it("reserves room for language and copy controls without forcing full width", () => {
    expect(styles).toContain(".md-content .md-code-header");
    expect(styles).toContain("padding: 6px 12px 0 12px");
    expect(styles).toContain("justify-content: space-between");
    expect(styles).toContain(".md-content .md-code-copy-btn");
    expect(styles).toContain("width: 28px");
    expect(styles).toContain("height: 28px");
    expect(styles).toContain("position: static");
  });

  it("keeps long code lines inside the code block scroll container", () => {
    const contentStyles = styles.slice(
      styles.indexOf(".md-content {"),
      styles.indexOf("/* --- Headings --- */"),
    );
    const preStyles = styles.slice(
      styles.indexOf(".md-content .md-code-block pre {"),
      styles.indexOf(".md-content .md-code-block pre code {"),
    );
    expect(contentStyles).toContain("min-width: 0");
    expect(contentStyles).toContain("max-width: 100%");
    expect(preStyles).toContain("min-width: 0");
    expect(preStyles).toContain("max-width: 100%");
    expect(preStyles).toContain("overflow-x: auto");
    expect(preStyles).toContain("padding: 0");
  });
});
