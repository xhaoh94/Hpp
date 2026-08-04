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
