import { describe, expect, it } from "vitest";
import {
  THINKING_LEVELS,
  getOrderedModelProviders,
  groupModelsByProvider,
  includeCurrentModel,
  isSameModel,
  getModelThinkingLevels,
  normalizeModelThinkingLevel,
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
    expect(THINKING_LEVELS.map((level) => level.id)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
  });

  it("uses only model-specific thinking levels and does not invent missing capabilities", () => {
    const claudeModel = {
      ...models[0],
      supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    };
    expect(getModelThinkingLevels(claudeModel).map((level) => level.id))
      .toEqual(["off", "low", "medium", "high", "xhigh"]);
    expect(normalizeModelThinkingLevel("minimal", claudeModel)).toBe("medium");
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
      { id: "xhigh", label: THINKING_LEVELS[5].label },
      { id: "ultra", label: "ultra" },
    ]);
  });
});
