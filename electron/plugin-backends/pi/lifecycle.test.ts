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

const respondToInit = (child: FakePiProcess, sessionFilePath = "C:\\sessions\\pi.jsonl") => {
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      const command = JSON.parse(line) as Record<string, unknown>;
      if (command.type !== "init") continue;
      child.stdout.write(`${JSON.stringify({ type: "history_snapshot", messages: [] })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "ready", id: command.id, sessionFilePath })}\n`);
    }
  });
};

describe("Pi lifecycle", () => {
  beforeEach(() => {
    spawnMock.mockReset();
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
