import { describe, expect, it } from "vitest";
import { combineAgentModels } from "./agent-model-list";

const backendModels = [
  { provider: "factory", id: "official", name: "Official" },
  { provider: "custom", id: "shared", name: "Backend shared" },
];
const configuredModels = [
  { provider: "custom", id: "shared", name: "Configured shared" },
  { provider: "custom", id: "private", name: "Private" },
];

describe("combineAgentModels", () => {
  it("hides backend models when a merge plugin disables them", () => {
    expect(combineAgentModels(backendModels, configuredModels, "merge", false)).toEqual(configuredModels);
  });

  it("merges backend and configured models with configured values winning", () => {
    expect(combineAgentModels(backendModels, configuredModels, "merge", true)).toEqual([
      backendModels[0],
      configuredModels[0],
      configuredModels[1],
    ]);
  });

  it("preserves configured and backend mode fallback behavior", () => {
    expect(combineAgentModels(backendModels, [], "configured", false)).toEqual(backendModels);
    expect(combineAgentModels(backendModels, configuredModels, "backend", false)).toEqual(backendModels);
  });
});
