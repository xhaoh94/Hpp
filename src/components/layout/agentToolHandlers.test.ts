import { describe, expect, it, vi } from "vitest";
import type { AgentEventRuntimeController } from "./agentEventTypes";
import { createSessionRuntime } from "./agentEventUtils";
import { handleToolEndEvent } from "./agentToolHandlers";

describe("handleToolEndEvent todo plan snapshots", () => {
  it("clears the plan when todo_write returns an explicit empty task list", () => {
    const runtime = createSessionRuntime();
    const updateProcessPlanSteps = vi.fn();
    const ctx = {
      ensureAssistantContinuation: vi.fn(),
      finishAssistantProcessText: vi.fn(),
      finishThinkingEntry: vi.fn(),
      getPendingUIResponse: () => null,
      setPendingUIResponse: vi.fn(),
      recordProcessFiles: vi.fn(),
      updateInferredPlanSteps: vi.fn(),
      updateProcessPlanSteps,
      appendProcessEntry: vi.fn(),
      updateLastAssistantProcessEntry: vi.fn(),
    } as unknown as AgentEventRuntimeController;

    handleToolEndEvent({
      type: "tool_end",
      toolName: "todo_write",
      details: { tasks: [] },
    } as unknown as Parameters<typeof handleToolEndEvent>[0], "session-1", runtime, ctx);

    // 空快照必须走到「清空」，而不是被当成没有计划数据忽略。
    expect(updateProcessPlanSteps).toHaveBeenCalledWith("session-1", [], true);
  });
});