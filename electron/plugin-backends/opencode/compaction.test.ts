import { describe, expect, it } from "vitest";
import { buildOpenCodeConfigContent } from "./backend";

function parse(value: string) {
  return JSON.parse(value) as Record<string, any>;
}

describe("OpenCode context compaction config", () => {
  // Hpp 已移除「手填 Base URL/Key」的独立压缩渠道：OpenCode 只能用会话模型，
  // 即使旧配置里还留着渠道引用也不能注入 provider。
  it("ignores a legacy compaction model reference and preserves the user config", () => {
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
      model: "tanwan/summary",
    }, { provider: "tanwan", id: "gpt-5.6-sol" }));

    expect(config.permission).toBe("allow");
    expect(config.provider.existing).toBeDefined();
    expect(config.provider["hpp-compaction"].name).toBe("User provider");
    expect(config.provider["hpp-compaction-2"]).toBeUndefined();
    expect(config.enabled_providers).toEqual(["existing"]);
    // 独立思考等级需要显式指定模型（OpenCode 只对显式 model 应用 variant），
    // 但指定的必须是当前会话模型。
    expect(config.agent.compaction).toMatchObject({
      model: "tanwan/gpt-5.6-sol",
      variant: "max",
      prompt: "keep me",
    });
  });

  it("writes the V2 shape without injecting providers and skips the V1 permission override", () => {
    const source = JSON.stringify({
      provider: {
        existing: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://x/v1" } },
      },
    });

    const config = parse(buildOpenCodeConfigContent(source, {
      thinkingLevel: "high",
      modelMode: "current",
    }, { provider: "openai", id: "gpt-5.4" }, "v2"));

    // 2.x 的权限是 ordered rules，schema 仍在演进：不写权限字段，交给事件层自动批准。
    expect(config.permission).toBeUndefined();
    expect(config.permissions).toBeUndefined();
    // 用户原有的 V1 provider 段在迁移期仍被接受，原样保留。
    expect(config.provider.existing).toBeDefined();
    expect(config.providers).toBeUndefined();
    expect(config.agent.compaction.model).toBe("openai/gpt-5.4");
    expect(config.enabled_providers).toBeUndefined();
  });

  it("pins the selected chat model when an independent current-model level is used", () => {
    const config = parse(buildOpenCodeConfigContent(undefined, {
      thinkingLevel: "low",
      modelMode: "current",
    }, {
      provider: "openai",
      id: "gpt-5.4",
    }));

    expect(config.agent.compaction).toEqual({
      model: "openai/gpt-5.4",
      variant: "low",
    });
    // 不再凭空补一个空的 provider 段。
    expect(config.provider).toBeUndefined();
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
    }, {
      provider: "openai",
      id: "gpt-5.4",
    }));

    expect(config.agent.compaction).toEqual({ prompt: "preserved" });
  });
});
