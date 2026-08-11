import { describe, expect, it } from "vitest";
import {
  THINKING_LEVELS,
  getOrderedModelProviders,
  groupModelsByProvider,
  includeCurrentModel,
  isSameModel,
  getModelThinkingLevels,
  normalizeModelThinkingLevel,
  getEffectiveThinkingLevelMode,
  getThinkingToggleLevel,
  isModelThinkingLevelSelectable,
} from "./models";

const models = [
  { id: "a", name: "A", provider: "one", reasoning: true },
  { id: "b", name: "B", provider: "two", reasoning: true },
  { id: "c", name: "C", provider: "one", reasoning: false },
];

describe("shared model rules", () => {
  it("compares and groups provider-qualified model ids", () => {
    expect(isSameModel(models[0], { id: "a", provider: "one" })).toBe(true);
    expect(groupModelsByProvider(models).get("one")?.map((model) => model.id)).toEqual(["a", "c"]);
  });

  it("honors provider order and includes a missing current model", () => {
    expect(getOrderedModelProviders(models, ["two", "one"])).toEqual(["two", "one"]);
    expect(includeCurrentModel(models, { id: "d", name: "D", provider: "three", reasoning: true })[0].id).toBe("d");
  });

  it("keeps one canonical thinking-level catalog", () => {
    expect(THINKING_LEVELS.map((level) => level.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("uses only model-specific thinking levels and does not invent missing capabilities", () => {
    const claudeModel = {
      ...models[0],
      supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    };
    expect(getModelThinkingLevels(claudeModel).map((level) => level.id))
      .toEqual(["off", "low", "medium", "high", "xhigh"]);
    expect(normalizeModelThinkingLevel("minimal", claudeModel)).toBe("medium");
    expect(normalizeModelThinkingLevel("off", { ...models[0], supportedThinkingLevels: ["high"] })).toBe("off");
    expect(getModelThinkingLevels(models[0])).toEqual([]);
  });

  it("preserves native order, normalizes protocol aliases, and keeps future levels", () => {
    const model = {
      ...models[0],
      supportedThinkingLevels: ["none", "low", "max", "ultra", "low"],
    };
    expect(getModelThinkingLevels(model)).toEqual([
      { id: "off", label: THINKING_LEVELS[0].label },
      { id: "low", label: THINKING_LEVELS[2].label },
      { id: "max", label: THINKING_LEVELS[6].label },
      { id: "ultra", label: THINKING_LEVELS[7].label },
    ]);
    expect(normalizeModelThinkingLevel("none", model)).toBe("off");
    expect(normalizeModelThinkingLevel("max", model)).toBe("max");
  });

  it("derives effective thinking level mode from backend mode or supported levels", () => {
    // 非 reasoning 模型 → undefined
    expect(getEffectiveThinkingLevelMode({ ...models[0], reasoning: false })).toBeUndefined();
    // 后端已设 thinkingLevelMode → 直接使用
    expect(getEffectiveThinkingLevelMode({ ...models[0], thinkingLevelMode: "levels" })).toBe("levels");
    expect(getEffectiveThinkingLevelMode({ ...models[0], thinkingLevelMode: "toggle" })).toBe("toggle");
    // 非 pi 后端未产出 mode：按自定义等级数量推导
    // 0 档 → toggle（思考开关）
    expect(getEffectiveThinkingLevelMode(models[0])).toBe("toggle");
    // 1 档 → toggle
    expect(getEffectiveThinkingLevelMode({ ...models[0], supportedThinkingLevels: ["medium"] })).toBe("toggle");
    // >1 档 → levels
    expect(getEffectiveThinkingLevelMode({
      ...models[0],
      supportedThinkingLevels: ["low", "medium", "high"],
    })).toBe("levels");
    // off 不计入有效档位：off+medium → toggle
    expect(getEffectiveThinkingLevelMode({
      ...models[0],
      supportedThinkingLevels: ["off", "medium"],
    })).toBe("toggle");
    // null/undefined → undefined
    expect(getEffectiveThinkingLevelMode(null)).toBeUndefined();
    expect(getEffectiveThinkingLevelMode(undefined)).toBeUndefined();
  });

  it("selects the correct enabled level for a thinking toggle", () => {
    expect(getThinkingToggleLevel({ supportedThinkingLevels: ["high"] })).toBe("high");
    expect(getThinkingToggleLevel({ supportedThinkingLevels: ["off", "minimal", "low", "medium", "high"] })).toBe("medium");
    expect(getThinkingToggleLevel({ supportedThinkingLevels: [] })).toBe("medium");
    expect(getThinkingToggleLevel(null)).toBe("medium");
  });

  it("validates toggle values even when off/default are not declared levels", () => {
    const singleLevel = { ...models[0], supportedThinkingLevels: ["high"] };
    expect(isModelThinkingLevelSelectable(singleLevel, "high")).toBe(true);
    expect(isModelThinkingLevelSelectable(singleLevel, "off")).toBe(true);
    expect(isModelThinkingLevelSelectable(singleLevel, "medium")).toBe(false);
    expect(isModelThinkingLevelSelectable(models[0], "medium")).toBe(true);
    expect(isModelThinkingLevelSelectable(models[0], "off")).toBe(true);
    expect(isModelThinkingLevelSelectable({ ...models[0], reasoning: false }, "off")).toBe(false);
  });
});
