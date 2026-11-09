import { describe, expect, it } from "vitest";
import type { AgentSubagent, ChatMessage } from "@/stores/chat-store";
import {
  collectRunningSubagents,
  formatIdleAgo,
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
