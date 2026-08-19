import { describe, expect, it } from "vitest";
import { buildDiffSummary, collectProcessDiffs } from "./diff-summary";

describe("shared diff summary", () => {
  it("normalizes project paths, deduplicates patches, and merges file totals", () => {
    const patch = "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new";
    const summary = buildDiffSummary([
      { file: "C:\\repo\\src\\a.ts", patch, additions: 1, deletions: 1 },
      { file: "C:/repo/src/a.ts", patch, additions: 1, deletions: 1 },
    ], "C:/repo");
    expect(summary.files).toEqual([{ file: "src/a.ts", patches: [patch], additions: 1, deletions: 1 }]);
    expect(summary.reversiblePatches).toEqual([patch]);
  });

  it("keeps reversible patches in chronological order even when file summaries are sorted", () => {
    const secondFileFirst = "--- a/src/z.ts\n+++ b/src/z.ts\n-old-z\n+new-z";
    const firstFileSecond = "--- a/src/a.ts\n+++ b/src/a.ts\n-old-a\n+new-a";
    const summary = buildDiffSummary([
      { file: "src/z.ts", patch: secondFileFirst },
      { file: "src/a.ts", patch: firstFileSecond },
      { file: "src/z.ts", patch: secondFileFirst },
    ]);
    expect(summary.files.map((file) => file.file)).toEqual(["src/a.ts", "src/z.ts"]);
    expect(summary.reversiblePatches).toEqual([secondFileFirst, firstFileSecond]);
  });

  it("collects process file changes once by change key", () => {
    const result = collectProcessDiffs({ entries: [{
      id: "edit",
      files: [
        { file: "src/a.ts", action: "edited", additions: 2, changeKey: "a" },
        { file: "src/a.ts", action: "edited", additions: 2, changeKey: "a" },
      ],
    }] });
    expect(result).toEqual([{ file: "src/a.ts", patch: "", additions: 2, deletions: 0, status: "modified" }]);
  });

  it("does not render empty file-change cards", () => {
    expect(buildDiffSummary([
      { file: "src/unchanged.ts", additions: 0, deletions: 0, status: "modified" },
    ]).files).toEqual([]);
  });
});
