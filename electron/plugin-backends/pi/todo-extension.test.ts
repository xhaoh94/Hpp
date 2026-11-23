import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// Hpp worker 侧扩展以 ESM .mjs 形式发布，项目没有对应的类型声明。
// @ts-expect-error Hpp worker extension is intentionally shipped as ESM.
import {
  createHppTodoExtension,
  formatTodoContent,
  normalizeTodoDraft,
  readTodoSnapshotFromBranch,
  TODO_GUIDANCE,
  TODO_TOOL_NAME,
} from "./todo-extension.mjs";

const createHarness = () => {
  const tools: Array<Record<string, any>> = [];
  const handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
  const appendEntry = vi.fn();
  const extension = createHppTodoExtension();
  extension({
    on: (name: string, handler: (event: unknown, context: unknown) => unknown) => {
      const list = handlers.get(name) || [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool: (tool: Record<string, any>) => tools.push(tool),
    appendEntry,
  });
  return { extension, tools, handlers, appendEntry };
};

const runTodo = async (tool: Record<string, any>, todos: unknown) => tool.execute(
  "call-todo",
  { todos },
  new AbortController().signal,
  undefined,
  { hasUI: false },
);

describe("Pi todo extension", () => {
  it("注册 todo_write，并按 UI 契约把每一项写成 #id", async () => {
    const { tools } = createHarness();
    expect(tools.map((tool) => tool.name)).toEqual([TODO_TOOL_NAME]);
    const result = await runTodo(tools[0], [
      { id: "1", title: "定位压缩阈值读取路径", status: "completed" },
      { id: "2", title: "改造 worker 扩展装配", status: "in_progress" },
      { id: "3", title: "补测试", status: "pending" },
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe([
      "任务列表已更新（1/3 完成）：",
      "#1 ✓ 定位压缩阈值读取路径",
      "#2 ▶ 改造 worker 扩展装配",
      "#3 ○ 补测试",
    ].join("\n"));
    // UI 的 normalizePlanStepsFromToolResult 只读 details.tasks。
    expect(result.details).toMatchObject({
      version: 1,
      tasks: [
        { id: "1", title: "定位压缩阈值读取路径", status: "completed" },
        { id: "2", title: "改造 worker 扩展装配", status: "in_progress" },
        { id: "3", title: "补测试", status: "pending" },
      ],
    });
  });

  it("整表覆盖：后一次调用替换前一次列表", async () => {
    const { tools, extension } = createHarness();
    await runTodo(tools[0], [{ id: "1", title: "第一版", status: "pending" }]);
    const result = await runTodo(tools[0], [{ id: "9", title: "第二版", status: "completed" }]);
    expect(result.details.tasks).toEqual([{ id: "9", title: "第二版", status: "completed" }]);
    expect(extension.getTasks()).toEqual([{ id: "9", title: "第二版", status: "completed" }]);
  });

  it("空数组表示清空列表", async () => {
    const { tools, extension } = createHarness();
    await runTodo(tools[0], [{ id: "1", title: "旧任务", status: "pending" }]);
    const result = await runTodo(tools[0], []);
    expect(result.content[0].text).toBe("任务列表已清空。");
    expect(result.details.tasks).toEqual([]);
    expect(extension.getTasks()).toEqual([]);
  });

  it("拒绝重复 id、空标题、非法状态和多项 in_progress", () => {
    expect(normalizeTodoDraft([{ id: "1", title: "a", status: "pending" }, { id: "1", title: "b", status: "pending" }]))
      .toEqual({ error: "任务 id 重复：1" });
    expect(normalizeTodoDraft([{ id: "1", title: "  ", status: "pending" }]))
      .toEqual({ error: "任务 #1 缺少 title" });
    expect(normalizeTodoDraft([{ id: "1", title: "a", status: "doing" }]).error).toContain("status 无效");
    expect(normalizeTodoDraft([{ id: "任务一", title: "a", status: "pending" }]).error).toContain("任务 id 只能包含");
    expect(normalizeTodoDraft([
      { id: "1", title: "a", status: "in_progress" },
      { id: "2", title: "b", status: "in_progress" },
    ]).error).toContain("只能有 1 个 in_progress");
  });

  it("最多 50 项", () => {
    const tooMany = Array.from({ length: 51 }, (_, index) => ({
      id: String(index + 1),
      title: `任务 ${index + 1}`,
      status: "pending",
    }));
    expect(normalizeTodoDraft(tooMany).error).toContain("最多 50 项");
  });

  it("校验失败时返回 isError，且不覆盖已有状态", async () => {
    const { tools, extension } = createHarness();
    await runTodo(tools[0], [{ id: "1", title: "有效任务", status: "pending" }]);
    const result = await runTodo(tools[0], [
      { id: "1", title: "a", status: "in_progress" },
      { id: "2", title: "b", status: "in_progress" },
    ]);
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toContain("只能有 1 个 in_progress");
    expect(extension.getTasks()).toEqual([{ id: "1", title: "有效任务", status: "pending" }]);
  });

  it("从分支历史恢复最后一次快照", () => {
    const branch = [
      { type: "message", message: { role: "user", content: [] } },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: TODO_TOOL_NAME,
          details: { version: 1, tasks: [{ id: "1", title: "旧", status: "completed" }] },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: TODO_TOOL_NAME,
          details: { version: 1, tasks: [{ id: "2", title: "新", status: "in_progress" }] },
        },
      },
    ];
    expect(readTodoSnapshotFromBranch(branch)).toEqual([{ id: "2", title: "新", status: "in_progress" }]);
    // 没有 todo_write 时返回 null，不能把「没建列表」误当成「已清空」。
    expect(readTodoSnapshotFromBranch([])).toBeNull();
    expect(readTodoSnapshotFromBranch([{ type: "message", message: { role: "toolResult", toolName: "read" } }]))
      .toBeNull();
  });

  it("session_start / session_tree 时按当前分支重建", async () => {
    const { extension, handlers } = createHarness();
    const context = {
      sessionManager: {
        getBranch: () => [{
          type: "message",
          message: {
            role: "toolResult",
            toolName: TODO_TOOL_NAME,
            details: { version: 1, tasks: [{ id: "7", title: "恢复项", status: "pending" }] },
          },
        }],
      },
    };
    for (const name of ["session_start", "session_tree"]) {
      const list = handlers.get(name) || [];
      expect(list).toHaveLength(1);
      await list[0]({}, context);
      expect(extension.getTasks()).toEqual([{ id: "7", title: "恢复项", status: "pending" }]);
    }
  });

  it("只把未完成任务注入上下文", async () => {
    const { tools, extension } = createHarness();
    await runTodo(tools[0], [
      { id: "1", title: "已完成", status: "completed" },
      { id: "2", title: "进行中", status: "in_progress" },
      { id: "3", title: "取消", status: "cancelled" },
      { id: "4", title: "待办", status: "pending" },
    ]);
    const context = extension.buildUnfinishedContext();
    expect(context).toContain("#2 ▶ 进行中");
    expect(context).toContain("#4 ○ 待办");
    expect(context).not.toContain("已完成");
    expect(context).not.toContain("取消");
  });

  it("提示词写清使用时机与 in_progress 约束", () => {
    expect(TODO_GUIDANCE).toContain("3 步及以上");
    expect(TODO_GUIDANCE).toContain("in_progress");
    expect(formatTodoContent([])).toBe("任务列表已清空。");
  });

  it("保留 P4 的 owner / blockedBy 字段", async () => {
    const { tools } = createHarness();
    const result = await runTodo(tools[0], [
      { id: "1", title: "先做", status: "completed" },
      { id: "2", title: "后面做", status: "pending", owner: "sa_1", blockedBy: ["1", "1", ""] },
    ]);
    expect(result.details.tasks[1]).toMatchObject({ owner: "sa_1", blockedBy: ["1"] });
  });

  it("updateTask 修改 owner/status 并 appendEntry 持久化", async () => {
    const { tools, extension, appendEntry } = createHarness();
    await runTodo(tools[0], [{ id: "1", title: "任务", status: "pending" }]);
    appendEntry.mockClear();

    expect(extension.updateTask("1", { status: "in_progress", owner: "sa_9" })).toMatchObject({
      id: "1",
      status: "in_progress",
      owner: "sa_9",
    });
    expect(extension.updateTask("missing", { status: "completed" })).toBeNull();
    expect(appendEntry).toHaveBeenCalledWith("hpp-todo", expect.objectContaining({
      tasks: [expect.objectContaining({ id: "1", status: "in_progress", owner: "sa_9" })],
    }));

    extension.updateTask("1", { status: "pending", owner: "", lastError: "失败了" });
    expect(extension.findTask("1")).toMatchObject({ status: "pending", lastError: "失败了" });
    expect(extension.findTask("1")?.owner).toBeUndefined();
  });

  it("从 appendEntry 的 hpp-todo 记录恢复后台状态", () => {
    const { extension } = createHarness();
    extension.restoreFromSession({
      sessionManager: {
        getBranch: () => [{
          type: "custom",
          customType: "hpp-todo",
          data: {
            version: 1,
            tasks: [{ id: "1", title: "后台任务", status: "in_progress", owner: "sa_7" }],
          },
        }],
      },
    });
    expect(extension.getTasks()).toEqual([{
      id: "1",
      title: "后台任务",
      status: "in_progress",
      owner: "sa_7",
    }]);
  });

  it("worker 把 todo_write 登记为只读工具并挂进扩展列表", () => {
    const worker = readFileSync(new URL("./worker.mjs", import.meta.url), "utf8");
    // ask 档位下不在只读集合的工具每次调用都会弹审批；plan 模式也靠这个集合放行。
    expect(worker).toMatch(/const READ_ONLY_TOOLS = new Set\(\[[^\]]*TODO_TOOL_NAME[^\]]*\]\)/);
    // 热切换内置扩展后 todo 也必须还在（共用 buildHppExtensionFactories）。
    expect(worker).toContain("activeHppTodoExtension,");
    // 压缩和每轮系统提示都要能读到未完成任务。
    expect(worker).toContain("buildUnfinishedContext");
  });
});