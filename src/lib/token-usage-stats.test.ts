import { describe, expect, it } from "vitest";
import {
  formatTokenCacheRate,
  getTokenCacheRate,
  summarizeTokenUsage,
  UNKNOWN_TOKEN_CHANNEL,
  UNKNOWN_TOKEN_MODEL,
} from "./token-usage-stats";

describe("token usage stats", () => {
  it("sums input, output and cached input across assistant turns", () => {
    const summary = summarizeTokenUsage([
      {
        role: "assistant",
        modelProvider: "openai",
        modelId: "gpt-5",
        modelLabel: "GPT-5",
        tokenUsage: { input: 1000, output: 100, cacheInput: 400 },
      },
      {
        role: "assistant",
        modelProvider: "openai",
        modelId: "gpt-5",
        modelLabel: "GPT-5",
        tokenUsage: { input: 500, output: 50, cacheInput: 100 },
      },
      { role: "user", tokenUsage: { input: 9999, output: 9999 } },
    ]);

    expect(summary.messageCount).toBe(2);
    expect(summary.totals).toEqual({
      input: 1500,
      output: 150,
      cachedInput: 500,
      total: 1650,
    });
    expect(getTokenCacheRate(summary.totals)).toBeCloseTo(1 / 3);
    expect(formatTokenCacheRate(getTokenCacheRate(summary.totals))).toBe("33.3%");
  });

  it("groups by channel and by channel + model id", () => {
    const summary = summarizeTokenUsage([
      {
        role: "assistant",
        modelProvider: "channel-a",
        modelId: "model-x",
        tokenUsage: { input: 100, output: 10, cacheInput: 20 },
      },
      {
        role: "assistant",
        modelProvider: "channel-a",
        modelId: "model-x",
        tokenUsage: { input: 50, output: 5, cacheInput: 10 },
      },
      {
        role: "assistant",
        modelProvider: "channel-a",
        modelId: "model-y",
        tokenUsage: { input: 300, output: 30, cacheInput: 0 },
      },
      {
        role: "assistant",
        modelProvider: "channel-b",
        modelId: "model-x",
        tokenUsage: { input: 900, output: 90, cacheInput: 450 },
      },
    ]);

    expect(summary.byChannel.map((group) => group.name)).toEqual(["channel-b", "channel-a"]);
    expect(summary.byChannel.find((group) => group.name === "channel-a")).toMatchObject({
      input: 450,
      output: 45,
      cachedInput: 30,
      messageCount: 3,
    });
    // 同名模型跨渠道不能合并：model-x 在 channel-a / channel-b 各一行。
    expect(summary.byModel).toHaveLength(3);
    expect(summary.byModel.map((group) => `${group.detail}/${group.name}`)).toEqual([
      "channel-b/model-x",
      "channel-a/model-y",
      "channel-a/model-x",
    ]);
    expect(summary.byModel.find((group) => group.detail === "channel-b")).toMatchObject({
      input: 900,
      cachedInput: 450,
    });
  });

  it("falls back to the model label for legacy messages without provider or model id", () => {
    const summary = summarizeTokenUsage([
      {
        role: "assistant",
        modelLabel: "Claude Sonnet",
        tokenUsage: { input: 200, output: 20, cacheInput: 50 },
      },
    ]);

    expect(summary.byChannel).toEqual([
      expect.objectContaining({ name: UNKNOWN_TOKEN_CHANNEL, input: 200 }),
    ]);
    expect(summary.byModel).toEqual([
      expect.objectContaining({
        name: "Claude Sonnet",
        detail: undefined,
        inferred: true,
        input: 200,
      }),
    ]);
    expect(UNKNOWN_TOKEN_MODEL).toBe("未记录模型");
  });

  it("returns an empty summary without token usage", () => {
    const summary = summarizeTokenUsage([
      { role: "assistant" },
      { role: "assistant", tokenUsage: { input: 0, output: 0 } },
    ]);

    expect(summary.totals).toEqual({ input: 0, output: 0, cachedInput: 0, total: 0 });
    expect(summary.messageCount).toBe(0);
    expect(summary.byChannel).toEqual([]);
    expect(summary.byModel).toEqual([]);
    expect(getTokenCacheRate(summary.totals)).toBeUndefined();
    expect(formatTokenCacheRate(undefined)).toBe("—");
  });

  it("clamps cached input to the reported input total", () => {
    const summary = summarizeTokenUsage([
      {
        role: "assistant",
        modelProvider: "channel",
        modelId: "model",
        tokenUsage: { input: 100, output: 10, cacheInput: 300 },
      },
    ]);
    expect(summary.totals.cachedInput).toBe(100);
    expect(getTokenCacheRate(summary.totals)).toBe(1);
  });
});
