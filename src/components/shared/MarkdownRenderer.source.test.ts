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
    expect(styles).toContain("padding: 14px 52px 14px 16px");
    expect(styles).toContain(".md-content .md-code-block:has(.md-code-lang) pre");
    expect(styles).toContain("padding-right: 96px");
  });
});
