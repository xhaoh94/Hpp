import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  userDataDir: "",
  capabilities: {} as Record<string, unknown>,
  nativeState: undefined as unknown,
  writtenState: undefined as unknown,
  activationResult: {} as Record<string, unknown>,
}));

vi.mock("electron", () => ({
  app: { getPath: () => testState.userDataDir },
}));

vi.mock("./agent-plugin-registry", () => ({
  getAgentPluginRegistry: () => ({
    getCapabilities: async () => testState.capabilities,
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
    testState.nativeState = undefined;
    testState.writtenState = undefined;
    testState.activationResult = {};
    vi.resetModules();
    ({
      activateAgentProviderConfig,
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
