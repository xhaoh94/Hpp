import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync(new URL("./worker.mjs", import.meta.url), "utf8");

/**
 * 智能压缩现在由主进程统一触发（见 electron/agents/context-compaction-controller.ts），
 * pi 侧不再改写 reserveTokens，也不接收阈值参数。
 *
 * 保留这些反向断言，防止有人把「改各家配置」的方案又加回来：
 * 那套方案只有 pi 能精确映射，且 claude/codex/opencode 改完必须重开会话。
 */
describe("pi 智能压缩", () => {
  it("不再注入 reserveTokens / 不再代理 SettingsManager", () => {
    expect(worker).not.toContain("overrideCompactionThreshold");
    expect(worker).not.toContain("resolveCompactionReserveTokens");
    expect(worker).not.toContain("getCompactionSettings");
  });

  it("不再接收 setCompactionThreshold 命令", () => {
    expect(worker).not.toContain('case "setCompactionThreshold"');
    expect(worker).not.toContain("compactionThreshold");
  });
});
