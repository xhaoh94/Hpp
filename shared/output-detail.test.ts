import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTPUT_DETAIL_LEVEL,
  formatChangedFilesSummary,
  isOutputDetailLevel,
  normalizeOutputDetailLevel,
  OUTPUT_DETAIL_LEVELS,
  shouldListChangedFiles,
} from "./output-detail";

describe("output detail level", () => {
  it("defaults to the fully detailed output", () => {
    expect(DEFAULT_OUTPUT_DETAIL_LEVEL).toBe("detailed");
    expect(normalizeOutputDetailLevel(undefined)).toBe("detailed");
    expect(normalizeOutputDetailLevel(null)).toBe("detailed");
    expect(normalizeOutputDetailLevel("")).toBe("detailed");
    expect(normalizeOutputDetailLevel("verbose")).toBe("detailed");
    expect(normalizeOutputDetailLevel(3)).toBe("detailed");
  });

  it("accepts every supported level and round-trips stored values", () => {
    for (const level of OUTPUT_DETAIL_LEVELS) {
      expect(isOutputDetailLevel(level)).toBe(true);
      expect(normalizeOutputDetailLevel(level)).toBe(level);
    }
    expect(OUTPUT_DETAIL_LEVELS).toEqual(["concise", "standard", "detailed"]);
  });

  it("only lists concrete changed files in detailed mode", () => {
    expect(shouldListChangedFiles("detailed")).toBe(true);
    expect(shouldListChangedFiles("standard")).toBe(false);
    expect(shouldListChangedFiles("concise")).toBe(false);
  });

  it("summarizes changed files without naming them", () => {
    expect(formatChangedFilesSummary(1)).toBe("已修改 1 个文件");
    expect(formatChangedFilesSummary(3)).toBe("已修改 3 个文件");
    expect(formatChangedFilesSummary(3.7)).toBe("已修改 3 个文件");
    expect(formatChangedFilesSummary(0)).toBe("");
    expect(formatChangedFilesSummary(-1)).toBe("");
    expect(formatChangedFilesSummary(Number.NaN)).toBe("");
  });
});
