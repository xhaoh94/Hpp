import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";

import { PiSDKAgent } from "./backend";

const createToolMessage = (agent: PiSDKAgent) => {
  const internals = agent as unknown as {
    handleWorkerMessage: (message: Record<string, unknown>) => void;
  };
  return internals.handleWorkerMessage.bind(agent);
};

describe("Pi subagent lifecycle", () => {
  it("converts Pi subagent tool events without emitting ordinary tool entries", () => {
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const handle = createToolMessage(agent);

    handle({
      type: "tool_execution_start",
      toolName: "subagent",
      toolCallId: "pi-subagent-1",
      args: {
        tasks: [
          { agent: "scout", task: "查找认证代码" },
          { agent: "reviewer", task: "检查相关测试" },
        ],
      },
    });
    handle({
      type: "tool_execution_update",
      toolName: "subagent",
      toolCallId: "pi-subagent-1",
      partialResult: {
        content: [{ type: "text", text: "并行任务：1/2 已完成" }],
        details: {
          mode: "parallel",
          results: [
            { agent: "scout", task: "查找认证代码", exitCode: 0, model: "test/scout", output: "src/auth.ts" },
            {
              agent: "reviewer",
              task: "检查相关测试",
              exitCode: -1,
              model: "test/reviewer",
              output: "上一轮结果",
              message: "正在读取测试文件",
            },
          ],
        },
      },
    });
    handle({
      type: "tool_execution_end",
      toolName: "subagent",
      toolCallId: "pi-subagent-1",
      result: {
        content: [{ type: "text", text: "两个子任务已完成" }],
        details: {
          mode: "parallel",
          results: [
            { agent: "scout", task: "查找认证代码", exitCode: 0, model: "test/scout", output: "src/auth.ts" },
            {
              agent: "reviewer",
              task: "检查相关测试",
              exitCode: 0,
              model: "test/reviewer",
              output: "tests/auth.test.ts",
              usage: { input: 512, output: 128, cacheRead: 64, turns: 1 },
            },
          ],
        },
      },
      isError: false,
    });

    expect(events.filter((event) => event.type === "tool_start" || event.type === "tool_end")).toHaveLength(0);
    const subagentEvents = events.filter((event) => event.type === "subagent_event");
    expect(subagentEvents).toHaveLength(3);
    expect(subagentEvents[0]).toMatchObject({
      type: "subagent_event",
      id: "pi-subagent-1",
      phase: "started",
      source: "pi",
      state: "running",
    });
    expect(subagentEvents[1]).toMatchObject({
      state: "running",
      subagents: [
        {},
        { message: "正在读取测试文件" },
      ],
    });
    expect(subagentEvents[2]).toMatchObject({
      phase: "completed",
      state: "completed",
      subagents: [
        expect.objectContaining({ id: "pi-subagent-1:1", label: "Scout", status: "completed", model: "test/scout" }),
        expect.objectContaining({
          id: "pi-subagent-1:2",
          label: "Reviewer",
          status: "completed",
          model: "test/reviewer",
          usage: expect.objectContaining({ inputTokens: 512, outputTokens: 128, cacheReadTokens: 64, turns: 1 }),
        }),
      ],
    });

    agent.dispose();
  });

  it("marks a timed out child with a distinct stop reason", () => {
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const handle = createToolMessage(agent);
    handle({
      type: "tool_execution_start",
      toolName: "subagent",
      toolCallId: "pi-subagent-timeout-event",
      args: { agent: "worker", task: "超时任务" },
    });
    handle({
      type: "tool_execution_end",
      toolName: "subagent",
      toolCallId: "pi-subagent-timeout-event",
      result: {
        details: {
          results: [{
            agent: "worker",
            task: "超时任务",
            exitCode: 1,
            stopReason: "timeout",
            errorMessage: "子 Agent 超时（1 秒）",
          }],
        },
      },
      isError: true,
    });

    expect(events.at(-1)).toMatchObject({
      type: "subagent_event",
      title: "已超时",
      state: "error",
      stopReason: "timeout",
      subagents: [expect.objectContaining({ status: "error", stopReason: "timeout" })],
    });
    agent.dispose();
  });

  it("completes a compatible external subagent even when it omits structured details", () => {
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const handle = createToolMessage(agent);
    handle({
      type: "tool_execution_start",
      toolName: "subagent",
      toolCallId: "pi-subagent-generic",
      args: { agent: "custom", task: "返回摘要" },
    });
    handle({
      type: "tool_execution_end",
      toolName: "subagent",
      toolCallId: "pi-subagent-generic",
      result: { content: [{ type: "text", text: "摘要" }] },
      isError: false,
    });

    expect(events.at(-1)).toMatchObject({
      type: "subagent_event",
      phase: "completed",
      state: "completed",
    });
    agent.dispose();
  });

  it("preserves resumeAgent action from the start event until completion", () => {
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const handle = createToolMessage(agent);
    handle({
      type: "tool_execution_start",
      toolName: "subagent",
      toolCallId: "pi-subagent-resume",
      action: "resumeAgent",
      args: { agent: "worker", task: "继续任务" },
    });
    handle({
      type: "tool_execution_end",
      toolName: "subagent",
      toolCallId: "pi-subagent-resume",
      result: { content: [{ type: "text", text: "已继续完成" }] },
      isError: false,
    });

    expect(events.at(-1)).toMatchObject({ action: "resumeAgent", tool: "resumeAgent", state: "completed" });
    agent.dispose();
  });

  it("keeps a running background subagent observable across parent turns", () => {
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as { prepareNewTurn: () => void };
    const handle = createToolMessage(agent);
    handle({
      type: "tool_execution_start",
      toolName: "subagent",
      toolCallId: "pi-subagent-background",
      args: { agent: "worker", task: "后台任务" },
    });
    internals.prepareNewTurn();
    handle({
      type: "tool_execution_update",
      toolName: "subagent",
      toolCallId: "pi-subagent-background",
      partialResult: {
        details: {
          results: [{ agent: "worker", status: "running", exitCode: -1, output: "仍在运行" }],
        },
      },
    });

    expect(events.filter((event) => event.type === "subagent_event")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ state: "running", phase: "started" });
    agent.dispose();
  });

  it("does not downgrade a terminal subagent after a late running event", () => {
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const handle = createToolMessage(agent);
    handle({
      type: "tool_execution_start",
      toolName: "subagent",
      toolCallId: "pi-subagent-ordering",
      args: { agent: "worker", task: "完成任务" },
    });
    handle({
      type: "tool_execution_end",
      toolName: "subagent",
      toolCallId: "pi-subagent-ordering",
      result: {
        details: {
          results: [{ agent: "worker", exitCode: 0, status: "completed", model: { provider: "test", id: "worker-model" }, output: "已完成" }],
        },
      },
      isError: false,
    });
    const countAfterCompletion = events.filter((event) => event.type === "subagent_event").length;

    handle({
      type: "tool_execution_update",
      toolName: "subagent",
      toolCallId: "pi-subagent-ordering",
      partialResult: {
        details: {
          results: [{ agent: "worker", exitCode: -1, status: "running", output: "迟到更新" }],
        },
      },
    });

    expect(events.filter((event) => event.type === "subagent_event")).toHaveLength(countAfterCompletion);
    expect(events.at(-1)).toMatchObject({
      phase: "completed",
      state: "completed",
      action: "spawnAgent",
      subagents: [expect.objectContaining({ model: "test/worker-model" })],
    });
    agent.dispose();
  });

  it("emits interrupted subagent state when the parent Pi turn is aborted", async () => {
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const handle = createToolMessage(agent);
    handle({
      type: "tool_execution_start",
      toolName: "subagent",
      toolCallId: "pi-subagent-abort",
      args: { agent: "worker", task: "长时间任务" },
    });

    await agent.abort();

    expect(events).toContainEqual(expect.objectContaining({
      type: "subagent_event",
      id: "pi-subagent-abort",
      phase: "completed",
      state: "interrupted",
      source: "pi",
    }));
    expect(agent.isIdle()).toBe(true);
  });
});

