import { describe, expect, it } from "vitest";
import {
  DIFF_HOVER_PREVIEW_MAX_LINES,
  buildDiffPreviewLines,
  classifyDiffPreviewLine,
} from "@/lib/diff-hover-preview";

describe("classifyDiffPreviewLine", () => {
  it("treats hunk and file headers as headers, not as add/del lines", () => {
    expect(classifyDiffPreviewLine("@@ -1,3 +1,4 @@")).toBe("header");
    expect(classifyDiffPreviewLine("diff --git a/a.ts b/a.ts")).toBe("header");
    expect(classifyDiffPreviewLine("--- a/a.ts")).toBe("header");
    expect(classifyDiffPreviewLine("+++ b/a.ts")).toBe("header");
  });

  it("classifies added, deleted and context lines", () => {
    expect(classifyDiffPreviewLine("+const a = 1;")).toBe("add");
    expect(classifyDiffPreviewLine("-const a = 1;")).toBe("del");
    expect(classifyDiffPreviewLine(" const a = 1;")).toBe("context");
    expect(classifyDiffPreviewLine("")).toBe("context");
    // 只有行首的 +/- 才代表改动；行内出现不算。
    expect(classifyDiffPreviewLine("const a = 1; // +1")).toBe("context");
  });
});

describe("buildDiffPreviewLines", () => {
  it("joins every patch of one file and drops trailing blank lines", () => {
    const { lines, hiddenCount } = buildDiffPreviewLines([
      "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      "--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-a\n+b\n",
    ]);
    expect(lines.map((line) => line.text)).toEqual([
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ]);
    expect(hiddenCount).toBe(0);
  });

  it("caps huge patches and reports how many lines were left out", () => {
    const patch = Array.from({ length: 20 }, (_, index) => `+line ${index}`).join("\n");
    const { lines, hiddenCount } = buildDiffPreviewLines([patch], 5);
    expect(lines).toHaveLength(5);
    expect(hiddenCount).toBe(15);
    expect(DIFF_HOVER_PREVIEW_MAX_LINES).toBeGreaterThan(0);
  });

  it("returns nothing for an empty patch", () => {
    expect(buildDiffPreviewLines([])).toEqual({ lines: [], hiddenCount: 0 });
    expect(buildDiffPreviewLines([""])).toEqual({ lines: [], hiddenCount: 0 });
  });
});
