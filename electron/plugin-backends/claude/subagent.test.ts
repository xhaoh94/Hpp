import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";
import { ClaudeSDKAgent } from "./backend";

interface ClaudeInternals {
  activePromptId: string | null;
  turnActive: boolean;
  handleWorkerMessage: (message: Record<string, unknown>) => void;
}

const getSubagentEvents = (events: AgentEvent[]) =>
  events.filter((event) => event.type === "subagent_event");

describe("Claude subagent bridge", () => {
  it("maps Task lifecycle metadata to subagent_event and suppresses generic tool entries", () => {
    const events: AgentEvent[] = [];
    const agent = new ClaudeSDKAgent("session-one", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as ClaudeInternals;
    internals.activePromptId = "prompt-one";
    internals.turnActive = true;

    internals.handleWorkerMessage({
      type: "tool_execution_start",
      toolUseId: "tool-task-1",
      toolName: "Task",
      input: {
        description: "Inspect the backend",
        prompt: "Inspect the backend and report findings.",
        subagent_type: "Explore",
        model: "claude-sonnet-4-6",
      },
    });
    internals.handleWorkerMessage({
      type: "subagent_started",
      toolUseId: "tool-task-1",
      taskId: "agent-explore-1",
      taskType: "explore",
      description: "Inspect the backend",
      prompt: "Inspect the backend and report findings.",
      model: "claude-sonnet-4-6",
      status: "running",
    });
    internals.handleWorkerMessage({
      type: "tool_execution_end",
      toolUseId: "tool-task-1",
      toolName: "Task",
      input: {
        description: "Inspect the backend",
        prompt: "Inspect the backend and report findings.",
        subagent_type: "Explore",
        model: "claude-sonnet-4-6",
      },
      toolUseResult: {
        agentId: "agent-explore-1",
        agentType: "explore",
        status: "completed",
        usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 80 },
      },
      output: {
        agentId: "agent-explore-1",
        status: "completed",
      },
    });
    internals.handleWorkerMessage({
      type: "tool_execution_start",
      toolUseId: "task-output-1",
      toolName: "TaskOutput",
      input: { task_id: "agent-explore-1", block: true },
    });
    internals.handleWorkerMessage({
      type: "tool_execution_end",
      toolUseId: "task-output-1",
      toolName: "TaskOutput",
      toolUseResult: {
        retrieval_status: "success",
        task: {
          task_id: "agent-explore-1",
          status: "completed",
          result: "Backend inspection complete.",
          output: "Backend inspection complete.",
        },
      },
    });

    const subagentEvents = getSubagentEvents(events);
    expect(subagentEvents.at(-1)).toEqual(expect.objectContaining({
      id: "tool-task-1",
      toolCallId: "tool-task-1",
      phase: "completed",
      action: "spawnAgent",
      tool: "spawnAgent",
      state: "completed",
      detail: "Inspect the backend",
      prompt: "Inspect the backend and report findings.",
      subagents: [expect.objectContaining({
        id: "agent-explore-1",
        label: "Explore",
        status: "completed",
        model: "claude-sonnet-4-6",
        message: "Backend inspection complete.",
        usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 80 },
      })],
    }));
    expect(events.some((event) =>
      (event.type === "tool_start" || event.type === "tool_end")
      && (event.toolCallId === "tool-task-1" || event.toolCallId === "task-output-1")
    )).toBe(false);
  });

  it("keeps background Claude tasks running after the top-level tool returns", () => {
    const events: AgentEvent[] = [];
    const agent = new ClaudeSDKAgent("session-one", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as ClaudeInternals;

    internals.handleWorkerMessage({
      type: "tool_execution_start",
      toolUseId: "tool-background-1",
      toolName: "Agent",
      input: {
        description: "Research asynchronously",
        prompt: "Research the issue.",
        subagent_type: "research",
        run_in_background: true,
      },
    });
    internals.handleWorkerMessage({
      type: "tool_execution_end",
      toolUseId: "tool-background-1",
      toolName: "Agent",
      input: {
        description: "Research asynchronously",
        prompt: "Research the issue.",
        subagent_type: "research",
      },
      toolUseResult: {
        taskId: "task-background-1",
        status: "running",
      },
    });

    expect(getSubagentEvents(events).at(-1)).toEqual(expect.objectContaining({
      phase: "started",
      state: "running",
      background: true,
      subagents: [expect.objectContaining({
        id: "task-background-1",
        label: "Research",
        status: "running",
      })],
    }));
  });
});
