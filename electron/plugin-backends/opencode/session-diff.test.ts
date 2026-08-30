import { describe, expect, it } from "vitest";
import { applyPatch } from "diff";
import { createOpenCodeUnifiedPatch, normalizeOpenCodeSessionDiffs } from "./session-diff";

describe("OpenCode session diff normalization", () => {
  it("converts before/after contents into a reusable unified patch", () => {
    const before = "one\ntwo\nthree\n";
    const after = "one\nchanged\nthree\n";
    const [diff] = normalizeOpenCodeSessionDiffs([{
      file: "src/app.ts",
      before,
      after,
      additions: 1,
      deletions: 1,
    }]);

    expect(diff).toMatchObject({
      file: "src/app.ts",
      additions: 1,
      deletions: 1,
      status: "modified",
      statusExplicit: false,
    });
    expect(diff.patch).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(diff.patch).toContain("@@ -1,3 +1,3 @@");
    expect(diff.patch).toContain("-two\n+changed");
    expect(applyPatch(before, diff.patch)).toBe(after);
  });

  it("accepts the native SnapshotFileDiff schema used by OpenCode 1.18", () => {
    const nativePatch = [
      "Index: src/app.ts",
      "===================================================================",
      "--- src/app.ts\t",
      "+++ src/app.ts\t",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");
    expect(normalizeOpenCodeSessionDiffs([{
      file: "src/app.ts",
      patch: nativePatch,
      additions: 1,
      deletions: 1,
      status: "modified",
    }])).toEqual([expect.objectContaining({
      file: "src/app.ts",
      patch: expect.stringContaining("diff --git a/src/app.ts b/src/app.ts"),
      additions: 1,
      deletions: 1,
      status: "modified",
    })]);
  });

  it("preserves CR bytes in provider patches for CRLF files (undo regression)", () => {
    // provider 对 CRLF 文件生成的补丁，hunk 行尾天然携带 \r（内容的一部分）。
    // 撤销引擎用 git apply 逐字节匹配，任何行尾归一化都会让补丁全军覆没。
    const nativePatch = [
      "Index: src/app.ts",
      "===================================================================",
      "--- src/app.ts\t",
      "+++ src/app.ts\t",
      "@@ -1,2 +1,2 @@",
      " one\r",
      "-two\r",
      "+two改\r",
      " three\r",
    ].join("\n");
    const [diff] = normalizeOpenCodeSessionDiffs([{
      file: "src/app.ts",
      patch: nativePatch,
      additions: 1,
      deletions: 1,
      status: "modified",
    }]);
    expect(diff).toBeDefined();
    expect(diff.patch).toContain("-two\r\n+two改");
    expect(diff.patch).toContain(" one\r\n");
  });

  it("uses lifecycle metadata only when OpenCode reports it explicitly", () => {
    const addedPatch = [
      "Index: new.txt",
      "===================================================================",
      "--- new.txt\t",
      "+++ new.txt\t",
      "@@ -0,0 +1,1 @@",
      "+created",
    ].join("\n");
    expect(normalizeOpenCodeSessionDiffs([{
      file: "new.txt",
      patch: addedPatch,
      additions: 1,
      deletions: 0,
      status: "added",
    }])[0]).toMatchObject({ status: "added", statusExplicit: true });
    expect(normalizeOpenCodeSessionDiffs([{
      file: "new.txt",
      patch: addedPatch,
      additions: 1,
      deletions: 0,
      status: "added",
    }])[0].patch).toContain("new file mode 100644\n--- /dev/null\n+++ b/new.txt");

    const nativeAddedPatch = "--- /dev/null\n+++ new.txt\n@@ -0,0 +1 @@\n+created";
    expect(normalizeOpenCodeSessionDiffs([{ file: "new.txt", patch: nativeAddedPatch }])).toEqual([]);
    expect(normalizeOpenCodeSessionDiffs([{ file: "new.txt", patch: nativeAddedPatch, status: "modified" }])).toEqual([]);

    const ambiguous = normalizeOpenCodeSessionDiffs([
      { file: "existing-empty.txt", before: "", after: "created\n", additions: 1, deletions: 0 },
      { file: "truncated.txt", before: "removed\n", after: "", additions: 0, deletions: 1 },
    ]);
    expect(ambiguous).toEqual([
      expect.objectContaining({ status: "modified", statusExplicit: false }),
      expect.objectContaining({ status: "modified", statusExplicit: false }),
    ]);
    expect(ambiguous[0].patch).toContain("--- a/existing-empty.txt\n+++ b/existing-empty.txt");
    expect(ambiguous[1].patch).toContain("--- a/truncated.txt\n+++ b/truncated.txt");
  });

  it("accepts top-level a/b directories and Git-octal quoted Unicode paths", () => {
    const aPatch = "Index: a/app.ts\n===\n--- a/app.ts\n+++ a/app.ts\n@@ -1 +1 @@\n-old\n+new";
    const unicodePatch = 'Index: "\\347\\233\\256\\345\\275\\225/file.txt"\n===\n--- "\\347\\233\\256\\345\\275\\225/file.txt"\n+++ "\\347\\233\\256\\345\\275\\225/file.txt"\n@@ -1 +1 @@\n-old\n+new';
    expect(normalizeOpenCodeSessionDiffs([
      { file: "a/app.ts", patch: aPatch, additions: 1, deletions: 1 },
      { file: "目录/file.txt", patch: unicodePatch, additions: 1, deletions: 1 },
    ]).map((diff) => diff.file)).toEqual(["a/app.ts", "目录/file.txt"]);
  });

  it("rejects native patches whose path does not match the declared file", () => {
    const patch = "Index: other.txt\n===\n--- other.txt\n+++ other.txt\n@@ -1 +1 @@\n-a\n+b";
    expect(normalizeOpenCodeSessionDiffs([{
      file: "target.txt",
      patch,
      additions: 1,
      deletions: 1,
    }])).toEqual([]);
  });

  it("marks created and deleted files explicitly when status is present", () => {
    const diffs = normalizeOpenCodeSessionDiffs([
      { file: "new.txt", before: "", after: "created\n", additions: 1, deletions: 0, status: "added" },
      { file: "old.txt", before: "removed\n", after: "", additions: 0, deletions: 1, status: "deleted" },
    ]);

    expect(diffs[0]).toMatchObject({ status: "added", statusExplicit: true });
    expect(diffs[0].patch).toContain("new file mode 100644\n--- /dev/null\n+++ b/new.txt");
    expect(diffs[1]).toMatchObject({ status: "deleted", statusExplicit: true });
    expect(diffs[1].patch).toContain("deleted file mode 100644\n--- a/old.txt\n+++ /dev/null");
  });

  it("handles CRLF input and paths that need quoting", () => {
    const patch = createOpenCodeUnifiedPatch("目录/file name.txt", "旧\r\n", "新\r\n");
    expect(patch).toContain('diff --git "a/目录/file name.txt" "b/目录/file name.txt"');
    // 行内 \r 必须保留：git apply 逐字节匹配上下文行，洗掉 \r 的补丁
    // 在 CRLF 文件上正反向都 apply 不上（撤销回归的根因之一）。
    expect(patch).toContain("-旧\r\n+新\r");
  });

  it("drops unchanged, malformed, unsafe, and oversized entries", () => {
    const oversized = "x".repeat(20 * 1024 * 1024 + 1);
    expect(normalizeOpenCodeSessionDiffs([
      { file: "same.txt", before: "same", after: "same", additions: 0, deletions: 0 },
      { file: "../outside.txt", before: "a", after: "b", additions: 1, deletions: 1 },
      { file: "missing.txt", additions: 1, deletions: 0 },
      { file: "large.txt", before: "", after: oversized, additions: 1, deletions: 0 },
    ])).toEqual([]);
  });
});
