import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./useAutoCompaction.ts", import.meta.url), "utf8");
const modal = readFileSync(new URL("./ContextUsageModal.tsx", import.meta.url), "utf8");

/**
 * 智能压缩（单阈值）的几条硬约束：
 * - 只在 idle 执行（后端 compact 要求 agent 空闲，回合中调用必失败）
 * - 压缩中不重复触发
 * - 用量回落到阈值以下才重新解锁，避免压缩后仍高于阈值时反复压缩
 */
describe("智能压缩自动触发", () => {
  it("only compacts when the session is idle and not already compacting", () => {
    expect(source).toContain('status !== "idle"');
    expect(source).toContain("compacting");
  });

  it("re-arms after a failed compaction instead of retrying in a loop", () => {
    expect(source).toContain("watchRef.current.armed = true");
  });

  it("uses one persisted threshold rather than a tier list", () => {
    expect(source).toContain("loadContextCompactionThreshold()");
    expect(source).toContain("isContextThresholdReached(");
    expect(source).not.toContain("Tiers");
  });

  it("unlocks only after usage falls back below the threshold", () => {
    expect(source).toContain("state.above = false");
    expect(source).toContain("state.above = true");
  });

  it("picks up threshold changes without reopening the session", () => {
    expect(source).toContain("GENERAL_SETTINGS_UPDATED_EVENT");
  });

  it("exposes a single draggable threshold marker on the context bar", () => {
    expect(modal).toContain("context-threshold-handle");
    expect(modal).toContain("setPointerCapture");
    expect(modal).toContain("percentFromPointer");
    expect(modal).toContain("saveContextCompactionThreshold");
    expect(modal).not.toContain("context-tier-chip");
  });
});
