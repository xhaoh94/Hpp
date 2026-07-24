import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/types";
import {
  getSubagentProcessEntry,
  normalizeSubagentStatus,
  parseSubagentsFromEvent,
} from "./subagentEvents";

describe("subagent events", () => {
  it("turns the canonical lifecycle event into a persistent process entry", () => {
    const entry = getSubagentProcessEntry({
      type: "subagent_event",
      id: "activity-1",
      phase: "completed",
      action: "spawnAgent",
      tool: "spawnAgent",
      title: "已开始工作",
      detail: "Inspect the backend",
      state: "completed",
      timestamp: 100,
      startedAt: 100,
      completedAt: 130,
      subagents: [{
        id: "thread-1",
        label: "Backend commentary",
        status: "running",
        model: "gpt-5",
        path: "/root/backend_commentary",
      }],
    } as AgentEvent);

    expect(entry).toEqual(expect.objectContaining({
      id: "activity-1",
      type: "subagent",
      title: "已开始工作",
      detail: "Inspect the backend",
      state: "completed",
      timestamp: 100,
      startedAt: 100,
      completedAt: 130,
      phase: "completed",
      action: "spawnAgent",
      tool: "spawnAgent",
      subagents: [expect.objectContaining({
        id: "thread-1",
        label: "Backend commentary",
        status: "running",
      })],
    }));
  });

  it("accepts older agent aliases and normalizes lifecycle states", () => {
    expect(parseSubagentsFromEvent({
      type: "subagent_event",
      agents: [{ threadId: "thread-2", name: "History", state: "in-progress" }],
    } as AgentEvent)).toEqual([expect.objectContaining({
      id: "thread-2",
      label: "History",
      status: "running",
    })]);

    expect(normalizeSubagentStatus("succeeded")).toBe("completed");
    expect(normalizeSubagentStatus("shutdown")).toBe("interrupted");
  });

  it("uses an agent path as a readable fallback label", () => {
    expect(parseSubagentsFromEvent({
      type: "subagent_event",
      agentThreadId: "thread-3",
      agentPath: "/root/frontend_commentary",
      state: "running",
    } as AgentEvent)).toEqual([expect.objectContaining({
      id: "thread-3",
      label: "frontend commentary",
      path: "/root/frontend_commentary",
      status: "running",
    })]);
  });
});
