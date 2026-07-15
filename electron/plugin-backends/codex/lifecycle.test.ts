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

const respondToLifecycle = (child: FakeCodexProcess) => {
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      const command = JSON.parse(line) as Record<string, unknown>;
      if (command.type === "init") {
        child.stdout.write(`${JSON.stringify({ type: "ready", id: command.id })}\n`);
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
});
