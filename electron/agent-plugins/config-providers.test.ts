import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("official plugin config providers", () => {
  let tempRoot = "";
  const originalEnv = {
    CODEX_HOME: process.env.CODEX_HOME,
    DROID_CONFIG_PATH: process.env.DROID_CONFIG_PATH,
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
    PI_CONFIG_PATH: process.env.PI_CONFIG_PATH,
  };

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "hpp-plugin-config-"));
    process.env.CODEX_HOME = join(tempRoot, "codex");
    process.env.DROID_CONFIG_PATH = join(tempRoot, "droid.json");
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

  it("lets Droid users hide the backend model catalog without core hardcoding", async () => {
    const manifest = JSON.parse(await readFile(
      join(process.cwd(), "electron", "agent-plugins", "droid", "hpp-agent-plugin.json"),
      "utf8",
    ));

    expect(manifest.capabilities.configuration).toMatchObject({
      modelListMode: "merge",
      backendModelVisibility: {
        userConfigurable: true,
        defaultVisible: false,
        label: "显示 Droid 官方模型",
      },
    });
  });

  it("maps Pi endpoints through the plugin adapter", async () => {
    const { getProviderApi, getProviderEndpoint, toProviderConfig } = await import("./pi/config.mjs");
    expect(toProviderConfig(provider("responses"))).toMatchObject({ api: "openai-responses" });
    expect(toProviderConfig(provider("chat-completions"))).toMatchObject({ api: "openai-completions" });
    expect(getProviderApi("anthropic-messages")).toBe("anthropic-messages");
    expect(getProviderApi("google-generative-ai")).toBe("google-generative-ai");
    expect(getProviderEndpoint("azure-openai-responses")).toBe("azure-openai-responses");
  });

  it("maps all Droid endpoint protocols through the plugin adapter", async () => {
    const { getProviderEndpoint, getProviderType } = await import("./droid/config.mjs");
    expect(getProviderType("chat-completions")).toBe("generic-chat-completion-api");
    expect(getProviderType("responses")).toBe("openai");
    expect(getProviderType("anthropic-messages")).toBe("anthropic");
    expect(getProviderEndpoint("generic-chat-completion-api")).toBe("chat-completions");
    expect(getProviderEndpoint("openai")).toBe("responses");
    expect(getProviderEndpoint("anthropic")).toBe("anthropic-messages");
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
          cost: { input: 1, output: 2 },
          variants: { high: { disabled: false } },
        },
      },
    });
  });

  it("refuses to overwrite an invalid OpenCode config", async () => {
    const invalid = "{ invalid jsonc";
    await writeFile(process.env.OPENCODE_CONFIG!, invalid, "utf8");
    const opencode = await import("./opencode/config.mjs");

    await expect(opencode.writeProviderConfig({ providers: [provider("responses")] })).rejects.toThrow("Failed to parse");
    await expect(readFile(process.env.OPENCODE_CONFIG!, "utf8")).resolves.toBe(invalid);
  });

  it("writes plugin-owned Pi and Droid configuration files", async () => {
    const pi = await import("./pi/config.mjs");
    const droid = await import("./droid/config.mjs");
    await pi.writeProviderConfig({ providers: [provider("responses")] });
    await droid.writeProviderConfig({ providers: [provider("anthropic-messages")] });

    const piConfig = JSON.parse(await readFile(process.env.PI_CONFIG_PATH!, "utf8"));
    const droidConfig = JSON.parse(await readFile(process.env.DROID_CONFIG_PATH!, "utf8"));
    expect(piConfig.providers.custom.api).toBe("openai-responses");
    expect(droidConfig.customModels[0].provider).toBe("anthropic");
    await expect(droid.readProviderConfig()).resolves.toMatchObject({
      providers: [{
        providerId: "custom",
        displayName: "Custom",
        endpoint: "anthropic-messages",
      }],
    });
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

  it("preserves unmanaged Droid models and managed advanced fields", async () => {
    await writeFile(process.env.DROID_CONFIG_PATH!, JSON.stringify({
      keepMe: true,
      customModels: [{
        model: "native-model",
        displayName: "Native model",
        provider: "generic-chat-completion-api",
        baseUrl: "https://native.example/v1",
        apiKey: "native-key",
        extraArgs: { temperature: 0.2 },
      }, {
        hppManaged: true,
        hppProviderId: "custom",
        hppProviderDisplayName: "Old name",
        provider: "generic-chat-completion-api",
        model: "model",
        id: "custom:existing-model",
        displayName: "Old model",
        baseUrl: "https://old.example/v1",
        apiKey: "old-key",
        maxOutputTokens: 4096,
        extraArgs: { top_p: 0.9 },
      }],
    }, null, 2), "utf8");
    const droid = await import("./droid/config.mjs");

    await droid.writeProviderConfig({ providers: [provider("responses")] });

    const saved = JSON.parse(await readFile(process.env.DROID_CONFIG_PATH!, "utf8"));
    expect(saved.keepMe).toBe(true);
    expect(saved.customModels[0]).toMatchObject({
      model: "native-model",
      extraArgs: { temperature: 0.2 },
    });
    expect(saved.customModels[1]).toMatchObject({
      hppProviderId: "custom",
      hppProviderDisplayName: "Custom",
      provider: "openai",
      model: "model",
      id: "custom:existing-model",
      maxOutputTokens: 4096,
      extraArgs: { top_p: 0.9 },
    });
    await expect(droid.readProviderConfig()).resolves.toMatchObject({
      providers: [{ providerId: "custom", displayName: "Custom", endpoint: "responses" }],
    });
  });

  it("refuses to overwrite an invalid Droid config", async () => {
    const invalid = "{ invalid json";
    await writeFile(process.env.DROID_CONFIG_PATH!, invalid, "utf8");
    const droid = await import("./droid/config.mjs");

    await expect(droid.writeProviderConfig({ providers: [provider("responses")] })).rejects.toThrow("Failed to parse");
    await expect(readFile(process.env.DROID_CONFIG_PATH!, "utf8")).resolves.toBe(invalid);
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
