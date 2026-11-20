import { describe, expect, it } from "vitest";
import {
  CONTEXT_TIER_MAX,
  CONTEXT_TIER_MIN,
  crossedCompactionTier,
  normalizeContextCompactionTiers,
} from "./context-compaction-tiers";

describe("normalizeContextCompactionTiers", () => {
  it("clamps, dedupes and sorts tiers", () => {
    expect(normalizeContextCompactionTiers([90, 50, 50, 5, 99, 70]))
      .toEqual([CONTEXT_TIER_MIN, 50, 70, 90, CONTEXT_TIER_MAX]);
  });

  it("accepts {percent} objects from legacy config", () => {
    expect(normalizeContextCompactionTiers([{ percent: 60 }, { percent: 80 }])).toEqual([60, 80]);
  });

  it("drops non-numeric values and returns empty for junk", () => {
    expect(normalizeContextCompactionTiers(["70", null, undefined, {}])).toEqual([]);
    expect(normalizeContextCompactionTiers(null)).toEqual([]);
  });

  it("caps at the tier limit", () => {
    const result = normalizeContextCompactionTiers([10, 20, 30, 40, 50, 60, 70]);
    expect(result).toHaveLength(5);
    expect(result).toEqual([10, 20, 30, 40, 50]);
  });

  it("keeps an intentionally empty list empty", () => {
    expect(normalizeContextCompactionTiers([])).toEqual([]);
  });
});

describe("crossedCompactionTier", () => {
  it("fires when usage rises past a tier", () => {
    expect(crossedCompactionTier(0.71, 0.68, [50, 70, 90])).toBe(70);
  });

  it("returns the highest crossed tier when several are crossed", () => {
    expect(crossedCompactionTier(0.92, 0.4, [50, 70, 90])).toBe(90);
  });

  it("does not fire when usage only rises within a tier band", () => {
    expect(crossedCompactionTier(0.68, 0.62, [50, 70, 90])).toBeNull();
  });

  it("does not fire when usage falls", () => {
    expect(crossedCompactionTier(0.6, 0.75, [50, 70, 90])).toBeNull();
  });

  it("can fire again after usage drops below the tier (repeatable)", () => {
    // 压缩后用量回落到 0.6，再次涨到 0.72 —— 同一档位应再次触发。
    expect(crossedCompactionTier(0.6, 0.72, [70])).toBeNull();
    expect(crossedCompactionTier(0.72, 0.6, [70])).toBe(70);
  });

  it("rejects invalid ratios", () => {
    expect(crossedCompactionTier(Number.NaN, 0.5, [70])).toBeNull();
    expect(crossedCompactionTier(2, 0.5, [70])).toBeNull();
  });
});
