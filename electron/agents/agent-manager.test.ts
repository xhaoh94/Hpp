import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  createBackend: vi.fn(),
  downloadOfficialPluginZip: vi.fn(),
  getCapabilities: vi.fn(),
  getStatus: vi.fn(),
  inspectInstallCandidate: vi.fn(),
  installFromPath: vi.fn(),
  listAgents: vi.fn(),
  listOfficialAgentPlugins: vi.fn(),
  removePlugin: vi.fn(),
  reloadRegistry: vi.fn(),
  shutdownRegistry: vi.fn(),
  updateAgent: vi.fn(),
  handlers: new Map<string, (...args: any[]) => any>(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "C:\\temp\\hpp-test",
    getVersion: () => "0.0.2",
  },
  BrowserWindow: class {},
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      testState.handlers.set(channel, handler);
    }),
  },
}));

vi.mock("./agent-plugin-registry", () => ({
  getAgentPluginRegistry: () => ({
    createBackend: testState.createBackend,
    getCapabilities: testState.getCapabilities,
    getStatus: testState.getStatus,
    inspectInstallCandidate: testState.inspectInstallCandidate,
    installFromPath: testState.installFromPath,
    listAgents: testState.listAgents,
    removePlugin: testState.removePlugin,
    reload: testState.reloadRegistry,
    shutdown: testState.shutdownRegistry,
    updateAgent: testState.updateAgent,
  }),
}));

