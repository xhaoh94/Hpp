import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUnifiedPatch, patchDescribesChange } from "./unified-patch";

/**
 * 用真实 git apply 验证补丁的字节精确性。
 *
 * 撤销引擎（rebuild-file.ts）用 git apply 逐字节匹配上下文行（无
 * --ignore-whitespace）。补丁生成端任何「顺手」的行尾归一化都会让
 * Windows CRLF 文件上的补丁全军覆没——这是「补丁 #N 正反向均失败：
 * patch does not apply」的直接根因，本文件钉死该回归。
 */
const runGitApply = (cwd: string, patch: string, reverse: boolean) => spawnSync(
  "git",
  [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.filemode=false",
    "apply",
    ...(reverse ? ["--reverse"] : []),
    "--whitespace=nowarn",
    "-",
  ],
  // 与撤销引擎同款：只去尾随换行符，保留最后一行的 \r（CRLF 内容）
  { cwd, input: `${patch.replace(/\n+$/, "")}\n`, encoding: "utf-8" },
);

const roundtrip = (options: {
  label: string;
  before: string;
  after: string;
  expectCrInPatch: boolean;
}) => {
  it(`${options.label}：补丁可被真实 git apply 反向还原`, () => {
    const patch = createUnifiedPatch("test.txt", options.before, options.after, "modified");
    expect(patch).not.toBe("");
    expect(patchDescribesChange(patch)).toBe(true);
    expect(patch.includes("\r")).toBe(options.expectCrInPatch);

    const worktree = mkdtempSync(join(tmpdir(), "hpp-unified-patch-"));
    try {
      writeFileSync(join(worktree, "test.txt"), options.after, "utf8");
      const result = runGitApply(worktree, patch, true);
      expect(result.status).toBe(0);
      // 反向应用后必须逐字节还原为修改前内容（含行尾），否则撤销等于写坏文件
      expect(readFileSync(join(worktree, "test.txt"), "utf8")).toBe(options.before);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  }, 30000);
};

describe("createUnifiedPatch 字节精确性", () => {
  roundtrip({
    label: "CRLF 文件（Windows 常态，曾全军覆没的场景）",
    before: "line1\r\nline2\r\nline3\r\nline4\r\n",
    after: "line1\r\nline2改\r\nline3\r\nline4\r\nline5\r\n",
    expectCrInPatch: true,
  });

  roundtrip({
    label: "LF 文件（对照组）",
    before: "line1\nline2\nline3\nline4\n",
    after: "line1\nline2改\nline3\nline4\nline5\n",
    expectCrInPatch: false,
  });

  roundtrip({
    label: "末尾无换行文件",
    before: "a\nb",
    after: "a\nb\nc",
    expectCrInPatch: false,
  });

  roundtrip({
    label: "CRLF 且末尾无换行",
    before: "a\r\nb",
    after: "a\r\nb\r\nc",
    expectCrInPatch: true,
  });

  it("纯行尾改写（CRLF→LF）不出补丁：语义比较保持归一化", () => {
    expect(createUnifiedPatch("a.txt", "x\r\ny\r\n", "x\ny\n")).toBe("");
  });

  it("新增空文件仍输出生命周期头（撤销时才能删除该文件）", () => {
    const patch = createUnifiedPatch("empty.txt", null, "", "added");
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("--- /dev/null");
  });

  it("删除空文件仍输出生命周期头", () => {
    const patch = createUnifiedPatch("empty.txt", "", null, "deleted");
    expect(patch).toContain("deleted file mode 100644");
    expect(patch).toContain("+++ /dev/null");
  });

  it("CRLF 新增文件：正向补丁可被 git apply 反向还原为删除", () => {
    const patch = createUnifiedPatch(
      "new.txt",
      null,
      "a\r\nb\r\n",
      "added",
    );
    expect(patch.includes("\r")).toBe(true);

    const worktree = mkdtempSync(join(tmpdir(), "hpp-unified-patch-"));
    try {
      writeFileSync(join(worktree, "new.txt"), "a\r\nb\r\n", "utf8");
      const result = runGitApply(worktree, patch, true);
      expect(result.status).toBe(0);
      // 反向应用 new-file 补丁 = 把文件删掉，还原「修改前不存在」的状态
      expect(existsSync(join(worktree, "new.txt"))).toBe(false);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  }, 30000);
});
