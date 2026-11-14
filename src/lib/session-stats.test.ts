import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/stores/chat-store";
import {
  formatSessionDuration,
  formatSessionStatsSummary,
  summarizeSessionStats,
} from "./session-stats";

const assistant = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "a1",
  role: "assistant",
  content: "",
  timestamp: 1_000,
  ...overrides,
});

describe("summarizeSessionStats", () => {
  it("统计轮次、工具步数、模型/工具耗时与输出速度", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hi", timestamp: 0 },
      assistant({
        tokenUsage: { input: 1_000, output: 400 },
        process: {
          startedAt: 0,
          endedAt: 10_000,
          entries: [
            { id: "t1", type: "tool", title: "read", timestamp: 1, startedAt: 1_000, completedAt: 3_000 },
            { id: "t2", type: "tool", title: "edit", timestamp: 2, startedAt: 4_000, completedAt: 5_000 },
            { id: "s1", type: "status", title: "思考", timestamp: 3 },
          ],
        },
      }),
      assistant({
        id: "a2",
        tokenUsage: { input: 2_000, output: 600 },
        process: { startedAt: 12_000, endedAt: 20_000, entries: [] },
      }),
    ];

    const stats = summarizeSessionStats(messages);
    expect(stats.turns).toBe(2);
    expect(stats.steps).toBe(2);
    expect(stats.modelMs).toBe(18_000);
    expect(stats.toolMs).toBe(3_000);
    expect(stats.outputTokens).toBe(1_000);
    expect(stats.tokensPerSecond).toBe(56);
  });

  it("运行中的回合按当前时间算已用时长", () => {
    const stats = summarizeSessionStats([
      assistant({ isStreaming: true, process: { startedAt: 1_000, entries: [] } }),
    ], 31_000);
    expect(stats.modelMs).toBe(30_000);
  });

  it("没有数据时各项为 0，且不给输出速度", () => {
    const stats = summarizeSessionStats([{ id: "u", role: "user", content: "hi", timestamp: 0 }]);
    expect(stats).toMatchObject({ turns: 0, steps: 0, modelMs: 0, toolMs: 0, outputTokens: 0 });
    expect(stats.tokensPerSecond).toBeUndefined();
    expect(formatSessionStatsSummary(stats)).toBe("");
  });

  it("只有轮次没有耗时时不编造速度", () => {
    const stats = summarizeSessionStats([assistant({ tokenUsage: { input: 10, output: 20 } })]);
    expect(stats.turns).toBe(1);
    expect(stats.tokensPerSecond).toBeUndefined();
    expect(formatSessionStatsSummary(stats)).toBe("1 轮");
  });
});

describe("格式化", () => {
  it("时长按分/小时收敛", () => {
    expect(formatSessionDuration(0)).toBe("0秒");
    expect(formatSessionDuration(400)).toBe("1秒");
    expect(formatSessionDuration(43_000)).toBe("43秒");
    expect(formatSessionDuration(17 * 60_000 + 27_000)).toBe("17分27秒");
    expect(formatSessionDuration(60 * 60_000 + 2 * 60_000)).toBe("1小时2分");
  });

  it("摘要拼轮次/步数/速度", () => {
    expect(formatSessionStatsSummary({ turns: 4, steps: 147, modelMs: 1, toolMs: 0, outputTokens: 1, tokensPerSecond: 193 }))
      .toBe("4 轮 147 步 · 193 token/s");
    expect(formatSessionStatsSummary({ turns: 1, steps: 0, modelMs: 0, toolMs: 0, outputTokens: 0 }))
      .toBe("1 轮");
  });
});
