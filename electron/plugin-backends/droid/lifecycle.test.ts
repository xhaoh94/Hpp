import { EventEmitter } from "events";
import { PassThrough } from "stream";
import type { ChildProcess } from "child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return { ...original, spawn: spawnMock };
});

import { DroidAgent } from "./backend";

class FakeDroidProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

interface DroidInternals {
  process: ChildProcess | null;
  waitForExit: (childProcess: ChildProcess, timeoutMs: number) => Promise<boolean>;
  killProcessTree: (childProcess: ChildProcess) => Promise<void>;
}

describe("Droid lifecycle", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("loads an existing Droid session instead of creating a new one", async () => {
    const child = new FakeDroidProcess();
    spawnMock.mockReturnValue(child);
    const requests: Record<string, unknown>[] = [];
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
      requests.push(request);
      child.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        factoryApiVersion: "1.0.0",
        factoryProtocolVersion: "1.108.0",
        type: "response",
        id: request.id,
        result: {
          session: { messages: [] },
          availableModels: [],
        },
      })}\n`);
    });

    const agent = new DroidAgent();
    await agent.init("C:\\project", "existing-session");

    expect(requests[0]).toMatchObject({
      method: "droid.load_session",
      params: { sessionId: "existing-session", loadAllMessages: true },
    });
    expect(agent.sessionFilePath).toBe("existing-session");
    agent.dispose();
  });

  it("rejects initialization when the Droid process cannot start", async () => {
    const child = new FakeDroidProcess();
    spawnMock.mockReturnValue(child);
    child.stdin.on("data", () => child.emit("error", new Error("spawn failed")));

    const agent = new DroidAgent();
    await expect(agent.init("C:\\project")).rejects.toThrow("spawn failed");
  });

  it("terminates the full Droid process tree on dispose", async () => {
    const agent = new DroidAgent();
    const internals = agent as unknown as DroidInternals;
    const child = new FakeDroidProcess() as unknown as ChildProcess;
    internals.process = child;
    internals.waitForExit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    internals.killProcessTree = vi.fn(async () => undefined);

    await agent.dispose();

    expect(internals.killProcessTree).toHaveBeenCalledWith(child);
    expect(internals.waitForExit).toHaveBeenNthCalledWith(1, child, 750);
    expect(internals.waitForExit).toHaveBeenNthCalledWith(2, child, 500);
  });
});
