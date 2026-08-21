import { describe, expect, it, vi } from "vitest";
import { ClaudeSDKAgent } from "./backend";

type MutableClaudeAgent = {
  process: {
    stdin: { writable: boolean; write: ReturnType<typeof vi.fn> };
    kill?: ReturnType<typeof vi.fn>;
  } | null;
  isReady: boolean;
  activePromptId: string | null;
  turnActive: boolean;
  pendingResponses: Map<string, (message: Record<string, unknown>) => void>;
  pendingUIRequestIds: Set<string>;
  pendingGuidance: { id: string; accepted: boolean; responseStarted: boolean } | null;
  handleWorkerMessage: (message: Record<string, unknown>) => void;
  handleWorkerTermination: (child: object, detail: string) => void;
};

const mutable = (agent: ClaudeSDKAgent) => agent as unknown as MutableClaudeAgent;

describe("ClaudeSDKAgent busy lifecycle", () => {
  it("forwards the Hpp host system prompt to the SDK worker", async () => {
    const agent = new ClaudeSDKAgent("session-one");
    const write = vi.fn();
    Object.assign(mutable(agent), {
      process: { stdin: { writable: true, write } },
      isReady: true,
    });

    await agent.sendMessage("hello", undefined, {
      clientMessageId: "prompt-one",
      hostSystemPrompt: "[HPP] 请使用简体中文",
    });

    expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
      type: "prompt",
      id: "prompt-one",
      hostSystemPrompt: "[HPP] 请使用简体中文",
    });
    mutable(agent).handleWorkerMessage({ type: "prompt_done", id: "prompt-one" });
  });

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

  it("confirms an active-turn guidance only after acceptance and matching delivery", async () => {
    const events: Record<string, unknown>[] = [];
    const agent = new ClaudeSDKAgent("session-one", (event) => events.push(event));
    const write = vi.fn();
    Object.assign(mutable(agent), {
      process: { stdin: { writable: true, write } },
      isReady: true,
      activePromptId: "prompt-one",
      turnActive: true,
      streamedText: true,
    });

    const sending = agent.sendGuidance("steer this turn");
    const command = JSON.parse(String(write.mock.calls[0][0])) as { id: string; type: string };
    expect(command).toMatchObject({ type: "guidance" });

    // Exercise the same event-before-RPC race handled by the renderer-level
    // two-phase confirmation. Delivery is latched but cannot render yet.
    mutable(agent).handleWorkerMessage({ type: "guidance_delivered", id: command.id });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "guidance_response_started" }));

    mutable(agent).handleWorkerMessage({ type: "guidance_done", id: command.id });
    await sending;
    expect(events.filter((event) => event.type === "guidance_response_started")).toHaveLength(1);
    expect(mutable(agent).pendingGuidance).toBeNull();

    // Fallback text belongs to the guided Assistant message even when the old
    // interrupted message had already streamed text.
    mutable(agent).handleWorkerMessage({
      type: "message_end",
      text: "guided fallback",
      nativeTurnId: "assistant-guided",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "stream_delta",
      delta: "guided fallback",
    }));
  });

  it("settles an unaccepted guidance request when the turn is aborted", async () => {
    const agent = new ClaudeSDKAgent("session-one");
    const write = vi.fn();
    Object.assign(mutable(agent), {
      process: { stdin: { writable: true, write } },
      isReady: true,
      activePromptId: "prompt-one",
      turnActive: true,
    });

    const sending = agent.sendGuidance("steer");
    const rejection = expect(sending).rejects.toThrow("Claude guidance interrupted");
    const aborting = agent.abort();
    const abortCommand = JSON.parse(String(write.mock.calls[1][0])) as { id: string };
    mutable(agent).handleWorkerMessage({ type: "aborted", id: abortCommand.id });

    await rejection;
    await aborting;
    expect(mutable(agent).pendingGuidance).toBeNull();
  });

  it("rejects guidance when Claude has no active command", async () => {
    const agent = new ClaudeSDKAgent("session-one");
    Object.assign(mutable(agent), {
      process: { stdin: { writable: true, write: vi.fn() } },
      isReady: true,
    });

    await expect(agent.sendGuidance("steer"))
      .rejects.toThrow("SESSION_NOT_RUNNING");
  });

  it("does not finish the active turn for an unrelated worker error", () => {
    const events: Record<string, unknown>[] = [];
    const agent = new ClaudeSDKAgent("session-one", (event) => events.push(event));
    Object.assign(mutable(agent), {
      activePromptId: "prompt-one",
      turnActive: true,
      pendingUIRequestIds: new Set(["permission-one"]),
    });

    mutable(agent).handleWorkerMessage({ type: "error", id: "prompt-two", error: "SESSION_BUSY" });
    expect(agent.isIdle()).toBe(false);
    expect(mutable(agent).activePromptId).toBe("prompt-one");
    expect(events).toEqual([]);

    mutable(agent).handleWorkerMessage({ type: "error", id: "prompt-one", error: "request failed" });
    expect(agent.isIdle()).toBe(true);
    expect(mutable(agent).pendingUIRequestIds.size).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["process_event", "stream_end", "agent_end"]);
  });

  it("ignores a stale prompt_done without stranding the active prompt", () => {
    const events: Record<string, unknown>[] = [];
    const agent = new ClaudeSDKAgent("session-one", (event) => events.push(event));
    Object.assign(mutable(agent), {
      activePromptId: "prompt-current",
      turnActive: true,
    });

    mutable(agent).handleWorkerMessage({ type: "prompt_done", id: "prompt-stale" });

    expect(agent.isIdle()).toBe(false);
    expect(mutable(agent).activePromptId).toBe("prompt-current");
    expect(mutable(agent).turnActive).toBe(true);
    expect(events).toEqual([]);

    mutable(agent).handleWorkerMessage({ type: "prompt_done", id: "prompt-current" });
    expect(agent.isIdle()).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["stream_end", "agent_end"]);
  });

  it("keeps the turn busy when a completed compact boundary arrives before prompt_done", () => {
    const events: Record<string, unknown>[] = [];
    const agent = new ClaudeSDKAgent("session-one", (event) => events.push(event));
    Object.assign(mutable(agent), {
      activePromptId: "prompt-one",
      turnActive: true,
    });

    mutable(agent).handleWorkerMessage({
      type: "context_compaction",
      uuid: "compact-one",
      phase: "completed",
    });

    expect(agent.isIdle()).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "context_compaction",
      id: "compact-one",
      phase: "completed",
    }));

    mutable(agent).handleWorkerMessage({ type: "prompt_done", id: "prompt-one" });
    expect(agent.isIdle()).toBe(true);
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

  it("rejects a UI response when the worker reports a transport error", async () => {
    const agent = new ClaudeSDKAgent("session-one");
    const write = vi.fn();
    Object.assign(mutable(agent), {
      process: { stdin: { writable: true, write } },
      isReady: true,
      activePromptId: "prompt-one",
      turnActive: true,
      pendingUIRequestIds: new Set(["question-one"]),
    });

    const sending = agent.sendUIResponse({ id: "question-one", text: "answer" });
    const rejection = expect(sending).rejects.toThrow("worker response failed");
    const command = JSON.parse(String(write.mock.calls[0][0])) as { id: string };
    mutable(agent).handleWorkerMessage({
      type: "error",
      id: command.id,
      error: "worker response failed",
    });

    await rejection;
    expect(mutable(agent).pendingUIRequestIds.has("question-one")).toBe(true);
  });

  it("cleans up the response callback when the worker write throws", async () => {
    const agent = new ClaudeSDKAgent("session-one");
    const write = vi.fn(() => {
      throw new Error("worker pipe failed");
    });
    Object.assign(mutable(agent), {
      process: { stdin: { writable: true, write } },
      isReady: true,
      pendingUIRequestIds: new Set(["question-one"]),
    });

    await expect(agent.sendUIResponse({ id: "question-one", text: "answer" }))
      .rejects.toThrow("worker pipe failed");
    expect(mutable(agent).pendingResponses.size).toBe(0);
    expect(mutable(agent).pendingUIRequestIds.has("question-one")).toBe(true);
  });

  it("returns to idle when a prompt cannot be written after the turn starts", async () => {
    const events: Record<string, unknown>[] = [];
    const agent = new ClaudeSDKAgent("session-one", (event) => events.push(event));
    Object.assign(mutable(agent), {
      process: { stdin: { writable: false, write: vi.fn() } },
      isReady: true,
    });

    await expect(agent.sendMessage("hello", undefined, { clientMessageId: "prompt-one" }))
      .rejects.toThrow("not writable");

    expect(agent.isIdle()).toBe(true);
    expect(mutable(agent).activePromptId).toBeNull();
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "stream_start",
      "process_event",
      "stream_end",
      "agent_end",
    ]);
  });

  it("terminalizes the turn and worker when abort acknowledgement fails", async () => {
    const events: Record<string, unknown>[] = [];
    const agent = new ClaudeSDKAgent("session-one", (event) => events.push(event));
    const write = vi.fn();
    const kill = vi.fn();
    Object.assign(mutable(agent), {
      process: { stdin: { writable: true, write }, kill },
      isReady: true,
      activePromptId: "prompt-one",
      turnActive: true,
      pendingUIRequestIds: new Set(["permission-one"]),
    });

    const aborting = agent.abort();
    const command = JSON.parse(String(write.mock.calls[0][0])) as { id: string };
    mutable(agent).handleWorkerMessage({ type: "error", id: command.id, error: "abort failed" });

    await expect(aborting).rejects.toThrow("abort failed");
    expect(agent.isIdle()).toBe(true);
    expect(mutable(agent).process).toBeNull();
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(events.map((event) => event.type)).toEqual(["process_event", "stream_end", "agent_end"]);
  });

  it("emits a terminal lifecycle before disposing an active turn", async () => {
    const events: Record<string, unknown>[] = [];
    const agent = new ClaudeSDKAgent("session-one", (event) => events.push(event));
    Object.assign(mutable(agent), {
      activePromptId: "prompt-one",
      turnActive: true,
      pendingUIRequestIds: new Set(["permission-one"]),
    });

    await agent.dispose();

    expect(agent.isIdle()).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["stream_end", "agent_end"]);
  });

  it("emits a disconnect when an idle worker terminates", () => {
    const events: Record<string, unknown>[] = [];
    const agent = new ClaudeSDKAgent("session-one", (event) => events.push(event));
    const child = { stdin: { writable: true, write: vi.fn() } };
    Object.assign(mutable(agent), { process: child, isReady: true });

    mutable(agent).handleWorkerTermination(child, "worker exited");

    expect(agent.isIdle()).toBe(true);
    expect(events).toEqual([expect.objectContaining({
      type: "agent_disconnected",
      detail: "worker exited",
    })]);
  });
});
