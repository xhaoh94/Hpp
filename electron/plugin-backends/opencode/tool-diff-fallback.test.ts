import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";
import { OpenCodeAgent } from "./backend";

interface OpenCodeInternals {
  projectPath: string;
  handleSSEEvent: (eventType: string, data: unknown) => void;
  activeToolDiffs: Array<{
    file: string;
    patch: string;
    additions: number;
    deletions: number;
  }>;
  clearTurnRuntime: () => void;
  toolFileDiffFallback: {
    mergeWithProviderDiffs: <T extends { file: string }>(
      providerDiffs: T[],
    ) => Array<{ file: string; patch: string }>;
  };
}

let projectPath = "";

const write = (relativePath: string, content: string) => {
  writeFileSync(join(projectPath, relativePath), content, "utf8");
};

const createBackend = () => {
  const events: AgentEvent[] = [];
  const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
  const internals = agent as unknown as OpenCodeInternals;
  internals.projectPath = projectPath;
  return { events, internals };
};

const partUpdated = (
  id: string,
  status: string,
  input: unknown,
  output?: unknown,
  patchOverride?: string,
) => ({
  properties: {
    part: {
      id,
      messageID: "message_1",
      type: "tool",
      tool: "edit",
      state: {
        status,
        input,
        ...(output === undefined
          ? patchOverride === undefined
            ? {}
            : { output: { patch: patchOverride } }
          : patchOverride !== undefined
            ? { ...asRecord(output), patch: patchOverride }
            : { output }),
      },
    },
  },
});

const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), "hpp-oc-fallback-"));
});

afterEach(() => {
  rmSync(projectPath, { recursive: true, force: true });
});

