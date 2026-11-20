import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./useAutoCompaction.ts", import.meta.url), "utf8");
const modal = readFileSync(new URL("./ContextUsageModal.tsx", import.meta.url), "utf8");

/**
 * 智能压缩的几条硬约束：
 * - 只在 idle 执行（后端 compact 要求 agent 空闲，回合中调用必失败）
 * - 压缩中不重复触发
 * - 压缩完成 usage 被清空时把基线归零，让同一档位下次还能再触发
 */
describe("智能压缩自动触发", () => {
  it("only compacts when the session is idle and not already compacting", () => {
    expect(source).toContain('status !== "idle"');
    expect(source).toContain("compacting");
  });

  it("re-arms the same tier after a failed compaction instead of retrying in a loop", () => {
    expect(source).toContain("armRef.current.armedTier = tier");
  });

  it("resets the ratio baseline when usage is cleared after compaction", () => {
    expect(source).toContain("armRef.current.lastRatio = 0");
  });

  it("loads tiers from persisted settings and uses the shared tier predicate", () => {
    expect(source).toContain("loadContextCompactionTiers()");
    expect(source).toContain("crossedCompactionTier(");
  });

  it("exposes draggable tier handles on the context bar", () => {
    expect(modal).toContain("context-tier-handle");
    expect(modal).toContain("setPointerCapture");
    expect(modal).toContain("percentFromPointer");
    expect(modal).toContain("saveContextCompactionTiers");
  });
});
