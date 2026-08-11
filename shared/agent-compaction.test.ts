import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_COMPACTION_CONFIG,
  isCustomAgentCompactionModelConfigured,
  normalizeAgentCompactionConfig,
  resolveStoredAgentCompactionConfig,
  setStoredAgentCompactionConfig,
} from "./agent-compaction";

describe("Agent 上下文压缩配置", () => {
  it("默认使用当前模型和 low 思考等级", () => {
    expect(normalizeAgentCompactionConfig(undefined)).toEqual(DEFAULT_AGENT_COMPACTION_CONFIG);
  });

  it("归一化自定义 OpenAI 兼容模型配置", () => {
    const config = normalizeAgentCompactionConfig({
      thinkingLevel: "off",
      modelMode: "custom",
      customModel: {
        baseUrl: " https://example.com/v1 ",
        apiKey: " secret ",
        modelId: " fast-model ",
        api: "openai-responses",
        reasoning: true,
      },
    });

    expect(config).toEqual({
      thinkingLevel: "off",
      modelMode: "custom",
      customModel: {
        baseUrl: "https://example.com/v1",
        apiKey: "secret",
        modelId: "fast-model",
        api: "openai-responses",
        reasoning: true,
      },
    });
    expect(isCustomAgentCompactionModelConfigured(config)).toBe(true);
  });

  it("自定义模型缺少 Base URL 或模型 ID 时视为未配置完成", () => {
    const config = normalizeAgentCompactionConfig({
      modelMode: "custom",
      customModel: { baseUrl: "https://example.com/v1" },
    });

    expect(isCustomAgentCompactionModelConfigured(config)).toBe(false);
  });

  it("按 Agent 独立保存，并兼容旧的全局配置", () => {
    const legacy = { thinkingLevel: "high" };
    const byAgent = setStoredAgentCompactionConfig({}, "pi", normalizeAgentCompactionConfig({
      thinkingLevel: "low",
      modelMode: "custom",
      customModel: { baseUrl: "https://pi.example/v1", modelId: "summary" },
    }));

    expect(resolveStoredAgentCompactionConfig("pi", byAgent, legacy)).toMatchObject({
      thinkingLevel: "low",
      modelMode: "custom",
    });
    expect(resolveStoredAgentCompactionConfig("opencode", byAgent, legacy)).toMatchObject({
      thinkingLevel: "high",
      modelMode: "current",
    });
    expect(resolveStoredAgentCompactionConfig("claude", byAgent)).toBeUndefined();
  });
});
