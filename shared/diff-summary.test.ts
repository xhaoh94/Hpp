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
});
