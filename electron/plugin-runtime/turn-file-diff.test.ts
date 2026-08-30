import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolFileDiffFallback, TurnFileDiffTracker } from "./turn-file-diff";
import { buildDiffsFromToolEvent } from "./process-events";

let projectPath = "";

const write = (relativePath: string, content: string) => {
  writeFileSync(join(projectPath, relativePath), content, "utf8");
};

const mutatingTool = (filePath: string) => ({ toolKind: "edit_file", filePath });

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), "hpp-turn-diff-"));
});

afterEach(() => {
  rmSync(projectPath, { recursive: true, force: true });
});

describe("TurnFileDiffTracker", () => {
  it("computes a real patch when the provider reports no diff", () => {
    write("test.txt", "第01行\n第05行：保持不变\n第10行\n");
    const tracker = new TurnFileDiffTracker();

    // 工具执行前抓快照
    tracker.capture(projectPath, "test.txt");
    // 工具改写文件
    write("test.txt", "第01行\n第05行：又一次测试改动\n第10行\n");

    const diff = tracker.resolve(projectPath, "test.txt");
    expect(diff).not.toBeNull();
    expect(diff?.file).toBe("test.txt");
    expect(diff?.status).toBe("modified");
    expect(diff?.additions).toBe(1);
    expect(diff?.deletions).toBe(1);
    expect(diff?.patch).toContain("--- a/test.txt");
    expect(diff?.patch).toContain("+++ b/test.txt");
    expect(diff?.patch).toContain("@@");
    expect(diff?.patch).toContain("-第05行：保持不变");
    expect(diff?.patch).toContain("+第05行：又一次测试改动");
  });

  it("CRLF 文件产出的补丁可被真实 git apply 反向还原（撤销链路回归）", () => {
    const before = "line1\r\nline2\r\nline3\r\nline4\r\n";
    const after = "line1\r\nline2改\r\nline3\r\nline4\r\nline5\r\n";
    write("test.txt", before);
    const tracker = new TurnFileDiffTracker();
    tracker.capture(projectPath, "test.txt");
    write("test.txt", after);

    const diff = tracker.resolve(projectPath, "test.txt");
    expect(diff).not.toBeNull();
    // 补丁必须携带 \r：git apply 逐字节匹配上下文行，
    // 洗掉 \r 的补丁在 CRLF 文件上必然 "patch does not apply"
    expect(diff?.patch.includes("\r")).toBe(true);

    const worktree = mkdtempSync(join(tmpdir(), "hpp-crlf-apply-"));
    try {
      writeFileSync(join(worktree, "test.txt"), after, "utf8");
      const result = spawnSync(
        "git",
        ["-c", "core.autocrlf=false", "-c", "core.filemode=false", "apply", "--reverse", "--whitespace=nowarn", "-"],
        { cwd: worktree, input: `${diff!.patch.replace(/\n+$/, "")}\n`, encoding: "utf-8" },
      );
      expect(result.status).toBe(0);
      expect(readFileSync(join(worktree, "test.txt"), "utf8")).toBe(before);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  }, 30000);

  it("reports added for a file created by the tool", () => {
    const tracker = new TurnFileDiffTracker();
    tracker.capture(projectPath, "new.ts");
    write("new.ts", "export const a = 1;\n");

    const diff = tracker.resolve(projectPath, "new.ts");
    expect(diff?.status).toBe("added");
    expect(diff?.statusExplicit).toBe(true);
    expect(diff?.additions).toBe(1);
    expect(diff?.patch).toContain("new file mode 100644");
    expect(diff?.patch).toContain("--- /dev/null");
  });

  it("reports added for an empty file created by the tool", () => {
    const tracker = new TurnFileDiffTracker();
    tracker.capture(projectPath, "empty.txt");
    write("empty.txt", "");

    const diff = tracker.resolve(projectPath, "empty.txt");
    expect(diff?.status).toBe("added");
    // 空文件没有 hunk，但生命周期头必须保留，撤销时才能把文件删掉
    expect(diff?.patch).toContain("new file mode 100644");
    expect(diff?.patch).toContain("--- /dev/null");
  });

  it("reports deleted for an empty file removed by the tool", () => {
    write("blank.txt", "");
    const tracker = new TurnFileDiffTracker();
    tracker.capture(projectPath, "blank.txt");
    rmSync(join(projectPath, "blank.txt"));

    const diff = tracker.resolve(projectPath, "blank.txt");
    expect(diff?.status).toBe("deleted");
    expect(diff?.patch).toContain("deleted file mode 100644");
    expect(diff?.patch).toContain("+++ /dev/null");
  });

  it("reports deleted for a file removed by the tool", () => {
    write("gone.txt", "旧内容\n");
    const tracker = new TurnFileDiffTracker();
    tracker.capture(projectPath, "gone.txt");
    rmSync(join(projectPath, "gone.txt"));

    const diff = tracker.resolve(projectPath, "gone.txt");
    expect(diff?.status).toBe("deleted");
    expect(diff?.statusExplicit).toBe(true);
    expect(diff?.deletions).toBe(1);
    expect(diff?.patch).toContain("deleted file mode 100644");
    expect(diff?.patch).toContain("+++ /dev/null");
  });

  it("accumulates successive edits into one cumulative diff", () => {
    write("a.txt", "line1\n");
    const tracker = new TurnFileDiffTracker();

    tracker.capture(projectPath, "a.txt");
    write("a.txt", "line1\nline2\n");
    expect(tracker.resolve(projectPath, "a.txt")?.additions).toBe(1);

    // 第二次编辑：快照仍是本轮最早的，因此得到累计差异
    write("a.txt", "line1\nline2\nline3\n");
    const cumulative = tracker.resolve(projectPath, "a.txt");
    expect(cumulative?.additions).toBe(2);
  });

  it("returns null when no baseline was captured", () => {
    write("a.txt", "内容\n");
    const tracker = new TurnFileDiffTracker();
    // 没有 tool_start 快照（例如 provider 未流式下发 pending 状态）
    expect(tracker.resolve(projectPath, "a.txt")).toBeNull();
  });

  it("returns null when the baseline was captured too late", () => {
    write("a.txt", "旧\n");
    const tracker = new TurnFileDiffTracker();
    // 模拟 tool_start 与 tool_end 在同一 tick 触发：抓到的已是改后内容
    write("a.txt", "新\n");
    tracker.capture(projectPath, "a.txt");
    // 宁可不出 diff，也不编造一个无法撤销的空补丁
    expect(tracker.resolve(projectPath, "a.txt")).toBeNull();
  });

  it("refuses binary files", () => {
    writeFileSync(join(projectPath, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const tracker = new TurnFileDiffTracker();
    tracker.capture(projectPath, "blob.bin");
    writeFileSync(join(projectPath, "blob.bin"), Buffer.from([0x00, 0x09, 0x09]));
    expect(tracker.resolve(projectPath, "blob.bin")).toBeNull();
  });

  it("refuses paths escaping the project directory", () => {
    const tracker = new TurnFileDiffTracker();
    tracker.capture(projectPath, "../outside.txt");
    expect(tracker.resolve(projectPath, "../outside.txt")).toBeNull();
    tracker.capture(projectPath, "/etc/passwd");
    expect(tracker.resolve(projectPath, "/etc/passwd")).toBeNull();
  });

  it("clears baselines on reset", () => {
    write("a.txt", "旧\n");
    const tracker = new TurnFileDiffTracker();
    tracker.capture(projectPath, "a.txt");
    write("a.txt", "新\n");
    expect(tracker.resolve(projectPath, "a.txt")).not.toBeNull();

    tracker.reset();
    expect(tracker.resolve(projectPath, "a.txt")).toBeNull();
  });
});

describe("ToolFileDiffFallback", () => {
  it("only tracks file mutating tools", () => {
    write("a.txt", "旧\n");
    const fallback = new ToolFileDiffFallback();

    // read_file 不参与快照，因此 tool_end 拿不到兜底
    fallback.onToolStart(projectPath, { toolKind: "read_file", filePath: "a.txt" });
    write("a.txt", "新\n");
    expect(fallback.resolve(projectPath, { toolKind: "read_file", filePath: "a.txt" })).toBeNull();
  });

  it("produces a usable fallback for edit_file", () => {
    write("a.txt", "旧\n");
    const fallback = new ToolFileDiffFallback();
    fallback.onToolStart(projectPath, mutatingTool("a.txt"));
    write("a.txt", "新\n");

    const diff = fallback.resolve(projectPath, mutatingTool("a.txt"));
    expect(diff?.additions).toBe(1);
    expect(diff?.deletions).toBe(1);
  });

  it("resolves absolute tool paths against the project", () => {
    write("a.txt", "旧\n");
    const fallback = new ToolFileDiffFallback();
    const absolutePath = join(projectPath, "a.txt");
    fallback.onToolStart(projectPath, mutatingTool(absolutePath));
    write("a.txt", "新\n");

    const diff = fallback.resolve(projectPath, mutatingTool(absolutePath));
    // 输出的必须是项目相对路径，否则下游撤销无法定位文件
    expect(diff?.file).toBe("a.txt");
  });

  it("deduplicates merges by file when the fallback is null", () => {
    // provider 流式下发了多个 incremental patch（例如 OpenCode 在 tool_start
    // 抓晚了导致 fallback 拿不到基线），mergeDiffs 仍必须按文件去重，
    // 否则 prepareFile 会拿一堆过期行号的 patch 去逐个反 apply，每份都
    // "patch does not apply"，最终弹窗报「补丁 #N 正反向均失败」。
    const fallback = new ToolFileDiffFallback();
    const incremental1 = {
      file: "a.txt",
      patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+step1\n",
      additions: 1,
      deletions: 1,
    };
    const incremental2 = {
      file: "a.txt",
      patch: "--- a/a.txt\n+++ b/a.txt\n@@ -2 +2 @@\n-step1\n+step2\n",
      additions: 1,
      deletions: 1,
    };

    const first = fallback.mergeDiffs([], [incremental1], null);
    const second = fallback.mergeDiffs(first, [incremental2], null);

    expect(second.filter((diff) => diff.file === "a.txt")).toHaveLength(1);
    expect(second.find((diff) => diff.file === "a.txt")?.patch).toContain("+step2");
  });

  it("preserves other files when deduping by file", () => {
    const fallback = new ToolFileDiffFallback();
    const aFirst = {
      file: "a.txt",
      patch: "p-a-first",
      additions: 1,
      deletions: 1,
    };
    const bFromProvider = {
      file: "b.txt",
      patch: "p-b",
      additions: 1,
      deletions: 1,
    };
    const aSecond = {
      file: "a.txt",
      patch: "p-a-second",
      additions: 2,
      deletions: 2,
    };

    const first = fallback.mergeDiffs([bFromProvider], [aFirst], null);
    const second = fallback.mergeDiffs(first, [aSecond], null);

    expect(second).toHaveLength(2);
    expect(second.find((diff) => diff.file === "a.txt")?.patch).toBe("p-a-second");
    expect(second.find((diff) => diff.file === "b.txt")?.patch).toBe("p-b");
  });

  it("covers additional files in the same batch as the fallback file", () => {
    // 一次工具调用可能改多个文件：fallback 是其中一个，patches 列表里包含
    // 另一个同批次文件，二者都必须保留，不能因为 fallback.file 在 override
    // 集合里就丢掉另一个文件。
    const fallback = new ToolFileDiffFallback();
    const aDiff = {
      file: "a.txt",
      patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-旧\n+新\n",
      additions: 1,
      deletions: 1,
    };
    const bDiff = {
      file: "b.txt",
      patch: "--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-旧\n+新\n",
      additions: 1,
      deletions: 1,
    };

    const merged = fallback.mergeDiffs([], [aDiff, bDiff], aDiff);

    expect(merged.map((diff) => diff.file).sort()).toEqual(["a.txt", "b.txt"]);
  });
});

describe("buildDiffsFromToolEvent with a computed fallback", () => {
  it("drops a reported modification that carries no patch", () => {
    // 这正是「diff 卡片显示 +0 -0、审核弹窗拒绝撤销」的成因
    expect(buildDiffsFromToolEvent({
      toolKind: "edit_file" as never,
      filePath: "test.txt",
      patch: "",
      status: "modified",
      statusExplicit: true,
    })).toEqual([]);
  });

  it("drops a patch that only contains context lines", () => {
    expect(buildDiffsFromToolEvent({
      toolKind: "edit_file" as never,
      filePath: "test.txt",
      patch: "@@ -1,3 +1,3 @@\n 第01行\n 第05行\n 第10行\n",
      status: "modified",
      statusExplicit: true,
    })).toEqual([]);
  });

  it("uses the computed fallback when the provider reports no patch", () => {
    const diffs = buildDiffsFromToolEvent(
      {
        toolKind: "edit_file" as never,
        filePath: "test.txt",
        patch: "",
        status: "modified",
        statusExplicit: true,
      },
      {
        file: "test.txt",
        patch: "--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-旧\n+新\n",
        additions: 1,
        deletions: 1,
        status: "modified",
        statusExplicit: false,
      },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      file: "test.txt",
      additions: 1,
      deletions: 1,
      status: "modified",
    });
    expect(diffs[0].patch).toContain("+新");
  });

  it("prefers the computed fallback over a provider patch that may be stale", () => {
    // 兜底由磁盘真实内容算出，反向应用必然成功；provider 的补丁可能基于过期
    // 上下文（看着有正常的 +/- 行，正反向却都 apply 不上），那正是
    // 「审核弹窗显示无法撤销」的主要成因。
    const diffs = buildDiffsFromToolEvent(
      {
        toolKind: "edit_file" as never,
        filePath: "test.txt",
        patch: "--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-provider\n+patch\n",
        additions: 1,
        deletions: 1,
        status: "modified",
        statusExplicit: true,
      },
      {
        file: "test.txt",
        patch: "--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-自算\n+兜底\n",
        additions: 1,
        deletions: 1,
        status: "modified",
        statusExplicit: false,
      },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].patch).toContain("+兜底");
    expect(diffs[0].patch).not.toContain("+patch");
  });

  it("falls back to the provider patch when nothing could be computed", () => {
    const diffs = buildDiffsFromToolEvent(
      {
        toolKind: "edit_file" as never,
        filePath: "test.txt",
        patch: "--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-provider\n+patch\n",
        status: "modified",
        statusExplicit: true,
      },
      null,
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].patch).toContain("+patch");
  });

  it("keeps an explicit lifecycle change even without a patch", () => {
    // 新建空文件没有内容差异，但撤销时要能把文件删掉
    expect(buildDiffsFromToolEvent({
      toolKind: "write_file" as never,
      filePath: "src/empty.ts",
      patch: "",
      status: "added",
      statusExplicit: true,
    })).toMatchObject([{
      file: "src/empty.ts",
      status: "added",
      statusExplicit: true,
    }]);
  });

  it("returns nothing when neither source yields a change", () => {
    expect(buildDiffsFromToolEvent(
      {
        toolKind: "edit_file" as never,
        filePath: "test.txt",
        patch: "",
        status: "modified",
        statusExplicit: true,
      },
      null,
    )).toEqual([]);
  });
});
