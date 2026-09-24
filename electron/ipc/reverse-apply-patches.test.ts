import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  alignPatchLineEndings,
  getPatchTargetPath,
  readTargetLineEndings,
  reverseApplyPatches,
  type RunGitApply,
} from "./reverse-apply-patches";

const tempDirs: string[] = [];

const createRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "hpp-review-undo-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Hpp Test"], { cwd: dir });
  return dir;
};

const commit = (dir: string, message: string) => {
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
};

const diff = (dir: string) => execFileSync("git", ["diff", "--no-ext-diff"], {
  cwd: dir,
  encoding: "utf8",
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("reverseApplyPatches", () => {
  it("reverts repeated modifications to one file from newest to oldest", { timeout: 30000 }, () => {
    const dir = createRepo();
    const file = join(dir, "sample.txt");
    writeFileSync(file, "one\ntwo\nthree\n");
    commit(dir, "initial");

    writeFileSync(file, "ONE\ntwo\nthree\n");
    const firstPatch = diff(dir);
    commit(dir, "first edit");

    writeFileSync(file, "ONE\nTWO\nthree\n");
    const secondPatch = diff(dir);

    expect(reverseApplyPatches(dir, [firstPatch, secondPatch])).toEqual({ success: true });
    expect(readFileSync(file, "utf8").replace(/\r\n/g, "\n")).toBe("one\ntwo\nthree\n");
  });

  it("restores already reverted patches when a later reverse step fails", { timeout: 30000 }, () => {
    const calls: Array<{ patch: string; reverse: boolean }> = [];
    const run: RunGitApply = (_cwd, patch, reverse) => {
      calls.push({ patch, reverse });
      if (patch === "first" && reverse) {
        return { status: 1, stderr: "first patch failed" };
      }
      return { status: 0 };
    };

    expect(reverseApplyPatches("project", ["first", "second", "third"], run)).toEqual({
      success: false,
      error: "first patch failed",
    });
    expect(calls).toEqual([
      { patch: "third", reverse: true },
      { patch: "second", reverse: true },
      { patch: "first", reverse: true },
      { patch: "second", reverse: false },
      { patch: "third", reverse: false },
    ]);
  });

  it("reverts a CRLF worktree file with an LF-only provider patch", { timeout: 30000 }, () => {
    const dir = createRepo();
    const file = join(dir, "sample.txt");
    writeFileSync(file, "one\ntwo\nthree\n");
    commit(dir, "initial");

    writeFileSync(file, "ONE\ntwo\nthree\n");
    const patch = diff(dir);
    // provider（pi/codex 等）下发的补丁只带 \n，而 Windows 上 autocrlf=true
    // 检出的工作区文件是 CRLF —— 这两者字节上永远对不上。
    expect(patch).not.toContain("\r");
    writeFileSync(file, "ONE\r\ntwo\r\nthree\r\n");

    expect(reverseApplyPatches(dir, [patch])).toEqual({ success: true });
    expect(readFileSync(file, "utf8")).toBe("one\r\ntwo\r\nthree\r\n");
  });

  it("reverts a mixed line ending worktree file line by line", { timeout: 30000 }, () => {
    const dir = createRepo();
    const file = join(dir, "sample.txt");
    writeFileSync(file, "one\ntwo\nthree\n");
    commit(dir, "initial");

    writeFileSync(file, "ONE\ntwo\nthree\n");
    const patch = diff(dir);
    expect(patch).not.toContain("\r");
    // 混行：第 1、3 行 CRLF，第 2 行 LF —— 整个文件统一对齐怎么选都有一半对不上
    writeFileSync(file, "ONE\r\ntwo\nthree\r\n");

    expect(reverseApplyPatches(dir, [patch])).toEqual({ success: true });
    expect(readFileSync(file, "utf8")).toBe("one\r\ntwo\nthree\r\n");
  });
});

describe("patch line ending alignment", () => {
  const patch = [
    "diff --git a/x.lua b/x.lua",
    "--- a/x.lua",
    "+++ b/x.lua",
    "@@ -1,3 +1,3 @@",
    "-one",
    "+ONE",
    " two",
    "\\ No newline at end of file",
  ].join("\n");

  it("rewrites only content lines, leaving headers and markers untouched", () => {
    expect(alignPatchLineEndings(patch, true).split("\n")).toEqual([
      "diff --git a/x.lua b/x.lua",
      "--- a/x.lua",
      "+++ b/x.lua",
      "@@ -1,3 +1,3 @@",
      "-one\r",
      "+ONE\r",
      " two\r",
      "\\ No newline at end of file",
    ]);
    // 幂等：已对齐的补丁不会再叠一层 \r，反向对齐（CRLF 文件的补丁打到 LF 文件）也能还原。
    const crlf = alignPatchLineEndings(patch, true);
    expect(alignPatchLineEndings(crlf, true)).toBe(crlf);
    expect(alignPatchLineEndings(crlf, false)).toBe(patch);
  });

  it("resolves the target path from the headers", () => {
    expect(getPatchTargetPath(patch)).toBe("x.lua");
    // git 会在头后面跟一个制表符 + 时间戳；带引号的路径要按 git 的转义还原。
    expect(getPatchTargetPath("--- a/x.lua\t2024-01-01\n+++ b/x.lua\t2024-01-01")).toBe("x.lua");
    expect(getPatchTargetPath('--- "a/E:\\\\a b.txt"')).toBe("E:/a b.txt");
    // 删除补丁的新侧是 /dev/null，此时没有可对齐的目标文件。
    expect(getPatchTargetPath("--- a/x.lua\n+++ /dev/null")).toBe("");
    expect(getPatchTargetPath("@@ -1 +1 @@\n-a\n+b")).toBe("");
  });

  it("aligns each content line to that line's own ending in the target file", () => {
    // 混行文件：第 1、3 行 CRLF，第 2 行 LF
    const target = { defaultCrlf: true, crlfByLine: [true, false, true] };
    expect(alignPatchLineEndings(patch, target).split("\n")).toEqual([
      "diff --git a/x.lua b/x.lua",
      "--- a/x.lua",
      "+++ b/x.lua",
      "@@ -1,3 +1,3 @@",
      "-one\r", // 对应第 1 行 -> CRLF
      "+ONE\r", // 新增行没有可匹配的旧行 -> 跟随 defaultCrlf
      " two", // 对应第 2 行 -> LF
      "\\ No newline at end of file",
    ]);
  });

  it("advances the old line number past context and deleted lines only", () => {
    const twoHunks = [
      "diff --git a/x.lua b/x.lua",
      "--- a/x.lua",
      "+++ b/x.lua",
      "@@ -1,1 +1,2 @@",
      "-keep",
      "+added",
      "+more",
      "@@ -9,1 +10,1 @@",
      "-last",
      "+LAST",
    ].join("\n");
    const crlfByLine = [true, false, false, false, false, false, false, false, false];
    expect(alignPatchLineEndings(twoHunks, { defaultCrlf: true, crlfByLine }).split("\n")).toEqual([
      "diff --git a/x.lua b/x.lua",
      "--- a/x.lua",
      "+++ b/x.lua",
      "@@ -1,1 +1,2 @@",
      "-keep\r",
      "+added\r",
      "+more\r",
      "@@ -9,1 +10,1 @@", // 第二个 hunk 从第 9 行重新起算
      "-last", // 第 9 行是 LF
      "+LAST\r",
    ]);
  });

  it("still aligns whole-file additions whose hunk starts at old line 0", () => {
    // @@ -0,0 时旧行号就是 0，不能用「旧行号 === 0」判断是否在 hunk 内
    const created = [
      "diff --git a/x.lua b/x.lua",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/x.lua",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
    ].join("\n");
    expect(alignPatchLineEndings(created, { defaultCrlf: true, crlfByLine: [] }).split("\n")).toEqual([
      "diff --git a/x.lua b/x.lua",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/x.lua",
      "@@ -0,0 +1,2 @@",
      "+a\r",
      "+b\r",
    ]);
  });

  it("stays idempotent in per-line mode", () => {
    const target = { defaultCrlf: true, crlfByLine: [true, false, true] };
    const once = alignPatchLineEndings(patch, target);
    expect(alignPatchLineEndings(once, target)).toBe(once);
  });

  it("reads each line's own ending off the target file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hpp-eol-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "m.txt"), "a\r\nb\nc\r\n");
    const headers = "--- a/m.txt\n+++ b/m.txt\n@@ -1,3 +1,3 @@";

    expect(readTargetLineEndings(dir, headers)).toEqual({
      defaultCrlf: true,
      crlfByLine: [true, false, true],
    });
    // 目标文件读不到（新增补丁，或路径越界）时没有可对齐的行尾
    expect(readTargetLineEndings(dir, "--- /dev/null\n+++ b/nope.txt")).toBeNull();
  });
});
