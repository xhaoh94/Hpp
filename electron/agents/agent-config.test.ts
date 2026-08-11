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
  let listAgentConfig: typeof import("./agent-config").listAgentConfig;
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
      listAgentConfig,
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

  it("derives custom-model reasoning from whether thinking levels are selected", async () => {
    const result = await saveAgentProviderConfig("test-agent", {
      ...provider("provider-a"),
      models: [{
        id: "enabled-model",
        name: "Enabled",
        reasoning: false,
        imageInput: false,
        supportedThinkingLevels: ["high", "future-tier"],
      }, {
        id: "disabled-model",
        name: "Disabled",
        reasoning: true,
        imageInput: false,
        supportedThinkingLevels: [],
      }],
    });

    expect(result).toMatchObject({
      success: true,
      config: {
        providers: expect.arrayContaining([expect.objectContaining({
          providerId: "provider-a",
          models: [expect.objectContaining({
            id: "enabled-model",
            // 自定义模型选中任意档位即支持思考，忽略旧 reasoning 值。
            reasoning: true,
            supportedThinkingLevels: ["high", "future-tier"],
            hasThinkingLevels: true,
          }), expect.objectContaining({
            id: "disabled-model",
            // 自定义模型未选档位即不支持思考。
            reasoning: false,
          })],
        })]),
      },
    });
  });

  it("enriches saved configs with discovered thinking-level declarations", async () => {
    // settings 里保存的是旧版配置：模型没有 hasThinkingLevels 字段。
    const settingsPath = join(tempRoot, "hpp-data", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.agentConfigs["test-agent"].providers.push({
      providerId: "opencode",
      displayName: "opencode",
      baseUrl: "https://opencode.example/v1",
      apiKey: "key",
      endpoint: "chat-completions",
      models: [{ id: "deepseek-v4-flash-free", name: "DeepSeek", reasoning: true, imageInput: false }],
    });
    await writeFile(settingsPath, JSON.stringify(settings), "utf8");
    // 插件实时发现（读 models.json + 渠道目录）：内置目录模型由 Agent 自身管理能力，
    // isBuiltin:true/hasThinkingLevels:false，配置弹窗不显示能力控件。
    testState.nativeState = {
      providers: [{
        providerId: "opencode",
        displayName: "opencode",
        baseUrl: "https://opencode.example/v1",
        apiKey: "key",
        endpoint: "chat-completions",
        models: [{
          id: "deepseek-v4-flash-free",
          name: "DeepSeek",
          reasoning: true,
          imageInput: false,
          isBuiltin: true,
          hasThinkingLevels: false,
        }],
      }],
    };

    const result = await listAgentConfig("test-agent");
    const opencode = result.config?.providers.find((item) => item.providerId === "opencode");
    expect(opencode?.models[0]).toMatchObject({
      id: "deepseek-v4-flash-free",
      reasoning: true,
      imageInput: false,
      // 内置目录模型 → 能力由 Agent 管理，配置弹窗不显示能力控件。
      isBuiltin: true,
      hasThinkingLevels: false,
    });
  });

  it("cross-matches discovered models by id across provider ids", async () => {
    // 用户的自定义渠道 providerId 为 "tanwan"，但模型 "gpt-5.6-sol" 在 pi 内置目录
    // 中由 "opencode" provider 声明。enrich 应按 modelId 跨 provider 兜底查找。
    const settingsPath = join(tempRoot, "hpp-data", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.agentConfigs["test-agent"].providers.push({
      providerId: "tanwan",
      displayName: "tanwan",
      baseUrl: "https://api.example/v1",
      apiKey: "key",
      endpoint: "chat-completions",
      models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true, imageInput: false }],
    });
    await writeFile(settingsPath, JSON.stringify(settings), "utf8");
    // 插件发现结果中，模型 "gpt-5.6-sol" 属于 opencode provider。
    testState.nativeState = {
      providers: [{
        providerId: "opencode",
        displayName: "opencode",
        baseUrl: "https://opencode.example/v1",
        apiKey: "key",
        endpoint: "chat-completions",
        models: [{
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          reasoning: true,
          imageInput: true,
          isBuiltin: true,
          hasThinkingLevels: false,
        }],
      }],
    };

    const result = await listAgentConfig("test-agent");
    const tanwan = result.config?.providers.find((item) => item.providerId === "tanwan");
    // 跨 provider 兜底匹配成功 → 标记为内置，能力由 Agent 管理。
    expect(tanwan?.models[0]).toMatchObject({
      id: "gpt-5.6-sol",
      isBuiltin: true,
      hasThinkingLevels: false,
      imageInput: true, // 目录权威值覆盖配置值
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
          models: [expect.objectContaining({ reasoning: false, imageInput: false })],
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
        reasoning: false,
        supportsImages: true,
      },
      {
        id: "provider-b-model",
        name: "provider-b",
        provider: "provider-b",
        reasoning: false,
        supportsImages: true,
      },
    ]);
    await expect(getConfiguredAgentModels("test-agent", { activeOnly: true })).resolves.toEqual([{
      id: "provider-a-model",
      name: "provider-a",
      provider: "provider-a",
      reasoning: false,
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

  it("derives chat thinking controls from builtin capabilities and custom selections", async () => {
    const dataDir = join(tempRoot, "hpp-data");
    testState.capabilities = {
      configuration: {
        ...providerConfiguration("hpp"),
        modelDefaults: {
          reasoning: true,
          imageInput: false,
          supportedThinkingLevels: ["low", "medium", "high"],
        },
      },
      providerActivation: "none",
    };
    await writeFile(join(dataDir, "settings.json"), JSON.stringify({
      agentConfigs: {
        "test-agent": {
          providers: [{
            providerId: "provider-a",
            displayName: "provider-a",
            baseUrl: "https://provider-a.example/v1",
            apiKey: "key",
            authMode: "bearer",
            endpoint: "responses",
            models: [
              { id: "builtin-levels", name: "Builtin Levels", reasoning: true, imageInput: true, isBuiltin: true, supportedThinkingLevels: ["high", "max"] },
              { id: "builtin-toggle", name: "Builtin Toggle", reasoning: true, imageInput: true, isBuiltin: true },
              { id: "builtin-single", name: "Builtin Single", reasoning: true, imageInput: true, isBuiltin: true, supportedThinkingLevels: ["high"] },
              { id: "custom-toggle", name: "Custom Toggle", reasoning: true, imageInput: false, supportedThinkingLevels: ["high"] },
              { id: "custom-levels", name: "Custom Levels", reasoning: true, imageInput: false, supportedThinkingLevels: ["low", "high"] },
              { id: "custom-off", name: "Custom Off", reasoning: false, imageInput: false, supportedThinkingLevels: ["high"] },
            ],
          }],
        },
      },
    }), "utf8");

    await expect(getConfiguredAgentModels("test-agent")).resolves.toEqual([
      expect.objectContaining({ id: "builtin-levels", thinkingLevelMode: "levels", supportedThinkingLevels: ["high", "max"] }),
      expect.objectContaining({ id: "builtin-toggle", thinkingLevelMode: "toggle" }),
      expect.objectContaining({ id: "builtin-single", thinkingLevelMode: "levels", supportedThinkingLevels: ["high"] }),
      expect.objectContaining({ id: "custom-toggle", thinkingLevelMode: "toggle", supportedThinkingLevels: ["high"] }),
      expect.objectContaining({ id: "custom-levels", thinkingLevelMode: "levels", supportedThinkingLevels: ["low", "high"] }),
      expect.objectContaining({ id: "custom-off", reasoning: true, thinkingLevelMode: "toggle", supportedThinkingLevels: ["high"] }),
    ]);
  });

  it("keeps per-model thinking levels from the provider configuration", async () => {
    // Model-declared levels win over the plugin default and unknown ids are
    // preserved verbatim (empty/duplicate entries are normalized away).
    const dataDir = join(tempRoot, "hpp-data");
    await writeFile(join(dataDir, "settings.json"), JSON.stringify({
      agentConfigs: {
        "test-agent": {
          activeProviderId: "provider-a",
          providers: [{
            providerId: "provider-a",
            displayName: "provider-a",
            baseUrl: "https://provider-a.example/v1",
            apiKey: "key",
            authMode: "bearer",
            endpoint: "responses",
            models: [{
              id: "model-deep",
              name: "Deep Model",
              reasoning: true,
              imageInput: false,
              supportedThinkingLevels: ["off", "deep", "auto", "deep", ""],
            }],
          }],
        },
      },
    }), "utf8");
    await expect(getConfiguredAgentModels("test-agent")).resolves.toEqual([
      {
        id: "model-deep",
        name: "Deep Model",
        provider: "provider-a",
        reasoning: true,
        supportsImages: false,
        supportedThinkingLevels: ["off", "deep", "auto"],
        thinkingLevelMode: "levels",
      },
    ]);
  });
});
