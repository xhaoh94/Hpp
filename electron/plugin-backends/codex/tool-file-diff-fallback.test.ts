import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";
import { CodexAgent } from "./backend";

interface CodexInternals {
  projectPath: string;
  handleWorkerMessage: (message: Record<string, unknown>) => void;
}

type EmittedDiff = {
  file: string;
  patch?: string;
  status?: string;
  additions?: number;
  deletions?: number;
};

/**
 * 不走 init：测试只关心 tool/diff 事件的兜底合成，不需要真的拉起 worker 进程。
 */
const connect = (projectPath: string, events: AgentEvent[]): CodexInternals => {
  const agent = new CodexAgent("session-fallback", (event) => events.push(event as AgentEvent));
  const internals = agent as unknown as CodexInternals;
  internals.projectPath = projectPath;
  return internals;
};

const fileChange = (
  type: "tool_start" | "tool_end",
  files: string[],
): Record<string, unknown> => ({
  type,
  toolName: "file_change",
  toolCallId: "item-1",
  toolKind: "edit_file",
  args: { changes: files.map((path) => ({ path })) },
  files: files.map((file) => ({ file, label: file })),
});

const emittedDiffs = (events: AgentEvent[]): EmittedDiff[] => {
  const updates = events.filter(
    (event) => (event as { type: string }).type === "diff_update",
  ) as unknown as Array<{ diffs: EmittedDiff[] }>;
  return updates.at(-1)?.diffs ?? [];
};

describe("Codex turn file diff fallback", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-fallback-"));
    mkdirSync(join(dir, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers the disk snapshot over a provider patch built from stale content", () => {
    const target = join(dir, "src", "a.ts");
    writeFileSync(target, "const a = 1;\n");
    const events: AgentEvent[] = [];
    const internals = connect(dir, events);

    internals.handleWorkerMessage({ type: "agent_start" });
    internals.handleWorkerMessage(fileChange("tool_start", ["src/a.ts"]));
    writeFileSync(target, "const a = 2;\n");
    internals.handleWorkerMessage(fileChange("tool_end", ["src/a.ts"]));
    // provider 的补丁基于过期上下文，反向应用必然对不上。
    internals.handleWorkerMessage({
      type: "diff_update",
      diffs: [{ file: "src/a.ts", patch: "@@ -1 +1 @@\n-const stale = 0;\n+const a = 2;", additions: 1, deletions: 1 }],
    });

    const diffs = emittedDiffs(events);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ file: "src/a.ts", status: "modified" });
    expect(diffs[0].patch).toContain("-const a = 1;");
    expect(diffs[0].patch).toContain("+const a = 2;");
    expect(diffs[0].patch).not.toContain("stale");
  });

  it("matches the same file across provider and snapshot path separators", () => {
    const target = join(dir, "src", "a.ts");
    writeFileSync(target, "one\n");
    const events: AgentEvent[] = [];
    const internals = connect(dir, events);

    internals.handleWorkerMessage({ type: "agent_start" });
    internals.handleWorkerMessage(fileChange("tool_start", ["src/a.ts"]));
    writeFileSync(target, "two\n");
    internals.handleWorkerMessage(fileChange("tool_end", ["src/a.ts"]));
    // Windows 上 provider 走 path.relative，路径会是反斜杠形式。
    internals.handleWorkerMessage({
      type: "diff_update",
      diffs: [{ file: "src\\a.ts", patch: "@@ -1 +1 @@\n-nope\n+two", additions: 1, deletions: 1 }],
    });

    const diffs = emittedDiffs(events);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].file).toBe("src/a.ts");
    expect(diffs[0].patch).toContain("-one");
    expect(diffs[0].patch).toContain("+two");
  });

  it("keeps provider diffs for files the snapshot never captured", () => {
    const events: AgentEvent[] = [];
    const internals = connect(dir, events);

    internals.handleWorkerMessage({ type: "agent_start" });
    internals.handleWorkerMessage({
      type: "diff_update",
      diffs: [{ file: "src/other.ts", patch: "@@ -1 +1 @@\n-x\n+y", additions: 1, deletions: 1 }],
    });

    const diffs = emittedDiffs(events);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].file).toBe("src/other.ts");
    expect(diffs[0].patch).toContain("+y");
  });

  it("drops the previous turn's baseline when a new turn starts", () => {
    const target = join(dir, "src", "a.ts");
    writeFileSync(target, "v1\n");
    const events: AgentEvent[] = [];
    const internals = connect(dir, events);

    internals.handleWorkerMessage({ type: "agent_start" });
    internals.handleWorkerMessage(fileChange("tool_start", ["src/a.ts"]));
    writeFileSync(target, "v2\n");
    internals.handleWorkerMessage(fileChange("tool_end", ["src/a.ts"]));
    // 本轮没有结算 diff_update（例如被中断），下一轮必须重新抓基线。

    internals.handleWorkerMessage({ type: "agent_start" });
    internals.handleWorkerMessage(fileChange("tool_start", ["src/a.ts"]));
    writeFileSync(target, "v3\n");
    internals.handleWorkerMessage(fileChange("tool_end", ["src/a.ts"]));
    internals.handleWorkerMessage({ type: "diff_update", diffs: [] });

    const diffs = emittedDiffs(events);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].patch).toContain("-v2");
    expect(diffs[0].patch).toContain("+v3");
    expect(diffs[0].patch).not.toContain("v1");
  });

  it("produces a snapshot patch that git can reverse-apply byte-exactly", () => {
    const target = join(dir, "src", "a.ts");
    // 走 CRLF 工作区：provider 的补丁是 LF，落到 CRLF 文件上必然对不上字节；
    // 兜底补丁的内容行直接来自磁盘，自带正确行尾。
    writeFileSync(target, "const a = 1;\r\n");
    const events: AgentEvent[] = [];
    const internals = connect(dir, events);

    internals.handleWorkerMessage({ type: "agent_start" });
    internals.handleWorkerMessage(fileChange("tool_start", ["src/a.ts"]));
    writeFileSync(target, "const a = 2;\r\n");
    internals.handleWorkerMessage(fileChange("tool_end", ["src/a.ts"]));
    internals.handleWorkerMessage({ type: "diff_update", diffs: [] });

    const patch = emittedDiffs(events)[0].patch || "";
    // 撤销就是把这份补丁反向应用回去；不能 apply 的补丁等于撤销按钮不可用。
    // 参数与生产一致：关掉 autocrlf，否则 git 会按本机配置改写行尾。
    const applied = spawnSync(
      "git",
      ["-c", "core.autocrlf=false", "apply", "--reverse", "--whitespace=nowarn", "-"],
      {
        cwd: dir,
        input: patch.endsWith("\n") ? patch : `${patch}\n`,
        encoding: "utf-8",
      },
    );
    expect(applied.stderr || "").toBe("");
    expect(applied.status).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("const a = 1;\r\n");
  });
});
