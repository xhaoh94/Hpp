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

  it("uses model-specific thinking levels without changing legacy defaults", () => {
    const claudeModel = {
      ...models[0],
      supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    };
    expect(getModelThinkingLevels(claudeModel).map((level) => level.id))
      .toEqual(["off", "low", "medium", "high", "xhigh"]);
    expect(normalizeModelThinkingLevel("minimal", claudeModel)).toBe("medium");
    expect(getModelThinkingLevels(models[0]).map((level) => level.id))
      .toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
  });
});
