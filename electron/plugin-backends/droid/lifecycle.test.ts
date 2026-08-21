import { EventEmitter } from "events";
import { PassThrough } from "stream";
import type { ChildProcess } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  isReady: boolean;
  turnActive: boolean;
  clientMessageIdsByRequestId: Map<string, string>;
  activeClientMessageId: string | null;
  guidancePendingResponse: boolean;
  guidanceRequestId: string | null;
  sendRpcAsync: (...args: unknown[]) => Promise<unknown>;
  handleNotification: (method: string, params: unknown) => void;
  sendGuidance: (message: string) => Promise<void>;
  waitForExit: (childProcess: ChildProcess, timeoutMs: number) => Promise<boolean>;
  killProcessTree: (childProcess: ChildProcess) => Promise<void>;
}

describe("Droid lifecycle", () => {
  const originalConfigPath = process.env.DROID_CONFIG_PATH;
  const tempRoots: string[] = [];

  beforeEach(async () => {
    spawnMock.mockReset();
    const root = await mkdtemp(join(tmpdir(), "hpp-droid-lifecycle-"));
    tempRoots.push(root);
    process.env.DROID_CONFIG_PATH = join(root, "settings.json");
    await writeFile(process.env.DROID_CONFIG_PATH, JSON.stringify({ keepMe: true }), "utf8");
  });

  afterEach(async () => {
    if (originalConfigPath === undefined) delete process.env.DROID_CONFIG_PATH;
    else process.env.DROID_CONFIG_PATH = originalConfigPath;
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
    await agent.init("C:\\project", "existing-session", {
      hostSystemPrompt: "Always answer in Simplified Chinese.",
    });

    expect(requests[0]).toMatchObject({
      method: "droid.load_session",
      params: { sessionId: "existing-session", loadAllMessages: true },
    });
    const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
    const systemPromptFlagIndex = spawnArgs.indexOf("--append-system-prompt");
    expect(systemPromptFlagIndex).toBeGreaterThan(-1);
    expect(spawnArgs[systemPromptFlagIndex + 1]).toBe("Always answer in Simplified Chinese.");
    const settingsFlagIndex = spawnArgs.indexOf("--settings");
    expect(settingsFlagIndex).toBeGreaterThan(-1);
    const runtimeSettingsPath = spawnArgs[settingsFlagIndex + 1];
    const runtimeSettings = JSON.parse(await readFile(runtimeSettingsPath, "utf8"));
    expect(runtimeSettings).toMatchObject({ keepMe: true, compactionModel: "same" });
    expect(requests[1]).toMatchObject({
      method: "droid.update_session_settings",
      params: { compactionModel: "same" },
    });
    expect(agent.sessionFilePath).toBe("existing-session");
    await agent.dispose();
    await expect(readFile(runtimeSettingsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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

  it("confirms delivered guidance after the previous Droid turn settles", async () => {
    const events: Array<{ type: string }> = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event as { type: string }));
    const internals = agent as unknown as DroidInternals;
    internals.process = (new FakeDroidProcess() as unknown) as ChildProcess;
    internals.isReady = true;
    internals.turnActive = true;
    internals.activeClientMessageId = "hpp-original";
    internals.sendRpcAsync = vi.fn(async () => ({ result: {} }));

    // The RPC acknowledgement only queues the guidance. Droid continues the
    // old assistant message and must not confirm yet.
    await internals.sendGuidance("steer this turn");
    expect(internals.guidancePendingResponse).toBe(true);
    expect(internals.sendRpcAsync).toHaveBeenCalledWith(
      "droid.add_user_message",
      expect.objectContaining({ text: "steer this turn" }),
      30000,
      expect.any(String),
    );
    const guidanceRequestId = internals.guidanceRequestId;
    expect(typeof guidanceRequestId).toBe("string");

    internals.handleNotification("droid.session_notification", {
      notification: { type: "assistant_text_delta", messageId: "old", blockIndex: 0, textDelta: "old" },
    });
    expect(events.some((event) => event.type === "guidance_response_started")).toBe(false);

    // Real Droid emits a brief idle between the old response and the queued
    // guidance turn. That clears ordinary client-message metadata.
    internals.handleNotification("droid.session_notification", {
      notification: { type: "droid_working_state_changed", newState: "idle" },
    });
    expect(internals.activeClientMessageId).toBeNull();
    expect(internals.clientMessageIdsByRequestId.size).toBe(0);
    expect(internals.guidancePendingResponse).toBe(true);

    // create_message(user) for the matching request is delayed until Droid
    // actually starts the guidance turn. Confirmation must not depend on the
    // metadata that the preceding idle notification cleared.
    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "create_message",
        requestId: guidanceRequestId,
        message: { id: "droid-guidance", role: "user" },
      },
    });

    expect(events.some((event) => event.type === "guidance_response_started")).toBe(true);
    expect(internals.guidancePendingResponse).toBe(false);
    expect(internals.guidanceRequestId).toBeNull();
  });
});
