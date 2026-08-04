import { describe, expect, it, vi } from "vitest";
import type { AgentEventRuntimeController } from "./agentEventTypes";
import { dispatchAgentEvent, mergeHistoryCommentary, parseHistorySnapshotMessages } from "./agentEventDispatcher";

describe("parseHistorySnapshotMessages", () => {
  it("restores commentary attached to a completed assistant message", () => {
    const messages = parseHistorySnapshotMessages([
      { id: "user-1", role: "user", content: "发布版本", timestamp: 1 },
      {
        id: "assistant-1",
        role: "assistant",
        content: "版本已经发布。",
        timestamp: 4,
        commentary: [
          { id: "note-1", content: "我先检查发布配置。", timestamp: 2 },
          { id: "note-2", content: "现在开始构建。", timestamp: 3 },
        ],
      },
    ]);

    expect(messages[1]).toMatchObject({
      content: "版本已经发布。",
      commentary: [
        { id: "note-1", content: "我先检查发布配置。", isStreaming: false },
        { id: "note-2", content: "现在开始构建。", isStreaming: false },
      ],
    });
  });

  it("folds phase commentary records into the following final answer", () => {
    const messages = parseHistorySnapshotMessages([
      { id: "user-1", role: "user", content: "修复问题", timestamp: 1 },
      {
        id: "note-1",
        itemId: "commentary-item-1",
        role: "assistant",
        phase: "commentary",
        content: "我会先定位事件流。",
        timestamp: 2,
      },
      {
        id: "assistant-1",
        role: "assistant",
        phase: "final_answer",
        content: "问题已修复。",
        timestamp: 3,
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: "assistant-1",
      content: "问题已修复。",
      commentary: [{
        id: "commentary-item-1",
        content: "我会先定位事件流。",
        isStreaming: false,
      }],
    });
  });

  it("backfills commentary into a persisted assistant turn without replacing local data", () => {
    const existing = [{
      id: "local-assistant",
      role: "assistant" as const,
      content: "done",
      timestamp: 4,
      nativeTurnId: "turn-1",
      process: { startedAt: 1, endedAt: 4, entries: [] },
    }];
    const recovered = [{
      id: "history-assistant",
      role: "assistant" as const,
      content: "done",
      timestamp: 4,
      nativeTurnId: "turn-1",
      commentary: [{ id: "note-1", content: "working", timestamp: 2 }],
    }];

    const merged = mergeHistoryCommentary(existing, recovered);

    expect(merged[0]).toMatchObject({
      id: "local-assistant",
      process: existing[0].process,
      commentary: [{ id: "note-1", content: "working", timestamp: 2, isStreaming: false }],
    });
  });

  it("does not duplicate persisted commentary whose history id is different", () => {
    const existing = [{
      id: "local-assistant",
      role: "assistant" as const,
      content: "done",
      timestamp: 4,
      nativeTurnId: "turn-1",
      commentary: [{ id: "live-item-id", content: "working", timestamp: 2 }],
    }];
    const recovered = [{
      id: "history-assistant",
      role: "assistant" as const,
      content: "done",
      timestamp: 4,
      nativeTurnId: "turn-1",
      commentary: [{ id: "history-item-id", content: "working", timestamp: 2.1 }],
    }];

    expect(mergeHistoryCommentary(existing, recovered)).toBe(existing);
  });

  it("restores a commentary-only interrupted turn after its persisted user message", () => {
    const existing = [{
      id: "local-user",
      role: "user" as const,
      content: "investigate",
      timestamp: 1,
      nativeTurnId: "turn-interrupted",
    }];
    const recovered = [{
      id: "history-commentary-only",
      role: "assistant" as const,
      content: "",
      timestamp: 2,
      nativeTurnId: "turn-interrupted",
      commentary: [{ id: "note-1", content: "I found the cause.", timestamp: 2 }],
    }];

    expect(mergeHistoryCommentary(existing, recovered)).toEqual([
      existing[0],
      recovered[0],
    ]);
  });
});

describe("dispatchAgentEvent subagent lifecycle", () => {
  it("adds a subagent event to the assistant process timeline", () => {
    const appendProcessEntry = vi.fn();
    const controller = {
      isOpenProjectSession: () => true,
      getRuntime: () => ({ manualAbortRequested: false }),
      cancelAgentEndGrace: vi.fn(),
      completeIdleNotice: vi.fn(),
      refreshStreamWatchdog: vi.fn(),
      ensureAssistantContinuation: vi.fn(),
      finishAssistantProcessText: vi.fn(),
      finishThinkingEntry: vi.fn(),
      updateInferredPlanSteps: vi.fn(),
      appendProcessEntry,
    } as unknown as AgentEventRuntimeController;

    dispatchAgentEvent({
      type: "subagent_event",
      sessionId: "session-1",
      id: "spawn-1",
      title: "已开始工作",
      state: "running",
      subagents: [{ id: "thread-1", label: "Backend", status: "running" }],
    }, controller);

    expect(appendProcessEntry).toHaveBeenCalledWith("session-1", expect.objectContaining({
      id: "spawn-1",
      type: "subagent",
      title: "已开始工作",
      state: "running",
      subagents: [expect.objectContaining({ id: "thread-1", label: "Backend" })],
    }));
  });
});
