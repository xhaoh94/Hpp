import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";
import { OpenCodeAgent } from "./backend";

interface OpenCodeSubagentInternals {
  sessionId: string | null;
  permissionMode: "ask" | "auto" | "full-access";
  handleSSEEvent: (eventType: string, data: unknown) => void;
}

const getSubagentEvents = (events: AgentEvent[]) =>
  events.filter((event) => event.type === "subagent_event");

describe("OpenCode subagent bridge", () => {
  it("renders native task tool lifecycle as subagent events instead of generic tool events", () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as OpenCodeSubagentInternals;
    internals.sessionId = "ses_parent";

    internals.handleSSEEvent("message.part.updated", {
      properties: {
        part: {
          id: "part_task_1",
          callID: "call_task_1",
          sessionID: "ses_parent",
          type: "tool",
          tool: "task",
          state: {
            status: "pending",
            input: {},
          },
        },
      },
    });
    internals.handleSSEEvent("message.part.updated", {
      properties: {
        part: {
          id: "part_task_1",
          callID: "call_task_1",
          sessionID: "ses_parent",
          type: "tool",
          tool: "task",
          state: {
            status: "running",
            input: {
              description: "Inspect backend",
              prompt: "Inspect the OpenCode backend and report findings.",
              subagent_type: "explore",
            },
            title: "Inspect backend",
            metadata: {
              sessionId: "ses_child",
              model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
            },
            time: { start: 100 },
          },
        },
      },
    });
    internals.handleSSEEvent("message.part.updated", {
      properties: {
        part: {
          id: "part_task_1",
          callID: "call_task_1",
          sessionID: "ses_parent",
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: {
              description: "Inspect backend",
              prompt: "Inspect the OpenCode backend and report findings.",
              subagent_type: "explore",
            },
            output: "Inspection complete.",
            metadata: {
              sessionId: "ses_child",
              model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
              usage: { input_tokens: 1500, output_tokens: 400, total_tokens: 1900 },
            },
            time: { start: 100, end: 250 },
          },
        },
      },
    });

    const subagentEvents = getSubagentEvents(events);
    expect(subagentEvents).toHaveLength(3);
    expect(subagentEvents[0]).toEqual(expect.objectContaining({
      id: "part_task_1",
      phase: "started",
      action: "spawnAgent",
      state: "running",
      subagents: [expect.objectContaining({
        id: "opencode-subagent-part_task_1",
        label: "Subagent",
        status: "pending",
      })],
    }));
    expect(subagentEvents.at(-1)).toEqual(expect.objectContaining({
      id: "part_task_1",
      toolCallId: "part_task_1",
      phase: "completed",
      action: "spawnAgent",
      tool: "spawnAgent",
      title: "已开始工作",
      detail: "Inspect the OpenCode backend and report findings.",
      state: "completed",
      startedAt: 100,
      completedAt: 250,
      subagents: [expect.objectContaining({
        id: "ses_child",
        label: "Explore",
        status: "completed",
        model: "anthropic/claude-sonnet-4-6",
        message: "Inspection complete.",
        usage: { inputTokens: 1500, outputTokens: 400, totalTokens: 1900 },
      })],
    }));
    expect(events.some((event) =>
      (event.type === "tool_start" || event.type === "tool_end")
      && event.toolCallId === "part_task_1"
    )).toBe(false);
  });

  it("keeps a background task running until its child session becomes idle", () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as OpenCodeSubagentInternals;
    internals.sessionId = "ses_parent";

    internals.handleSSEEvent("message.part.updated", {
      properties: {
        part: {
          id: "part_background_task",
          sessionID: "ses_parent",
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: {
              description: "Research in background",
              prompt: "Research the issue.",
              subagent_type: "research",
              background: true,
            },
            output: '<task id="ses_background" state="running">Background task started</task>',
            metadata: {
              sessionId: "ses_background",
              background: true,
            },
            time: { start: 300, end: 320 },
          },
        },
      },
    });

    expect(getSubagentEvents(events).at(-1)).toEqual(expect.objectContaining({
      phase: "started",
      state: "running",
      subagents: [expect.objectContaining({
        id: "ses_background",
        label: "Research",
        status: "running",
      })],
    }));

    internals.handleSSEEvent("message.part.updated", {
      properties: {
        part: {
          id: "background_result",
          sessionID: "ses_background",
          type: "text",
          text: "Background research complete.",
        },
        delta: "Background research complete.",
      },
    });
    internals.handleSSEEvent("session.status", {
      properties: {
        sessionID: "ses_background",
        status: { type: "idle" },
      },
    });

    expect(getSubagentEvents(events).at(-1)).toEqual(expect.objectContaining({
      id: "part_background_task",
      phase: "completed",
      state: "completed",
      subagents: [expect.objectContaining({
        id: "ses_background",
        status: "completed",
        message: "Background research complete.",
      })],
    }));
  });

  it("routes tracked child permission prompts without leaking child text into the parent stream", () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as OpenCodeSubagentInternals;
    internals.sessionId = "ses_parent";
    internals.permissionMode = "ask";

    internals.handleSSEEvent("message.part.updated", {
      properties: {
        part: {
          id: "part_task_permissions",
          sessionID: "ses_parent",
          type: "tool",
          tool: "task",
          state: {
            status: "running",
            input: {
              description: "Edit implementation",
              prompt: "Implement the change.",
              subagent_type: "general",
            },
            metadata: { sessionId: "ses_child_permissions" },
          },
        },
      },
    });

    internals.handleSSEEvent("message.part.updated", {
      properties: {
        part: {
          id: "child_text",
          sessionID: "ses_child_permissions",
          type: "text",
          text: "This text belongs to the child session.",
        },
        delta: "This text belongs to the child session.",
      },
    });
    internals.handleSSEEvent("permission.asked", {
      properties: {
        id: "permission_child_edit",
        sessionID: "ses_child_permissions",
        action: "edit",
        resources: ["src/app.ts"],
      },
    });

    expect(events).not.toContainEqual(expect.objectContaining({
      type: "stream_delta",
      delta: "This text belongs to the child session.",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "process_event",
      entryType: "question",
      requestId: "permission_child_edit",
      method: "opencode.permission",
    }));

    const beforeIdle = getSubagentEvents(events).length;
    internals.handleSSEEvent("session.status", {
      properties: {
        sessionID: "ses_child_permissions",
        status: { type: "idle" },
      },
    });
    expect(getSubagentEvents(events)).toHaveLength(beforeIdle);
  });

  it("maps task_id reuse to the canonical resume action", () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as OpenCodeSubagentInternals;
    internals.sessionId = "ses_parent";

    internals.handleSSEEvent("message.part.updated", {
      properties: {
        part: {
          id: "part_resume_task",
          sessionID: "ses_parent",
          type: "tool",
          tool: "task",
          state: {
            status: "running",
            input: {
              description: "Continue investigation",
              prompt: "Continue from the previous findings.",
              subagent_type: "explore",
              task_id: "ses_existing_child",
            },
          },
        },
      },
    });

    expect(getSubagentEvents(events).at(-1)).toEqual(expect.objectContaining({
      action: "resumeAgent",
      tool: "resumeAgent",
      title: "已继续工作",
      subagents: [expect.objectContaining({ id: "ses_existing_child" })],
    }));
  });
});
