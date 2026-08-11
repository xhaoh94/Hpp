import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Keep this test focused on the public AgentManager contract.  A backend is
 * deliberately identified by an arbitrary id below so the assertion does not
 * accidentally become Pi/Codex-specific as more adapters are added.
 */
const testState = vi.hoisted(() => ({
  createBackend: vi.fn(),
  getCapabilities: vi.fn(),
  getStatus: vi.fn(),
  shutdownRegistry: vi.fn(),
  handlers: new Map<string, (...args: any[]) => any>(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "C:\\temp\\hpp-policy-test",
    getVersion: () => "0.1.10",
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
    shutdown: testState.shutdownRegistry,
    // These methods are not used by the cases below, but keeping the mock
    // shape complete makes this test resilient to handler registration
    // changes in AgentManager.
    getPackageVersions: vi.fn(async () => []),
    listAgents: vi.fn(async () => []),
    reload: vi.fn(async () => []),
    updateAgent: vi.fn(async () => ({ success: true, agents: [] })),
    rollbackAgent: vi.fn(async () => ({ success: true, agents: [] })),
    removePlugin: vi.fn(async () => ({ success: true, agents: [] })),
    inspectInstallCandidate: vi.fn(),
    installFromPath: vi.fn(),
  }),
}));

vi.mock("./official-agent-plugins", () => ({
  downloadOfficialAgentPlugin: vi.fn(),
  downloadOfficialPluginZip: vi.fn(),
  listOfficialAgentPlugins: vi.fn(async () => ({ success: true, plugins: [] })),
}));

vi.mock("./agent-config", () => ({
  activateAgentProviderConfig: vi.fn(),
  copyAgentProviderConfig: vi.fn(),
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
  combineAgentModels: vi.fn((models: unknown[]) => models),
}));

import { HPP_AGENT_SYSTEM_PROMPT } from "./agent-runtime-policy";
import { registerAgentHandlers, shutdownAgentRuntime } from "./agent-manager";

const originalHppDataDir = process.env.HPP_DATA_DIR;

function getHandler<T extends (...args: any[]) => any>(channel: string): T {
  const handler = testState.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler as T;
}

function createBackend() {
  let sessionFilePath: string | null = null;
  return {
    setWindow: vi.fn(),
    init: vi.fn(async (_projectPath: string, existingSessionFilePath?: string) => {
      sessionFilePath = existingSessionFilePath || "native-policy-session";
    }),
    isIdle: vi.fn(() => true),
    refreshIdle: vi.fn(async () => true),
    sendMessage: vi.fn(async () => undefined),
    sendGuidance: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    getModels: vi.fn(async () => []),
    listActions: vi.fn(async () => []),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    sendUIResponse: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    get sessionFilePath() {
      return sessionFilePath;
    },
  };
}

const capabilities = (planMode: "native" | "prompt") => ({
  planMode,
  permissions: true,
  guidance: true,
  fork: false,
  actions: true,
  configuration: "none" as const,
  providerActivation: "none" as const,
});

describe("Hpp host runtime language policy", () => {
  beforeEach(() => {
    process.env.HPP_DATA_DIR = `C:\\temp\\hpp-policy-tests-${process.pid}-missing`;
    testState.handlers.clear();
    testState.createBackend.mockReset();
    testState.getCapabilities.mockReset();
    testState.getStatus.mockReset().mockResolvedValue({ installed: true });
    testState.shutdownRegistry.mockReset();
    registerAgentHandlers(() => null);
  });

  afterEach(async () => {
    await shutdownAgentRuntime();
    if (originalHppDataDir === undefined) delete process.env.HPP_DATA_DIR;
    else process.env.HPP_DATA_DIR = originalHppDataDir;
  });

  it("exports a real UTF-8 Simplified Chinese policy", () => {
    expect(HPP_AGENT_SYSTEM_PROMPT).toContain("[HPP 语言规则]");
    expect(HPP_AGENT_SYSTEM_PROMPT).toContain("请始终使用简体中文进行交流和回复");
    expect(HPP_AGENT_SYSTEM_PROMPT).toContain("可见的思考或推理");
    // U+FFFD and common mojibake markers indicate that a packaged policy was
    // decoded with the wrong code page; fail early before it reaches any CLI.
    expect(HPP_AGENT_SYSTEM_PROMPT).not.toContain("\uFFFD");
    expect(HPP_AGENT_SYSTEM_PROMPT).not.toContain("璇█瑙勫垯");
    expect(HPP_AGENT_SYSTEM_PROMPT).not.toContain("浣犳槸");
    expect(HPP_AGENT_SYSTEM_PROMPT).not.toContain("璇峰缁");
  });

  it.each([
    ["future-native", "native"],
    // Older Pi manifests advertised prompt mode; AgentManager intentionally
    // treats Pi as native because Hpp owns its Plan hook now.
    ["pi", "prompt"],
  ] as const)("passes the host policy through init/send for %s", async (agentId, planMode) => {
    const backend = createBackend();
    testState.createBackend.mockResolvedValueOnce(backend);
    testState.getCapabilities.mockResolvedValue(capabilities(planMode));

    const create = getHandler<(event: unknown, id: string, cwd: string, sessionId: string) => Promise<unknown>>("agent:createSession");
    const send = getHandler<(event: unknown, message: string, images: undefined, sessionId: string, options: Record<string, unknown>) => Promise<unknown>>("agent:sendMessage");
    await expect(create({}, agentId, "C:\\project", `${agentId}-session`)).resolves.toMatchObject({ success: true });

    await expect(send({}, "请先检查项目", undefined, `${agentId}-session`, {
      planModeEnabled: true,
      permissionMode: "ask",
    })).resolves.toEqual({ success: true });

    expect(backend.init).toHaveBeenCalledWith("C:\\project", undefined, {
      hostSystemPrompt: HPP_AGENT_SYSTEM_PROMPT,
    });
    expect(backend.sendMessage).toHaveBeenCalledWith(
      // Native Plan adapters receive the original user message. In
      // particular, no legacy English <plan_mode> wrapper may leak into the
      // persisted/displayed message.
      "请先检查项目",
      undefined,
      expect.objectContaining({
        planModeEnabled: true,
        permissionMode: "ask",
        displayMessage: "请先检查项目",
        hostSystemPrompt: HPP_AGENT_SYSTEM_PROMPT,
      }),
    );
    const sentMessage = (backend.sendMessage.mock.calls as unknown[][])[0]?.[0];
    expect(String(sentMessage)).not.toContain("<plan_mode>");
  });
});
