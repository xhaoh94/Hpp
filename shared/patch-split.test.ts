import { describe, expect, it } from "vitest";
import { buildFullFileDiff, buildReviewDiff, linesToPairs, splitPatch } from "./patch-split";

describe("splitPatch", () => {
  it("parses a standard hunk into aligned left/right lines", () => {
    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1234567..89abcde 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,5 +1,6 @@",
      " const value = 1;",
      "-const removed = true;",
      "+const added = true;",
      "+const second = 2;",
      " const tail = 3;",
    ].join("\n");

    const { lines, status } = splitPatch(patch);
    expect(status).toBe("modified");
    expect(lines).toEqual([
      { type: "context", text: "const value = 1;", leftLineNo: 1, rightLineNo: 1 },
      { type: "del", text: "const removed = true;", leftLineNo: 2 },
      { type: "add", text: "const added = true;", rightLineNo: 2 },
      { type: "add", text: "const second = 2;", rightLineNo: 3 },
      { type: "context", text: "const tail = 3;", leftLineNo: 3, rightLineNo: 4 },
    ]);
  });

  it("detects a newly added file via /dev/null", () => {
    const patch = [
      "diff --git a/readme.md b/readme.md",
      "new file mode 100644",
      "index 0000000..abc1234",
      "--- /dev/null",
      "+++ b/readme.md",
      "@@ -0,0 +1,2 @@",
      "+# Title",
      "+body",
    ].join("\n");

    const { lines, status } = splitPatch(patch);
    expect(status).toBe("added");
    expect(lines).toEqual([
      { type: "add", text: "# Title", rightLineNo: 1 },
      { type: "add", text: "body", rightLineNo: 2 },
    ]);
  });

  it("detects a deleted file via /dev/null", () => {
    const patch = [
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "index abc1234..0000000",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-gone",
    ].join("\n");

    const { lines, status } = splitPatch(patch);
    expect(status).toBe("deleted");
    expect(lines).toEqual([{ type: "del", text: "gone", leftLineNo: 1 }]);
  });

  it("treats leading - or + characters as content, not markers", () => {
    const patch = [
      "--- a/x",
      "+++ b/x",
      "@@ -1,1 +1,1 @@",
      "--not-a-marker", // 内容以 - 开头：raw "--"（一个 - 标记 + 内容）
      "++not-a-marker", // 内容以 + 开头：raw "++"（一个 + 标记 + 内容）
    ].join("\n");

    const { lines } = splitPatch(patch);
    expect(lines).toEqual([
      { type: "del", text: "-not-a-marker", leftLineNo: 1 },
      { type: "add", text: "+not-a-marker", rightLineNo: 1 },
    ]);
  });

  it("supports hunk headers without counts", () => {
    const patch = [
      "@@ -2 +2 @@",
      " context",
      "-old",
      "+new",
    ].join("\n");

    const { lines } = splitPatch(patch);
    expect(lines[0]).toMatchObject({ type: "context", leftLineNo: 2, rightLineNo: 2 });
    expect(lines[1]).toMatchObject({ type: "del", leftLineNo: 3 });
    expect(lines[2]).toMatchObject({ type: "add", rightLineNo: 3 });
  });

  it("handles empty, metadata-only and malformed patches safely", () => {
    expect(splitPatch("")).toEqual({ lines: [], status: "modified" });
    expect(splitPatch("   \n")).toEqual({ lines: [], status: "modified" });

    const metadataOnly = splitPatch("diff --git a/x b/x\n--- a/x\n+++ b/x");
    expect(metadataOnly.lines).toEqual([]);

    // 无 hunk 的行不会进入结果。
    const malformed = splitPatch("random text without hunk");
    expect(malformed.lines).toEqual([]);
  });

  it("ignores header lines between hunks", () => {
    const patch = [
      "--- a/one",
      "+++ b/one",
      "@@ -1,1 +1,1 @@",
      " a",
      "--- a/two",
      "+++ b/two",
      "@@ -1,1 +1,2 @@",
      " b",
      "+b2",
    ].join("\n");

    const { lines } = splitPatch(patch);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ type: "context", text: "a" });
    expect(lines[1]).toMatchObject({ type: "context", text: "b" });
    expect(lines[2]).toMatchObject({ type: "add", text: "b2" });
  });
});

