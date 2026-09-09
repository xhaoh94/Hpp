import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "C:\\app",
    getPath: () => "C:\\data",
  },
}));

import { AgentPluginProcess } from "./agent-plugin-process";
import { clearAllPendingUIEvents, getPendingUIEvents } from "./pending-ui-events";

afterEach(() => clearAllPendingUIEvents());

describe("AgentPluginProcess requests", () => {
  it("cannot restart after shutdown", async () => {
    const pluginProcess = new AgentPluginProcess("C:\\plugin\\index.mjs", {}, {});

    await pluginProcess.shutdown();

    await expect(pluginProcess.ensureLoaded()).rejects.toThrow("Plugin host stopped.");
  });

  it("removes a timed-out request from the pending map", async () => {
    const pluginProcess = new AgentPluginProcess("C:\\plugin\\index.mjs", {}, {});
    const internals = pluginProcess as unknown as {
      child: { stdin: { writable: boolean; write: ReturnType<typeof vi.fn> } };
      pending: Map<string, unknown>;
      request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
    };
    internals.child = {
      stdin: { writable: true, write: vi.fn() },
    };

    await expect(internals.request("getStatus", undefined, 10)).rejects.toThrow(
      "Plugin host request timed out: getStatus",
    );
    expect(internals.pending.size).toBe(0);
  });

  it("rejects backend calls when that backend is disposed", async () => {
    const pluginProcess = new AgentPluginProcess("C:\\plugin\\index.mjs", {}, {});
    const internals = pluginProcess as unknown as {
      child: { stdin: { writable: boolean; write: ReturnType<typeof vi.fn> } };
      pending: Map<string, { backendId?: string; reject: (error: Error) => void }>;
      backendSessionIds: Map<string, string>;
      request: ReturnType<typeof vi.fn>;
    };
    internals.child = {
      stdin: { writable: true, write: vi.fn() },
    };
    internals.backendSessionIds.set("backend-1", "session-1");
    const reject = vi.fn();
    internals.pending.set("request-1", { backendId: "backend-1", reject });
    internals.request = vi.fn().mockResolvedValue(undefined);

    await pluginProcess.disposeBackend("backend-1");

    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: "Plugin backend disposed." }));
    expect(internals.pending.has("request-1")).toBe(false);
    expect(internals.request).toHaveBeenCalledWith("disposeBackend", { backendId: "backend-1" }, 5000);
  });
});

describe("AgentPluginProcess pending UI capture", () => {
  it("captures plugin questions before forwarding and clears them on backend disposal", async () => {
    const pluginProcess = new AgentPluginProcess("C:\\plugin\\index.mjs", {}, {});
    vi.spyOn(pluginProcess, "ensureLoaded").mockResolvedValue({
      getStatus: false,
      update: false,
      uninstall: false,
      getDefaultThinkingLevel: false,
      readProviderConfig: false,
      writeProviderConfig: false,
      activateProvider: false,
      lookupModel: false,
    });
    const internals = pluginProcess as unknown as {
      request: ReturnType<typeof vi.fn>;
      eventHandlers: Map<string, (event: unknown) => void>;
    };
    internals.request = vi.fn().mockResolvedValue({
      sendGuidance: false,
      forkSession: false,
      listActions: false,
    });
    const onEvent = vi.fn();

    const { backendId } = await pluginProcess.createBackend("session-a", onEvent);
    const event = {
      type: "process_event",
      entryType: "question",
      requestId: "question-1",
      state: "running",
    };
    internals.eventHandlers.get(backendId)?.(event);

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      ...event,
      pendingUIRevision: 1,
    }));
    expect(getPendingUIEvents("session-a")).toEqual([
      expect.objectContaining({ sessionId: "session-a", requestId: "question-1" }),
    ]);

    const terminalEvent = {
      type: "process_event",
      entryType: "question",
      requestId: "question-1",
      state: "completed",
    };
    internals.eventHandlers.get(backendId)?.(terminalEvent);
    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      ...terminalEvent,
      pendingUIRevision: 2,
    }));
    expect(getPendingUIEvents("session-a")).toEqual([]);

    await pluginProcess.disposeBackend(backendId);
    expect(getPendingUIEvents("session-a")).toEqual([]);
  });
});
