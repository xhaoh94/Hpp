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
