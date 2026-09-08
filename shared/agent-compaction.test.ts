import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_COMPACTION_CONFIG,
  isCustomAgentCompactionModelConfigured,
  normalizeAgentCompactionConfig,
  parseAgentCompactionModelRef,
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
      enabled: true,
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

  it("enabled 缺省视为启用，仅显式 false 表示关闭", () => {
    // 存量配置没有 enabled 字段，升级后必须保持启用，不能误伤老用户。
    expect(normalizeAgentCompactionConfig(undefined).enabled).toBe(true);
    expect(normalizeAgentCompactionConfig({ thinkingLevel: "low" }).enabled).toBe(true);
    expect(normalizeAgentCompactionConfig({ enabled: true }).enabled).toBe(true);
    expect(normalizeAgentCompactionConfig({ enabled: false }).enabled).toBe(false);
    // 非布尔脏数据不按关闭处理。
    expect(normalizeAgentCompactionConfig({ enabled: 0 }).enabled).toBe(true);
    expect(normalizeAgentCompactionConfig({ enabled: "false" }).enabled).toBe(true);
  });

  it("自定义模型缺少 Base URL 或模型 ID 时视为未配置完成", () => {
    const config = normalizeAgentCompactionConfig({
      modelMode: "custom",
      customModel: { baseUrl: "https://example.com/v1" },
    });

    expect(isCustomAgentCompactionModelConfigured(config)).toBe(false);
  });

  it("渠道模型引用只在自定义模式下保留，且能拆出 provider/modelId", () => {
    const config = normalizeAgentCompactionConfig({
      modelMode: "custom",
      model: " tanwan/gpt-5.6-sol ",
    });
    expect(config.model).toBe("tanwan/gpt-5.6-sol");
    expect(parseAgentCompactionModelRef(config.model)).toEqual({
      provider: "tanwan",
      modelId: "gpt-5.6-sol",
    });
    expect(isCustomAgentCompactionModelConfigured(config)).toBe(true);

    // 非自定义模式：不保留引用（避免与主 Agent 模型语义混淆）。
    expect(normalizeAgentCompactionConfig({ model: "tanwan/gpt-5.6-sol" }).model).toBeUndefined();
    // 残缺引用不视为已配置。
    expect(isCustomAgentCompactionModelConfigured(normalizeAgentCompactionConfig({
      modelMode: "custom",
      model: "no-separator",
    }))).toBe(false);
    expect(parseAgentCompactionModelRef("tanwan/")).toBeUndefined();
    expect(parseAgentCompactionModelRef("/gpt-5.6-sol")).toBeUndefined();
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
