import { describe, expect, it } from "vitest";
import { combineAgentModels } from "./agent-model-list";

const backendModels = [
  { provider: "factory", id: "official", name: "Official", supportedThinkingLevels: ["low", "high"] },
  { provider: "custom", id: "shared", name: "Backend shared", supportedThinkingLevels: ["off", "medium"] },
];
const configuredModels = [
  { provider: "custom", id: "shared", name: "Configured shared" },
  { provider: "custom", id: "private", name: "Private" },
];

describe("combineAgentModels", () => {
  it("hides backend models when a merge plugin disables them", () => {
    expect(combineAgentModels(backendModels, configuredModels, "merge", false)).toEqual([
      { ...configuredModels[0], supportedThinkingLevels: ["off", "medium"] },
      configuredModels[1],
    ]);
  });

  it("merges backend and configured models with configured values winning", () => {
    expect(combineAgentModels(backendModels, configuredModels, "merge", true)).toEqual([
      backendModels[0],
      { ...configuredModels[0], supportedThinkingLevels: ["off", "medium"] },
      configuredModels[1],
    ]);
  });

  it("preserves configured and backend mode fallback behavior", () => {
    expect(combineAgentModels(backendModels, [], "configured", false)).toEqual(backendModels);
    expect(combineAgentModels(backendModels, configuredModels, "backend", false)).toEqual(backendModels);
  });

  it("enriches a configured model from a unique backend id across provider aliases", () => {
    expect(combineAgentModels(backendModels, [{ provider: "configured", id: "official", name: "Configured" }], "configured"))
      .toEqual([{ provider: "configured", id: "official", name: "Configured", supportedThinkingLevels: ["low", "high"] }]);
  });
});
