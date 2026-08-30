import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return { ...original, spawn: spawnMock };
});

import { CodexAgent } from "./backend";

class FakeCodexProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => {
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  });
}

const respondToLifecycle = (
  child: FakeCodexProcess,
  onCommand?: (command: Record<string, unknown>) => void,
) => {
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      const command = JSON.parse(line) as Record<string, unknown>;
      onCommand?.(command);
      if (command.type === "init") {
        child.stdout.write(`${JSON.stringify({ type: "ready", id: command.id })}\n`);
      }
      if (command.type === "guidance") {
        child.stdout.write(`${JSON.stringify({ type: "guidance_done", id: command.id })}\n`);
      }
      if (command.type === "dispose") {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      }
    }
  });
};

describe("Codex lifecycle", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("ignores output from a replaced Codex worker", () => {
    const events: AgentEvent[] = [];
    const agent = new CodexAgent("session-1", (event) => events.push(event as AgentEvent));
    const oldWorker = new FakeCodexProcess();
    const currentWorker = new FakeCodexProcess();
    const internals = agent as unknown as {
      process: FakeCodexProcess;
      handleWorkerMessage: (message: Record<string, unknown>, sourceChild?: object) => void;
    };
    internals.process = currentWorker;
    internals.handleWorkerMessage({ type: "stream_delta", delta: "stale" }, oldWorker);

    expect(events).toEqual([]);
  });

  it("waits for worker disposal without emitting a disconnect", async () => {
    const child = new FakeCodexProcess();
    respondToLifecycle(child);
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new CodexAgent("session-1", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");

    await agent.dispose();

    expect(child.exitCode).toBe(0);
    expect(events.some((event) => event.type === "agent_disconnected")).toBe(false);
  });

  it("emits a terminal lifecycle before disposing an active turn", async () => {
    const child = new FakeCodexProcess();
    respondToLifecycle(child);
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new CodexAgent("session-1", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");
    events.length = 0;
    await agent.sendMessage("work", undefined, { clientMessageId: "prompt-dispose" });

    await agent.dispose();

    expect(agent.isIdle()).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "stream_end",
      "agent_end",
    ]);
  });

  it("forwards host system guidance to the worker without changing the displayed message", async () => {
    const child = new FakeCodexProcess();
    const commands: Record<string, unknown>[] = [];
    respondToLifecycle(child, (command) => commands.push(command));
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new CodexAgent("session-1", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project", undefined, { hostSystemPrompt: "HPP_HOST_GUIDANCE" });
    events.length = 0;

    await agent.sendMessage("actual user text", undefined, {
      clientMessageId: "prompt-host-guidance",
      displayMessage: "visible user text",
      hostSystemPrompt: "HPP_HOST_GUIDANCE",
    });
    await agent.sendGuidance("steer this turn", undefined, {
      hostSystemPrompt: "HPP_HOST_GUIDANCE",
    });

    expect(commands).toContainEqual(expect.objectContaining({
      type: "init",
      hostSystemPrompt: "HPP_HOST_GUIDANCE",
    }));
    expect(commands).toContainEqual(expect.objectContaining({
      id: "prompt-host-guidance",
      type: "prompt",
      message: "actual user text",
      hostSystemPrompt: "HPP_HOST_GUIDANCE",
    }));
    expect(commands).toContainEqual(expect.objectContaining({
      type: "guidance",
      message: "steer this turn",
      hostSystemPrompt: "HPP_HOST_GUIDANCE",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "message_start",
      role: "user",
      content: "visible user text",
    }));
    await agent.dispose();
  });

  it("emits guidance_response_started only for the delivered steer request", async () => {
    const child = new FakeCodexProcess();
    const commands: Record<string, unknown>[] = [];
    respondToLifecycle(child, (command) => commands.push(command));
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new CodexAgent("session-1", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");
    await agent.sendMessage("work", undefined, { clientMessageId: "prompt-1" });

    // turn/steer acceptance and unrelated old output must not report the
    // guidance as started yet.
    await agent.sendGuidance("steer this turn");
    child.stdout.write(`${JSON.stringify({ type: "stream_delta", delta: "still finishing" })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "guidance_delivered", id: "unrelated-guidance" })}\n`);
    expect(events.some((event) => event.type === "guidance_response_started")).toBe(false);

    // The worker reports delivery with the same command id after matching the
    // delayed Codex userMessage item.
    const guidanceCommand = commands.find((command) => command.type === "guidance");
    expect(guidanceCommand?.id).toEqual(expect.any(String));
    child.stdout.write(`${JSON.stringify({ type: "guidance_delivered", id: guidanceCommand?.id })}\n`);
    expect(events.some((event) => event.type === "guidance_response_started")).toBe(true);
    await agent.dispose();
  });

  it("keeps the first prompt active when a concurrent prompt is rejected", async () => {
    const child = new FakeCodexProcess();
    respondToLifecycle(child);
    spawnMock.mockReturnValue(child);
    const agent = new CodexAgent("session-1");
    await agent.init("C:\\project");
    await agent.sendMessage("first", undefined, { clientMessageId: "prompt-1" });
    await agent.sendMessage("second", undefined, { clientMessageId: "prompt-2" });

    child.stdout.write(`${JSON.stringify({ type: "error", id: "prompt-2", error: "Codex is already running" })}\n`);

    expect(agent.isIdle()).toBe(false);
    child.stdout.write(`${JSON.stringify({ type: "prompt_done", id: "prompt-1" })}\n`);
    expect(agent.isIdle()).toBe(true);
    await agent.dispose();
  });

  it("keeps the prompt busy through compaction and stream_end until the worker's terminal agent_end", async () => {
    const child = new FakeCodexProcess();
    respondToLifecycle(child);
    spawnMock.mockReturnValue(child);
    const agent = new CodexAgent("session-1");
    await agent.init("C:\\project");
    await agent.sendMessage("work", undefined, { clientMessageId: "prompt-compaction" });

    child.stdout.write(`${JSON.stringify({ type: "context_compaction", id: "compact-1" })}\n`);
    expect(agent.isIdle()).toBe(false);

    child.stdout.write(`${JSON.stringify({ type: "stream_end", content: "done", force: true })}\n`);
    expect(agent.isIdle()).toBe(false);

    // Codex worker synthesizes agent_end only from finishPrompt/abort; app-server
    // retry and compaction notifications are never forwarded as agent_end.
    child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    expect(agent.isIdle()).toBe(true);
    await agent.dispose();
  });

  it("does not treat an unrelated control response as an active conversation turn", async () => {
    const child = new FakeCodexProcess();
    respondToLifecycle(child);
    spawnMock.mockReturnValue(child);
    const agent = new CodexAgent("session-1");
    await agent.init("C:\\project");

    const internals = agent as unknown as {
      pendingResponses: Map<string, (data: Record<string, unknown>) => void>;
    };
    internals.pendingResponses.set("models-request", vi.fn());

    expect(agent.isIdle()).toBe(true);
    await agent.dispose();
  });

  it("rejects a UI response when the worker reports an error", async () => {
    const agent = new CodexAgent("session-1");
    const write = vi.fn();
    const internals = agent as unknown as {
      process: { stdin: { writable: boolean; write: (value: string) => void } };
      handleWorkerMessage: (message: Record<string, unknown>) => void;
    };
    internals.process = { stdin: { writable: true, write } };

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
  });

  it("does not fail an active prompt for an unrelated control RPC error", async () => {
    const child = new FakeCodexProcess();
    respondToLifecycle(child);
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new CodexAgent("session-1", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");
    await agent.sendMessage("work", undefined, { clientMessageId: "prompt-1" });
    const internals = agent as unknown as {
      pendingResponses: Map<string, (data: Record<string, unknown>) => void>;
    };
    const controlResponse = vi.fn();
    internals.pendingResponses.set("models-request", controlResponse);

    child.stdout.write(`${JSON.stringify({
      type: "error",
      id: "models-request",
      error: "models unavailable",
    })}\n`);

    expect(controlResponse).toHaveBeenCalledTimes(1);
    expect(agent.isIdle()).toBe(false);
    expect(events.some((event) => event.type === "process_event" && event.state === "error")).toBe(false);
    child.stdout.write(`${JSON.stringify({ type: "prompt_done", id: "prompt-1" })}\n`);
    await agent.dispose();
  });

  it("returns to idle when a prompt cannot be written", async () => {
    const events: AgentEvent[] = [];
    const agent = new CodexAgent("session-1", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as {
      process: { stdin: { writable: boolean; write: ReturnType<typeof vi.fn> } };
    };
    internals.process = { stdin: { writable: false, write: vi.fn() } };

    await expect(agent.sendMessage("work", undefined, { clientMessageId: "prompt-1" }))
      .rejects.toThrow("not writable");

    expect(agent.isIdle()).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "process_event",
      "stream_end",
      "agent_end",
    ]);
  });

  it("finishes an active turn when the worker input pipe fails asynchronously", async () => {
    const child = new FakeCodexProcess();
    respondToLifecycle(child);
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new CodexAgent("session-1", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");
    events.length = 0;
    await agent.sendMessage("work", undefined, { clientMessageId: "prompt-pipe-error" });

    child.stdin.emit("error", new Error("broken pipe"));

    expect(agent.isIdle()).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "process_event",
      "stream_end",
      "agent_end",
    ]);
  });

  it("returns to idle when the worker reports its internal transport disconnected", async () => {
    const child = new FakeCodexProcess();
    respondToLifecycle(child);
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new CodexAgent("session-1", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");
    events.length = 0;
    await agent.sendMessage("work", undefined, { clientMessageId: "prompt-disconnected" });

    child.stdout.write(`${JSON.stringify({ type: "agent_disconnected", detail: "app-server exited" })}\n`);

    expect(agent.isIdle()).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent_disconnected",
      detail: "app-server exited",
    }));
  });

  it("returns to idle when abort cannot be written", async () => {
    const events: AgentEvent[] = [];
    const agent = new CodexAgent("session-1", (event) => events.push(event as AgentEvent));
    const stdin = { writable: true, write: vi.fn() };
    const internals = agent as unknown as { process: { stdin: typeof stdin } };
    internals.process = { stdin };
    await agent.sendMessage("work", undefined, { clientMessageId: "prompt-abort-write" });
    stdin.writable = false;

    await expect(agent.abort()).resolves.toBeUndefined();

    expect(agent.isIdle()).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "aborted",
      detail: expect.stringContaining("not writable"),
    }));
  });

  it("emits a complete terminal lifecycle for an active prompt error", async () => {
    const child = new FakeCodexProcess();
    respondToLifecycle(child);
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new CodexAgent("session-1", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");
    events.length = 0;
    await agent.sendMessage("work", undefined, { clientMessageId: "prompt-1" });

    child.stdout.write(`${JSON.stringify({ type: "error", id: "prompt-1", error: "request failed" })}\n`);

    expect(agent.isIdle()).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "process_event",
      "stream_end",
      "agent_end",
    ]);
    await agent.dispose();
  });

  it("forwards commentary events from the worker", async () => {
    const child = new FakeCodexProcess();
    respondToLifecycle(child);
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new CodexAgent("session-1", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");

    child.stdout.write(`${JSON.stringify({ type: "commentary_delta", itemId: "commentary-1", delta: "Working" })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "commentary_end", itemId: "commentary-1", content: "Working" })}\n`);

    expect(events).toContainEqual(expect.objectContaining({
      type: "commentary_delta",
      itemId: "commentary-1",
      delta: "Working",
      sessionId: "session-1",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "commentary_end",
      itemId: "commentary-1",
      content: "Working",
      sessionId: "session-1",
    }));
    await agent.dispose();
  });

  it("forwards normalized sub-agent lifecycle events from the worker", async () => {
    const child = new FakeCodexProcess();
    respondToLifecycle(child);
    spawnMock.mockReturnValue(child);
    const events: AgentEvent[] = [];
    const agent = new CodexAgent("session-1", (event) => events.push(event as AgentEvent));
    await agent.init("C:\\project");

    child.stdout.write(`${JSON.stringify({
      type: "subagent_event",
      id: "collab-1",
      toolCallId: "collab-1",
      phase: "completed",
      action: "wait",
      tool: "wait",
      title: "已完成",
      state: "completed",
      timestamp: 1000,
      startedAt: 900,
      completedAt: 1000,
      subagents: [{
        id: "agent-1",
        label: "Backend commentary",
        status: "completed",
        model: "gpt-5",
        path: "/root/backend_commentary",
        message: "Done",
      }],
    })}\n`);

    expect(events).toContainEqual(expect.objectContaining({
      type: "subagent_event",
      id: "collab-1",
      action: "wait",
      state: "completed",
      timestamp: 1000,
      sessionId: "session-1",
      subagents: [{
        id: "agent-1",
        label: "Backend commentary",
        status: "completed",
        model: "gpt-5",
        path: "/root/backend_commentary",
        message: "Done",
      }],
    }));
    await agent.dispose();
  });
});