vi.mock("./official-agent-plugins", () => ({
  downloadOfficialPluginZip: testState.downloadOfficialPluginZip,
  listOfficialAgentPlugins: testState.listOfficialAgentPlugins,
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

import { AgentManager, registerAgentHandlers, shutdownAgentRuntime } from "./agent-manager";
import { HPP_AGENT_SYSTEM_PROMPT } from "./agent-runtime-policy";
import {
  clearAllPendingUIEvents,
  getPendingUIEvents,
  observePendingUIEvent,
} from "./pending-ui-events";

afterEach(() => clearAllPendingUIEvents());

function getHandler(channel: string) {
  const handler = testState.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler;
}

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createBackend(idle = true) {
  let sessionFilePath: string | null = null;
  return {
    setWindow: vi.fn(),
    init: vi.fn(async (
      _projectPath: string,
      existingSessionFilePath?: string,
      _options?: { hostSystemPrompt?: string },
    ) => {
      sessionFilePath = existingSessionFilePath || "native-session";
    }),
    isIdle: vi.fn(() => idle),
    sendMessage: vi.fn(),
    sendGuidance: vi.fn(),
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

function createOfficialPlugin(id = "pi") {
  return {
    id,
    name: id === "pi" ? "Pi" : id,
    version: "1.2.2",
    minHppVersion: "0.0.2",
    compatible: true,
    runtime: "sdk" as const,
    order: 20,
    capabilities: {
      planMode: "prompt" as const,
      permissions: true,
      guidance: true,
      fork: true,
      actions: true,
      configuration: "none" as const,
      providerActivation: "none" as const,
    },
    zipFile: `${id}.zip`,
    downloadUrl: `https://example.test/${id}.zip`,
  };
}

describe("AgentManager runtime updates", () => {
  beforeEach(() => {
    testState.createBackend.mockReset();
    testState.getCapabilities.mockReset().mockResolvedValue({
      planMode: "prompt",
      permissions: true,
      guidance: false,
      fork: false,
      configuration: "none",
      providerActivation: "none",
    });
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
    expect(restoredBackend.init).toHaveBeenCalledWith("C:\\project", "native-session-1", {
      hostSystemPrompt: HPP_AGENT_SYSTEM_PROMPT,
    });
    expect(manager.getAgentBySessionId("session-1")).toBe(restoredBackend);
    await manager.shutdown();
  });

  it("supplies the host policy to guidance without trusting renderer options", async () => {
    const backend = createBackend(true);
    testState.createBackend.mockResolvedValueOnce(backend);
    testState.getCapabilities.mockResolvedValueOnce({
      planMode: "native",
      permissions: true,
      guidance: true,
      fork: false,
      configuration: "none",
      providerActivation: "none",
    });
    const manager = new AgentManager();

    await manager.createSession("guidance-session", "pi", "C:\\project");
    await manager.sendGuidance("guidance-session", "继续检查", undefined, {
      displayMessage: "显示用文本",
      hostSystemPrompt: "untrusted renderer value",
    });

    expect(backend.sendGuidance).toHaveBeenCalledWith(
      "继续检查",
      undefined,
      expect.objectContaining({
        displayMessage: "显示用文本",
        hostSystemPrompt: HPP_AGENT_SYSTEM_PROMPT,
      }),
    );
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

  it("removes a session from the manager even when disposing it fails", async () => {
    const backend = createBackend(true);
    backend.dispose.mockRejectedValueOnce(new Error("dispose failed"));
    testState.createBackend.mockResolvedValueOnce(backend);
    const manager = new AgentManager();

    await manager.createSession("session-4", "codex", "C:\\project", "native-session-4");
    await expect(manager.removeSession("session-4")).rejects.toThrow("dispose failed");

    expect(manager.getAgentBySessionId("session-4")).toBeNull();
    expect(manager.getSessionAgentType("session-4")).toBeUndefined();
    expect(manager.getSessionFilePath("session-4")).toBeUndefined();
    expect(manager.hasAgentSessions("codex")).toBe(false);
    await manager.shutdown();
  });

  it("awaits old backend teardown without rolling back an initialized replacement", async () => {
    const originalBackend = createBackend(true);
    const replacementBackend = createBackend(true);
    const disposal = createDeferred();
    originalBackend.dispose.mockImplementationOnce(() => disposal.promise);
    testState.createBackend
      .mockResolvedValueOnce(originalBackend)
      .mockResolvedValueOnce(replacementBackend);
    const manager = new AgentManager();

    await manager.createSession("reload-session", "codex", "C:\\project", "native-reload");
    let settled = false;
    const reload = manager.reloadConfig("codex", "reload-session").finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(originalBackend.dispose).toHaveBeenCalledTimes(1));
    expect(manager.getAgentBySessionId("reload-session")).toBe(replacementBackend);
    expect(settled).toBe(false);

    disposal.reject(new Error("old backend dispose failed"));
    await expect(reload).resolves.toMatchObject({
      success: true,
      reloadedSessionIds: ["reload-session"],
    });
    expect(manager.getAgentBySessionId("reload-session")).toBe(replacementBackend);
    await manager.shutdown();
  });

  it("disposes a replacement backend whose initialization fails", async () => {
    const originalBackend = createBackend(true);
    const failedReplacement = createBackend(true);
    failedReplacement.init.mockRejectedValueOnce(new Error("replacement init failed"));
    testState.createBackend
      .mockResolvedValueOnce(originalBackend)
      .mockResolvedValueOnce(failedReplacement);
    const manager = new AgentManager();

    await manager.createSession("failed-reload", "codex", "C:\\project", "native-reload");
    await expect(manager.reloadConfig("codex", "failed-reload"))
      .rejects.toThrow("replacement init failed");

    expect(failedReplacement.dispose).toHaveBeenCalledTimes(1);
    expect(originalBackend.dispose).not.toHaveBeenCalled();
    expect(manager.getAgentBySessionId("failed-reload")).toBe(originalBackend);
    await manager.shutdown();
  });
});

describe("AgentManager plugin removal", () => {
  beforeEach(() => {
    testState.handlers.clear();
    testState.createBackend.mockReset();
    testState.getCapabilities.mockReset().mockResolvedValue({
      planMode: "prompt",
      permissions: true,
      guidance: false,
      fork: false,
      configuration: "none",
      providerActivation: "none",
    });
    testState.getStatus.mockReset().mockResolvedValue({ installed: true });
    testState.downloadOfficialPluginZip.mockReset().mockResolvedValue("C:\\temp\\pi.zip");
    testState.inspectInstallCandidate.mockReset().mockResolvedValue({ id: "codex" });
    testState.installFromPath.mockReset();
    testState.listAgents.mockReset().mockResolvedValue([]);
    testState.listOfficialAgentPlugins.mockReset().mockResolvedValue({
      success: true,
      plugins: [createOfficialPlugin()],
    });
    testState.removePlugin.mockReset().mockResolvedValue({ success: true, agents: [] });
    testState.reloadRegistry.mockReset().mockResolvedValue([]);
    testState.shutdownRegistry.mockReset();
    testState.updateAgent.mockReset();
    registerAgentHandlers(() => null);
  });

  afterEach(async () => {
    await shutdownAgentRuntime();
  });

  it("returns a UI response failure when the target session has no active agent", async () => {
    await expect(getHandler("agent:sendUIResponse")({}, {
      sessionId: "missing-session",
      id: "question-1",
      text: "answer",
    })).resolves.toEqual({
      success: false,
      error: "No active agent",
    });
  });

  it("awaits and propagates backend UI response failures", async () => {
    const backend = createBackend(true);
    backend.sendUIResponse.mockRejectedValueOnce(new Error("response transport failed"));
    testState.createBackend.mockResolvedValueOnce(backend);
    await getHandler("agent:createSession")({}, "pi", "C:\\project", "ui-session");
    observePendingUIEvent("ui-session", {
      type: "process_event",
      entryType: "question",
      requestId: "question-1",
      state: "running",
    });

    await expect(getHandler("agent:sendUIResponse")({}, {
      sessionId: "ui-session",
      id: "question-1",
      text: "answer",
    })).resolves.toEqual({
      success: false,
      error: "response transport failed",
    });
    expect(backend.sendUIResponse).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "ui-session",
      id: "question-1",
    }));
    expect(getPendingUIEvents("ui-session")).toHaveLength(1);
  });

  it("exposes pending UI snapshots, treats them as busy, and clears them after a successful answer", async () => {
    const backend = createBackend(true);
    testState.createBackend.mockResolvedValueOnce(backend);
    await getHandler("agent:createSession")({}, "pi", "C:\\project", "pending-ui-session");
    observePendingUIEvent("pending-ui-session", {
      type: "process_event",
      entryType: "question",
      requestId: "question-1",
      method: "permission/request",
      questions: [{ question: "Allow?" }],
      state: "running",
    });

    await expect(getHandler("agent:getPendingUIRequests")({}, "pending-ui-session"))
      .resolves.toEqual({
        revision: 1,
        requests: [expect.objectContaining({
          sessionId: "pending-ui-session",
          requestId: "question-1",
          method: "permission/request",
        })],
      });
    await expect(getHandler("agent:getSessionState")({}, "pending-ui-session"))
      .resolves.toEqual({ success: true, idle: false });

    await expect(getHandler("agent:sendUIResponse")({}, {
      sessionId: "pending-ui-session",
      id: "question-1",
      text: "yes",
    })).resolves.toEqual({ success: true, pendingUIRevision: 2 });

    await expect(getHandler("agent:getPendingUIRequests")({}, "pending-ui-session"))
      .resolves.toEqual({ revision: 2, requests: [] });
    await expect(getHandler("agent:getSessionState")({}, "pending-ui-session"))
      .resolves.toEqual({ success: true, idle: true });
  });

  it("publishes the cleared cache revision so an in-flight stale snapshot cannot revive an answer", async () => {
    const manager = new AgentManager();
    const backend = createBackend(false);
    testState.createBackend.mockResolvedValueOnce(backend);
    const send = vi.fn();
    manager.setWindow({ webContents: { send } } as never);
    await manager.createSession("revision-session", "pi", "C:\\project");
    observePendingUIEvent("revision-session", {
      type: "ask_user_question",
      id: "question-1",
    });

    await expect(manager.sendUIResponse({
      sessionId: "revision-session",
      id: "question-1",
      text: "yes",
    })).resolves.toBe(2);

    expect(send).toHaveBeenCalledWith("agent:event", {
      type: "pending_ui_cache_revision",
      sessionId: "revision-session",
      pendingUIRevision: 2,
    });
    await manager.shutdown();
  });

  it("clears pending UI snapshots after aborting or removing a session", async () => {
    const abortedBackend = createBackend(false);
    const removedBackend = createBackend(true);
    testState.createBackend
      .mockResolvedValueOnce(abortedBackend)
      .mockResolvedValueOnce(removedBackend);
    await getHandler("agent:createSession")({}, "pi", "C:\\project", "abort-pending-session");
    await getHandler("agent:createSession")({}, "pi", "C:\\project", "remove-pending-session");
    observePendingUIEvent("abort-pending-session", {
      type: "ask_user_question", id: "abort-question",
    });
    observePendingUIEvent("remove-pending-session", {
      type: "ask_user_question", id: "remove-question",
    });

    await expect(getHandler("agent:abort")({}, "abort-pending-session"))
      .resolves.toEqual({ success: true });
    await expect(getHandler("agent:removeSession")({}, "remove-pending-session"))
      .resolves.toEqual({ success: true });

    expect(getPendingUIEvents("abort-pending-session")).toEqual([]);
    expect(getPendingUIEvents("remove-pending-session")).toEqual([]);
  });

  it("refreshes backend idle state for session-state reconciliation", async () => {
    const refreshIdle = vi.fn(async () => true);
    const backend = { ...createBackend(false), refreshIdle };
    testState.createBackend.mockResolvedValueOnce(backend);
    await getHandler("agent:createSession")({}, "pi", "C:\project", "refresh-idle-session");

    await expect(getHandler("agent:getSessionState")({}, "refresh-idle-session")).resolves.toEqual({
      success: true,
      idle: true,
    });
    expect(refreshIdle).toHaveBeenCalledTimes(1);
  });

  it("marks a cached session state stale when the live idle refresh fails", async () => {
    const refreshIdle = vi.fn(async () => {
      throw new Error("idle query failed");
    });
    const backend = { ...createBackend(false), refreshIdle };
    testState.createBackend.mockResolvedValueOnce(backend);
    await getHandler("agent:createSession")({}, "pi", "C:\\project", "stale-idle-session");

    await expect(getHandler("agent:getSessionState")({}, "stale-idle-session")).resolves.toEqual({
      success: true,
      idle: false,
      stale: true,
      error: "idle query failed",
    });
  });

  it("bounds a hanging idle refresh and returns the guarded cache as stale", async () => {
    vi.useFakeTimers();
    try {
      const refreshIdle = vi.fn(() => new Promise<boolean>(() => undefined));
      const backend = { ...createBackend(false), refreshIdle };
      testState.createBackend.mockResolvedValueOnce(backend);
      await getHandler("agent:createSession")({}, "pi", "C:\\project", "hanging-idle-session");

      const statePromise = getHandler("agent:getSessionState")({}, "hanging-idle-session");
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(statePromise).resolves.toEqual({
        success: true,
        idle: false,
        stale: true,
        error: "Agent idle refresh timed out",
      });
      expect(refreshIdle).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates an official plugin by suspending and restoring idle sessions", async () => {
    const idleBackend = createBackend(true);
    const restoredBackend = createBackend(true);
    testState.createBackend
      .mockResolvedValueOnce(idleBackend)
      .mockResolvedValueOnce(restoredBackend);
    testState.installFromPath.mockResolvedValueOnce({ success: true, agents: [], replaced: true });

    await getHandler("agent:createSession")({}, "pi", "C:\\project", "idle-pi-session", "pi-session.json");
    await expect(getHandler("agentPlugin:installOfficial")({}, "pi")).resolves.toMatchObject({
      success: true,
      replaced: true,
      detachedSessionIds: [],
    });

    expect(idleBackend.dispose).toHaveBeenCalledTimes(1);
    expect(testState.installFromPath).toHaveBeenCalledWith("C:\\temp\\pi.zip", {
      expectedAgentId: "pi",
      canReplace: expect.any(Function),
    });
    expect(restoredBackend.init).toHaveBeenCalledWith("C:\\project", "pi-session.json", {
      hostSystemPrompt: HPP_AGENT_SYSTEM_PROMPT,
    });
    expect(await getHandler("agent:getSessionState")({}, "idle-pi-session")).toMatchObject({
      success: true,
      idle: true,
    });
  });

  it("updates a local plugin by suspending and restoring an idle session", async () => {
    const idleBackend = createBackend(true);
    const restoredBackend = createBackend(true);
    testState.createBackend
      .mockResolvedValueOnce(idleBackend)
      .mockResolvedValueOnce(restoredBackend);
    testState.inspectInstallCandidate.mockResolvedValueOnce({ id: "pi" });
    testState.installFromPath.mockResolvedValueOnce({ success: true, agents: [], replaced: true });

    await getHandler("agent:createSession")({}, "pi", "C:\\project", "local-idle-pi", "pi-session.json");
    await expect(getHandler("agentPlugin:installFromPath")({}, "C:\\plugin\\pi")).resolves.toMatchObject({
      success: true,
      replaced: true,
      detachedSessionIds: [],
    });

    expect(idleBackend.dispose).toHaveBeenCalledTimes(1);
    expect(testState.installFromPath).toHaveBeenCalledWith("C:\\plugin\\pi", {
      expectedAgentId: "pi",
      canReplace: expect.any(Function),
    });
    expect(restoredBackend.init).toHaveBeenCalledWith("C:\\project", "pi-session.json", {
      hostSystemPrompt: HPP_AGENT_SYSTEM_PROMPT,
    });
  });

  it("blocks an official plugin update only while a session is actually running", async () => {
    const runningBackend = createBackend(false);
    testState.createBackend.mockResolvedValueOnce(runningBackend);

    await getHandler("agent:createSession")({}, "pi", "C:\\project", "running-pi-session");
    await expect(getHandler("agentPlugin:installOfficial")({}, "pi")).resolves.toMatchObject({
      success: false,
      error: "该 Agent 仍有会话正在运行，请等待任务结束后再安装或更新插件。",
    });

    expect(runningBackend.dispose).not.toHaveBeenCalled();
    expect(testState.downloadOfficialPluginZip).not.toHaveBeenCalled();
    expect(testState.installFromPath).not.toHaveBeenCalled();
  });

  it("disposes an idle session and allows plugin removal", async () => {
    const idleBackend = createBackend(true);
    testState.createBackend.mockResolvedValueOnce(idleBackend);

    await expect(
      getHandler("agent:createSession")({}, "codex", "C:\\project", "idle-session", "native-idle")
    ).resolves.toMatchObject({ success: true });
    const result = await getHandler("agentPlugin:remove")({}, "codex", false);

    expect(result).toMatchObject({
      success: true,
      detachedSessionIds: ["idle-session"],
    });
    expect(idleBackend.dispose).toHaveBeenCalledTimes(1);
    expect(testState.removePlugin).toHaveBeenCalledWith("codex", false);
    expect(idleBackend.dispose.mock.invocationCallOrder[0])
      .toBeLessThan(testState.removePlugin.mock.invocationCallOrder[0]);
    expect(await getHandler("agent:getSessionState")({}, "idle-session")).toEqual({
      success: false,
      idle: true,
      error: "No active agent",
    });
  });

  it("keeps Plan mode independent from the selected permission mode", async () => {
    const backend = createBackend(true);
    testState.createBackend.mockResolvedValueOnce(backend);

    await getHandler("agent:createSession")({}, "codex", "C:\\project", "permission-session");
    await expect(getHandler("agent:sendMessage")(
      {},
      "inspect the project",
      undefined,
      "permission-session",
      { planModeEnabled: true, permissionMode: "ask", clientMessageId: "client-1" },
    )).resolves.toMatchObject({ success: true });

    expect(backend.sendMessage).toHaveBeenCalledWith(
      expect.stringMatching(/当前回合已启用计划模式[\s\S]*inspect the project/),
      undefined,
      expect.objectContaining({
        planModeEnabled: false,
        permissionMode: "ask",
        clientMessageId: "client-1",
        displayMessage: "inspect the project",
        hostSystemPrompt: HPP_AGENT_SYSTEM_PROMPT,
      }),
    );
  });

  it("uses Pi's built-in native Plan mode even with an older prompt-mode plugin manifest", async () => {
    const backend = createBackend(true);
    testState.createBackend.mockResolvedValueOnce(backend);

    await getHandler("agent:createSession")({}, "pi", "C:\\project", "pi-native-plan");
    testState.getCapabilities.mockResolvedValueOnce({
      planMode: "prompt",
      permissions: true,
      guidance: true,
      fork: true,
      actions: true,
      configuration: "none",
      providerActivation: "none",
    });
    await expect(getHandler("agent:sendMessage")(
      {},
      "inspect the project",
      undefined,
      "pi-native-plan",
      { planModeEnabled: true, permissionMode: "auto" },
    )).resolves.toMatchObject({ success: true });

    expect(backend.sendMessage).toHaveBeenCalledWith(
      "inspect the project",
      undefined,
      expect.objectContaining({
        planModeEnabled: true,
        permissionMode: "auto",
        displayMessage: "inspect the project",
        hostSystemPrompt: HPP_AGENT_SYSTEM_PROMPT,
      }),
    );
    expect(backend.sendMessage.mock.calls[0]?.[0]).not.toContain("<plan_mode>");
  });

  it("does not claim to enforce permissions for plugins without an approval hook", async () => {
    const backend = createBackend(true);
    testState.createBackend.mockResolvedValueOnce(backend);
    await getHandler("agent:createSession")({}, "third-party", "C:\\project", "unprotected-session");
    testState.getCapabilities.mockResolvedValueOnce({
      planMode: "prompt",
      permissions: false,
      guidance: false,
      fork: false,
      actions: false,
      configuration: "none",
      providerActivation: "none",
    });

    await getHandler("agent:sendMessage")(
      {},
      "run",
      undefined,
      "unprotected-session",
      { permissionMode: "ask" },
    );

    expect(backend.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("run"),
      undefined,
      expect.objectContaining({
        permissionMode: "full-access",
        displayMessage: "run",
        hostSystemPrompt: HPP_AGENT_SYSTEM_PROMPT,
      }),
    );
  });

  it("blocks plugin removal only while a session is truly running", async () => {
    const runningBackend = createBackend(false);
    testState.createBackend.mockResolvedValueOnce(runningBackend);

    await getHandler("agent:createSession")({}, "codex", "C:\\project", "running-session");
    const result = await getHandler("agentPlugin:remove")({}, "codex", false);

    expect(result).toMatchObject({
      success: false,
      error: "该 Agent 仍有会话正在运行，请等待任务结束后再卸载插件。",
    });
    expect(runningBackend.dispose).not.toHaveBeenCalled();
    expect(testState.removePlugin).not.toHaveBeenCalled();
    expect(await getHandler("agent:getSessionState")({}, "running-session")).toEqual({
      success: true,
      idle: false,
    });
  });

  it("restores an idle session when plugin removal fails", async () => {
    const interruptedBackend = createBackend(true);
    const restoredBackend = createBackend(true);
    testState.createBackend
      .mockResolvedValueOnce(interruptedBackend)
      .mockResolvedValueOnce(restoredBackend);
    testState.removePlugin.mockResolvedValueOnce({
      success: false,
      error: "remove failed",
      agents: [],
    });

    await getHandler("agent:createSession")(
      {}, "codex", "C:\\project", "interrupted-session", "native-interrupted"
    );
    const result = await getHandler("agentPlugin:remove")({}, "codex", false);

    expect(result).toMatchObject({ success: false, error: "remove failed" });
    expect(interruptedBackend.dispose).toHaveBeenCalledTimes(1);
    expect(restoredBackend.init).toHaveBeenCalledWith("C:\\project", "native-interrupted", {
      hostSystemPrompt: HPP_AGENT_SYSTEM_PROMPT,
    });
    expect(await getHandler("agent:getSessionState")({}, "interrupted-session")).toEqual({
      success: true,
      idle: true,
    });
  });

  it("aborts removal and restores already-disposed peers when one idle session cannot close", async () => {
    const disposableBackend = createBackend(true);
    const failingBackend = createBackend(true);
    const restoredBackend = createBackend(true);
    failingBackend.dispose.mockRejectedValue(new Error("dispose failed"));
    testState.createBackend
      .mockResolvedValueOnce(disposableBackend)
      .mockResolvedValueOnce(failingBackend)
      .mockResolvedValueOnce(restoredBackend);

    await getHandler("agent:createSession")({}, "codex", "C:\\first", "first-session", "native-first");
    await getHandler("agent:createSession")({}, "codex", "C:\\second", "second-session", "native-second");
    const result = await getHandler("agentPlugin:remove")({}, "codex", false);

    expect(result).toMatchObject({
      success: false,
      error: "无法关闭 Agent 空闲会话：dispose failed",
    });
    expect(testState.removePlugin).not.toHaveBeenCalled();
    expect(restoredBackend.init).toHaveBeenCalledWith("C:\\first", "native-first", {
      hostSystemPrompt: HPP_AGENT_SYSTEM_PROMPT,
    });
    expect(await getHandler("agent:getSessionState")({}, "first-session")).toEqual({
      success: true,
      idle: true,
    });
    expect(await getHandler("agent:getSessionState")({}, "second-session")).toEqual({
      success: true,
      idle: true,
    });
  });

  it("reports detached sessions and disposes a replacement backend when restoration init fails", async () => {
    const originalBackend = createBackend(true);
    const failedReplacement = createBackend(true);
    failedReplacement.init.mockRejectedValueOnce(new Error("restore init failed"));
    testState.createBackend
      .mockResolvedValueOnce(originalBackend)
      .mockResolvedValueOnce(failedReplacement);
    testState.removePlugin.mockResolvedValueOnce({
      success: false,
      error: "remove failed",
      agents: [],
    });

    await getHandler("agent:createSession")(
      {}, "codex", "C:\\project", "restore-failure", "native-restore"
    );
    const result = await getHandler("agentPlugin:remove")({}, "codex", true);

    expect(result).toMatchObject({
      success: false,
      error: "remove failed；会话恢复失败：restore init failed",
      detachedSessionIds: ["restore-failure"],
    });
    expect(failedReplacement.dispose).toHaveBeenCalledTimes(1);
    expect(await getHandler("agent:getSessionState")({}, "restore-failure")).toMatchObject({
      success: false,
      error: "No active agent",
    });
  });

  it("blocks plugin removal while a session is still initializing", async () => {
    const backend = createBackend(true);
    const initialization = createDeferred();
    backend.init.mockImplementationOnce(() => initialization.promise);
    testState.createBackend.mockResolvedValueOnce(backend);

    const creating = getHandler("agent:createSession")(
      {}, "codex", "C:\\project", "initializing-session"
    );
    await vi.waitFor(() => expect(backend.init).toHaveBeenCalledTimes(1));

    await expect(getHandler("agentPlugin:remove")({}, "codex", false)).resolves.toMatchObject({
      success: false,
      error: "该 Agent 仍有会话正在初始化，请等待初始化完成后再卸载插件。",
    });
    expect(testState.removePlugin).not.toHaveBeenCalled();
    await expect(getHandler("agent:removeSession")({}, "initializing-session"))
      .rejects.toThrow("Agent 会话正在初始化，请稍后关闭。");

    initialization.resolve();
    await expect(creating).resolves.toMatchObject({ success: true });
  });

  it("serializes plugin installation behind an in-progress removal", async () => {
    const backend = createBackend(true);
    const disposal = createDeferred();
    backend.dispose.mockImplementationOnce(() => disposal.promise);
    testState.createBackend.mockResolvedValueOnce(backend);
    testState.installFromPath.mockResolvedValueOnce({ success: true, agents: [] });

    await getHandler("agent:createSession")({}, "codex", "C:\\project", "queued-removal");
    const removing = getHandler("agentPlugin:remove")({}, "codex", false);
    await vi.waitFor(() => expect(backend.dispose).toHaveBeenCalledTimes(1));

    const installing = getHandler("agentPlugin:installFromPath")({}, "C:\\plugin.zip");
    await Promise.resolve();
    expect(testState.installFromPath).not.toHaveBeenCalled();

    disposal.resolve();
    await expect(removing).resolves.toMatchObject({ success: true });
    await expect(installing).resolves.toMatchObject({ success: true });
    expect(testState.installFromPath).toHaveBeenCalledTimes(1);
  });

  it("hides a backend from sends while the session is being disposed", async () => {
    const backend = createBackend(true);
    const disposal = createDeferred();
    backend.dispose.mockImplementationOnce(() => disposal.promise);
    testState.createBackend.mockResolvedValueOnce(backend);

    await getHandler("agent:createSession")({}, "codex", "C:\\project", "closing-session");
    const closing = getHandler("agent:removeSession")({}, "closing-session");
    await vi.waitFor(() => expect(backend.dispose).toHaveBeenCalledTimes(1));

    await expect(
      getHandler("agent:sendMessage")({}, "hello", undefined, "closing-session")
    ).resolves.toMatchObject({ success: false, error: "No active agent" });
    expect(backend.sendMessage).not.toHaveBeenCalled();

    disposal.resolve();
    await expect(closing).resolves.toMatchObject({ success: true });
  });

  it("revalidates the backend after an awaited capability check before sending", async () => {
    const backend = createBackend(true);
    const capabilities = createDeferred<{
      planMode: "prompt";
      guidance: boolean;
      fork: boolean;
      configuration: "none";
      providerActivation: "none";
    }>();
    const disposal = createDeferred();
    backend.dispose.mockImplementationOnce(() => disposal.promise);
    testState.createBackend.mockResolvedValueOnce(backend);

    await getHandler("agent:createSession")({}, "codex", "C:\\project", "send-race");
    testState.getCapabilities.mockClear();
    testState.getCapabilities.mockReturnValueOnce(capabilities.promise);
    const sending = getHandler("agent:sendMessage")(
      {}, "hello", undefined, "send-race", { planModeEnabled: true }
    );
    await vi.waitFor(() => expect(testState.getCapabilities).toHaveBeenCalledTimes(1));

    const closing = getHandler("agent:removeSession")({}, "send-race");
    await vi.waitFor(() => expect(backend.dispose).toHaveBeenCalledTimes(1));
    capabilities.resolve({
      planMode: "prompt",
      guidance: false,
      fork: false,
      configuration: "none",
      providerActivation: "none",
    });

    await expect(sending).resolves.toMatchObject({ success: false, error: "No active agent" });
    expect(backend.sendMessage).not.toHaveBeenCalled();
    disposal.resolve();
    await closing;
  });

  it("blocks new sessions while a local plugin installation is mutating the catalog", async () => {
    const installation = createDeferred<{ success: true; agents: never[] }>();
    testState.installFromPath.mockReturnValueOnce(installation.promise);

    const installing = getHandler("agentPlugin:installFromPath")({}, "C:\\plugin.zip");
    await vi.waitFor(() => expect(testState.installFromPath).toHaveBeenCalledTimes(1));

    await expect(
      getHandler("agent:createSession")({}, "codex", "C:\\project", "install-race")
    ).resolves.toMatchObject({
      success: false,
      error: "Agent 插件正在安装或刷新，请等待操作完成。",
    });
    expect(testState.createBackend).not.toHaveBeenCalled();

    installation.resolve({ success: true, agents: [] });
    await expect(installing).resolves.toMatchObject({ success: true });
  });

  it("does not reload the plugin registry while sessions are open", async () => {
    const backend = createBackend(true);
    testState.createBackend.mockResolvedValueOnce(backend);
    await getHandler("agent:createSession")({}, "codex", "C:\\project", "reload-guard");

    await expect(getHandler("agentPlugin:reload")({})).resolves.toMatchObject({
      success: false,
      error: "仍有 Agent 会话处于打开或初始化状态，请先关闭后再刷新插件。",
    });
    expect(testState.reloadRegistry).not.toHaveBeenCalled();
  });
});
