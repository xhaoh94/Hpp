import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./useSessionModels.ts", import.meta.url), "utf8");

describe("useSessionModels thinking synchronization", () => {
  it("lets the ordered model-switch command reconcile thinking instead of racing it", () => {
    expect(source).toContain("SessionCommandCoordinator.setModel");
    expect(source).not.toContain("SessionCommandCoordinator.setThinking");
    expect(source).not.toContain("getSessionThinkingOrDefault");
  });
});
