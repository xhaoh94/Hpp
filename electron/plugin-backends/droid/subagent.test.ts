import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";
import { DroidAgent } from "./backend";

interface DroidInternals {
  turnActive: boolean;
  handleNotification: (method: string, params: unknown) => void;
}

const getSubagentEvents = (events: AgentEvent[]) =>
  events.filter((event) => event.type === "subagent_event");

describe("Droid subagent bridge", () => {
  it("maps delegate_task content blocks to subagent lifecycle events", () => {
    const events: AgentEvent[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as DroidInternals;
    internals.turnActive = true;

    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "create_message",
        message: {
          id: "assistant-task-1",
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "droid-task-1",
            name: "delegate_task",
            input: {
              description: "Review the API layer",
              prompt: "Review the API layer and summarize risks.",
              subagent_type: "reviewer",
              model: "factory/sonnet",
            },
          }],
        },
      },
    });
    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "tool_progress_update",
        toolUseId: "droid-task-1",
        toolName: "delegate_task",
        update: {
          status: "completed",
          parameters: {
            description: "Review the API layer",
            prompt: "Review the API layer and summarize risks.",
            subagent_type: "reviewer",
            model: "factory/sonnet",
          },
          result: {
            sessionId: "droid-child-1",
            status: "completed",
            summary: "API review complete.",
            usage: { input_tokens: 900, output_tokens: 220, total_tokens: 1120 },
          },
        },
      },
    });

    const subagentEvents = getSubagentEvents(events);
    expect(subagentEvents).toHaveLength(2);
    expect(subagentEvents.at(-1)).toEqual(expect.objectContaining({
      id: "droid-task-1",
      phase: "completed",
      action: "spawnAgent",
      state: "completed",
      subagents: [expect.objectContaining({
        id: "droid-child-1",
        label: "Reviewer",
        status: "completed",
        model: "factory/sonnet",
        usage: { inputTokens: 900, outputTokens: 220, totalTokens: 1120 },
      })],
    }));
    expect(events.some((event) =>
      (event.type === "tool_start" || event.type === "tool_end")
      && event.toolCallId === "droid-task-1"
    )).toBe(false);
  });

  it("marks authentication failures as subagent errors instead of completed", () => {
    const events: AgentEvent[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as DroidInternals;
    internals.turnActive = true;

    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "create_message",
        message: {
          id: "assistant-auth-failure",
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "droid-auth-failure",
            name: "Task",
            input: { description: "Run child", prompt: "Return a marker.", subagent_type: "worker" },
          }],
        },
      },
    });
    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "tool_progress_update",
        toolUseId: "droid-auth-failure",
        toolName: "Task",
        update: {
          type: "tool_result",
          status: "completed",
          fullOutput: "Authentication required. Please sign in.",
        },
      },
    });

    expect(getSubagentEvents(events).at(-1)).toEqual(expect.objectContaining({
      phase: "completed",
      state: "error",
      stopReason: "error",
      subagents: [expect.objectContaining({
        status: "error",
        message: "Authentication required. Please sign in.",
      })],
    }));
  });

  it("reconciles protocol-level false completion from the parent authentication error", () => {
    const events: AgentEvent[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as DroidInternals;
    internals.turnActive = true;

    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "create_message",
        message: {
          id: "assistant-auth-parent",
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "droid-auth-parent",
            name: "Task",
            input: { description: "Run child", prompt: "Return a marker.", subagent_type: "worker" },
          }],
        },
      },
    });
    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "tool_progress_update",
        toolUseId: "droid-auth-parent",
        toolName: "Task",
        update: { type: "tool_result", status: "completed" },
      },
    });
    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "assistant_text_delta",
        textDelta: "Error running task subagent: Authentication required. Please sign in.",
      },
    });
    internals.handleNotification("droid.session_notification", {
      notification: { type: "droid_working_state_changed", newState: "idle" },
    });

    expect(getSubagentEvents(events).at(-1)).toEqual(expect.objectContaining({
      phase: "completed",
      state: "error",
      stopReason: "error",
      subagents: [expect.objectContaining({ status: "error" })],
    }));
  });

  it("does not complete a background subagent when the parent session becomes idle", () => {
    const events: AgentEvent[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as DroidInternals;
    internals.turnActive = true;

    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "create_message",
        message: {
          id: "assistant-background-1",
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "droid-background-1",
            name: "task",
            input: {
              description: "Research in background",
              prompt: "Research the issue.",
              subagent_type: "research",
              background: true,
            },
          }],
        },
      },
    });
    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "droid_working_state_changed",
        newState: "idle",
      },
    });

    expect(getSubagentEvents(events).at(-1)).toEqual(expect.objectContaining({
      phase: "started",
      state: "running",
      subagents: [expect.objectContaining({
        status: "running",
      })],
    }));
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);

    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "tool_progress_update",
        toolUseId: "droid-background-1",
        toolName: "task",
        update: {
          type: "tool_result",
          status: "completed",
          result: {
            sessionId: "droid-background-1",
            status: "completed",
            summary: "Research complete.",
          },
        },
      },
    });

    expect(getSubagentEvents(events).at(-1)).toEqual(expect.objectContaining({
      phase: "completed",
      state: "completed",
      subagents: [expect.objectContaining({
        id: "droid-background-1",
        status: "completed",
      })],
    }));
  });
});
