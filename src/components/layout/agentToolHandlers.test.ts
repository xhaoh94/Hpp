import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/types";
import { createSessionRuntime } from "./agentEventUtils";
import { handleToolEndEvent, handleToolStartEvent, resolveActiveToolKey } from "./agentToolHandlers";
import type { AgentEventHandlerContext, ProcessEntryDraft } from "./agentEventTypes";

const createContext = () => {
  const entries: ProcessEntryDraft[] = [];
  const updateInferredPlanSteps = vi.fn();
  const updateProcessPlanSteps = vi.fn();
  const context = {
    getPendingUIResponse: () => null,
    getPendingUIFromEvent: vi.fn(() => ({
      sessionId: "session-1",
      requestId: "question-start-id",
      entryId: "question-entry-id",
    })),
    setPendingUIResponse: vi.fn(),
    ensureAssistantContinuation: vi.fn(),
    appendProcessEntry: (_sessionId: string, entry: ProcessEntryDraft) => entries.push(entry),
    updateInferredPlanSteps,
    updateProcessPlanSteps,
    recordProcessFiles: vi.fn(),
    finishAssistantProcessText: vi.fn(),
    finishThinkingEntry: vi.fn(),
  } as unknown as AgentEventHandlerContext;
  return { context, entries, updateInferredPlanSteps, updateProcessPlanSteps };
};

