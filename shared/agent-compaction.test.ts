import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_COMPACTION_CONFIG,
  normalizeAgentCompactionConfig,
  resolveStoredAgentCompactionConfig,
  setStoredAgentCompactionConfig,
} from "./agent-compaction";

describe("Agent 上下文压缩配置", () => {
  it("默认使用 low 思考等级并启用压缩", () => {
    expect(normalizeAgentCompactionConfig(undefined)).toEqual(DEFAULT_AGENT_COMPACTION_CONFIG);
  });

  it("丢弃所有模型相关字段（旧版的 modelMode / model / customModel）", () => {
    const config = normalizeAgentCompactionConfig({
      thinkingLevel: "off",
      modelMode: "custom",
      model: " tanwan/gpt-5.6-sol ",
      customModel: {
        baseUrl: " https://example.com/v1 ",
        apiKey: " secret ",
        modelId: " fast-model ",
      },
    });

    // 压缩一律走 Agent 自己的模型，配置里不再保存模型选择。
    expect(config).toEqual({ enabled: true, thinkingLevel: "off" });
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

  it("按 Agent 独立保存，并兼容旧的全局配置", () => {
    const legacy = { thinkingLevel: "high" };
    const byAgent = setStoredAgentCompactionConfig({}, "pi", normalizeAgentCompactionConfig({
      thinkingLevel: "low",
      modelMode: "custom",
      model: "tanwan/summary",
    }));

    expect(resolveStoredAgentCompactionConfig("pi", byAgent, legacy)).toEqual({
      enabled: true,
      thinkingLevel: "low",
    });
    expect(resolveStoredAgentCompactionConfig("opencode", byAgent, legacy)).toEqual({
      enabled: true,
      thinkingLevel: "high",
    });
    expect(resolveStoredAgentCompactionConfig("claude", byAgent)).toBeUndefined();
  });
});
