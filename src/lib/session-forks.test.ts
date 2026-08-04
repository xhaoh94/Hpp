import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/stores/chat-store";
import { cloneMessagesForFork } from "./session-forks";

describe("forked message lifecycle normalization", () => {
  it("uses the source activity time and settles every nested transient state", () => {
    const source: ChatMessage = {
      id: "source",
      role: "assistant",
      content: "partial",
      timestamp: 10,
      isStreaming: true,
      commentary: [{ id: "note", content: "working", timestamp: 20, isStreaming: true }],
      process: {
        startedAt: 5,
        entries: [{
          id: "tool",
          type: "tool",
          title: "running",
          timestamp: 30,
          completedAt: 35,
          state: "running",
          subagents: [{ id: "child", label: "Child", status: "pending" }],
        }],
        planSteps: [{ id: "step", title: "work", status: "running" }],
      },
    };

    const [forked] = cloneMessagesForFork([source]);

    expect(forked.id).not.toBe(source.id);
    expect(forked.isStreaming).toBeUndefined();
    expect(forked).toMatchObject({
      commentary: [{ isStreaming: false }],
      process: {
        endedAt: 35,
        entries: [{ state: "interrupted", subagents: [{ status: "interrupted" }] }],
        planSteps: [{ status: "cancelled" }],
      },
    });
    expect(source.process?.endedAt).toBeUndefined();
    expect(source.process?.entries[0].state).toBe("running");
  });

  it("preserves a valid source end time while repairing inconsistent nested state", () => {
    const [forked] = cloneMessagesForFork([{
      id: "ended-source",
      role: "assistant",
      content: "done",
      timestamp: 10,
      process: {
        startedAt: 5,
        endedAt: 25,
        entries: [{
          id: "child",
          type: "subagent",
          title: "child",
          timestamp: 30,
          state: "completed",
          subagents: [{ id: "child", label: "Child", status: "running" }],
        }],
      },
    }]);

    expect(forked.process).toMatchObject({
      endedAt: 25,
      entries: [{ state: "completed", subagents: [{ status: "interrupted" }] }],
    });
  });
});
