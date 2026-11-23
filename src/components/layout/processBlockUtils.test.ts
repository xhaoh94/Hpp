import { describe, expect, it } from "vitest";
import type {
  AgentProcess,
  AgentProcessEntry,
  AgentProcessStep,
} from "@/stores/chat-store";
import {
  getStepProgressText,
  getSubagentDisplayTitle,
  getSubagentSummaryText,
  getSubagentTitle,
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

describe("getSubagentTitle", () => {
  it("shrinks a task description to verb + core object", () => {
    const prompt = "请独立编写行为测试，仅新增 Tools/Tests/RedPointDisplayBindingTest.lua，不改生产文件。背景：即将新增 prefab";
    expect(getSubagentTitle(prompt)).toBe("编写测试");
    expect(getSubagentTitle("请审查迁移回归风险")).toBe("审查风险");
    expect(getSubagentTitle("请排查登录接口的异常")).toBe("排查异常");
  });

  it("drops adverbials, polite prefixes and trailing punctuation", () => {
    expect(getSubagentTitle("请你帮我审查这段逻辑：")).toBe("审查逻辑");
    expect(getSubagentTitle("麻烦看一下这个 bug。")).toBe("看bug");
    expect(getSubagentTitle("正在修复支付回调问题")).toBe("修复问题");
  });

  it("peels scope prefixes off noun-style task names", () => {
    // 截图真实数据：一级保留全名，胶囊剥掉「全项目剩余动态」前缀。
    expect(getSubagentTitle("全项目剩余动态红点迁移C组")).toBe("红点迁移C组");
    expect(getSubagentTitle("全项目剩余动态红点迁移A组")).toBe("红点迁移A组");
    expect(getSubagentSummaryText("全项目剩余动态红点迁移C组")).toBe("全项目剩余动态红点迁移C组");
  });

  it("keeps titles it cannot safely shorten instead of mangling them", () => {
    expect(getSubagentTitle("", "修复完成\n下一步：验证")).toBe("修复完成");
    expect(getSubagentTitle("随便聊聊这件事")).toBe("随便聊聊这件事");
    expect(getSubagentTitle()).toBe("");
  });

  it("caps very long single clauses", () => {
    const title = getSubagentTitle(`请${"做一件事".repeat(20)}`);
    expect(title.length).toBe(41);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("getSubagentDisplayTitle", () => {
  it("shrinks a scheduler-supplied title too", () => {
    // claude 的 Task 没有独立 title 参数，description 常常就是一句话。
    expect(getSubagentDisplayTitle({ title: "请独立编写行为测试" })).toBe("编写测试");
    expect(getSubagentDisplayTitle({ title: "全项目剩余动态红点迁移C组" })).toBe("红点迁移C组");
  });

  it("keeps an already-minimal title untouched", () => {
    expect(getSubagentDisplayTitle({ title: "审查风险" })).toBe("审查风险");
    expect(getSubagentDisplayTitle({ title: "补齐静态红点" })).toBe("补齐静态红点");
  });

  it("falls back to the prompt when no title was given", () => {
    expect(getSubagentDisplayTitle({ prompt: "请审查迁移回归风险，不改生产文件" })).toBe("审查风险");
    expect(getSubagentDisplayTitle({ label: "Explore" })).toBe("Explore");
    expect(getSubagentDisplayTitle({})).toBe("");
  });
});

describe("getSubagentSummaryText", () => {
  it("keeps the unshortened first clause, unlike the verb-object title", () => {
    const prompt = "请独立编写行为测试，仅新增 Tools/Tests/RedPointDisplayBindingTest.lua，不改生产文件。背景：即将新增 prefab";
    expect(getSubagentTitle(prompt)).toBe("编写测试");
    // 一级保留原始分句，不做动宾压缩，也不带后面的路径/约束。
    expect(getSubagentSummaryText(prompt)).toBe("独立编写行为测试");
  });

  it("cuts at the first comma/semicolon and caps very long clauses", () => {
    expect(getSubagentSummaryText("审查迁移回归风险，不改生产文件")).toBe("审查迁移回归风险");
    expect(getSubagentSummaryText("第一句；第二句。第三句")).toBe("第一句");
    const long = getSubagentSummaryText(`请${"做一件事".repeat(30)}，后面还有`);
    expect(long.length).toBe(41);
    expect(long.endsWith("…")).toBe(true);
  });

  it("falls back to detailed output and handles empty input", () => {
    expect(getSubagentSummaryText("", "修复完成\n下一步：验证")).toBe("修复完成");
    expect(getSubagentSummaryText()).toBe("");
  });
});
