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
  turnActive: boolean;
  sendRpcAsync: (method: string, params: unknown, timeoutMs?: number, requestId?: string) => Promise<unknown>;
  handleServerRequest: (method: string, requestId: string, params: unknown) => void;
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
    }, {
      id: "model",
      name: "Custom model",
      provider: "custom-provider",
      reasoning: false,
      supportsImages: false,
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

  it("sends base64 images and finishes a failed send", async () => {
    const events: AgentEvent[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = agent as unknown as DroidInternals;
    internals.process = { stdin: { writable: true, write: vi.fn() } };
    internals.isReady = true;
    const sendRpcAsync = vi.fn(async () => ({ result: {} }));
    internals.sendRpcAsync = sendRpcAsync;

    await agent.sendMessage("hello", [{ mimeType: "image/png", data: "base64-data" }]);

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

  it("converts ask-user and permission responses to Droid protocol", () => {
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

    internals.handleServerRequest("droid.ask_user", "ask-1", {
      toolCallId: "tool-1",
      questions: [{ index: 7, topic: "Choice", question: "Pick one", options: ["A", "B"] }],
    });
    agent.sendUIResponse({ id: "ask-1", answers: [{ questionIndex: 0, value: "B" }] });

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
    agent.sendUIResponse({ id: "permission-1", value: "deny" });
    expect(writes[1]).toMatchObject({
      id: "permission-1",
      result: { selectedOption: "cancel" },
    });
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
});
