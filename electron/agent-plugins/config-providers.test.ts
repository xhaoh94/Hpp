import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("official plugin config providers", () => {
  let tempRoot = "";
  const originalEnv = {
    CODEX_HOME: process.env.CODEX_HOME,
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
    PI_CONFIG_PATH: process.env.PI_CONFIG_PATH,
  };

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "hpp-plugin-config-"));
    process.env.CODEX_HOME = join(tempRoot, "codex");
    process.env.OPENCODE_CONFIG = join(tempRoot, "opencode.json");
    process.env.PI_CONFIG_PATH = join(tempRoot, "pi.json");
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const provider = (endpoint: string) => ({
    providerId: "custom",
    displayName: "Custom",
    baseUrl: "https://api.example/v1",
    apiKey: "key",
    endpoint,
    models: [{ id: "model", name: "Model", reasoning: true, imageInput: true }],
  });

  it("uses configured Pi models instead of the expanded SDK catalog", async () => {
    const manifest = JSON.parse(await readFile(
      join(process.cwd(), "electron", "agent-plugins", "pi", "hpp-agent-plugin.json"),
      "utf8",
    ));

    expect(manifest.capabilities.configuration.modelListMode).toBe("configured");
  });

  it("declares context compaction support in plugin manifests", async () => {
    const readManifest = async (agentId: string) => JSON.parse(await readFile(
      join(process.cwd(), "electron", "agent-plugins", agentId, "hpp-agent-plugin.json"),
      "utf8",
    ));
    const [pi, opencode, codex, claude] = await Promise.all(
      ["pi", "opencode", "codex", "claude"].map(readManifest),
    );

    // 压缩模型不可配置（走 pi 自己的模型），清单里不再声明 channelModel。
    expect(pi.capabilities.compaction).toEqual({
      thinkingLevel: true,
      toggle: true,
    });
    expect(opencode.capabilities.compaction).toEqual({ thinkingLevel: true });
    expect(codex.capabilities.compaction).toBeUndefined();
    expect(claude.capabilities.compaction).toBeUndefined();
  });

  it("declares per-model endpoint overrides only where the backend can honour them", async () => {
    const readConfiguration = async (agentId: string) => {
      const manifest = JSON.parse(await readFile(
        join(process.cwd(), "electron", "agent-plugins", agentId, "hpp-agent-plugin.json"),
        "utf8",
      ));
      return manifest.capabilities.configuration;
    };
    const configurations = await Promise.all(["pi", "opencode", "codex", "claude"].map(readConfiguration));

    expect(configurations[0].modelEndpointOverrides).toBe(true);
    // 其余后端的端点写在进程级 env / 单份 config 里，做不到按模型切换。
    expect(configurations.slice(1).every((configuration) => configuration.modelEndpointOverrides === undefined)).toBe(true);
  });

  it("maps Pi endpoints through the plugin adapter", async () => {
    const { getProviderApi, getProviderEndpoint, toProviderConfig } = await import("./pi/config.mjs");
    expect(toProviderConfig(provider("responses"))).toMatchObject({ api: "openai-responses" });
    expect(toProviderConfig(provider("chat-completions"))).toMatchObject({ api: "openai-completions" });
    expect(getProviderApi("anthropic-messages")).toBe("anthropic-messages");
    expect(getProviderApi("google-generative-ai")).toBe("google-generative-ai");
    expect(getProviderEndpoint("azure-openai-responses")).toBe("azure-openai-responses");
  });

  it("maps Pi thinking-level declarations in both directions", async () => {
    const pi = await import("./pi/config.mjs");
    const configuredProvider = {
      ...provider("chat-completions"),
      models: [{
        id: "custom-thinking-model",
        name: "Custom Thinking Model",
        reasoning: true,
        imageInput: false,
        supportedThinkingLevels: ["high", "max", "future-tier"],
      }],
    };

    expect(pi.toProviderConfig(configuredProvider).models[0]).toMatchObject({
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        max: "max",
        "future-tier": "future-tier",
      },
    });

    await writeFile(process.env.PI_CONFIG_PATH!, JSON.stringify({
      providers: {
        custom: pi.toProviderConfig(configuredProvider),
      },
    }), "utf8");
    await expect(pi.readProviderConfig()).resolves.toMatchObject({
      providers: [{
        models: [{
          id: "custom-thinking-model",
          supportedThinkingLevels: ["high", "max", "future-tier"],
        }],
      }],
    });
  });

  it("writes per-model Pi endpoints and URLs, and reads them back", async () => {
    const pi = await import("./pi/config.mjs");
    const configuredProvider = {
      ...provider("responses"),
      models: [
        { id: "gpt-model", name: "GPT", reasoning: true, imageInput: true },
        // 与渠道端点相同的显式覆盖不应落成模型级 api。
        { id: "gpt-same-endpoint", name: "GPT 2", reasoning: true, imageInput: true, endpoint: "responses" },
        {
          id: "claude-model",
          name: "Claude",
          reasoning: true,
          imageInput: true,
          endpoint: "anthropic-messages",
          baseUrl: "https://relay.example/claude/v1",
        },
        { id: "claude-inherit-url", name: "Claude 2", reasoning: true, imageInput: true, endpoint: "anthropic-messages" },
      ],
    };

    const written = pi.toProviderConfig(configuredProvider);
    expect(written.models[0]).not.toHaveProperty("api");
    expect(written.models[1]).not.toHaveProperty("api");
    expect(written.models[2]).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://relay.example/claude/v1",
    });
    expect(written.models[3]).toMatchObject({ api: "anthropic-messages" });
    expect(written.models[3]).not.toHaveProperty("baseUrl");

    await writeFile(process.env.PI_CONFIG_PATH!, JSON.stringify({
      providers: { custom: written },
    }), "utf8");
    const state = await pi.readProviderConfig();
    expect(state).toMatchObject({
      providers: [{
        models: [
          { id: "gpt-model" },
          { id: "gpt-same-endpoint" },
          { id: "claude-model", endpoint: "anthropic-messages", baseUrl: "https://relay.example/claude/v1" },
          { id: "claude-inherit-url", endpoint: "anthropic-messages" },
        ],
      }],
    });
    expect(state.providers[0].models[0]).not.toHaveProperty("endpoint");
    expect(state.providers[0].models[3]).not.toHaveProperty("baseUrl");
  });

  it("keeps the declared Pi context window when reading channels back", async () => {
    const pi = await import("./pi/config.mjs");
    const configuredProvider = {
      ...provider("responses"),
      models: [{
        id: "window-model",
        name: "Window Model",
        reasoning: true,
        imageInput: false,
        contextWindow: 1050000,
      }],
    };

    // 写入 models.json 时保留 contextWindow。
    await writeFile(process.env.PI_CONFIG_PATH!, JSON.stringify({
      providers: { custom: pi.toProviderConfig(configuredProvider) },
    }), "utf8");

    // 读回时不能丢掉窗口：否则标题栏/上下文弹窗只能显示“未提供上下文窗口”。
    const state = await pi.readProviderConfig();
    expect(state).toMatchObject({
      providers: [{ models: [{ id: "window-model", contextWindow: 1050000 }] }],
    });

    // 再写回也不能丢（保存渠道后窗口仍保留）。
    await pi.writeProviderConfig(state);
    const saved = JSON.parse(await readFile(process.env.PI_CONFIG_PATH!, "utf8"));
    expect(saved.providers.custom.models[0].contextWindow).toBe(1050000);
  });

  it("keeps Pi reasoning independent from the declared thinking levels", async () => {
    const pi = await import("./pi/config.mjs");
    const base = provider("chat-completions");

    // reasoning: true 但没勾选思考档位 → 保留 reasoning（开关模式），不写 map。
    const unselected = pi.toProviderConfig({
      ...base,
      models: [{ id: "mimo", name: "Mimo", reasoning: true, imageInput: true }],
    });
    expect(unselected.models[0]).toMatchObject({ reasoning: true });
    expect(unselected.models[0]).not.toHaveProperty("thinkingLevelMap");

    // reasoning: false + 勾选思考档位 → 档位无效，不写 map。
    const disabled = pi.toProviderConfig({
      ...base,
      models: [{ id: "mimo", name: "Mimo", reasoning: false, supportedThinkingLevels: ["low", "high"] }],
    });
    expect(disabled.models[0]).toMatchObject({ reasoning: false });
    expect(disabled.models[0]).not.toHaveProperty("thinkingLevelMap");

    // reasoning: true + 勾选思考档位 → 写 map。
    const selected = pi.toProviderConfig({
      ...base,
      models: [{
        id: "mimo",
        name: "Mimo",
        reasoning: true,
        imageInput: true,
        supportedThinkingLevels: ["low", "high"],
      }],
    });
    expect(selected.models[0]).toMatchObject({ reasoning: true });
    // 勾选 low/high → map 只写显式排除项（缺键 = 支持，pi 语义）。
    expect(selected.models[0].thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      medium: null,
    });
  });

  it("flags directory-declared thinking levels when reading Pi models", async () => {
    const pi = await import("./pi/config.mjs");
    // 模拟目录数据（models-store.json）：deepseek 有档位声明、mimo 有目录条目但无档位、GLM 不在目录。
    await writeFile(
      process.env.PI_CONFIG_PATH!.replace(/pi\.json$/, "models-store.json"),
      JSON.stringify({
        opencode: {
          models: [
            // 与真实目录一致：内置条目同时声明 reasoning/input；完整 map 中缺键 = 支持（pi 语义）。
            { id: "deepseek-v4-flash-free", reasoning: true, input: ["text"], thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" } },
            { id: "mimo-v2.5-free", reasoning: true, input: ["text", "image"] },
          ],
        },
      }),
      "utf8",
    );
    await writeFile(process.env.PI_CONFIG_PATH!, JSON.stringify({
      providers: {
        custom: {
          baseUrl: "https://api.example/v1",
          api: "openai-completions",
          name: "Custom",
          models: [
            { id: "deepseek-v4-flash-free", name: "DeepSeek", reasoning: true, input: ["text"] },
            { id: "mimo-v2.5-free", name: "MiMo", reasoning: true, input: ["text", "image"] },
            { id: "GLM-5.1", name: "GLM", reasoning: true, input: ["text"] },
          ],
        },
      },
    }), "utf8");
    await expect(pi.readProviderConfig()).resolves.toMatchObject({
      providers: [{
        models: [
          // 内置模型（目录命中）→ 能力由 Agent 管理，isBuiltin:true/hasThinkingLevels:false；
          // supportedThinkingLevels 仍按目录预填，用于后端档位计算。
          { id: "deepseek-v4-flash-free", reasoning: true, imageInput: false, isBuiltin: true, hasThinkingLevels: false, supportedThinkingLevels: ["high", "max"] },
          // 内置但无档位声明 → 同样不显示能力控件。
          { id: "mimo-v2.5-free", reasoning: true, imageInput: true, isBuiltin: true, hasThinkingLevels: false },
          // 目录里完全没有 → 非内置，提供自定义能力控件。
          { id: "GLM-5.1", reasoning: true, imageInput: false, isBuiltin: false, hasThinkingLevels: true },
        ],
      }],
    });
  });

  it("looks up Pi builtin models by id before saving", async () => {
    const pi = await import("./pi/config.mjs");
    await writeFile(
      process.env.PI_CONFIG_PATH!.replace(/pi\.json$/, "models-store.json"),
      JSON.stringify({
        opencode: {
          models: [
            { id: "deepseek-v4-flash-free", reasoning: true, input: ["text"], thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" } },
            { id: "mimo-v2.5-free", reasoning: true, input: ["text", "image"] },
          ],
        },
      }),
      "utf8",
    );

    // 目录命中 → 返回内置能力（与 readProviderConfig 的内置判定一致）。
    await expect(pi.lookupModel("deepseek-v4-flash-free")).resolves.toMatchObject({
      isBuiltin: true,
      reasoning: true,
      imageInput: false,
      supportedThinkingLevels: ["high", "max"],
    });
    // 内置但无档位声明 → 不返回 supportedThinkingLevels。
    await expect(pi.lookupModel("mimo-v2.5-free")).resolves.toMatchObject({
      isBuiltin: true,
      reasoning: true,
      imageInput: true,
    });
    expect(await pi.lookupModel("mimo-v2.5-free")).not.toHaveProperty("supportedThinkingLevels");
    // 不在目录 / 空 id → 非内置。
    await expect(pi.lookupModel("GLM-5.1")).resolves.toBeNull();
    await expect(pi.lookupModel("")).resolves.toBeNull();
  });

  it("looks up Codex builtin models from models_cache.json before saving", async () => {
    const codexHome = process.env.CODEX_HOME!;
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({
      models: [
        {
          slug: "gpt-5.1-codex",
          display_name: "GPT-5.1 Codex",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
          input_modalities: ["text", "image"],
        },
      ],
    }), "utf8");

    const { lookupModel } = await import("./codex/config.mjs");
    await expect(lookupModel("gpt-5.1-codex")).resolves.toMatchObject({
      isBuiltin: true,
      name: "GPT-5.1 Codex",
      reasoning: true,
      imageInput: true,
      supportedThinkingLevels: ["low", "medium", "high"],
    });
    await expect(lookupModel("unknown-model")).resolves.toBeNull();
  });

  it("maps and detects OpenCode endpoint packages", async () => {
    const { readProviderConfig, toProviderConfig } = await import("./opencode/config.mjs");
    expect(toProviderConfig(provider("responses"))).toMatchObject({ npm: "@ai-sdk/openai" });
    expect(toProviderConfig(provider("chat-completions"))).toMatchObject({ npm: "@ai-sdk/openai-compatible" });
    expect(toProviderConfig(provider("anthropic-messages"))).toMatchObject({ npm: "@ai-sdk/anthropic" });

    await writeFile(process.env.OPENCODE_CONFIG!, JSON.stringify({
      provider: {
        responses: {
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://responses.example/v1", apiKey: "key" },
          models: { model: { name: "Model" } },
        },
        chat: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://chat.example/v1", apiKey: "key" },
          models: { model: { name: "Model" } },
        },
      },
    }), "utf8");
    await expect(readProviderConfig()).resolves.toMatchObject({
      providers: [
        { providerId: "responses", endpoint: "responses" },
        { providerId: "chat", endpoint: "chat-completions" },
      ],
    });
  });

  it("preserves unsupported providers and advanced OpenCode fields when writing JSONC", async () => {
    process.env.OPENCODE_CONFIG = join(tempRoot, "opencode.jsonc");
    await writeFile(process.env.OPENCODE_CONFIG, `{
      // Existing OpenCode configuration
      "provider": {
        "custom": {
          "npm": "@ai-sdk/openai-compatible",
          "name": "Existing",
          "options": { "baseURL": "https://old.example/v1", "apiKey": "old", "timeout": 1234 },
          "models": {
            "model": {
              "name": "Existing model",
              "reasoning": false,
              "cost": { "input": 1, "output": 2 },
              "variants": { "high": { "disabled": false } }
            }
          }
        },
        "google": {
          "npm": "@ai-sdk/google",
          "options": { "apiKey": "google-key" }
        }
      },
    }`, "utf8");

    const opencode = await import("./opencode/config.mjs");
    await expect(opencode.readProviderConfig()).resolves.toMatchObject({
      providers: [{ providerId: "custom", endpoint: "chat-completions" }],
    });
    await opencode.writeProviderConfig({ providers: [provider("responses")] });

    const config = JSON.parse(await readFile(process.env.OPENCODE_CONFIG, "utf8"));
    expect(config.provider.google).toEqual({
      npm: "@ai-sdk/google",
      options: { apiKey: "google-key" },
    });
    expect(config.provider.custom).toMatchObject({
      npm: "@ai-sdk/openai",
      options: { baseURL: "https://api.example/v1", apiKey: "key", timeout: 1234 },
      models: {
        model: {
          reasoning: true,
          attachment: true,
          hppSupportedThinkingLevels: [],
          cost: { input: 1, output: 2 },
          variants: { high: { disabled: false } },
        },
      },
    });
  });

  it("reads and writes the OpenCode V2 providers shape", async () => {
    await writeFile(process.env.OPENCODE_CONFIG!, JSON.stringify({
      providers: {
        custom: {
          name: "Custom",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: "https://v2.example/v1", apiKey: "v2-key" },
          models: { model: { name: "Model", reasoning: true } },
        },
        google: { name: "Google", package: "@ai-sdk/google" },
      },
    }), "utf8");

    const opencode = await import("./opencode/config.mjs");
    await expect(opencode.readProviderConfig()).resolves.toMatchObject({
      providers: [{
        providerId: "custom",
        endpoint: "chat-completions",
        baseUrl: "https://v2.example/v1",
        apiKey: "v2-key",
      }],
    });

    await opencode.writeProviderConfig({ providers: [provider("responses")] });

    const config = JSON.parse(await readFile(process.env.OPENCODE_CONFIG!, "utf8"));
    // 已有 providers 段时保持 V2 结构，不额外写出 V1 的 provider 段。
    expect(config.provider).toBeUndefined();
    expect(config.providers.custom).toMatchObject({
      package: "@opencode/ai/providers/openai",
      settings: { baseURL: "https://api.example/v1", apiKey: "key" },
      models: { model: { reasoning: true, attachment: true } },
    });
    // 非 Hpp 管理的 provider 原样保留。
    expect(config.providers.google).toEqual({ name: "Google", package: "@ai-sdk/google" });
  });

  it("refuses to overwrite an invalid OpenCode config", async () => {
    const invalid = "{ invalid jsonc";
    await writeFile(process.env.OPENCODE_CONFIG!, invalid, "utf8");
    const opencode = await import("./opencode/config.mjs");

    await expect(opencode.writeProviderConfig({ providers: [provider("responses")] })).rejects.toThrow("Failed to parse");
    await expect(readFile(process.env.OPENCODE_CONFIG!, "utf8")).resolves.toBe(invalid);
  });

  it("writes plugin-owned Pi configuration files", async () => {
    const pi = await import("./pi/config.mjs");
    await pi.writeProviderConfig({ providers: [provider("responses")] });

    const piConfig = JSON.parse(await readFile(process.env.PI_CONFIG_PATH!, "utf8"));
    expect(piConfig.providers.custom.api).toBe("openai-responses");
  });

  it("preserves native Pi JSONC providers and advanced model fields", async () => {
    await writeFile(process.env.PI_CONFIG_PATH!, `{
      // Pi accepts JSONC and trailing commas.
      "providers": {
        "managed": {
          "name": "Managed",
          "baseUrl": "https://managed.example/v1",
          "api": "anthropic-messages",
          "apiKey": "key",
          "headers": { "x-provider": "keep" },
          "models": [{
            "id": "model",
            "name": "Model",
            "reasoning": true,
            "input": ["text"],
            "contextWindow": 200000,
            "maxTokens": 8192,
            "headers": { "x-model": "keep" },
          }],
        },
        "native-extension": {
          "baseUrl": "https://native.example",
          "api": "custom-stream-api",
          "models": [{ "id": "native" }],
        },
      },
    }`, "utf8");
    const pi = await import("./pi/config.mjs");

    const state = await pi.readProviderConfig();
    expect(state.providers).toMatchObject([{ providerId: "managed", endpoint: "anthropic-messages" }]);
    await pi.writeProviderConfig(state);

    const saved = JSON.parse(await readFile(process.env.PI_CONFIG_PATH!, "utf8"));
    expect(saved.providers["native-extension"]).toMatchObject({ api: "custom-stream-api" });
    expect(saved.providers.managed).toMatchObject({
      api: "anthropic-messages",
      headers: { "x-provider": "keep" },
      models: [{
        id: "model",
        contextWindow: 200000,
        maxTokens: 8192,
        headers: { "x-model": "keep" },
      }],
    });
  });

  it("refuses to overwrite an invalid Pi config", async () => {
    const invalid = "{ invalid jsonc";
    await writeFile(process.env.PI_CONFIG_PATH!, invalid, "utf8");
    const pi = await import("./pi/config.mjs");

    await expect(pi.writeProviderConfig({ providers: [provider("responses")] })).rejects.toThrow("Failed to parse Pi config");
    await expect(readFile(process.env.PI_CONFIG_PATH!, "utf8")).resolves.toBe(invalid);
  });

  it("writes Codex endpoint activation through the plugin adapter", async () => {
    const codexHome = process.env.CODEX_HOME!;
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), [
      'model_provider = "custom"',
      'model = "old-model"',
      "",
      "[model_providers.custom]",
      'base_url = "https://old.example/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"), "utf8");

    const { activateProvider } = await import("./codex/config.mjs");
    await activateProvider(provider("chat-completions"));
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toContain('wire_api = "chat"');
    await activateProvider(provider("responses"));
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toContain('wire_api = "responses"');
  });

  it("sets model_provider when Codex only has a provider section", async () => {
    const codexHome = process.env.CODEX_HOME!;
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), [
      "[model_providers.custom]",
      'base_url = "https://old.example/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"), "utf8");

    const { activateProvider } = await import("./codex/config.mjs");
    await activateProvider(provider("responses"));

    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toMatch(/^model_provider = "custom"/m);
  });

  it("refuses to overwrite an invalid Codex auth file", async () => {
    const codexHome = process.env.CODEX_HOME!;
    await mkdir(codexHome, { recursive: true });
    const configPath = join(codexHome, "config.toml");
    const authPath = join(codexHome, "auth.json");
    const originalConfig = 'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://old.example/v1"\n';
    const invalidAuth = "{ invalid json";
    await writeFile(configPath, originalConfig, "utf8");
    await writeFile(authPath, invalidAuth, "utf8");

    const { activateProvider } = await import("./codex/config.mjs");
    await expect(activateProvider(provider("responses"))).rejects.toThrow("Failed to parse");
    await expect(readFile(configPath, "utf8")).resolves.toBe(originalConfig);
    await expect(readFile(authPath, "utf8")).resolves.toBe(invalidAuth);
  });
});
