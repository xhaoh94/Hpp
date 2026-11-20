import { describe, expect, it } from "vitest";
import {
  CONTEXT_THRESHOLD_MAX,
  CONTEXT_THRESHOLD_MIN,
  DEFAULT_CONTEXT_COMPACTION_THRESHOLD,
  isContextThresholdReached,
  normalizeContextCompactionThreshold,
} from "./context-compaction-threshold";

describe("normalizeContextCompactionThreshold", () => {
  it("clamps into the allowed range", () => {
    expect(normalizeContextCompactionThreshold(5)).toBe(CONTEXT_THRESHOLD_MIN);
    expect(normalizeContextCompactionThreshold(99)).toBe(CONTEXT_THRESHOLD_MAX);
  });

  it("rounds and still accepts the legacy {percent} shape", () => {
    expect(normalizeContextCompactionThreshold(72.6)).toBe(73);
    expect(normalizeContextCompactionThreshold({ percent: 60 })).toBe(60);
  });

  it("falls back to the default for junk", () => {
    expect(normalizeContextCompactionThreshold(undefined)).toBe(DEFAULT_CONTEXT_COMPACTION_THRESHOLD);
    expect(normalizeContextCompactionThreshold("80")).toBe(DEFAULT_CONTEXT_COMPACTION_THRESHOLD);
    expect(normalizeContextCompactionThreshold(Number.NaN)).toBe(DEFAULT_CONTEXT_COMPACTION_THRESHOLD);
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
});
