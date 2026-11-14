import { describe, expect, it } from "vitest";
import type { AgentSubagent, ChatMessage } from "@/stores/chat-store";
import {
  collectRunningSubagents,
  formatIdleAgo,
  formatSubagentUsage,
  getSubagentCacheRate,
  getSubagentElapsedMs,
  getSubagentIdleMs,
  isSubagentStalled,
  SUBAGENT_STALL_MS,
} from "./subagentMonitorModel";

const subagent = (overrides: Partial<AgentSubagent> = {}): AgentSubagent => ({
  id: "call-1:1",
  label: "Reviewer",
  status: "running",
  message: "正在运行 read 工具",
  startedAt: 1_000,
  lastActivityAt: 1_000,
  ...overrides,
});

const message = (id: string, subagents: AgentSubagent[]): ChatMessage => ({
  id,
  role: "assistant",
  content: "",
  timestamp: 1,
  process: {
    startedAt: 1,
    entries: [{
      id: `${id}-entry`,
      type: "subagent",
      title: "Subagent",
      timestamp: 1,
      subagents,
    }],
  },
});

describe("Subagent 监视窗数据", () => {
  it("只收集运行中/等待中的子任务", () => {
    const running = collectRunningSubagents([
      message("m1", [
        subagent({ id: "a", status: "running" }),
        subagent({ id: "b", status: "pending" }),
        subagent({ id: "c", status: "completed" }),
        subagent({ id: "d", status: "error" }),
      ]),
    ]);

    expect(running.map((item) => item.id)).toEqual(["a", "b"]);
    expect(running[0].messageId).toBe("m1");
    expect(running[0].entryId).toBe("m1-entry");
  });

  // 进度事件会反复更新同一个子任务，后出现的条目才算最新状态。
  it("同一子任务以最后一条进程条目为准", () => {
    const running = collectRunningSubagents([
      message("m1", [subagent({ id: "a", message: "旧活动" })]),
      message("m2", [subagent({ id: "a", message: "新活动", lastActivityAt: 2_000 })]),
    ]);

    expect(running).toHaveLength(1);
    expect(running[0].message).toBe("新活动");
    expect(running[0].messageId).toBe("m2");
  });

  it("会话结束时（任务已终态）不返回任何内容", () => {
    expect(collectRunningSubagents([message("m1", [subagent({ status: "completed" })])])).toEqual([]);
    expect(collectRunningSubagents([])).toEqual([]);
  });

  // 旧数据里残留的占位项永远不会收到终态事件；条目都结束了就别再给它开页签。
  it("条目已结束时忽略残留的 running 子任务", () => {
    const finished = message("m1", [
      subagent({ id: "call-1", label: "Subagent", status: "running" }),
      subagent({ id: "call-1:1", status: "completed" }),
    ]);
    finished.process!.entries[0].state = "completed";
    expect(collectRunningSubagents([finished])).toEqual([]);
  });

  it("耗时按任务自己的 startedAt 算，完成后冻结在 completedAt", () => {
    expect(getSubagentElapsedMs(subagent({ startedAt: 1_000 }), 61_000)).toBe(60_000);
    expect(getSubagentElapsedMs(subagent({ startedAt: 1_000, completedAt: 31_000 }), 99_000)).toBe(30_000);
    // 老后端没有 startedAt：不硬造数字。
    expect(getSubagentElapsedMs({ id: "x", label: "X" }, 9_999)).toBeUndefined();
  });

  it("超过阈值没有活动就判定为可能卡住", () => {
    const running = subagent({ status: "running", lastActivityAt: 1_000 });
    expect(getSubagentIdleMs(running, 1_000 + SUBAGENT_STALL_MS - 1)).toBe(SUBAGENT_STALL_MS - 1);
    expect(isSubagentStalled(running, 1_000 + SUBAGENT_STALL_MS - 1)).toBe(false);
    expect(isSubagentStalled(running, 1_000 + SUBAGENT_STALL_MS)).toBe(true);
    // 已结束的任务不提示卡住。
    expect(isSubagentStalled(subagent({ status: "completed", lastActivityAt: 1_000 }), 999_999)).toBe(false);
  });

  it("最后活动时长的文案分秒/分", () => {
    expect(formatIdleAgo(3_000)).toBe("3 秒前");
    expect(formatIdleAgo(59_000)).toBe("59 秒前");
    expect(formatIdleAgo(8 * 60_000)).toBe("8 分钟前");
    expect(formatIdleAgo(2 * 60 * 60_000)).toBe("2 小时前");
  });
});

describe("子任务消耗摘要", () => {
  it("拼出 token / 缓存命中 / 轮次", () => {
    expect(formatSubagentUsage({
      inputTokens: 12_000,
      outputTokens: 3_400,
      cacheReadTokens: 10_440,
      totalTokens: 15_400,
      turns: 3,
    })).toBe("15.4k token · 缓存 87% · 3 轮");
  });

  it("后端只报 input/output 时自己算总数", () => {
    // pi 的 usage 没有 totalTokens，不补的话只会显示轮次
    expect(formatSubagentUsage({ inputTokens: 512, outputTokens: 128, turns: 1 }))
      .toBe("640 token · 1 轮");
  });

  it("没有缓存数据时不写缓存率，空用量返回空串", () => {
    expect(formatSubagentUsage({ inputTokens: 800 })).toBe("800 token");
    expect(formatSubagentUsage({})).toBe("");
    expect(formatSubagentUsage(undefined)).toBe("");
  });

  it("缓存率落在 0..1 且没有输入时为 undefined", () => {
    expect(getSubagentCacheRate({ inputTokens: 100, cacheReadTokens: 250 })).toBe(1);
    expect(getSubagentCacheRate({ inputTokens: 4, cacheReadTokens: 1 })).toBe(0.25);
    expect(getSubagentCacheRate({ outputTokens: 10 })).toBeUndefined();
    expect(getSubagentCacheRate(undefined)).toBeUndefined();
  });
});
