import { describe, expect, it } from "vitest";
import {
  isHighRiskAgentPermissionRequest,
  normalizeAgentPermissionMode,
} from "./agent-permissions";

describe("agent permission policy", () => {
  it("defaults invalid and missing settings to automatic permissions", () => {
    expect(normalizeAgentPermissionMode(undefined)).toBe("auto");
    expect(normalizeAgentPermissionMode("plan")).toBe("auto");
    expect(normalizeAgentPermissionMode("ask")).toBe("ask");
    expect(normalizeAgentPermissionMode("full-access")).toBe("full-access");
  });

  it("only classifies known project-local reads as low risk", () => {
    expect(isHighRiskAgentPermissionRequest("read", ["src/App.tsx"])).toBe(false);
    expect(isHighRiskAgentPermissionRequest("edit", ["src/App.tsx"])).toBe(true);
    expect(isHighRiskAgentPermissionRequest("read", ["../secret.txt"])).toBe(true);
    expect(isHighRiskAgentPermissionRequest("unknown", [])).toBe(true);
  });
});
