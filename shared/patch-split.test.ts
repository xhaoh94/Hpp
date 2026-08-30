import { describe, expect, it } from "vitest";
import {
  buildFullFileDiff,
  buildReviewDiff,
  dropPatchesHunks,
  extractChangePatch,
  extractHunkPatch,
  linesToPairs,
  splitHunkIndex,
  splitPatch,
} from "./patch-split";

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
      { type: "context", text: "const value = 1;", leftLineNo: 1, rightLineNo: 1, hunkIdx: 0 },
      { type: "del", text: "const removed = true;", leftLineNo: 2, hunkIdx: 0 },
      { type: "add", text: "const added = true;", rightLineNo: 2, hunkIdx: 0 },
      { type: "add", text: "const second = 2;", rightLineNo: 3, hunkIdx: 0 },
      { type: "context", text: "const tail = 3;", leftLineNo: 3, rightLineNo: 4, hunkIdx: 0 },
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
      { type: "add", text: "# Title", rightLineNo: 1, hunkIdx: 0 },
      { type: "add", text: "body", rightLineNo: 2, hunkIdx: 0 },
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
    expect(lines).toEqual([{ type: "del", text: "gone", leftLineNo: 1, hunkIdx: 0 }]);
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
      { type: "del", text: "-not-a-marker", leftLineNo: 1, hunkIdx: 0 },
      { type: "add", text: "+not-a-marker", rightLineNo: 1, hunkIdx: 0 },
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

  it("keeps unsupported file-level metadata so the UI can explain why undo is disabled", () => {
    const files = buildReviewDiff([
      {
        file: "binary.dat",
        patch: "diff --git a/binary.dat b/binary.dat\nBinary files a/binary.dat and b/binary.dat differ\n",
      },
      {
        file: "mode.sh",
        patch: "diff --git a/mode.sh b/mode.sh\nold mode 100644\nnew mode 100755\n",
      },
    ]);
    expect(files.map((file) => file.displayFile)).toEqual(["binary.dat", "mode.sh"]);
  });

  it("keeps empty added and deleted files for file-level undo", () => {
    const files = buildReviewDiff([
      {
        file: "empty-added.txt",
        status: "added",
        patch: "diff --git a/empty-added.txt b/empty-added.txt\nnew file mode 100644\nindex 0000000..e69de29\n",
      },
      {
        file: "empty-deleted.txt",
        status: "deleted",
        patch: "diff --git a/empty-deleted.txt b/empty-deleted.txt\ndeleted file mode 100644\nindex e69de29..0000000\n",
      },
    ]);
    expect(files.map((file) => [file.displayFile, file.status])).toEqual([
      ["empty-added.txt", "added"],
      ["empty-deleted.txt", "deleted"],
    ]);
  });

  it("does not treat an inferred added shape as an explicit lifecycle status", () => {
    const files = buildReviewDiff([{
      file: "created.ts",
      patch: "@@ -0,0 +1,1 @@\n+created\n",
      status: "added",
      statusExplicit: false,
    }]);
    expect(files[0]).toMatchObject({ status: "added", statusExplicit: false });
  });

  it("preserves an explicit lifecycle status", () => {
    const files = buildReviewDiff([{
      file: "created.ts",
      patch: "@@ -0,0 +1,1 @@\n+created\n",
      status: "added",
      statusExplicit: true,
    }]);
    expect(files[0]).toMatchObject({ status: "added", statusExplicit: true });
  });

  it("does not overwrite an explicit added lifecycle with a later inferred modified status", () => {
    const files = buildReviewDiff([
      {
        file: "created.ts",
        patch: "@@ -0,0 +1,1 @@\n+created\n",
        status: "added",
        statusExplicit: true,
      },
      {
        file: "created.ts",
        patch: "@@ -1 +1 @@\n-created\n+updated\n",
        status: "modified",
        statusExplicit: false,
      },
    ]);
    expect(files[0]).toMatchObject({ status: "added", statusExplicit: true });
  });

  it("sorts files by display path and ignores malformed entries", () => {
    const files = buildReviewDiff(
      [{ file: "b.ts", patch: "@@ -1 +1 @@\n+b\n" }, { file: "" as never }, { file: "a.ts", patch: "@@ -1 +1 @@\n+a\n" }],
      "",
    );
    expect(files.map((file) => file.displayFile)).toEqual(["a.ts", "b.ts"]);
  });

  it("does not merge case-distinct POSIX paths", () => {
    const files = buildReviewDiff([
      { file: "src/A.ts", patch: "@@ -1 +1 @@\n-a\n+A\n" },
      { file: "src/a.ts", patch: "@@ -1 +1 @@\n-b\n+B\n" },
    ]);
    expect(files.map((file) => file.displayFile)).toEqual(["src/a.ts", "src/A.ts"]);
  });

  it("merges case variants of Windows absolute paths", () => {
    const files = buildReviewDiff([
      { file: "C:/Work/A.ts", patch: "@@ -1 +1 @@\n-a\n+A\n" },
      { file: "c:/work/a.ts", patch: "@@ -2 +2 @@\n-b\n+B\n" },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].patches).toHaveLength(2);
  });

  it("merges case variants of relative paths in a Windows project", () => {
    const files = buildReviewDiff([
      { file: "src/A.ts", patch: "@@ -1 +1 @@\n-a\n+A\n" },
      { file: "src/a.ts", patch: "@@ -2 +2 @@\n-b\n+B\n" },
    ], "C:/Work/App");
    expect(files).toHaveLength(1);
    expect(files[0].patches).toHaveLength(2);
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
    expect(files[0].patches).toEqual([
      "@@ -1 +1 @@\n-a\n+b\n",
      "@@ -2 +2 @@\n-c\n+d\n",
    ]);
  });
});

