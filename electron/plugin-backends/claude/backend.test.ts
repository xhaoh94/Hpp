import { describe, expect, it, vi } from "vitest";
import { ClaudeSDKAgent } from "./backend";

type MutableClaudeAgent = {
  process: { stdin: { writable: boolean; write: ReturnType<typeof vi.fn> } } | null;
  isReady: boolean;
  activePromptId: string | null;
  turnActive: boolean;
  handleWorkerMessage: (message: Record<string, unknown>) => void;
};

const mutable = (agent: ClaudeSDKAgent) => agent as unknown as MutableClaudeAgent;

describe("ClaudeSDKAgent busy lifecycle", () => {
  it("does not overwrite an active prompt with a second send", async () => {
    const agent = new ClaudeSDKAgent("session-one");
    const write = vi.fn();
    Object.assign(mutable(agent), {
      process: { stdin: { writable: true, write } },
      isReady: true,
      activePromptId: "prompt-one",
      turnActive: true,
    });

    await expect(agent.sendMessage("second", undefined, { clientMessageId: "prompt-two" }))
      .rejects.toThrow("SESSION_BUSY");
    expect(mutable(agent).activePromptId).toBe("prompt-one");
    expect(agent.isIdle()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("does not finish the active turn for an unrelated worker error", () => {
    const events: Record<string, unknown>[] = [];
    const agent = new ClaudeSDKAgent("session-one", (event) => events.push(event));
    Object.assign(mutable(agent), {
      activePromptId: "prompt-one",
      turnActive: true,
    });

    mutable(agent).handleWorkerMessage({ type: "error", id: "prompt-two", error: "SESSION_BUSY" });
    expect(agent.isIdle()).toBe(false);
    expect(mutable(agent).activePromptId).toBe("prompt-one");
    expect(events).toEqual([]);

    mutable(agent).handleWorkerMessage({ type: "error", id: "prompt-one", error: "request failed" });
    expect(agent.isIdle()).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["process_event", "stream_end", "agent_end"]);
  });

  it("waits for an explicit worker abort acknowledgement", async () => {
    const events: Record<string, unknown>[] = [];
    const agent = new ClaudeSDKAgent("session-one", (event) => events.push(event));
    const write = vi.fn();
    Object.assign(mutable(agent), {
      process: { stdin: { writable: true, write } },
      isReady: true,
      activePromptId: "prompt-one",
      turnActive: true,
    });

    const aborting = agent.abort();
    const command = JSON.parse(String(write.mock.calls[0][0])) as { id: string };
    expect(agent.isIdle()).toBe(false);
    mutable(agent).handleWorkerMessage({ type: "aborted", id: command.id });
    await aborting;

    expect(agent.isIdle()).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["stream_end", "agent_end", "aborted"]);
  });
});