describe("buildReviewDiff", () => {
  const diffs = [
    { file: "C:\\work\\app\\src\\a.ts", patch: "@@ -1 +1 @@\n-old\n+new\n", additions: 1, deletions: 1 },
    { file: "C:\\work\\app\\src\\b.ts", patch: "@@ -1 +1 @@\n+x\n", additions: 1, deletions: 0 },
    { file: "C:\\work\\app\\src\\meta.ts", additions: 5, deletions: 2, status: "modified" },
  ];

  it("aggregates by file, relativizes display path and keeps original path", () => {
    const files = buildReviewDiff(diffs, "C:\\work\\app");
    expect(files).toHaveLength(3);
    const a = files.find((file) => file.file.endsWith("a.ts"));
    expect(a?.displayFile).toBe("src/a.ts");
    expect(a?.additions).toBe(1);
    expect(a?.deletions).toBe(1);
    expect(a?.hasPatch).toBe(true);
  });

  it("counts lines from the parsed patch instead of metadata", () => {
    const b = buildReviewDiff(diffs, "C:\\work\\app").find((file) => file.file.endsWith("b.ts"));
    expect(b?.status).toBe("added");
    expect(b?.additions).toBe(1);
    expect(b?.deletions).toBe(0);
  });

  it("falls back to metadata when a file has no patch", () => {
    const meta = buildReviewDiff(diffs, "C:\\work\\app").find((file) => file.file.endsWith("meta.ts"));
    expect(meta?.hasPatch).toBe(false);
    expect(meta?.additions).toBe(5);
    expect(meta?.deletions).toBe(2);
  });

  it("drops files that have no additions or deletions", () => {
    const files = buildReviewDiff(
      [
        { file: "a.ts", patch: "@@ -1 +1 @@\n x\n" },
        { file: "b.ts", patch: "@@ -1 +1 @@\n-a\n+b\n" },
        { file: "c.ts", additions: 0, deletions: 0 },
      ],
      "",
    );
    expect(files.map((file) => file.displayFile)).toEqual(["b.ts"]);
  });

  it("sorts files by display path and ignores malformed entries", () => {
    const files = buildReviewDiff(
      [{ file: "b.ts", patch: "@@ -1 +1 @@\n+b\n" }, { file: "" as never }, { file: "a.ts", patch: "@@ -1 +1 @@\n+a\n" }],
      "",
    );
    expect(files.map((file) => file.displayFile)).toEqual(["a.ts", "b.ts"]);
  });

  it("merges multiple patches for the same file", () => {
    const files = buildReviewDiff(
      [
        { file: "src/x.ts", patch: "@@ -1 +1 @@\n-a\n+b\n" },
        { file: "src/x.ts", patch: "@@ -2 +2 @@\n-c\n+d\n" },
      ],
      "",
    );
    expect(files).toHaveLength(1);
    expect(files[0].lines).toHaveLength(4);
  });
});

describe("buildFullFileDiff", () => {
  it("keeps unchanged regions as context around the change", () => {
    const patch = ["@@ -1,5 +1,6 @@", " line1", "-line2old", "+line2new", " line3", " line4"].join("\n");
    const content = ["line1", "line2new", "line3", "line4", "line5"].join("\n");
    const pairs = buildFullFileDiff(content, patch);
    expect(pairs).toEqual([
      { left: { lineNo: 1, type: "context", text: "line1" }, right: { lineNo: 1, type: "context", text: "line1" } },
      { left: { lineNo: 2, type: "del", text: "line2old" } },
      { right: { lineNo: 2, type: "add", text: "line2new" } },
      { left: { lineNo: 3, type: "context", text: "line3" }, right: { lineNo: 3, type: "context", text: "line3" } },
      { left: { lineNo: 4, type: "context", text: "line4" }, right: { lineNo: 4, type: "context", text: "line4" } },
      { left: { lineNo: 5, type: "context", text: "line5" }, right: { lineNo: 5, type: "context", text: "line5" } },
    ]);
  });

  it("restores leading and trailing unchanged lines with correct line numbers", () => {
    const patch = ["@@ -2,2 +2,2 @@", " b", "-x", "+y"].join("\n");
    const content = ["a", "b", "y", "c"].join("\n");
    const pairs = buildFullFileDiff(content, patch);
    expect(pairs).toHaveLength(5);
    expect(pairs[0].left?.lineNo).toBe(1);
    expect(pairs[0].left?.text).toBe("a");
    expect(pairs[0].left?.type).toBe("context");
    expect(pairs[4].left?.text).toBe("c");
    expect(pairs[4].left?.type).toBe("context");
    expect(pairs[4].left?.lineNo).toBe(4);
    expect(pairs[4].right?.lineNo).toBe(4);
  });

  it("treats a file without hunks as fully unchanged", () => {
    const pairs = buildFullFileDiff("a\nb", "");
    expect(pairs).toEqual([
      { left: { lineNo: 1, type: "context", text: "a" }, right: { lineNo: 1, type: "context", text: "a" } },
      { left: { lineNo: 2, type: "context", text: "b" }, right: { lineNo: 2, type: "context", text: "b" } },
    ]);
  });

  it("marks every line as added when the file is newly created", () => {
    const patch = ["@@ -0,0 +1,2 @@", "+a", "+b"].join("\n");
    const pairs = buildFullFileDiff("a\nb", patch);
    expect(pairs).toEqual([
      { right: { lineNo: 1, type: "add", text: "a" } },
      { right: { lineNo: 2, type: "add", text: "b" } },
    ]);
  });
});

describe("linesToPairs", () => {
  it("converts patch-only lines into aligned pairs", () => {
    const lines = [
      { type: "context" as const, text: "c", leftLineNo: 1, rightLineNo: 1 },
      { type: "del" as const, text: "d", leftLineNo: 2 },
      { type: "add" as const, text: "a", rightLineNo: 2 },
    ];
    expect(linesToPairs(lines)).toEqual([
      { left: { lineNo: 1, type: "context", text: "c" }, right: { lineNo: 1, type: "context", text: "c" } },
      { left: { lineNo: 2, type: "del", text: "d" } },
      { right: { lineNo: 2, type: "add", text: "a" } },
    ]);
  });
});
