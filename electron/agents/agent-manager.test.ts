import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  createBackend: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "C:\\temp\\hpp-test",
    getVersion: () => "0.0.2",
  },
  BrowserWindow: class {},
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

vi.mock("./agent-plugin-registry", () => ({
  getAgentPluginRegistry: () => ({
    createBackend: testState.createBackend,
    getCapabilities: vi.fn(async () => ({
      planMode: "prompt",
      guidance: false,
      fork: false,
      configuration: "none",
      providerActivation: "none",
    })),
    shutdown: vi.fn(),
  }),
}));

vi.mock("./official-agent-plugins", () => ({
  downloadOfficialPluginZip: vi.fn(),
  listOfficialAgentPlugins: vi.fn(),
}));

vi.mock("./agent-config", () => ({
  activateAgentProviderConfig: vi.fn(),
  deleteAgentProviderConfig: vi.fn(),
  getAgentConfigStateForBackend: vi.fn(async () => ({})),
  getAgentModelVisibility: vi.fn(),
  getConfiguredAgentModels: vi.fn(async () => []),
  listAgentConfig: vi.fn(),
  reorderAgentProviderConfigs: vi.fn(),
  restoreNativeConfigSnapshots: vi.fn(),
  saveAgentProviderConfig: vi.fn(),
  setAgentBackendModelsVisible: vi.fn(),
  setActiveAgentProviderConfig: vi.fn(),
  shouldShowAgentBackendModels: vi.fn(),
}));

vi.mock("./agent-model-fetch", () => ({
  fetchProviderModels: vi.fn(),
}));

vi.mock("./agent-model-list", () => ({
  combineAgentModels: vi.fn((backendModels: unknown[]) => backendModels),
}));

import { AgentManager } from "./agent-manager";

function createBackend(idle = true) {
  let sessionFilePath: string | null = null;
  return {
    setWindow: vi.fn(),
    init: vi.fn(async (_projectPath: string, existingSessionFilePath?: string) => {
      sessionFilePath = existingSessionFilePath || "native-session";
    }),
    isIdle: vi.fn(() => idle),
    sendMessage: vi.fn(),
    abort: vi.fn(),
    getModels: vi.fn(async () => []),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    sendUIResponse: vi.fn(),
    dispose: vi.fn(async () => undefined),
    get sessionFilePath() {
      return sessionFilePath;
    },
  };
}

describe("AgentManager runtime updates", () => {
  beforeEach(() => {
    testState.createBackend.mockReset();
  });

  it("suspends and restores idle sessions without closing them", async () => {
    const originalBackend = createBackend(true);
    const restoredBackend = createBackend(true);
    testState.createBackend
      .mockResolvedValueOnce(originalBackend)
      .mockResolvedValueOnce(restoredBackend);
    const manager = new AgentManager();

    await manager.createSession("session-1", "opencode", "C:\\project", "native-session-1");
    const suspension = await manager.suspendAgentSessionsForRuntimeUpdate("opencode");

    expect(suspension).toEqual({ success: true, sessionCount: 1 });
    expect(originalBackend.dispose).toHaveBeenCalledTimes(1);
    expect(manager.getAgentBySessionId("session-1")).toBeNull();

    const resumed = await manager.resumeAgentSessionsAfterRuntimeUpdate("opencode");

    expect(resumed.success).toBe(true);
    expect(resumed.reloadedSessionIds).toEqual(["session-1"]);
    expect(restoredBackend.init).toHaveBeenCalledWith("C:\\project", "native-session-1");
    expect(manager.getAgentBySessionId("session-1")).toBe(restoredBackend);
    await manager.shutdown();
  });

  it("rejects updates while a session is running", async () => {
    const runningBackend = createBackend(false);
    testState.createBackend.mockResolvedValueOnce(runningBackend);
    const manager = new AgentManager();

    await manager.createSession("session-2", "droid", "C:\\project");
    const suspension = await manager.suspendAgentSessionsForRuntimeUpdate("droid");

    expect(suspension).toEqual({
      success: false,
      sessionCount: 1,
      error: "该 Agent 仍有会话正在运行，请等待任务结束后再更新。",
    });
    expect(runningBackend.dispose).not.toHaveBeenCalled();
    expect(manager.getAgentBySessionId("session-2")).toBe(runningBackend);
    await manager.shutdown();
  });

  it("blocks new sessions until an update with no existing sessions finishes", async () => {
    const backend = createBackend(true);
    testState.createBackend.mockResolvedValueOnce(backend);
    const manager = new AgentManager();

    await expect(manager.suspendAgentSessionsForRuntimeUpdate("opencode")).resolves.toEqual({
      success: true,
      sessionCount: 0,
    });
    await expect(
      manager.createSession("session-3", "opencode", "C:\\project")
    ).rejects.toThrow("opencode CLI 正在更新");

    await expect(manager.resumeAgentSessionsAfterRuntimeUpdate("opencode")).resolves.toMatchObject({
      success: true,
      reloadedSessionIds: [],
    });
    await expect(manager.createSession("session-3", "opencode", "C:\\project")).resolves.toBeUndefined();
    await manager.shutdown();
  });
});
