import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return { ...original, spawn: spawnMock };
});

import { PiSDKAgent } from "./backend";

class FakePiProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

const respondToInit = (
  child: FakePiProcess,
  sessionFilePath = "C:\\sessions\\pi.jsonl",
  onCommand?: (command: Record<string, unknown>) => void,
) => {
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      const command = JSON.parse(line) as Record<string, unknown>;
      onCommand?.(command);
      if (command.type === "init") {
        child.stdout.write(`${JSON.stringify({ type: "history_snapshot", messages: [] })}\n`);
        child.stdout.write(`${JSON.stringify({ type: "ready", id: command.id, sessionFilePath })}\n`);
      }
      if (command.type === "guidance") {
        child.stdout.write(`${JSON.stringify({ type: "guidance_done", id: command.id })}\n`);
      }
      if (command.type === "setCompactionConfig") {
        child.stdout.write(`${JSON.stringify({ type: "compaction_config_changed", id: command.id })}\n`);
      }
    }
  });
};

describe("Pi lifecycle", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("does not report a control RPC as an active conversation turn", () => {
    const agent = new PiSDKAgent("hpp-session");
    const internals = agent as unknown as {
      pendingResponses: Map<string, (data: Record<string, unknown>) => void>;
    };
    internals.pendingResponses.set("models-request", vi.fn());

    expect(agent.isIdle()).toBe(true);
  });

  it("forwards the host policy during init, prompt, and guidance", async () => {
    const child = new FakePiProcess();
    const commands: Record<string, unknown>[] = [];
    respondToInit(child, "C:\\sessions\\pi.jsonl", (command) => commands.push(command));
    spawnMock.mockReturnValue(child);
    const agent = new PiSDKAgent("hpp-session");

    await agent.init("C:\\project", undefined, { hostSystemPrompt: "HPP_HOST_GUIDANCE" });
    await agent.sendMessage("work", undefined, { hostSystemPrompt: "HPP_HOST_GUIDANCE" });
    await agent.sendGuidance("steer this turn", undefined, {
      hostSystemPrompt: "HPP_HOST_GUIDANCE",
    });

    expect(commands).toContainEqual(expect.objectContaining({
      type: "init",
      hostSystemPrompt: "HPP_HOST_GUIDANCE",
    }));
    expect(commands).toContainEqual(expect.objectContaining({
      type: "prompt",
      message: "work",
      hostSystemPrompt: "HPP_HOST_GUIDANCE",
    }));
    expect(commands).toContainEqual(expect.objectContaining({
      type: "guidance",
      message: "steer this turn",
      hostSystemPrompt: "HPP_HOST_GUIDANCE",
    }));
    (agent as unknown as { process: unknown }).process = null;
  });

  it("forwards and hot-updates the generic Agent compaction config", async () => {
    const child = new FakePiProcess();
    const commands: Record<string, unknown>[] = [];
    respondToInit(child, "C:\\sessions\\pi.jsonl", (command) => commands.push(command));
    spawnMock.mockReturnValue(child);
    const agent = new PiSDKAgent("hpp-session");
    const initialConfig = {
      thinkingLevel: "low" as const,
      modelMode: "current" as const,
      customModel: {
        baseUrl: "",
        apiKey: "",
        modelId: "",
        api: "openai-completions" as const,
        reasoning: false,
      },
    };

    await agent.init("C:\\project", undefined, { compaction: initialConfig });
    expect(commands).toContainEqual(expect.objectContaining({
      type: "init",
      compactionConfig: initialConfig,
    }));

    const updatedConfig = {
      ...initialConfig,
      thinkingLevel: "off" as const,
    };
    await agent.setCompactionConfig(updatedConfig);
    expect(commands).toContainEqual(expect.objectContaining({
      type: "setCompactionConfig",
      config: updatedConfig,
    }));
    (agent as unknown as { process: unknown }).process = null;
  });

  it("reports a standalone Pi compaction as busy until its terminal phase", () => {
    const agent = new PiSDKAgent("hpp-session");
    const internals = agent as unknown as {
      handleWorkerMessage: (message: Record<string, unknown>) => void;
    };

    internals.handleWorkerMessage({
      type: "context_compaction",
      id: "compact-background",
      phase: "started",
    });
    expect(agent.isIdle()).toBe(false);

    internals.handleWorkerMessage({
      type: "context_compaction",
      id: "compact-background",
      phase: "completed",
    });
    expect(agent.isIdle()).toBe(true);
  });

  it("waits out an active compaction before asking the worker for models", async () => {
    const child = new FakePiProcess();
    const getModelsCommands: string[] = [];
    respondToInit(child, "C:\\sessions\\pi.jsonl", (command) => {
      if (command.type !== "getModels") return;
      getModelsCommands.push(String(command.id));
      child.stdout.write(`${JSON.stringify({
        type: "models",
        id: command.id,
        models: [
          { id: "claude-opus", name: "Opus", provider: "anthropic" },
        ],
      })}\n`);
    });
    spawnMock.mockReturnValue(child);
    const agent = new PiSDKAgent("hpp-session");
    await agent.init("C:\\project");

    const internals = agent as unknown as {
      handleWorkerMessage: (message: Record<string, unknown>) => void;
    };
    internals.handleWorkerMessage({
      type: "context_compaction",
      id: "compact-models",
      phase: "started",
    });

    // While compaction is active the probe must not hit the busy worker.
    const pending = agent.getModels();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getModelsCommands.length).toBe(0);

    internals.handleWorkerMessage({
      type: "context_compaction",
      id: "compact-models",
      phase: "completed",
    });

    const models = await pending;
    expect(getModelsCommands.length).toBe(1);
    expect(models).toEqual([
      expect.objectContaining({ id: "claude-opus", provider: "anthropic" }),
    ]);
    (agent as unknown as { process: unknown }).process = null;
  });

  it("returns the cached model list without probing the worker during compaction", async () => {
    const child = new FakePiProcess();
    const getModelsCommands: string[] = [];
    respondToInit(child, "C:\\sessions\\pi.jsonl", (command) => {
      if (command.type !== "getModels") return;
      getModelsCommands.push(String(command.id));
      child.stdout.write(`${JSON.stringify({
        type: "models",
        id: command.id,
        models: [{ id: "claude-sonnet", name: "Sonnet", provider: "anthropic" }],
      })}\n`);
    });
    spawnMock.mockReturnValue(child);
    const agent = new PiSDKAgent("hpp-session");
    await agent.init("C:\\project");

    // Prime the cache.
    const first = await agent.getModels();
    expect(first).toHaveLength(1);

    const internals = agent as unknown as {
      handleWorkerMessage: (message: Record<string, unknown>) => void;
    };
    internals.handleWorkerMessage({
      type: "context_compaction",
      id: "compact-cached",
      phase: "started",
    });

    const cached = await agent.getModels();
    expect(cached).toHaveLength(1);
    expect(getModelsCommands.length).toBe(1);
    (agent as unknown as { process: unknown }).process = null;
  });

  it("stays busy when prompt_done arrives before background compaction completes", async () => {
    const child = new FakePiProcess();
    respondToInit(child);
    spawnMock.mockReturnValue(child);
    const agent = new PiSDKAgent("hpp-session");
    await agent.init("C:\\project");
    await agent.sendMessage("hello", undefined, { clientMessageId: "client-background-compact" });

    child.stdout.write(`${JSON.stringify({
      type: "context_compaction",
      id: "compact-background",
      phase: "started",
    })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "prompt_done", id: "client-background-compact" })}\n`);

    expect(agent.isIdle()).toBe(false);
    await expect(agent.sendMessage("too early")).rejects.toThrow("SESSION_BUSY");

    child.stdout.write(`${JSON.stringify({
      type: "context_compaction",
      id: "compact-background",
      phase: "completed",
    })}\n`);
    expect(agent.isIdle()).toBe(true);
    (agent as unknown as { process: unknown }).process = null;
  });

  it("rejects a UI response when the worker reports an error", async () => {
    const agent = new PiSDKAgent("hpp-session");
    const write = vi.fn();
    const internals = agent as unknown as {
      process: { stdin: { writable: boolean; write: (value: string) => void } };
      pendingUIRequestIds: Set<string>;
      handleWorkerMessage: (message: Record<string, unknown>) => void;
    };
    internals.process = { stdin: { writable: true, write } };
    internals.pendingUIRequestIds.add("question-1");

    const sending = agent.sendUIResponse({ requestId: "question-1", text: "answer" });
    const rejection = expect(sending).rejects.toThrow("worker response failed");
    const command = JSON.parse(String(write.mock.calls[0][0])) as {
      id: string;
      response: { id?: string };
    };
    expect(command.response.id).toBe("question-1");

    internals.handleWorkerMessage({
      type: "error",
      id: command.id,
      error: "worker response failed",
    });

    await rejection;
    expect(internals.pendingUIRequestIds.has("question-1")).toBe(true);
  });

  it("returns to idle when a prompt cannot be written", async () => {
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as {
      process: { stdin: { writable: boolean; write: ReturnType<typeof vi.fn> } };
    };
    internals.process = { stdin: { writable: false, write: vi.fn() } };

    await expect(agent.sendMessage("hello", undefined, { clientMessageId: "client-write-failure" }))
      .rejects.toThrow("not writable");

    expect(agent.isIdle()).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "stream_start",
      "process_event",
      "stream_end",
      "agent_end",
    ]);
  });

  it("emits a terminal lifecycle before disposing an active turn", async () => {
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as {
      process: { stdin: { writable: boolean; write: ReturnType<typeof vi.fn> } } | null;
    };
    internals.process = { stdin: { writable: true, write: vi.fn() } };
    await agent.sendMessage("hello", undefined, { clientMessageId: "client-dispose" });
    internals.process = null;

    await agent.dispose();

    expect(agent.isIdle()).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "stream_start",
      "stream_end",
      "agent_end",
    ]);
  });

  it("keeps one Hpp turn open across Pi automatic retries", async () => {
    const child = new FakePiProcess();
    respondToInit(child);
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");
    await agent.sendMessage("hello", undefined, { clientMessageId: "client-1" });

    child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "temporary failure" },
    })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);

    expect(agent.isIdle()).toBe(false);
    expect(events.some((event) => event.type === "stream_end")).toBe(false);
    expect(events.some((event) => event.type === "process_event" && event.state === "error")).toBe(false);

    child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "message_end",
      message: { role: "assistant", text: "recovered", stopReason: "stop" },
    })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "prompt_done", id: "client-1" })}\n`);

    expect(agent.isIdle()).toBe(true);
    expect(events.filter((event) => event.type === "stream_end")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "stream_end", content: "recovered" }));
    expect(events.some((event) => event.type === "process_event" && event.state === "error")).toBe(false);
    agent.dispose();
  });

  it("falls back to idle when agent_end is not followed by prompt_done", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakePiProcess();
      respondToInit(child);
      spawnMock.mockReturnValue(child);
      const events: AgentEvent[] = [];
      const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
      await agent.init("C:\\project");
      events.length = 0;
      await agent.sendMessage("hello", undefined, { clientMessageId: "client-missing-settle" });

      child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
      expect(agent.isIdle()).toBe(false);

      await vi.advanceTimersByTimeAsync(4000);

      expect(agent.isIdle()).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ type: "stream_end", force: true }));
      expect(events).toContainEqual(expect.objectContaining({ type: "agent_end" }));
      (agent as unknown as { process: unknown }).process = null;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not settle from final text before Pi reports agent_end", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakePiProcess();
      respondToInit(child);
      spawnMock.mockReturnValue(child);
      const events: AgentEvent[] = [];
      const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
      await agent.init("C:\\project");
      events.length = 0;
      await agent.sendMessage("hello", undefined, { clientMessageId: "client-final-text" });

      child.stdout.write(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", text: "final answer", stopReason: "stop" },
      })}\n`);
      await vi.advanceTimersByTimeAsync(4000);

      expect(agent.isIdle()).toBe(false);
      expect(events.some((event) => event.type === "stream_end")).toBe(false);

      child.stdout.write(`${JSON.stringify({ type: "prompt_done", id: "client-final-text" })}\n`);
      expect(agent.isIdle()).toBe(true);
      (agent as unknown as { process: unknown }).process = null;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["context compaction", { type: "context_compaction", id: "compact-1", phase: "started" }],
    ["automatic retry", { type: "status", id: "retry-1", status: "retrying", title: "retrying" }],
  ])("keeps the turn active when %s follows agent_end", async (_label, continuationEvent) => {
    vi.useFakeTimers();
    try {
      const child = new FakePiProcess();
      respondToInit(child);
      spawnMock.mockReturnValue(child);
      const events: AgentEvent[] = [];
      const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
      await agent.init("C:\\project");
      events.length = 0;
      await agent.sendMessage("hello", undefined, { clientMessageId: "client-continuation" });

      child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
      child.stdout.write(`${JSON.stringify(continuationEvent)}\n`);
      await vi.advanceTimersByTimeAsync(4000);

      expect(agent.isIdle()).toBe(false);
      expect(events.some((event) => event.type === "stream_end")).toBe(false);

      child.stdout.write(`${JSON.stringify({ type: "prompt_done", id: "client-continuation" })}\n`);
      if (continuationEvent.type === "context_compaction") {
        expect(agent.isIdle()).toBe(false);
        child.stdout.write(`${JSON.stringify({
          type: "context_compaction",
          id: continuationEvent.id,
          phase: "completed",
        })}\n`);
      }
      expect(agent.isIdle()).toBe(true);
      (agent as unknown as { process: unknown }).process = null;
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the missing-prompt fallback after compaction completes", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakePiProcess();
      respondToInit(child);
      spawnMock.mockReturnValue(child);
      const events: AgentEvent[] = [];
      const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
      await agent.init("C:\\project");
      events.length = 0;
      await agent.sendMessage("hello", undefined, { clientMessageId: "client-compaction-tail" });

      child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
      child.stdout.write(`${JSON.stringify({
        type: "context_compaction",
        id: "compact-tail",
        phase: "started",
      })}\n`);
      await vi.advanceTimersByTimeAsync(4000);
      expect(agent.isIdle()).toBe(false);

      child.stdout.write(`${JSON.stringify({
        type: "context_compaction",
        id: "compact-tail",
        phase: "completed",
      })}\n`);
      await vi.advanceTimersByTimeAsync(4000);

      expect(agent.isIdle()).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ type: "stream_end", force: true }));
      (agent as unknown as { process: unknown }).process = null;
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the missing-prompt fallback when compaction fails with its own event id", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakePiProcess();
      respondToInit(child);
      spawnMock.mockReturnValue(child);
      const events: AgentEvent[] = [];
      const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
      await agent.init("C:\\project");
      events.length = 0;
      await agent.sendMessage("hello", undefined, { clientMessageId: "client-compaction-error" });

      child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
      child.stdout.write(`${JSON.stringify({
        type: "context_compaction",
        id: "compact-error",
        phase: "started",
      })}\n`);
      child.stdout.write(`${JSON.stringify({
        type: "error",
        id: "compact-error",
        error: "context compaction failed",
      })}\n`);
      await vi.advanceTimersByTimeAsync(4000);

      expect(agent.isIdle()).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({
        type: "context_compaction",
        id: "compact-error",
        phase: "interrupted",
      }));
      expect(events.some((event) => event.type === "process_event" && event.state === "error")).toBe(false);
      (agent as unknown as { process: unknown }).process = null;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["message update", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "tail" },
    }],
    ["tool completion", {
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "tool-tail",
      result: "ok",
    }],
  ])("re-arms the missing-prompt fallback after a late %s", async (_label, trailingEvent) => {
    vi.useFakeTimers();
    try {
      const child = new FakePiProcess();
      respondToInit(child);
      spawnMock.mockReturnValue(child);
      const events: AgentEvent[] = [];
      const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
      await agent.init("C:\\project");
      events.length = 0;
      await agent.sendMessage("hello", undefined, { clientMessageId: "client-trailing-event" });

      child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
      child.stdout.write(`${JSON.stringify(trailingEvent)}\n`);
      await vi.advanceTimersByTimeAsync(4000);

      expect(agent.isIdle()).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ type: "stream_end", force: true }));
      (agent as unknown as { process: unknown }).process = null;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not repeat narration when Pi emits multiple assistant messages around tools", async () => {
    const child = new FakePiProcess();
    respondToInit(child);
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");
    await agent.sendMessage("hello", undefined, { clientMessageId: "client-multi" });

    child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "first narration" },
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "message_end",
      message: { role: "assistant", text: "first narration", stopReason: "toolUse" },
    })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolName: "bash", toolCallId: "tool-1", args: {} })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "tool_execution_end", toolName: "bash", toolCallId: "tool-1", result: "ok" })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "second narration" },
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "message_end",
      message: { role: "assistant", text: "second narration", stopReason: "stop" },
    })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "prompt_done", id: "client-multi" })}\n`);

    expect(events.filter((event) => event.type === "stream_delta").map((event) => event.delta)).toEqual([
      "first narration",
      "second narration",
    ]);
    expect(events.some((event) => event.type === "stream_snapshot")).toBe(false);
    agent.dispose();
  });

  it("emits a whole-turn snapshot when Pi corrects the current assistant message", async () => {
    const child = new FakePiProcess();
    respondToInit(child);
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");
    await agent.sendMessage("hello", undefined, { clientMessageId: "client-snapshot" });

    child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "first" },
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "message_end",
      message: { role: "assistant", text: "first", stopReason: "toolUse" },
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "sec" },
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "message_end",
      message: { role: "assistant", text: "second", stopReason: "stop" },
    })}\n`);

    expect(events).toContainEqual(expect.objectContaining({
      type: "stream_snapshot",
      content: "firstsecond",
    }));
    agent.dispose();
  });

  it("forwards Pi runtime warnings without failing the turn", async () => {
    const child = new FakePiProcess();
    respondToInit(child);
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");
    await agent.sendMessage("hello", undefined, { clientMessageId: "client-warning" });

    child.stdout.write(`${JSON.stringify({
      type: "status",
      id: "pi-shell-unavailable",
      status: "warning",
      title: "Pi Shell 不可用，已改用文件发现工具",
      detail: "WSL is not installed",
    })}\n`);

    expect(events).toContainEqual(expect.objectContaining({
      type: "process_event",
      state: "warning",
      title: "Pi Shell 不可用，已改用文件发现工具",
    }));
    expect(events.some((event) => event.type === "process_event" && event.state === "error")).toBe(false);
    agent.dispose();
  });

  it("finishes an active turn when the Pi worker crashes", async () => {
    const child = new FakePiProcess();
    respondToInit(child);
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");
    await agent.sendMessage("hello", undefined, { clientMessageId: "client-1" });
    child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);

    child.emit("exit", 1, null);

    expect(agent.isIdle()).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "stream_end", force: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: "process_event", state: "error" }));
    await expect(agent.sendMessage("again")).rejects.toThrow("not running");
    expect(agent.isIdle()).toBe(true);
  });

  it("finishes an active turn when the Pi input pipe fails asynchronously", async () => {
    const child = new FakePiProcess();
    respondToInit(child);
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");
    events.length = 0;
    await agent.sendMessage("hello", undefined, { clientMessageId: "client-pipe-error" });

    child.stdin.emit("error", new Error("broken pipe"));

    expect(agent.isIdle()).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "process_event", state: "error" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "stream_end", force: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_end" }));
  });

  it("emits aborted and returns to idle after a manual abort", async () => {
    const child = new FakePiProcess();
    respondToInit(child);
    child.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
        const command = JSON.parse(line) as Record<string, unknown>;
        if (command.type === "abort") {
          child.stdout.write(`${JSON.stringify({ type: "aborted", id: command.id })}\n`);
        }
      }
    });
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");
    await agent.sendMessage("hello", undefined, { clientMessageId: "client-1" });

    expect(agent.isIdle()).toBe(false);
    await agent.abort();

    expect(agent.isIdle()).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "aborted" }));
    agent.dispose();
  });

  it("emits guidance_response_started only when the steer message is delivered", async () => {
    const child = new FakePiProcess();
    respondToInit(child);
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");
    await agent.sendMessage("work", undefined, { clientMessageId: "client-1" });

    // steer() only queues the guidance: sending it resolves but must not yet
    // report the guidance response as started.
    await agent.sendGuidance("steer this turn");
    child.stdout.write(`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "still finishing" } })}\n`);
    expect(events.some((event) => event.type === "guidance_response_started")).toBe(false);

    // The worker emits guidance_delivered once the steer message enters the
    // agent message flow, right before the guidance output begins.
    child.stdout.write(`${JSON.stringify({ type: "guidance_delivered" })}\n`);
    expect(events.some((event) => event.type === "guidance_response_started")).toBe(true);
    agent.dispose();
  });

  it("relays Pi history and native turn metadata", async () => {
    const child = new FakePiProcess();
    child.stdin.on("data", (chunk) => {
      const command = JSON.parse(chunk.toString()) as Record<string, unknown>;
      if (command.type !== "init") return;
      child.stdout.write(`${JSON.stringify({
        type: "history_snapshot",
        messages: [{ id: "history-1", role: "user", content: "hello", timestamp: 1, nativeTurnId: "pi-1" }],
      })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "ready", id: command.id, sessionFilePath: "pi-session" })}\n`);
    });
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new PiSDKAgent("hpp-session", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");
    child.stdout.write(`${JSON.stringify({
      type: "turn_metadata",
      nativeTurnId: "pi-assistant-1",
      clientUserMessageId: "client-1",
    })}\n`);

    expect(events).toContainEqual(expect.objectContaining({ type: "history_snapshot" }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "turn_metadata",
      nativeTurnId: "pi-assistant-1",
      clientUserMessageId: "client-1",
    }));
    agent.dispose();
  });
});
