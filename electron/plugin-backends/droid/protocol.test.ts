import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";
import { DroidAgent } from "./backend";

interface DroidInternals {
  process: { stdin: { writable: boolean; write: (value: string) => void } } | null;
  isReady: boolean;
  sessionId: string | null;
  planModeEnabled: boolean;
  permissionMode: "ask" | "auto" | "full-access";
  turnActive: boolean;
  pendingPermissionRequestId: string | null;
  pendingResponses: Map<string, unknown>;
  sendRpcAsync: (method: string, params: unknown, timeoutMs?: number, requestId?: string) => Promise<unknown>;
  handleProcessTermination: (childProcess: object, title: string, detail: string) => void;
  handleServerRequest: (method: string, requestId: string, params: unknown) => void;
  handleNotification: (method: string, params: unknown) => void;
  applySessionResult: (result: Record<string, unknown>, restoreHistory: boolean) => Promise<void>;
}

describe("Droid protocol adapter", () => {
  const originalConfigPath = process.env.DROID_CONFIG_PATH;
  const tempRoots: string[] = [];

  afterEach(async () => {
    if (originalConfigPath === undefined) delete process.env.DROID_CONFIG_PATH;
    else process.env.DROID_CONFIG_PATH = originalConfigPath;
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("does not report a control RPC as an active conversation turn", () => {
    const agent = new DroidAgent("hpp-session");
    const internals = agent as unknown as DroidInternals;
    internals.pendingResponses.set("models-request", {});

    expect(agent.isIdle()).toBe(true);
  });

  it("uses live model metadata and restores session history", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-droid-models-"));
    tempRoots.push(root);
    process.env.DROID_CONFIG_PATH = join(root, "settings.json");
    await writeFile(process.env.DROID_CONFIG_PATH, JSON.stringify({
      customModels: [{
        hppManaged: true,
        hppProviderId: "custom-provider",
        id: "custom:hpp:custom-provider:model",
        model: "model",
        displayName: "Custom model",
      }, {
        hppCompactionManaged: true,
        id: "custom:hpp:compaction",
        model: "summary-only",
        displayName: "Hpp summary only",
      }],
    }), "utf8");

    const events: AgentEvent[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as DroidInternals;
    await internals.applySessionResult({
      availableModels: [{
        id: "gpt-5.4",
        modelProvider: "openai",
        displayName: "GPT-5.4",
        supportedReasoningEfforts: ["low", "medium", "high"],
        noImageSupport: false,
      }, {
        id: "custom:hpp:custom-provider:model",
        modelProvider: "custom",
        displayName: "Custom model",
        supportedReasoningEfforts: ["none"],
        noImageSupport: true,
      }, {
        id: "custom:hpp:compaction",
        modelProvider: "custom",
        displayName: "Hpp summary only",
        supportedReasoningEfforts: ["none"],
        noImageSupport: true,
      }],
      session: {
        messages: [{
          id: "message-1",
          role: "user",
          content: [{ type: "text", text: "Restored question" }],
          createdAt: "2026-07-14T00:00:00.000Z",
        }],
      },
    }, true);

    await expect(agent.getModels()).resolves.toEqual([{
      id: "gpt-5.4",
      name: "GPT-5.4",
      provider: "openai",
      reasoning: true,
      supportsImages: true,
      supportedThinkingLevels: ["low", "medium", "high"],
    }, {
      id: "model",
      name: "Custom model",
      provider: "custom-provider",
      reasoning: false,
      supportsImages: false,
      supportedThinkingLevels: ["off"],
    }]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "history_snapshot",
      messages: [expect.objectContaining({
        role: "user",
        content: "Restored question",
        nativeTurnId: "message-1",
      })],
    }));
  });

  it("sends base64 images without copying the host system prompt into user text", async () => {
    const events: AgentEvent[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as DroidInternals;
    internals.process = { stdin: { writable: true, write: vi.fn() } };
    internals.isReady = true;
    const sendRpcAsync = vi.fn(async () => ({ result: {} }));
    internals.sendRpcAsync = sendRpcAsync;

    await agent.sendMessage(
      "hello",
      [{ mimeType: "image/png", data: "base64-data" }],
      { hostSystemPrompt: "Always answer in Simplified Chinese." },
    );

    expect(sendRpcAsync).toHaveBeenCalledWith("droid.add_user_message", {
      text: "hello",
      images: [{ type: "base64", mediaType: "image/png", data: "base64-data" }],
    }, 30000, expect.any(String));

    internals.turnActive = false;
    sendRpcAsync.mockRejectedValueOnce(new Error("invalid model"));
    await expect(agent.sendMessage("again")).rejects.toThrow("invalid model");
    expect(agent.isIdle()).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "stream_end" }));
  });

  it("finishes an active turn when the Droid input process terminates", () => {
    const events: AgentEvent[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as DroidInternals;
    const childProcess = { stdin: { writable: true, write: vi.fn() } };
    internals.process = childProcess;
    internals.isReady = true;
    internals.turnActive = true;

    internals.handleProcessTermination(childProcess, "Droid input failed", "broken pipe");

    expect(agent.isIdle()).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "process_event",
      "stream_end",
      "agent_end",
    ]);
  });

  it("emits a terminal lifecycle before disposing an active turn", async () => {
    const events: AgentEvent[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as DroidInternals;
    internals.turnActive = true;

    await agent.dispose();

    expect(agent.isIdle()).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["stream_end", "agent_end"]);
  });

  it("converts ask-user and permission responses to Droid protocol", async () => {
    const events: AgentEvent[] = [];
    const writes: Record<string, unknown>[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as DroidInternals;
    internals.process = {
      stdin: {
        writable: true,
        write: (value) => writes.push(JSON.parse(value)),
      },
    };
    internals.isReady = true;
    internals.planModeEnabled = true;
    internals.permissionMode = "ask";

    internals.handleServerRequest("droid.ask_user", "ask-1", {
      toolCallId: "tool-1",
      questions: [{ index: 7, topic: "Choice", question: "Pick one", options: ["A", "B"] }],
    });
    await agent.sendUIResponse({ id: "ask-1", answers: [{ questionIndex: 0, value: "B" }] });

    expect(writes[0]).toMatchObject({
      type: "response",
      id: "ask-1",
      result: {
        cancelled: false,
        answers: [{ index: 7, question: "Pick one", answer: "B" }],
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "process_event",
      requestId: "ask-1",
    }));

    internals.handleServerRequest("droid.request_permission", "permission-1", { toolUses: [] });
    await agent.sendUIResponse({ id: "permission-1", value: "deny" });
    expect(writes[1]).toMatchObject({
      id: "permission-1",
      result: { selectedOption: "cancel" },
    });
  });

  it("does not finish the turn when Droid reports idle while waiting for an answer", async () => {
    const events: AgentEvent[] = [];
    const writes: Record<string, unknown>[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as DroidInternals;
    internals.process = {
      stdin: {
        writable: true,
        write: (line: string) => writes.push(JSON.parse(line)),
      },
    };
    internals.isReady = true;
    internals.turnActive = true;

    internals.handleServerRequest("droid.ask_user", "ask-waiting", {
      questions: [{ index: 0, question: "Continue?" }],
    });
    internals.handleNotification("droid_working_state_changed", {
      notification: { type: "droid_working_state_changed", newState: "idle" },
    });

    expect(agent.isIdle()).toBe(false);
    expect(events.some((event) => event.type === "stream_end")).toBe(false);
    expect(events.some((event) => event.type === "agent_end")).toBe(false);

    await agent.sendUIResponse({ id: "ask-waiting", text: "yes" });
    internals.handleNotification("droid_working_state_changed", {
      notification: { type: "droid_working_state_changed", newState: "idle" },
    });

    expect(writes).toContainEqual(expect.objectContaining({ id: "ask-waiting", type: "response" }));
    expect(agent.isIdle()).toBe(true);
    expect(events.filter((event) => event.type === "stream_end")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
  });

  it("rejects UI responses when Droid is unavailable or the request is unknown", async () => {
    const agent = new DroidAgent("hpp-session");
    const internals = agent as unknown as DroidInternals;

    await expect(agent.sendUIResponse({ id: "ask-1", text: "answer" }))
      .rejects.toThrow("Droid is not ready");

    const write = vi.fn();
    internals.process = { stdin: { writable: true, write } };
    internals.isReady = true;
    internals.handleServerRequest("droid.ask_user", "ask-pending", {
      questions: [{ index: 0, question: "Continue?" }],
    });
    await expect(agent.sendUIResponse({ text: "answer" }))
      .rejects.toThrow("Droid UI response is missing request id");
    await expect(agent.sendUIResponse({ id: "missing-request", text: "answer" }))
      .rejects.toThrow("Unknown Droid UI request: missing-request");
    expect(write).not.toHaveBeenCalled();
  });

  it("propagates a Droid response write failure and keeps the request retryable", async () => {
    const agent = new DroidAgent("hpp-session");
    const internals = agent as unknown as DroidInternals;
    const write = vi.fn(() => {
      throw new Error("response pipe failed");
    });
    internals.process = { stdin: { writable: true, write } };
    internals.isReady = true;
    internals.handleServerRequest("droid.ask_user", "ask-retry", {
      questions: [{ index: 0, question: "Continue?" }],
    });

    await expect(agent.sendUIResponse({ id: "ask-retry", text: "yes" }))
      .rejects.toThrow("response pipe failed");

    write.mockImplementation(() => undefined);
    await expect(agent.sendUIResponse({ id: "ask-retry", text: "yes" }))
      .resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("auto-approves Droid permission requests only in full access mode", () => {
    const events: AgentEvent[] = [];
    const writes: Record<string, unknown>[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as DroidInternals;
    internals.process = {
      stdin: {
        writable: true,
        write: (value) => writes.push(JSON.parse(value)),
      },
    };
    internals.isReady = true;
    internals.permissionMode = "full-access";

    internals.handleServerRequest("droid.request_permission", "permission-full", {
      action: "execute command",
    });

    expect(writes).toContainEqual(expect.objectContaining({
      id: "permission-full",
      result: { selectedOption: "proceed_once" },
    }));
    expect(events).not.toContainEqual(expect.objectContaining({ requestId: "permission-full" }));
  });

  it("terminalizes the turn when an automatic permission response cannot be written", () => {
    const events: AgentEvent[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as DroidInternals;
    internals.process = {
      stdin: {
        writable: true,
        write: () => { throw new Error("permission pipe failed"); },
      },
    };
    internals.isReady = true;
    internals.turnActive = true;
    internals.permissionMode = "full-access";

    internals.handleServerRequest("droid.request_permission", "permission-auto-failure", {
      action: "read file",
    });

    expect(agent.isIdle()).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "process_event",
      "stream_end",
      "agent_end",
    ]);
  });

  it("acknowledges manual abort", async () => {
    const events: AgentEvent[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as DroidInternals;
    internals.process = { stdin: { writable: true, write: vi.fn() } };
    internals.isReady = true;
    internals.turnActive = true;
    internals.sendRpcAsync = vi.fn(async () => ({ result: {} }));

    await agent.abort();

    expect(agent.isIdle()).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "aborted" }));
  });

  it("returns to idle when abort responses cannot be written", async () => {
    const events: AgentEvent[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as DroidInternals;
    internals.process = { stdin: { writable: false, write: vi.fn() } };
    internals.isReady = true;
    internals.turnActive = true;
    internals.pendingPermissionRequestId = "permission-abort";

    await expect(agent.abort()).resolves.toBeUndefined();

    expect(agent.isIdle()).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "aborted",
      detail: expect.stringContaining("not writable"),
    }));
  });

  it("lists user-invocable skills and commands without paths and sends native slash syntax", async () => {
    const agent = new DroidAgent("hpp-session");
    const internals = agent as unknown as DroidInternals;
    internals.process = { stdin: { writable: true, write: vi.fn() } };
    internals.isReady = true;
    internals.sessionId = "droid-session";
    const sendRpcAsync = vi.fn(async (method: string) => method === "droid.list_skills"
      ? {
          result: {
            skills: [
              { name: "review", description: "Review changes", filePath: "C:\\project\\.factory\\skills\\review\\SKILL.md" },
              { name: "release", description: "Prepare release", filePath: "C:\\project\\.factory\\commands\\release.md" },
              { name: "disabled", enabled: false, filePath: "C:\\project\\.factory\\skills\\disabled\\SKILL.md" },
            ],
          },
        }
      : { result: {} });
    internals.sendRpcAsync = sendRpcAsync;

    const actions = await agent.listActions({ reload: true });
    expect(actions).toEqual([
      { kind: "skill", name: "review", description: "Review changes" },
      { kind: "command", name: "release", description: "Prepare release" },
    ]);
    expect(JSON.stringify(actions)).not.toContain(".factory");

    await agent.sendMessage("src", undefined, { action: { kind: "skill", name: "review" } });
    expect(sendRpcAsync).toHaveBeenCalledWith("droid.add_user_message", { text: "/review src" }, 30000, expect.any(String));

    internals.turnActive = false;
    await expect(agent.sendMessage("", undefined, { action: { kind: "skill", name: "missing" } }))
      .rejects.toThrow("ACTION_NOT_FOUND");
  });
});
