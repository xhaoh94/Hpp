import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/types/ipc";
import { ClaudeSDKAgent } from "./claude/backend";
import { OpenCodeAgent } from "./opencode/backend";
import { PiSDKAgent } from "./pi/backend";

type Scenario = {
  name: string;
  feedCompleted: (events: AgentEvent[]) => void;
  feedTimeout: (events: AgentEvent[]) => void;
};

const getSubagentEvents = (events: AgentEvent[]) =>
  events.filter((event) => event.type === "subagent_event");

const expectCanonicalCompleted = (events: AgentEvent[]) => {
  const subagentEvents = getSubagentEvents(events);
  expect(subagentEvents.length).toBeGreaterThanOrEqual(2);
  expect(subagentEvents.at(-1)).toEqual(expect.objectContaining({
    type: "subagent_event",
    phase: "completed",
    state: "completed",
    action: "spawnAgent",
    tool: "spawnAgent",
    subagents: [expect.objectContaining({ status: "completed" })],
  }));
  expect(events.some((event) =>
    (event.type === "tool_start" || event.type === "tool_end")
    && event.toolCallId,
  )).toBe(false);
};

const expectCanonicalTimeout = (events: AgentEvent[]) => {
  expect(getSubagentEvents(events).at(-1)).toEqual(expect.objectContaining({
    type: "subagent_event",
    phase: "completed",
    state: "error",
    title: "已超时",
    stopReason: "timeout",
    subagents: [expect.objectContaining({ status: "error", stopReason: "timeout" })],
  }));
};