describe("OpenCode tool diff fallback", () => {
  it("emits a diff_update with the fallback at tool_end, not waiting for turn end", () => {
    write("test.txt", "旧\n");
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    internals.projectPath = projectPath;

    internals.handleSSEEvent("message.part.updated", partUpdated(
      "tool_edit_1", "pending", { filePath: "test.txt" },
    ));
    write("test.txt", "新\n");
    internals.handleSSEEvent("message.part.updated", partUpdated(
      "tool_edit_1", "completed", { filePath: "test.txt" }, "ok",
    ));

    // 关键：用户从 AI 回复完毕到 session.idle 之间立刻打开审核弹窗时，
    // 兜底补丁必须已经在 diff_update 里发出去——不能等 turn 结束。
    // 不主动调 finishTurn 也不调 emitCachedTurnDiffs，验证 tool_end 自带发射。
    const diffUpdate = events.find(
      (event) => event.type === "diff_update"
        && Array.isArray((event as { diffs?: Array<{ file: string; patch: string }> }).diffs)
        && (event as { diffs: Array<{ file: string }> }).diffs.some((diff) => diff.file === "test.txt"),
    );
    expect(diffUpdate).toBeDefined();
    const diffs = (diffUpdate as { diffs: Array<{ file: string; patch: string; additions: number; deletions: number }> }).diffs;
    expect(diffs[0].additions).toBe(1);
    expect(diffs[0].deletions).toBe(1);
    expect(diffs[0].patch).toContain("-旧");
    expect(diffs[0].patch).toContain("+新");
  });

  it("computes a real patch when the edit tool reports no patch", () => {
    write("test.txt", "第01行\n第05行：保持不变\n第10行\n");
    const { internals } = createBackend();

    // 1) 工具开始执行：此刻文件尚未被改写，是抓基线的唯一时机
    internals.handleSSEEvent("message.part.updated", partUpdated(
      "tool_edit_1", "pending", { filePath: "test.txt" },
    ));

    // 2) 工具改写文件
    write("test.txt", "第01行\n第05行：又一次测试改动\n第10行\n");

    // 3) 工具完成：输出只是一句成功文本，没有 patch / before / after
    internals.handleSSEEvent("message.part.updated", partUpdated(
      "tool_edit_1", "completed", { filePath: "test.txt" }, "Successfully edited test.txt",
    ));

    expect(internals.activeToolDiffs).toHaveLength(1);
    const [diff] = internals.activeToolDiffs;
    expect(diff.file).toBe("test.txt");
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    expect(diff.patch).toContain("-第05行：保持不变");
    expect(diff.patch).toContain("+第05行：又一次测试改动");
  });

  it("keeps only the latest cumulative patch per file across consecutive edits", () => {
    write("a.txt", "line1\n");
    const { internals } = createBackend();

    internals.handleSSEEvent("message.part.updated", partUpdated(
      "tool_edit_1", "pending", { filePath: "a.txt" },
    ));
    write("a.txt", "line1\nline2\n");
    internals.handleSSEEvent("message.part.updated", partUpdated(
      "tool_edit_1", "completed", { filePath: "a.txt" }, "ok",
    ));

    internals.handleSSEEvent("message.part.updated", partUpdated(
      "tool_edit_2", "pending", { filePath: "a.txt" },
    ));
    write("a.txt", "line1\nline2\nline3\n");
    internals.handleSSEEvent("message.part.updated", partUpdated(
      "tool_edit_2", "completed", { filePath: "a.txt" }, "ok",
    ));

    // 兜底补丁是累计快照。若两份都保留，diff 卡片会把同一次改动重复计数
    // （+1 和 +2 相加显示成 +3）。这里必须只剩最新的一份。
    const diffs = internals.activeToolDiffs.filter((diff) => diff.file === "a.txt");
    expect(diffs).toHaveLength(1);
    expect(diffs[0].additions).toBe(2);
  });

  it("emits nothing when the tool part arrives already completed", () => {
    write("a.txt", "旧\n");
    const { internals } = createBackend();

    // provider 没有流式下发 pending：抓到的基线已是改后内容
    write("a.txt", "新\n");
    internals.handleSSEEvent("message.part.updated", partUpdated(
      "tool_edit_1", "completed", { filePath: "a.txt" }, "ok",
    ));

    // 算不出差异就诚实不出 diff，绝不编造空补丁
    expect(internals.activeToolDiffs).toHaveLength(0);
  });

  it("prefers the computed diff over the provider snapshot for the same file", () => {
    write("a.txt", "旧\n");
    write("b.txt", "provider-only\n");
    const { internals } = createBackend();

    internals.handleSSEEvent("message.part.updated", partUpdated(
      "tool_edit_1", "pending", { filePath: "a.txt" },
    ));
    write("a.txt", "新\n");
    internals.handleSSEEvent("message.part.updated", partUpdated(
      "tool_edit_1", "completed", { filePath: "a.txt" }, "ok",
    ));

    // provider 的权威快照可能基于过期上下文，apply 不上；兜底没覆盖到的
    // 文件（b.txt）必须原样保留，不能因为合并而丢失。
    const providerSnapshot = [
      { file: "a.txt", patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-过期上下文\n+provider\n", additions: 1, deletions: 1 },
      { file: "b.txt", patch: "--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-old\n+provider-only\n", additions: 1, deletions: 1 },
    ];
    const merged = internals.toolFileDiffFallback.mergeWithProviderDiffs(providerSnapshot);

    const byFile = new Map(merged.map((diff) => [diff.file, diff]));
    expect(byFile.get("a.txt")?.patch).toContain("+新");
    expect(byFile.get("a.txt")?.patch).not.toContain("+provider");
    expect(byFile.get("b.txt")?.patch).toContain("+provider-only");
  });

  it("clears baselines when the turn ends", () => {
    write("a.txt", "旧\n");
    const { internals } = createBackend();

    internals.handleSSEEvent("message.part.updated", partUpdated(
      "tool_edit_1", "pending", { filePath: "a.txt" },
    ));
    write("a.txt", "新\n");
    internals.handleSSEEvent("message.part.updated", partUpdated(
      "tool_edit_1", "completed", { filePath: "a.txt" }, "ok",
    ));
    expect(internals.activeToolDiffs).toHaveLength(1);

    internals.clearTurnRuntime();

    // 新一轮：基线已清空，同一文件再次编辑时不能再沿用上一轮的基线
    write("a.txt", "更新\n");
    internals.handleSSEEvent("message.part.updated", partUpdated(
      "tool_edit_2", "pending", { filePath: "a.txt" },
    ));
    write("a.txt", "再更新\n");
    internals.handleSSEEvent("message.part.updated", partUpdated(
      "tool_edit_2", "completed", { filePath: "a.txt" }, "ok",
    ));
    const diffs = internals.activeToolDiffs;
    expect(diffs).toHaveLength(1);
    // 基线是本轮起点（"更新"），不是上一轮的（"旧"）
    expect(diffs[0].patch).toContain("-更新");
    expect(diffs[0].patch).toContain("+再更新");
  });

  it("deduplicates the same file across multiple tool_end events when fallback is null", () => {
    // 这正是用户截图「补丁 #4 / #3 / #2 / #1 正反向均失败」的复现路径：
    // provider 在 tool_start 抓晚时（part 进入 completed 状态前文件已写完）
    // fallback 拿不到基线，给的又是 incremental patch；如果不去重，
    // 4 份过期行号的 patch 进入 prepareFile 后全部反 apply 失败。
    write("test.txt", "第01行\n第05行\n第10行\n");
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    internals.projectPath = projectPath;

    // 4 次 immediate-completed 调用，全部用同一文件。provider 给的并非
    // 累计 snapshot，而是每次的 incremental patch（行号基于本步骤之前）。
    const incrementalPatches = [
      "--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-第01行\n+第01行：A\n",
      "--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-第05行\n+第05行：B\n",
      "--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-第10行\n+第10行：C\n",
      "--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-第10行：空\n+第10行：D\n",
    ];
    incrementalPatches.forEach((patch, index) => {
      internals.handleSSEEvent("message.part.updated", partUpdated(
        `tool_edit_${index + 1}`,
        "completed",
        { filePath: "test.txt" },
        undefined,
        patch,
      ));
    });

    const sameFile = internals.activeToolDiffs.filter((diff) => diff.file === "test.txt");
    // 关键断言：同文件多份 incremental patch 进入后只剩最后一份，
    // prepareFile 至少不会因为「四个补丁全失败」整体拒绝撤销。
    expect(sameFile).toHaveLength(1);
  });
});
