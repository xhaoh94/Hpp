import { describe, expect, it } from "vitest";
import { buildOpenCodeConfigContent } from "./backend";

function parse(value: string) {
  return JSON.parse(value) as Record<string, any>;
}

describe("OpenCode context compaction config", () => {
  it("injects an isolated Responses model and preserves the user config", () => {
    const source = `{
      // Hpp must preserve JSONC input and unrelated providers.
      "enabled_providers": ["existing"],
      "provider": {
        "existing": { "npm": "@ai-sdk/openai-compatible", "models": {} },
        "hpp-compaction": { "name": "User provider", "models": {} },
      },
      "agent": {
        "compaction": { "model": "old/model", "variant": "high", "prompt": "keep me" },
      },
    }`;

    const config = parse(buildOpenCodeConfigContent(source, {
      thinkingLevel: "xhigh",
      modelMode: "custom",
      customModel: {
        baseUrl: "https://api.example.com/v1",
        apiKey: "secret",
        modelId: "compact/model",
        api: "openai-responses",
        reasoning: true,
      },
    }));

    expect(config.permission).toBe("allow");
    expect(config.provider.existing).toBeDefined();
    expect(config.provider["hpp-compaction"].name).toBe("User provider");
    expect(config.provider["hpp-compaction-2"]).toMatchObject({
      npm: "@ai-sdk/openai",
      name: "Hpp 上下文压缩",
      options: {
        baseURL: "https://api.example.com/v1",
        apiKey: "secret",
      },
      models: {
        "compact/model": {
          reasoning: true,
          attachment: false,
        },
      },
    });
    expect(config.agent.compaction).toMatchObject({
      model: "hpp-compaction-2/compact/model",
      variant: "max",
      prompt: "keep me",
    });
    expect(config.enabled_providers).toEqual(["existing", "hpp-compaction-2"]);
  });

  it("pins the selected chat model when an independent current-model level is used", () => {
    const config = parse(buildOpenCodeConfigContent(undefined, {
      thinkingLevel: "low",
      modelMode: "current",
      customModel: {},
    }, {
      provider: "openai",
      id: "gpt-5.4",
    }));

    expect(config.agent.compaction).toEqual({
      model: "openai/gpt-5.4",
      variant: "low",
    });
    expect(config.provider).toEqual({});
  });

  it("removes a previously configured model and variant when following chat settings", () => {
    const config = parse(buildOpenCodeConfigContent(JSON.stringify({
      agent: {
        compaction: {
          model: "old/model",
          variant: "high",
          prompt: "preserved",
        },
      },
    }), {
      thinkingLevel: "inherit",
      modelMode: "current",
      customModel: {},
    }, {
      provider: "openai",
      id: "gpt-5.4",
    }));

    expect(config.agent.compaction).toEqual({ prompt: "preserved" });
  });
});
