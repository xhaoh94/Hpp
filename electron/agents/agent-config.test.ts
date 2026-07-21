import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  userDataDir: "",
  capabilities: {} as Record<string, unknown>,
  capabilitiesByAgent: {} as Record<string, Record<string, unknown>>,
  nativeState: undefined as unknown,
  writtenState: undefined as unknown,
  activationResult: {} as Record<string, unknown>,
}));

vi.mock("electron", () => ({
  app: { getPath: () => testState.userDataDir },
}));

vi.mock("./agent-plugin-registry", () => ({
  getAgentPluginRegistry: () => ({
    getCapabilities: async (agentId: string) => testState.capabilitiesByAgent[agentId] || testState.capabilities,
    readProviderConfig: async () => testState.nativeState,
    writeProviderConfig: async (_agentId: string, state: unknown) => {
      testState.writtenState = state;
      return {};
    },
    activateProvider: async () => testState.activationResult,
  }),
}));

const providerConfiguration = (storage: "hpp" | "plugin" = "hpp") => ({
  type: "provider" as const,
  storage,
  endpoints: [
    { id: "chat-completions", label: "Chat Completions" },
    { id: "responses", label: "Responses" },
  ],
  defaultEndpoint: "responses",
  modelDefaults: { reasoning: false, imageInput: false },
  fixedModelCapabilities: false,
  modelListMode: "merge" as const,
});

const provider = (providerId: string, endpoint = "responses") => ({
  providerId,
  displayName: providerId,
  baseUrl: `https://${providerId}.example/v1`,
  apiKey: `${providerId}-key`,
  endpoint,
  models: [{ id: `${providerId}-model`, name: providerId, reasoning: true, imageInput: true }],
});

