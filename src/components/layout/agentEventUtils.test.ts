import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/types";
import {
  buildInferredPlanSteps,
  createSessionRuntime,
  getToolSummary,
  getUIResponsePayload,
  mergeRuntimeChangeFile,
  summarizeRuntimeChanges,
} from "./agentEventUtils";

describe("agentEventUtils", () => {
  it("builds inferred steps without a modify step until files change", () => {
    const runtime = createSessionRuntime();

    expect(buildInferredPlanSteps(runtime)).toBeNull();

    expect(buildInferredPlanSteps(runtime, "analyze")).toMatchObject([
      { id: "inferred-analyze", title: "分析请求", status: "running" },
      { id: "inferred-operate", title: "执行操作", status: "pending" },
      { id: "inferred-verify", title: "验证总结", status: "pending" },
    ]);

    expect(buildInferredPlanSteps(runtime, "operate")).toMatchObject([
      { id: "inferred-analyze", status: "completed" },
      { id: "inferred-operate", status: "running" },
      { id: "inferred-verify", status: "pending" },
    ]);

    expect(buildInferredPlanSteps(runtime, "modify")).toMatchObject([
      { id: "inferred-analyze", status: "completed" },
      { id: "inferred-operate", status: "completed" },
      { id: "inferred-modify", title: "修改文件", status: "running" },
      { id: "inferred-verify", status: "pending" },
    ]);
  });

  it("places terminal failure on the active inferred step", () => {
    const runtime = createSessionRuntime();

    buildInferredPlanSteps(runtime, "modify");

    expect(buildInferredPlanSteps(runtime, "failed")).toMatchObject([
      { id: "inferred-analyze", status: "completed" },
      { id: "inferred-operate", status: "completed" },
      { id: "inferred-modify", status: "failed" },
      { id: "inferred-verify", status: "pending" },
    ]);
  });

  it("adds modify step when change summary sees files", () => {
    const runtime = createSessionRuntime();

    expect(mergeRuntimeChangeFile(runtime, {
      file: "src/App.tsx",
      additions: 3,
      deletions: 1,
      changeKey: "patch-1",
    })).toBe(true);

    expect(mergeRuntimeChangeFile(runtime, {
      file: "src/App.tsx",
      additions: 3,
      deletions: 1,
      changeKey: "patch-1",
    })).toBe(false);

    expect(summarizeRuntimeChanges(runtime)).toEqual({
      filesChanged: 1,
      additions: 3,
      deletions: 1,
    });

    expect(buildInferredPlanSteps(runtime, "operate")?.map((step) => step.id)).toEqual([
      "inferred-analyze",
      "inferred-operate",
      "inferred-modify",
      "inferred-verify",
    ]);
  });

  it("does not generate inferred steps when native plan steps are active", () => {
    const runtime = createSessionRuntime();
    runtime.nativePlanSteps = true;

    expect(buildInferredPlanSteps(runtime, "analyze")).toBeNull();
  });

  it("normalizes confirm UI responses with localized negative answers", () => {
    expect(getUIResponsePayload({
      sessionId: "s1",
      requestId: "r1",
      method: "confirm",
      text: "否",
    })).toMatchObject({
      sessionId: "s1",
      type: "extension_ui_response",
      id: "r1",
      method: "confirm",
      confirmed: false,
      cancelled: false,
    });

    expect(getUIResponsePayload({
      sessionId: "s1",
      method: "confirm",
      text: " yes ",
    })).toMatchObject({
      sessionId: "s1",
      method: "confirm",
      confirmed: true,
    });
  });

  it("summarizes tool events for files, commands, and failures", () => {
    expect(getToolSummary({
      type: "tool",
      toolKind: "read_file",
      filePath: "src/App.tsx",
    } as AgentEvent, true)).toBe("正在读取 1 个文件");

    expect(getToolSummary({
      type: "tool",
      toolKind: "run_command",
      toolName: "npm test",
    } as AgentEvent, false)).toBe("已运行 npm test");

    expect(getToolSummary({
      type: "tool",
      toolKind: "write_file",
      isError: true,
    } as AgentEvent, false)).toBe("写入文件失败");
  });
});
