import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/types";
import { createSessionRuntime } from "./agentEventUtils";
import { handleToolEndEvent } from "./agentToolHandlers";
import type { AgentEventHandlerContext, ProcessEntryDraft } from "./agentEventTypes";

const createContext = () => {
  const entries: ProcessEntryDraft[] = [];
  const updateInferredPlanSteps = vi.fn();
  const context = {
    pendingUIResponseRef: { current: null },
    appendProcessEntry: (_sessionId: string, entry: ProcessEntryDraft) => entries.push(entry),
    updateInferredPlanSteps,
    recordProcessFiles: vi.fn(),
    finishAssistantProcessText: vi.fn(),
    finishThinkingEntry: vi.fn(),
  } as unknown as AgentEventHandlerContext;
  return { context, entries, updateInferredPlanSteps };
};

describe("handleToolEndEvent", () => {
  it("renders a non-zero command exit as a warning without failing the inferred plan", () => {
    const { context, entries, updateInferredPlanSteps } = createContext();

    handleToolEndEvent({
      type: "tool_end",
      toolKind: "run_command",
      command: "rg missing",
      exitCode: 1,
      isError: true,
    } as AgentEvent, "session-1", createSessionRuntime(), context);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "tool",
      state: "warning",
      title: "命令返回非零退出码 1",
      command: "rg missing",
      exitCode: 1,
    });
    expect(updateInferredPlanSteps).toHaveBeenCalledWith("session-1", "operate");
    expect(updateInferredPlanSteps).not.toHaveBeenCalledWith("session-1", "failed");
  });

  it("renders non-command tool failures as recoverable warnings", () => {
    const { context, entries, updateInferredPlanSteps } = createContext();

    handleToolEndEvent({
      type: "tool_end",
      toolKind: "read_file",
      filePath: "src/missing.ts",
      errorText: "File not found",
      isError: true,
    } as AgentEvent, "session-1", createSessionRuntime(), context);

    expect(entries[0]).toMatchObject({
      type: "tool",
      state: "warning",
      title: "读取文件未成功",
      detail: "File not found",
      files: [{ file: "src/missing.ts", action: "read" }],
    });
    expect(updateInferredPlanSteps).toHaveBeenCalledWith("session-1", "operate");
    expect(updateInferredPlanSteps).not.toHaveBeenCalledWith("session-1", "failed");
  });
});
