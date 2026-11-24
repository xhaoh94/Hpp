import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Hpp worker extension is intentionally shipped as ESM.
import { createSubagentStorage } from "./subagent-storage.mjs";

const taskEntry = (overrides: Record<string, unknown> = {}) => ({
  id: "sa_bg1",
  agent: "scout",
  agentScope: "user",
  task: "检查构建",
  lastTask: "检查构建",
  title: "检查构建",
  model: "pool/a",
  cwd: "",
  isolation: undefined,
  kind: "single",
  status: "completed",
  sessionFile: "",
  resultFile: "",
  startedAt: 1_700_000_000_000,
  completedAt: 1_700_000_010_000,
  lastActivityAt: 1_700_000_010_000,
  rounds: [{ task: "检查构建", status: "completed" }],
  usage: { input: 10, output: 20, turns: 1 },
  lastRoundUsage: { input: 10, output: 20, turns: 1 },
  toolCallId: "call-1",
  ...overrides,
});

describe("Pi 子任务持久化", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-storage-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("重建后同会话能读回任务与公开结果", async () => {
    const storage = createSubagentStorage(root, "parent-1");
    const result = {
      agent: "scout",
      task: "检查构建",
      exitCode: 0,
      output: "构建通过",
      stopReason: "stop",
      model: "pool/a",
    };
    storage.saveTask(taskEntry({ resultFile: join(storage.directory, "sa_bg1.result.md") }), result);

    // 模拟 worker 重启 / reload 后的新实例。
    const reopened = createSubagentStorage(root, "parent-1");
    expect(reopened.directory).toBe(storage.directory);
    expect(reopened.loadTask("sa_bg1")).toMatchObject({
      version: 1,
      id: "sa_bg1",
      agent: "scout",
      status: "completed",
      kind: "single",
      model: "pool/a",
      usage: { input: 10, output: 20 },
      result: { output: "构建通过", stopReason: "stop", exitCode: 0 },
    });
  });

  it("跨会话不共享任务记录", async () => {
    const first = createSubagentStorage(root, "parent-1");
    first.saveTask(taskEntry(), { output: "会话一的结论" });
    first.saveIsolation("sa_bg1", {
      id: "sa_bg1",
      status: "changed",
      worktree: { id: "sa_bg1", repoRoot: root, projectRoot: root, worktreePath: join(root, "wt") },
    });

    // 另一个会话用同一个任务 id 也必须查不到：目录按会话隔离。
    const second = createSubagentStorage(root, "parent-2");
    expect(second.directory).not.toBe(first.directory);
    expect(second.loadTask("sa_bg1")).toBeUndefined();
    expect(second.loadIsolation("sa_bg1")).toBeUndefined();
    // 同一个 id 在另一个会话里是全新记录，不会覆盖原会话的结果。
    second.saveTask(taskEntry(), { output: "会话二的结论" });
    expect(first.loadTask("sa_bg1")?.result).toMatchObject({ output: "会话一的结论" });
    expect(second.loadTask("sa_bg1")?.result).toMatchObject({ output: "会话二的结论" });
  });

  it("不会把非法任务 id 写成路径穿越", async () => {
    const storage = createSubagentStorage(root, "parent-1");
    for (const id of ["../escape", "sa_bg1/../../escape", "sync-1", "", "sa_../../x"]) {
      storage.saveTask(taskEntry({ id }), { output: "不该落盘" });
    }
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("只接受版本与 id 都匹配的记录", async () => {
    const storage = createSubagentStorage(root, "parent-1");
    storage.saveTask(taskEntry(), { output: "ok" });
    const path = join(storage.directory, "sa_bg1.task.json");
    const original = JSON.parse(await readFile(path, "utf8"));

    await writeFile(path, JSON.stringify({ ...original, version: 2 }), "utf8");
    expect(storage.loadTask("sa_bg1")).toBeUndefined();

    await writeFile(path, JSON.stringify({ ...original, id: "sa_other" }), "utf8");
    expect(storage.loadTask("sa_bg1")).toBeUndefined();

    // 坏 JSON 只丢弃这一条，不能让调用方抛错。
    await writeFile(path, "{ not json", "utf8");
    expect(storage.loadTask("sa_bg1")).toBeUndefined();
  });

  it("隔离记录可以保存、读回并清除", async () => {
    const storage = createSubagentStorage(root, "parent-1");
    const info = { id: "sa_wt1", repoRoot: "/repo", projectRoot: "/repo", worktreePath: "/wt/sa_wt1", branch: "hpp-sub/sa_wt1" };
    storage.saveIsolation("sa_wt1", { id: "sa_wt1", worktree: info, status: "changed" });
    expect(createSubagentStorage(root, "parent-1").loadIsolation("sa_wt1")).toMatchObject({
      id: "sa_wt1",
      worktree: { branch: "hpp-sub/sa_wt1" },
    });
    storage.saveIsolation("sa_wt1", null);
    expect(storage.loadIsolation("sa_wt1")).toBeUndefined();
    // 清除不能顺手删掉任务记录。
    storage.saveTask(taskEntry({ id: "sa_wt1" }), { output: "留着我" });
    storage.saveIsolation("sa_wt1", null);
    expect(storage.loadTask("sa_wt1")).toMatchObject({ id: "sa_wt1" });
  });

  it("同会话能按旧版 Markdown 结果恢复已结束任务", async () => {
    const storage = createSubagentStorage(root, "parent-1");
    await mkdir(storage.directory, { recursive: true });
    const resultFile = join(storage.directory, "w_legacy.result.md");
    await writeFile(resultFile, [
      "# 旧任务",
      "- id: w_legacy",
      "- agent: worker",
      "- model: (默认)",
      "- status: completed",
      "- startedAt: 2024-01-01T00:00:00.000Z",
      "- completedAt: 2024-01-01T00:05:00.000Z",
      "",
      "旧任务的结论",
    ].join("\n"), "utf8");

    expect(storage.loadTask("w_legacy")).toMatchObject({
      id: "w_legacy",
      agent: "worker",
      kind: "single",
      status: "completed",
      model: undefined,
      sessionFile: join(storage.directory, "w_legacy.jsonl"),
      result: { agent: "worker", output: "旧任务的结论", exitCode: 0 },
    });
    // 旧版记录不能跨会话认领。
    expect(createSubagentStorage(root, "parent-2").loadTask("w_legacy")).toBeUndefined();
  });

  it("旧版 Markdown 里的 id 与文件名不一致时不认领", async () => {
    const storage = createSubagentStorage(root, "parent-1");
    await mkdir(storage.directory, { recursive: true });
    await writeFile(join(storage.directory, "w_legacy.result.md"), [
      "# 旧任务",
      "- id: w_other",
      "- agent: worker",
      "- model: (默认)",
      "- status: completed",
      "- startedAt: 2024-01-01T00:00:00.000Z",
      "",
      "别人的结论",
    ].join("\n"), "utf8");
    expect(storage.loadTask("w_legacy")).toBeUndefined();
  });

  it("会话 key 为空或全是点号时退回 default 目录", () => {
    for (const key of [undefined, "", ".", ".."]) {
      expect(createSubagentStorage(root, key).directory).toBe(join(root, "default"));
    }
    // 带斜杠的 key 只会被替换成下划线，不会向上跳出数据目录。
    expect(createSubagentStorage(root, "../..").directory).toBe(join(root, ".._.."));
    // 会话文件名里常见的分隔符/空格只做替换，不改变目录层级。
    expect(createSubagentStorage(root, "a b/c").directory).toBe(join(root, "a_b_c"));
    // 没有配置数据目录时完全不落盘。
    expect(createSubagentStorage("", "parent-1").directory).toBeFalsy();
  });

  it("目录不可写时不抛错，也不破坏已有记录", async () => {
    const storage = createSubagentStorage(root, "parent-1");
    storage.saveTask(taskEntry(), { output: "第一版" });
    // 落盘失败（这里直接把目录替换成文件）只应告警。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await rm(storage.directory, { recursive: true, force: true });
      await writeFile(storage.directory, "not a directory", "utf8");
      expect(() => storage.saveTask(taskEntry(), { output: "第二版" })).not.toThrow();
      expect(warn).toHaveBeenCalled();
      expect(storage.loadTask("sa_bg1")).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});
