import { describe, expect, it } from "vitest";
import { isAgentTurnContinuationEvidence } from "./agent-event-lifecycle";

describe("isAgentTurnContinuationEvidence", () => {
  it.each([
    { type: "turn_lifecycle" },
    { type: "message_start" },
    { type: "stream_start" },
    { type: "stream_delta", delta: "answer" },
    { type: "stream_snapshot", content: "answer" },
    { type: "commentary_delta", itemId: "note", delta: "working" },
    { type: "thinking_delta", delta: "working" },
    { type: "tool_start", toolCallId: "tool" },
    { type: "process_event", state: "running" },
    { type: "process_event", state: "pending" },
    { type: "process_event", entryType: "question" },
    { type: "subagent_event", state: "running" },
    { type: "plan_update", steps: [{ step: "work", status: "in_progress" }] },
    { type: "ask_user_question", question: "Continue?" },
  ])("accepts active evidence %#", (event) => {
    expect(isAgentTurnContinuationEvidence(event)).toBe(true);
  });

  it.each([
    { type: "stream_delta", delta: "" },
    { type: "stream_snapshot", content: "" },
    { type: "commentary_delta", delta: "working" },
    { type: "commentary_delta", itemId: "note", delta: "" },
    { type: "thinking_delta", delta: "" },
    { type: "commentary_end", itemId: "note" },
    { type: "thinking_end" },
    { type: "tool_end", toolCallId: "tool" },
    { type: "diff_update", diffs: [{ file: "done.ts" }] },
    { type: "process_event", state: "completed" },
    { type: "process_event", state: "error" },
    { type: "process_event", state: "interrupted" },
    { type: "process_event", entryType: "question", state: "completed" },
    { type: "subagent_event", state: "completed" },
    { type: "subagent_event", subagents: [{ status: "failed" }] },
    { type: "plan_update", steps: [{ step: "work", status: "completed" }] },
    { type: "ask_user_question", state: "completed" },
    { type: "model_changed" },
  ])("rejects terminal, metadata, or empty evidence %#", (event) => {
    expect(isAgentTurnContinuationEvidence(event)).toBe(false);
  });

  it("uses nested process plans and subagent state maps", () => {
    expect(isAgentTurnContinuationEvidence({
      type: "process_event",
      kind: "plan_update",
      detail: { steps: [{ title: "one", status: "done" }, { title: "two" }] },
    })).toBe(true);
    expect(isAgentTurnContinuationEvidence({
      type: "subagent_event",
      agentsStates: { one: "completed", two: { state: "interrupted" } },
    })).toBe(false);
  });
});
