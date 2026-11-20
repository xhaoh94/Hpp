import { describe, expect, it, vi } from "vitest";
import { AgentRuntimeOperationQueue } from "./agent-runtime-operation-queue";

describe("AgentRuntimeOperationQueue", () => {
  it("runs runtime operations one at a time in FIFO order", async () => {
    const queue = new AgentRuntimeOperationQueue();
    const events: string[] = [];
    let releaseFirst = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run("codex", "update", async () => {
      events.push("codex:start");
      await firstGate;
      events.push("codex:end");
      return "codex";
    });
    const secondOperation = vi.fn(async () => {
      events.push("other-agent:start");
      events.push("other-agent:end");
      return "other-agent";
    });
    const second = queue.run("other-agent", "update", secondOperation);

    await vi.waitFor(() => expect(queue.active).toEqual({ agentId: "codex", kind: "update" }));
    expect(secondOperation).not.toHaveBeenCalled();
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual(["codex", "other-agent"]);
    expect(events).toEqual(["codex:start", "codex:end", "other-agent:start", "other-agent:end"]);
    expect(queue.active).toBeNull();
  });

  it("continues with the next operation after a failure", async () => {
    const queue = new AgentRuntimeOperationQueue();
    const failed = queue.run("opencode", "update", async () => {
      throw new Error("update failed");
    });
    const next = queue.run("pi", "update", async () => "completed");

    await expect(failed).rejects.toThrow("update failed");
    await expect(next).resolves.toBe("completed");
    expect(queue.active).toBeNull();
  });
});