const scenarios: Scenario[] = [
  {
    name: "Pi tool_execution details",
    feedCompleted: (events) => {
      const agent = new PiSDKAgent("matrix-pi", (event) => events.push(event as AgentEvent));
      const handle = (agent as unknown as {
        handleWorkerMessage: (message: Record<string, unknown>) => void;
      }).handleWorkerMessage.bind(agent);
      handle({
        type: "tool_execution_start",
        toolName: "subagent",
        toolCallId: "matrix-pi-call",
        args: { agent: "worker", task: "验证发布流程" },
      });
      handle({
        type: "tool_execution_end",
        toolName: "subagent",
        toolCallId: "matrix-pi-call",
        result: {
          details: {
            mode: "single",
            results: [{
              agent: "worker",
              task: "验证发布流程",
              model: "test/pi-worker",
              output: "完成",
              exitCode: 0,
              usage: { input: 100, output: 20 },
            }],
          },
        },
        isError: false,
      });
    },
    feedTimeout: (events) => {
      const agent = new PiSDKAgent("matrix-pi-timeout", (event) => events.push(event as AgentEvent));
      const handle = (agent as unknown as {
        handleWorkerMessage: (message: Record<string, unknown>) => void;
      }).handleWorkerMessage.bind(agent);
      handle({
        type: "tool_execution_start",
        toolName: "subagent",
        toolCallId: "matrix-pi-timeout-call",
        args: { agent: "worker", task: "等待超时" },
      });
      handle({
        type: "tool_execution_end",
        toolName: "subagent",
        toolCallId: "matrix-pi-timeout-call",
        result: {
          details: {
            results: [{
              agent: "worker",
              task: "等待超时",
              stopReason: "timeout",
              exitCode: 1,
              errorMessage: "子 Agent 超时",
            }],
          },
        },
        isError: true,
      });
    },
  },
  {
    name: "Claude Task metadata",
    feedCompleted: (events) => {
      const agent = new ClaudeSDKAgent("matrix-claude", (event) => events.push(event as AgentEvent));
      const internals = agent as unknown as {
        activePromptId: string | null;
        turnActive: boolean;
        handleWorkerMessage: (message: Record<string, unknown>) => void;
      };
      internals.activePromptId = "matrix-prompt";
      internals.turnActive = true;
      internals.handleWorkerMessage({
        type: "tool_execution_start",
        toolUseId: "matrix-claude-call",
        toolName: "Task",
        input: {
          description: "审查发布流程",
          prompt: "审查发布流程并返回风险。",
          subagent_type: "Explore",
        },
      });
      internals.handleWorkerMessage({
        type: "subagent_started",
        toolUseId: "matrix-claude-call",
        taskId: "matrix-claude-child",
        taskType: "explore",
        status: "running",
      });
      internals.handleWorkerMessage({
        type: "tool_execution_end",
        toolUseId: "matrix-claude-call",
        toolName: "Task",
        toolUseResult: {
          agentId: "matrix-claude-child",
          agentType: "explore",
          status: "completed",
          content: "审查完成",
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      });
    },
    feedTimeout: (events) => {
      const agent = new ClaudeSDKAgent("matrix-claude-timeout", (event) => events.push(event as AgentEvent));
      const internals = agent as unknown as {
        activePromptId: string | null;
        turnActive: boolean;
        handleWorkerMessage: (message: Record<string, unknown>) => void;
      };
      internals.activePromptId = "matrix-timeout-prompt";
      internals.turnActive = true;
      internals.handleWorkerMessage({
        type: "tool_execution_start",
        toolUseId: "matrix-claude-timeout-call",
        toolName: "Task",
        input: { description: "超时任务", prompt: "执行超时任务。", subagent_type: "worker" },
      });
      internals.handleWorkerMessage({
        type: "tool_execution_end",
        toolUseId: "matrix-claude-timeout-call",
        toolName: "Task",
        toolUseResult: {
          agentId: "matrix-claude-timeout-child",
          agentType: "worker",
          status: "error",
          stopReason: "timeout",
          error: "Claude 子 Agent 超时",
        },
      });
    },
  },
  {
    name: "OpenCode child session SSE",
    feedCompleted: (events) => {
      const agent = new OpenCodeAgent("matrix-opencode", (event) => events.push(event as AgentEvent));
      const internals = agent as unknown as {
        sessionId: string | null;
        handleSSEEvent: (eventType: string, data: unknown) => void;
      };
      internals.sessionId = "matrix-opencode-parent";
      internals.handleSSEEvent("message.part.updated", {
        properties: {
          part: {
            id: "matrix-opencode-call",
            sessionID: "matrix-opencode-parent",
            type: "tool",
            tool: "task",
            state: {
              status: "running",
              input: { description: "检查发布流程", prompt: "检查发布流程。", subagent_type: "explore" },
              metadata: { sessionId: "matrix-opencode-child" },
              time: { start: 100 },
            },
          },
        },
      });
      internals.handleSSEEvent("message.part.updated", {
        properties: {
          part: {
            id: "matrix-opencode-call",
            sessionID: "matrix-opencode-parent",
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { description: "检查发布流程", prompt: "检查发布流程。", subagent_type: "explore" },
              output: "检查完成",
              metadata: { sessionId: "matrix-opencode-child", usage: { input_tokens: 100, output_tokens: 20 } },
              time: { start: 100, end: 200 },
            },
          },
        },
      });
    },
    feedTimeout: (events) => {
      const agent = new OpenCodeAgent("matrix-opencode-timeout", (event) => events.push(event as AgentEvent));
      const internals = agent as unknown as {
        sessionId: string | null;
        handleSSEEvent: (eventType: string, data: unknown) => void;
      };
      internals.sessionId = "matrix-opencode-timeout-parent";
      internals.handleSSEEvent("message.part.updated", {
        properties: {
          part: {
            id: "matrix-opencode-timeout-call",
            sessionID: "matrix-opencode-timeout-parent",
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { description: "超时任务", prompt: "执行超时任务。", subagent_type: "worker" },
              output: "timeout",
              metadata: {
                sessionId: "matrix-opencode-timeout-child",
                stopReason: "timeout",
              },
              time: { start: 100, end: 200 },
            },
          },
        },
      });
    },
  },
];

describe("subagent backend release lifecycle matrix", () => {
  it.each(scenarios)("$name emits the canonical completed lifecycle", ({ feedCompleted }) => {
    const events: AgentEvent[] = [];
    feedCompleted(events);
    expectCanonicalCompleted(events);
  });

  it.each(scenarios)("$name keeps timeout distinct from generic failure", ({ feedTimeout }) => {
    const events: AgentEvent[] = [];
    feedTimeout(events);
    expectCanonicalTimeout(events);
  });
});
