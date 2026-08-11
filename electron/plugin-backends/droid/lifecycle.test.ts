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
});
