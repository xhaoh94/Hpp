import { describe, expect, it } from "vitest";
import {
  CONTEXT_THRESHOLD_MAX,
  CONTEXT_THRESHOLD_MIN,
  DEFAULT_CONTEXT_COMPACTION_THRESHOLD,
  contextCompactionThresholdKey,
  isContextThresholdReached,
  normalizeContextCompactionThreshold,
  normalizeContextCompactionThresholdMap,
  resolveContextCompactionThreshold,
} from "./context-compaction-threshold";

describe("normalizeContextCompactionThreshold", () => {
  it("clamps into the allowed range", () => {
    expect(normalizeContextCompactionThreshold(5)).toBe(CONTEXT_THRESHOLD_MIN);
    expect(normalizeContextCompactionThreshold(150)).toBe(CONTEXT_THRESHOLD_MAX);
    // 上限是 100%，这样用户能把“不按阈值自动压缩”存下来。
    expect(CONTEXT_THRESHOLD_MAX).toBe(100);
    expect(normalizeContextCompactionThreshold(100)).toBe(100);
  });

  it("rounds numeric values", () => {
    expect(normalizeContextCompactionThreshold(72.6)).toBe(73);
  });

  it("falls back to the default for junk", () => {
    expect(normalizeContextCompactionThreshold(undefined)).toBe(DEFAULT_CONTEXT_COMPACTION_THRESHOLD);
    expect(normalizeContextCompactionThreshold("80")).toBe(DEFAULT_CONTEXT_COMPACTION_THRESHOLD);
    expect(normalizeContextCompactionThreshold({ percent: 60 })).toBe(DEFAULT_CONTEXT_COMPACTION_THRESHOLD);
    expect(normalizeContextCompactionThreshold(Number.NaN)).toBe(DEFAULT_CONTEXT_COMPACTION_THRESHOLD);
  });
});

describe("per model threshold map", () => {
  it("keys thresholds by channel (provider) and model id", () => {
    expect(contextCompactionThresholdKey({ provider: "relay", id: "gpt-5.1" })).toBe("relay:gpt-5.1");
    // 没有作用域的阈值不能写，否则会退化成全局设置。
    expect(contextCompactionThresholdKey({ provider: "", id: "gpt-5.1" })).toBeNull();
    expect(contextCompactionThresholdKey({ provider: "relay", id: "  " })).toBeNull();
    expect(contextCompactionThresholdKey(null)).toBeNull();
  });

  it("drops junk entries and clamps valid ones", () => {
    const map = normalizeContextCompactionThresholdMap({
      "relay:gpt-5.1": 72.6,
      "relay:claude": 1,
      "no-provider-key": 80,
      "relay:bad": "80",
      // 两段有一端为空：永远匹配不到模型，直接丢掉。
      ":gpt-5": 60,
      "relay:": 60,
    });
    expect(map).toEqual({ "relay:gpt-5.1": 73, "relay:claude": CONTEXT_THRESHOLD_MIN });
  });

  it("resolves only the model entry, otherwise the default", () => {
    const thresholds = { "relay:gpt-5.1": 60 };
    expect(resolveContextCompactionThreshold(thresholds, { provider: "relay", id: "gpt-5.1" })).toBe(60);
    // 没配置过的模型直接回默认 100%，不再读取任何全局兜底值。
    expect(resolveContextCompactionThreshold(thresholds, { provider: "relay", id: "other" }))
      .toBe(DEFAULT_CONTEXT_COMPACTION_THRESHOLD);
    expect(resolveContextCompactionThreshold(thresholds, null)).toBe(DEFAULT_CONTEXT_COMPACTION_THRESHOLD);
  });
});

describe("isContextThresholdReached", () => {
  it("fires at and above the threshold", () => {
    expect(isContextThresholdReached(0.8, 80)).toBe(true);
    expect(isContextThresholdReached(0.95, 80)).toBe(true);
  });

  it("does not fire below the threshold", () => {
    expect(isContextThresholdReached(0.79, 80)).toBe(false);
  });

  it("tolerates floating point division right at the boundary", () => {
    // 真实用量是 640000/800000，除法可能给出 0.7999999999999999。
    expect(isContextThresholdReached(639999.9999999999 / 800000, 80)).toBe(true);
  });

  it("rejects invalid ratios", () => {
    expect(isContextThresholdReached(Number.NaN, 80)).toBe(false);
    expect(isContextThresholdReached(-0.1, 80)).toBe(false);
  });

  it("treats 100% as never firing before the window is actually full", () => {
    expect(isContextThresholdReached(0.99, 100)).toBe(false);
    expect(isContextThresholdReached(1, 100)).toBe(true);
  });
});
