import { describe, expect, it } from "vitest";
import type {
  AgentProcess,
  AgentProcessEntry,
  AgentProcessStep,
} from "@/stores/chat-store";
import {
  getStepProgressText,
  normalizeInferredStepsForDisplay,
  summarizeProcessEntries,
} from "./processBlockUtils";

const createProcess = (patch: Partial<AgentProcess>): AgentProcess => ({
  startedAt: 1000,
  entries: [],
  ...patch,
});

const step = (id: string, status: AgentProcessStep["status"]): AgentProcessStep => ({
  id,
  title: id,
  status,
});

const entry = (patch: Partial<AgentProcessEntry>): AgentProcessEntry => ({
  id: "entry",
  type: "status",
  title: "状态",
  timestamp: 1000,
  ...patch,
});

describe("processBlockUtils", () => {
  it("keeps inferred display to three steps when no files changed", () => {
    const process = createProcess({
      endedAt: 2000,
      planStepsSource: "inferred",
      planSteps: [
        step("inferred-analyze", "completed"),
        step("inferred-operate", "completed"),
        step("inferred-verify", "pending"),
      ],
    });

    expect(normalizeInferredStepsForDisplay(process, process.planSteps || [])).toEqual([
      { id: "inferred-analyze", title: "分析请求", status: "completed" },
      { id: "inferred-operate", title: "执行操作", status: "completed" },
      { id: "inferred-verify", title: "验证总结", status: "completed" },
    ]);
  });

  it("adds a modify display step when change summary reports files", () => {
    const process = createProcess({
      planStepsSource: "inferred",
      changeSummary: { filesChanged: 1, additions: 2, deletions: 0 },
      planSteps: [
        step("inferred-analyze", "completed"),
        step("inferred-operate", "running"),
        step("inferred-verify", "pending"),
      ],
    });

    expect(normalizeInferredStepsForDisplay(process, process.planSteps || [])).toEqual([
      { id: "inferred-analyze", title: "分析请求", status: "completed" },
      { id: "inferred-operate", title: "执行操作", status: "completed" },
      { id: "inferred-modify", title: "修改文件", status: "running" },
      { id: "inferred-verify", title: "验证总结", status: "pending" },
    ]);
  });

  it("does not let a failed modify step overwrite completed operate state", () => {
    const process = createProcess({
      planStepsSource: "inferred",
      planSteps: [
        step("inferred-analyze", "completed"),
        step("inferred-operate", "completed"),
        step("inferred-modify", "failed"),
        step("inferred-verify", "pending"),
      ],
    });

    expect(normalizeInferredStepsForDisplay(process, process.planSteps || [])).toEqual([
      { id: "inferred-analyze", title: "分析请求", status: "completed" },
      { id: "inferred-operate", title: "执行操作", status: "completed" },
      { id: "inferred-modify", title: "修改文件", status: "failed" },
      { id: "inferred-verify", title: "验证总结", status: "pending" },
    ]);
  });

  it("formats progress using terminal step position before completion counts", () => {
    expect(getStepProgressText([
      step("one", "completed"),
      step("two", "completed"),
      step("three", "failed"),
      step("four", "pending"),
    ])).toBe("第 3 / 4 步");

    expect(getStepProgressText([
      step("one", "completed"),
      step("two", "completed"),
      step("three", "pending"),
    ])).toBe("已完成 2 / 3");
  });

  it("summarizes process entries by active state before counts", () => {
    expect(summarizeProcessEntries([])).toBe("等待事件");

    expect(summarizeProcessEntries([
      entry({ type: "thinking", state: "running", detail: "  正在\n分析  " }),
    ])).toBe("正在思考: 正在 分析");

    expect(summarizeProcessEntries([
      entry({ id: "tool", type: "tool", state: "running", title: "正在读取 1 个文件" }),
      entry({ id: "diff", type: "diff", title: "diff" }),
    ])).toBe("正在读取 1 个文件");

    expect(summarizeProcessEntries([
      entry({ id: "tool", type: "tool", title: "工具" }),
      entry({ id: "diff", type: "diff", title: "diff" }),
    ])).toBe("已执行 1 个操作, 修改 1 个文件");

    expect(summarizeProcessEntries([
      entry({ id: "stop", type: "tool", state: "interrupted" }),
    ])).toBe("已中断");
  });
});