describe("buildFullFileDiff", () => {
  it("keeps unchanged regions as context around the change", () => {
    const patch = ["@@ -1,5 +1,6 @@", " line1", "-line2old", "+line2new", " line3", " line4"].join("\n");
    const content = ["line1", "line2new", "line3", "line4", "line5"].join("\n");
    const pairs = buildFullFileDiff(content, patch);
    // hunk 首行是上下文行，不属于修改点（无 changeStart）；修改点从首个增删行起；
    // hunk 结束后的未变化区域（pair[5]）不属于任何 hunk。
    expect(pairs).toEqual([
      { hunkIdx: 0, left: { lineNo: 1, type: "context", text: "line1" }, right: { lineNo: 1, type: "context", text: "line1" } },
      { hunkIdx: 0, changeIdx: 0, changeStart: true, left: { lineNo: 2, type: "del", text: "line2old" } },
      { hunkIdx: 0, changeIdx: 0, right: { lineNo: 2, type: "add", text: "line2new" } },
      { hunkIdx: 0, left: { lineNo: 3, type: "context", text: "line3" }, right: { lineNo: 3, type: "context", text: "line3" } },
      { hunkIdx: 0, left: { lineNo: 4, type: "context", text: "line4" }, right: { lineNo: 4, type: "context", text: "line4" } },
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
      { hunkIdx: 0, changeIdx: 0, changeStart: true, right: { lineNo: 1, type: "add", text: "a" } },
      { hunkIdx: 0, changeIdx: 0, right: { lineNo: 2, type: "add", text: "b" } },
    ]);
  });

  it("stamps changeIdx/changeStart on the first changed row of every hunk (regression: missing undo button on later hunks)", () => {
    // 复现审核弹窗的实际 bug：line 1 + line 20 两处改动，旧实现按行号回算时
    // 只能找到第一个 hunk，第二个 hunk 的撤销按钮渲染不出来。
    // 修法：每个 pair 在解析阶段就带 hunkIdx + 修改点序号，渲染时直接读取。
    const original = Array.from({ length: 20 }, (_, i) =>
      `第${String(i + 1).padStart(2, "0")}行：原始内容`,
    ).join("\n");
    const modified = original
      .replace("第01行：原始内容", "第01行：已修改")
      .replace("第20行：原始内容", "第20行：已修改");
    const patch = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1 +1 @@
-第01行：原始内容
+第01行：已修改
@@ -20 +20 @@
-第20行：原始内容
+第20行：已修改
`;
    const pairs = buildFullFileDiff(modified, patch);

    // hunk 0 的首个修改行（del:1）是修改点 0 的起点。
    expect(pairs[0].hunkIdx).toBe(0);
    expect(pairs[0]).toMatchObject({ changeIdx: 0, changeStart: true });
    // hunk 1 的首个修改行（del:20）也必须带修改点标志——这是之前丢按钮的位置。
    const hunk1Start = pairs.find(
      (p) => p.hunkIdx === 1 && p.left?.type === "del" && p.left?.lineNo === 20,
    );
    expect(hunk1Start).toMatchObject({ changeIdx: 0, changeStart: true });
    // 同一修改点的后续增删行不重复置位。
    expect(pairs[1].changeIdx).toBe(0);
    expect(pairs[1].changeStart).toBeUndefined();
    // hunk 之间的未变化区域不带 hunkIdx。
    const between = pairs.find(
      (p) => p.left?.lineNo === 5 && p.left?.type === "context",
    );
    expect(between?.hunkIdx).toBeUndefined();
    expect(between?.changeIdx).toBeUndefined();
  });
});

describe("linesToPairs", () => {
  it("converts patch-only lines into aligned pairs", () => {
    const lines = [
      { type: "context" as const, text: "c", leftLineNo: 1, rightLineNo: 1, hunkIdx: 0 },
      { type: "del" as const, text: "d", leftLineNo: 2, hunkIdx: 0 },
      { type: "add" as const, text: "a", rightLineNo: 2, hunkIdx: 0 },
    ];
    expect(linesToPairs(lines)).toEqual([
      { hunkIdx: 0, left: { lineNo: 1, type: "context", text: "c" }, right: { lineNo: 1, type: "context", text: "c" } },
      { hunkIdx: 0, changeIdx: 0, changeStart: true, left: { lineNo: 2, type: "del", text: "d" } },
      { hunkIdx: 0, changeIdx: 0, right: { lineNo: 2, type: "add", text: "a" } },
    ]);
  });

  it("marks changeStart on the first changed row of each change point", () => {
    // 上下文行不属于修改点；每个修改点的首个增删行置 changeStart（撤销按钮挂这），
    // 同一修改点的后续增删行不重复置位；跨 hunk 时修改点序号从 0 重新计数。
    const lines = [
      { type: "del" as const, text: "d1", leftLineNo: 1, hunkIdx: 0 },
      { type: "add" as const, text: "a1", rightLineNo: 1, hunkIdx: 0 },
      { type: "context" as const, text: "c", leftLineNo: 2, rightLineNo: 2, hunkIdx: 0 },
      { type: "add" as const, text: "a2", rightLineNo: 3, hunkIdx: 0 },
      { type: "del" as const, text: "d2", leftLineNo: 5, hunkIdx: 1 },
      { type: "add" as const, text: "a3", rightLineNo: 5, hunkIdx: 1 },
    ];
    const pairs = linesToPairs(lines);
    expect(pairs[0]).toMatchObject({ changeIdx: 0, changeStart: true });
    expect(pairs[1]).toMatchObject({ changeIdx: 0 });
    expect(pairs[1].changeStart).toBeUndefined();
    expect(pairs[2].changeIdx).toBeUndefined();
    expect(pairs[3]).toMatchObject({ changeIdx: 1, changeStart: true });
    expect(pairs[4]).toMatchObject({ hunkIdx: 1, changeIdx: 0, changeStart: true });
    expect(pairs[5]).toMatchObject({ hunkIdx: 1, changeIdx: 0 });
  });
});

describe("extractHunkPatch", () => {
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "index 1111111..2222222 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,3 +1,3 @@",
    " line1",
    "-line2",
    "+line2-A",
    " line3",
    "@@ -6,3 +6,3 @@",
    " line6",
    "-line7",
    "+line7-B",
    " line8",
  ].join("\n");

  it("extracts a clean single hunk with the file header", () => {
    expect(extractHunkPatch(patch, 1)).toBe([
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -6,3 +6,3 @@",
      " line6",
      "-line7",
      "+line7-B",
      " line8",
    ].join("\n"));
  });

  it("returns null for empty patches and out-of-range indices", () => {
    expect(extractHunkPatch("", 0)).toBeNull();
    expect(extractHunkPatch(patch, -1)).toBeNull();
    expect(extractHunkPatch(patch, 2)).toBeNull();
  });
});

describe("extractChangePatch", () => {
  // 复刻审核弹窗的真实场景：三处单行修改间距只有 4 行，git 用 3 行上下文
  // 会把它们合并成同一个 hunk；局部撤销必须能按修改点拆开。
  const mergedPatch = [
    "diff --git a/t.txt b/t.txt",
    "index 1111111..2222222 100644",
    "--- a/t.txt",
    "+++ b/t.txt",
    "@@ -1,16 +1,16 @@",
    " r1",
    " r2",
    "-r3",
    "+r3-A",
    " r4",
    " r5",
    " r6",
    " r7",
    "-r8",
    "+r8-B",
    " r9",
    " r10",
    " r11",
    " r12",
    "-r13",
    "+r13-C",
    " r14",
    " r15",
    " r16",
  ].join("\n");

  it("splits a merged hunk into per-change-point sub-patches", () => {
    const second = extractChangePatch(mergedPatch, 0, 1);
    expect(second).toBe([
      "diff --git a/t.txt b/t.txt",
      "index 1111111..2222222 100644",
      "--- a/t.txt",
      "+++ b/t.txt",
      "@@ -5,7 +5,7 @@",
      " r5",
      " r6",
      " r7",
      "-r8",
      "+r8-B",
      " r9",
      " r10",
      " r11",
    ].join("\n"));
  });

  it("clamps context at hunk boundaries for the first and last change point", () => {
    expect(extractChangePatch(mergedPatch, 0, 0)).toContain(
      ["@@ -1,6 +1,6 @@", " r1", " r2", "-r3", "+r3-A", " r4", " r5", " r6"].join("\n"),
    );
    expect(extractChangePatch(mergedPatch, 0, 2)).toContain(
      ["@@ -10,7 +10,7 @@", " r10", " r11", " r12", "-r13", "+r13-C", " r14", " r15", " r16"].join("\n"),
    );
  });

  it("preserves no-newline-at-EOF markers attached to the change rows", () => {
    const noEolPatch = [
      "diff --git a/n.txt b/n.txt",
      "--- a/n.txt",
      "+++ b/n.txt",
      "@@ -1,4 +1,4 @@",
      " n1",
      " n2",
      "-n3",
      "+n3-X",
      " n4",
      "\\ No newline at end of file",
    ].join("\n");
    expect(extractChangePatch(noEolPatch, 0, 0)).toBe([
      "diff --git a/n.txt b/n.txt",
      "--- a/n.txt",
      "+++ b/n.txt",
      "@@ -1,4 +1,4 @@",
      " n1",
      " n2",
      "-n3",
      "+n3-X",
      " n4",
      "\\ No newline at end of file",
    ].join("\n"));
  });

  it("returns null for out-of-range change indices and hunk-less patches", () => {
    expect(extractChangePatch(mergedPatch, 0, 3)).toBeNull();
    expect(extractChangePatch(mergedPatch, 1, 0)).toBeNull();
    expect(extractChangePatch("", 0, 0)).toBeNull();
    expect(extractChangePatch(mergedPatch, 0, -1)).toBeNull();
  });
});

describe("splitHunkIndex", () => {
  // 第一份补丁 1 个 hunk，第二份补丁 2 个 hunk（同文件连续两次编辑的增量补丁）。
  const first = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,3 +1,3 @@",
    " line1",
    "-line2",
    "+line2-A",
    " line3",
  ].join("\n");
  const second = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -4,3 +4,3 @@",
    " line4",
    "-line5",
    "+line5-A",
    " line6",
    "@@ -7,3 +7,3 @@",
    " line7",
    "-line8",
    "+line8-A",
    " line9",
  ].join("\n");

  it("maps merged hunk indices back to their source patch", () => {
    expect(splitHunkIndex([first, second], 0)).toEqual({ patchIndex: 0, hunkIndex: 0 });
    expect(splitHunkIndex([first, second], 1)).toEqual({ patchIndex: 1, hunkIndex: 0 });
    expect(splitHunkIndex([first, second], 2)).toEqual({ patchIndex: 1, hunkIndex: 1 });
  });

  it("returns null for out-of-range indices", () => {
    expect(splitHunkIndex([first, second], -1)).toBeNull();
    expect(splitHunkIndex([first, second], 3)).toBeNull();
    expect(splitHunkIndex([], 0)).toBeNull();
  });

  it("keeps hunk extraction clean when patches were merged for display", () => {
    // buildReviewDiff 会把同文件多份补丁 join("\n") 合并展示；此时直接按
    // 合并序号切 hunk 会把后续补丁的文件头混入正文，必须先定位回单份补丁。
    const patches = [first, second];
    const merged = patches.join("\n");

    // 合并补丁中 hunk[0] 属于第一份补丁：从原始补丁提取的结果不含第二份补丁的头部。
    const located = splitHunkIndex(patches, 0);
    expect(located).toEqual({ patchIndex: 0, hunkIndex: 0 });
    const hunk = extractHunkPatch(patches[located!.patchIndex], located!.hunkIndex);
    expect(hunk).toBe(first);
    // 对照：直接从合并补丁切 hunk[0] 会带出第二份补丁的文件头（脏补丁）。
    expect(extractHunkPatch(merged, 0)).not.toBe(first);
  });
});

describe("dropPatchesHunks", () => {
  // 第一份补丁 2 个 hunk，第二份补丁 1 个 hunk → 合并序号 0/1/2。
  const first = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,3 +1,3 @@",
    " line1",
    "-line2",
    "+line2-A",
    " line3",
    "@@ -6,3 +6,3 @@",
    " line6",
    "-line7",
    "+line7-B",
    " line8",
  ].join("\n");
  const second = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -9,3 +9,3 @@",
    " line9",
    "-line10",
    "+line10-C",
    " line11",
  ].join("\n");

  it("drops a hunk from the middle of one patch and keeps the rest", () => {
    const kept = dropPatchesHunks([first, second], [0]);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBe([
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -6,3 +6,3 @@",
      " line6",
      "-line7",
      "+line7-B",
      " line8",
    ].join("\n"));
    expect(kept[1]).toBe(second);
  });

  it("drops hunks spanning multiple patches", () => {
    const kept = dropPatchesHunks([first, second], [1, 2]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBe([
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-line2",
      "+line2-A",
      " line3",
    ].join("\n"));
  });

  it("removes a patch entirely when all of its hunks are reverted", () => {
    expect(dropPatchesHunks([first, second], [2])).toEqual([first]);
    // 全部 hunk 被撤销 → 空数组（文件级撤销时引擎不重放任何补丁）。
    expect(dropPatchesHunks([first, second], [0, 1, 2])).toEqual([]);
  });

  it("keeps patches untouched when no hunk is reverted", () => {
    expect(dropPatchesHunks([first, second], [])).toEqual([first, second]);
    expect(dropPatchesHunks([first, second], [99])).toEqual([first, second]);
  });

  it("drops empty and metadata-only patches (nothing replayable)", () => {
    expect(dropPatchesHunks(["", "   ", "--- a/x\n+++ b/x", first], [0])).toEqual([
      "--- a/a.txt\n+++ b/a.txt\n@@ -6,3 +6,3 @@\n line6\n-line7\n+line7-B\n line8",
    ]);
  });
});