describe("agent provider config", () => {
  let tempRoot = "";
  let deleteAgentProviderConfig: typeof import("./agent-config").deleteAgentProviderConfig;
  let copyAgentProviderConfig: typeof import("./agent-config").copyAgentProviderConfig;
  let getAgentConfigStateForBackend: typeof import("./agent-config").getAgentConfigStateForBackend;
  let getConfiguredAgentModels: typeof import("./agent-config").getConfiguredAgentModels;
  let getAgentModelVisibility: typeof import("./agent-config").getAgentModelVisibility;
  let saveAgentProviderConfig: typeof import("./agent-config").saveAgentProviderConfig;
  let setAgentBackendModelsVisible: typeof import("./agent-config").setAgentBackendModelsVisible;
  let activateAgentProviderConfig: typeof import("./agent-config").activateAgentProviderConfig;

  const writeSavedProviders = async () => {
    const dataDir = join(tempRoot, "hpp-data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "settings.json"), JSON.stringify({
      agentConfigs: {
        "test-agent": {
          activeProviderId: "provider-a",
          providers: [provider("provider-a"), provider("provider-b")],
        },
      },
    }), "utf8");
  };

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "hpp-agent-config-"));
    testState.userDataDir = tempRoot;
    testState.capabilities = {
      configuration: providerConfiguration("hpp"),
      providerActivation: "single-active",
    };
    testState.capabilitiesByAgent = {};
    testState.nativeState = undefined;
    testState.writtenState = undefined;
    testState.activationResult = {};
    vi.resetModules();
    ({
      activateAgentProviderConfig,
      copyAgentProviderConfig,
      deleteAgentProviderConfig,
      getAgentConfigStateForBackend,
      getAgentModelVisibility,
      getConfiguredAgentModels,
      saveAgentProviderConfig,
      setAgentBackendModelsVisible,
    } = await import("./agent-config"));
    await writeSavedProviders();
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("deletes only the provider with the exact id", async () => {
    await expect(deleteAgentProviderConfig("test-agent", "provider-b")).resolves.toMatchObject({
      success: true,
      config: {
        activeProviderId: "provider-a",
        providers: [{ providerId: "provider-a", endpoint: "responses" }],
      },
    });

    const settings = JSON.parse(await readFile(join(tempRoot, "hpp-data", "settings.json"), "utf8"));
    expect(settings.agentConfigs["test-agent"].providers.map((item: { providerId: string }) => item.providerId)).toEqual(["provider-a"]);
  });

  it("rejects a missing provider instead of silently succeeding", async () => {
    await expect(deleteAgentProviderConfig("test-agent", "provider-missing")).resolves.toMatchObject({
      success: false,
      error: "未找到渠道：provider-missing",
    });
  });

  it("does not delete the active single-provider channel", async () => {
    await expect(deleteAgentProviderConfig("test-agent", "provider-a")).resolves.toMatchObject({
      success: false,
      error: "当前启用的渠道不能直接删除，请先启用其它渠道。",
    });
  });

  it("validates endpoints against the plugin declaration", async () => {
    await expect(saveAgentProviderConfig("test-agent", provider("unsupported", "anthropic-messages"))).resolves.toMatchObject({
      success: false,
      error: "当前插件不支持 Endpoint：anthropic-messages",
    });
  });

  it("delegates plugin-owned configuration writes", async () => {
    testState.capabilities = {
      configuration: providerConfiguration("plugin"),
      providerActivation: "none",
    };
    testState.nativeState = { providers: [provider("native")] };

    await expect(saveAgentProviderConfig("test-agent", provider("added", "chat-completions"))).resolves.toMatchObject({
      success: true,
    });
    expect(testState.writtenState).toMatchObject({
      providers: [
        { providerId: "native" },
        { providerId: "added", endpoint: "chat-completions" },
      ],
    });
  });

  it("copies a compatible channel across agents and resolves id collisions", async () => {
    const settingsPath = join(tempRoot, "hpp-data", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.agentConfigs["test-agent"].providers.push(provider("opencode", "openai-completions"));
    settings.agentConfigs["target-agent"] = {
      providers: [provider("opencode", "chat-completions"), provider("opencode-copy", "chat-completions")],
    };
    await writeFile(settingsPath, JSON.stringify(settings), "utf8");
    testState.capabilitiesByAgent["target-agent"] = {
      configuration: {
        ...providerConfiguration("hpp"),
        endpoints: [{ id: "chat-completions", label: "Chat Completions" }],
        defaultEndpoint: "chat-completions",
        modelDefaults: { reasoning: true, imageInput: false },
        fixedModelCapabilities: true,
      },
      providerActivation: "none",
    };

    await expect(copyAgentProviderConfig("test-agent", "opencode", "target-agent")).resolves.toMatchObject({
      success: true,
      copiedProviderId: "opencode-copy-2",
      config: {
        providers: expect.arrayContaining([expect.objectContaining({
          providerId: "opencode-copy-2",
          endpoint: "chat-completions",
          models: [expect.objectContaining({ reasoning: true, imageInput: false })],
        })]),
      },
    });
  });

  it("copies a channel inside the current agent through the same API", async () => {
    await expect(copyAgentProviderConfig("test-agent", "provider-a", "test-agent")).resolves.toMatchObject({
      success: true,
      copiedProviderId: "provider-a-copy",
      config: {
        activeProviderId: "provider-a",
        providers: expect.arrayContaining([
          expect.objectContaining({ providerId: "provider-a" }),
          expect.objectContaining({ providerId: "provider-a-copy", endpoint: "responses" }),
        ]),
      },
    });
  });

  it("rejects cross-agent copies when the target has no compatible endpoint", async () => {
    testState.capabilitiesByAgent["target-agent"] = {
      configuration: {
        ...providerConfiguration("hpp"),
        endpoints: [{ id: "anthropic-messages", label: "Anthropic Messages" }],
        defaultEndpoint: "anthropic-messages",
      },
      providerActivation: "none",
    };

    await expect(copyAgentProviderConfig("test-agent", "provider-a", "target-agent")).resolves.toMatchObject({
      success: false,
      error: "目标 Agent 不支持 Endpoint：responses",
    });
  });

  it("discovers an initial Hpp-owned configuration through the plugin", async () => {
    await rm(join(tempRoot, "hpp-data", "settings.json"), { force: true });
    testState.nativeState = { activeProviderId: "native", providers: [provider("native")] };

    await expect(getAgentConfigStateForBackend("test-agent")).resolves.toMatchObject({
      activeProviderId: "native",
      providers: [{ providerId: "native" }],
    });
    const settings = JSON.parse(await readFile(join(tempRoot, "hpp-data", "settings.json"), "utf8"));
    expect(settings.agentConfigs["test-agent"].providers[0].providerId).toBe("native");
  });

  it("keeps legacy providers on Bearer and honors declared auth defaults", async () => {
    await expect(getAgentConfigStateForBackend("test-agent")).resolves.toMatchObject({
      providers: expect.arrayContaining([expect.objectContaining({ providerId: "provider-a", authMode: "bearer" })]),
    });

    testState.capabilities = {
      configuration: {
        ...providerConfiguration("hpp"),
        authModes: [
          { id: "bearer", label: "Bearer" },
          { id: "x-api-key", label: "X-Api-Key" },
        ],
        defaultAuthMode: "x-api-key",
      },
      providerActivation: "none",
    };
    await expect(saveAgentProviderConfig("test-agent", provider("new-provider"))).resolves.toMatchObject({
      success: true,
      config: { providers: expect.arrayContaining([expect.objectContaining({ providerId: "new-provider", authMode: "x-api-key" })]) },
    });
  });

  it("delegates single-active provider activation and returns snapshots", async () => {
    testState.activationResult = {
      snapshots: [{ filePath: join(tempRoot, "native.json"), existed: false, content: "" }],
    };

    await expect(activateAgentProviderConfig("test-agent", "provider-a")).resolves.toMatchObject({
      provider: { providerId: "provider-a" },
      snapshots: [{ existed: false }],
    });
  });

  it("exposes every configured channel while allowing active-only queries", async () => {
    await expect(getConfiguredAgentModels("test-agent")).resolves.toEqual([
      {
        id: "provider-a-model",
        name: "provider-a",
        provider: "provider-a",
        reasoning: true,
        supportsImages: true,
      },
      {
        id: "provider-b-model",
        name: "provider-b",
        provider: "provider-b",
        reasoning: true,
        supportsImages: true,
      },
    ]);
    await expect(getConfiguredAgentModels("test-agent", { activeOnly: true })).resolves.toEqual([{
      id: "provider-a-model",
      name: "provider-a",
      provider: "provider-a",
      reasoning: true,
      supportsImages: true,
    }]);
  });

  it("persists plugin-declared backend model visibility preferences", async () => {
    testState.capabilities = {
      configuration: {
        ...providerConfiguration("hpp"),
        backendModelVisibility: {
          userConfigurable: true,
          defaultVisible: false,
          label: "显示官方模型",
        },
      },
      providerActivation: "none",
    };

    await expect(getAgentModelVisibility("test-agent")).resolves.toMatchObject({
      success: true,
      backendModelsVisible: false,
    });
    await expect(setAgentBackendModelsVisible("test-agent", true)).resolves.toMatchObject({
      success: true,
      backendModelsVisible: true,
    });
    await expect(getAgentModelVisibility("test-agent")).resolves.toMatchObject({
      success: true,
      backendModelsVisible: true,
    });

    const settings = JSON.parse(await readFile(join(tempRoot, "hpp-data", "settings.json"), "utf8"));
    expect(settings.agentModelPreferences["test-agent"].backendModelsVisible).toBe(true);
  });
});