describe("handleToolEndEvent", () => {
  it("matches an end event back to its active entry when the provider changes the call id", () => {
    const runtime = createSessionRuntime();
    runtime.activeToolEntry["start-id"] = "entry-id";
    runtime.activeToolFile["start-id"] = [
      { file: "src/A.ts", action: "read" },
      { file: "src/B.ts", action: "read" },
    ];

    runtime.activeToolKind["start-id"] = "read_file";

    expect(resolveActiveToolKey("end-id", [
      { file: "src\\A.ts" },
      { file: "src/B.ts" },
    ], "read_file", runtime)).toBe("start-id");
  });

  it("correlates writes without matching a different operation on the same file", () => {
    const runtime = createSessionRuntime();
    runtime.activeToolEntry.read = "read-entry";
    runtime.activeToolFile.read = [{ file: "src/A.ts", action: "read" }];
    runtime.activeToolKind.read = "read_file";
    runtime.activeToolEntry.write = "write-entry";
    runtime.activeToolFile.write = [{ file: "src/A.ts", action: "written" }];
    runtime.activeToolKind.write = "write_file";

    expect(resolveActiveToolKey(
      "changed-write-id",
      [{ file: "src/A.ts" }],
      "write_file",
      runtime,
    )).toBe("write");
  });

  it("correlates an id-only end event when its tool kind has one active entry", () => {
    const runtime = createSessionRuntime();
    runtime.activeToolEntry["provider-start-id"] = "entry-id";
    runtime.activeToolKind["provider-start-id"] = "write_file";

    expect(resolveActiveToolKey(
      "provider-end-id",
      [],
      "write_file",
      runtime,
    )).toBe("provider-start-id");
  });

  it("correlates an id-drifted end with no tool kind when only one tool is active", () => {
    const runtime = createSessionRuntime();
    runtime.activeToolEntry["provider-start-id"] = "entry-id";
    runtime.activeToolKind["provider-start-id"] = "write_file";

    expect(resolveActiveToolKey(
      "provider-end-id",
      [],
      "unknown",
      runtime,
    )).toBe("provider-start-id");
  });

  it("does not guess an omitted tool kind when multiple tools are active", () => {
    const runtime = createSessionRuntime();
    runtime.activeToolEntry.read = "read-entry";
    runtime.activeToolKind.read = "read_file";
    runtime.activeToolEntry.write = "write-entry";
    runtime.activeToolKind.write = "write_file";

    expect(resolveActiveToolKey(
      "provider-end-id",
      [],
      "unknown",
      runtime,
    )).toBe("provider-end-id");
  });

  it("registers questions for id-drift correlation", () => {
    const runtime = createSessionRuntime();
    const { context } = createContext();

    handleToolStartEvent({
      type: "tool_start",
      toolKind: "question",
      toolCallId: "question-start-id",
      requestId: "question-start-id",
    } as AgentEvent, "session-1", runtime, context);

    expect(runtime.activeToolKind["question-start-id"]).toBe("question");
    expect(resolveActiveToolKey(
      "question-end-id",
      [],
      "question",
      runtime,
    )).toBe("question-start-id");
  });

  it("does not guess between concurrent tools of the same kind", () => {
    const runtime = createSessionRuntime();
    runtime.activeToolEntry.first = "first-entry";
    runtime.activeToolEntry.second = "second-entry";
    runtime.activeToolKind.first = "read_file";
    runtime.activeToolKind.second = "read_file";

    expect(resolveActiveToolKey(
      "provider-end-id",
      [],
      "read_file",
      runtime,
    )).toBe("provider-end-id");
  });

  it("maps a Pi todo result snapshot into the native plan UI", () => {
    const { context, updateProcessPlanSteps } = createContext();

    handleToolEndEvent({
      type: "tool_end",
      toolName: "todo",
      toolKind: "unknown",
      result: {
        content: [{ type: "text", text: "Created #1: inspect the renderer" }],
        details: {
          tasks: [
            { id: 1, subject: "Inspect the renderer", status: "in_progress" },
            { id: 2, subject: "Add compatibility tests", status: "pending" },
          ],
        },
      },
    } as AgentEvent, "session-1", createSessionRuntime(), context);

    expect(updateProcessPlanSteps).toHaveBeenCalledWith("session-1", [
      { id: "1", title: "Inspect the renderer", status: "running" },
    ], true);
  });

  it("accumulates only todo tasks touched during the current turn", () => {
    const { context, updateProcessPlanSteps } = createContext();
    const runtime = createSessionRuntime();

    handleToolEndEvent({
      type: "tool_end",
      toolName: "todo",
      result: {
        content: [{ type: "text", text: "Created #3: current step one" }],
        details: {
          tasks: [
            { id: 1, subject: "Historical task", status: "completed" },
            { id: 2, subject: "Another historical task", status: "completed" },
            { id: 3, subject: "Current step one", status: "in_progress" },
            { id: 4, subject: "Current step two", status: "pending" },
          ],
        },
      },
    } as AgentEvent, "session-1", runtime, context);

    handleToolEndEvent({
      type: "tool_end",
      toolName: "todo",
      result: {
        content: [{ type: "text", text: "Created #4: current step two" }],
        details: {
          tasks: [
            { id: 1, subject: "Historical task", status: "completed" },
            { id: 2, subject: "Another historical task", status: "completed" },
            { id: 3, subject: "Current step one", status: "completed" },
            { id: 4, subject: "Current step two", status: "in_progress" },
          ],
        },
      },
    } as AgentEvent, "session-1", runtime, context);

    expect(updateProcessPlanSteps).toHaveBeenNthCalledWith(1, "session-1", [
      { id: "3", title: "Current step one", status: "running" },
    ], true);
    expect(updateProcessPlanSteps).toHaveBeenNthCalledWith(2, "session-1", [
      { id: "3", title: "Current step one", status: "completed" },
      { id: "4", title: "Current step two", status: "running" },
    ], true);
  });

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

  it("does not present a rejected write as a completed file change", () => {
    const { context, entries } = createContext();

    handleToolEndEvent({
      type: "tool_end",
      toolKind: "write_file",
      filePath: "permission-test.txt",
      errorText: "用户拒绝了该操作",
      isError: true,
    } as AgentEvent, "session-1", createSessionRuntime(), context);

    expect(entries[0]).toMatchObject({
      type: "tool",
      state: "warning",
      title: "写入文件未成功",
      detail: "用户拒绝了该操作",
    });
    expect(entries[0].files).toBeUndefined();
    expect(context.recordProcessFiles).not.toHaveBeenCalled();
  });
});
