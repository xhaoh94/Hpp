import { describe, expect, it } from "vitest";
import {
  createAgentConfigExportData,
  isValidAgentConfigExport,
  resolveImportProviderId,
  sanitizeAgentConfigExport,
} from "./agent-config-io";
import type { AgentProviderConfig } from "../src/types";

const provider = (overrides: Partial<AgentProviderConfig> = {}): AgentProviderConfig => ({
  providerId: "chan-x",
  displayName: "渠道 X",
  baseUrl: "https://x.example.com/v1",
  apiKey: "sk-secret",
  authMode: "bearer",
  endpoint: "chat-completions",
  models: [{ id: "m1", name: "M1", reasoning: true, imageInput: false }],
  ...overrides,
});

describe("agent config export/import format", () => {
  it("builds a valid versioned export payload", () => {
    const data = createAgentConfigExportData(
      { pi: { activeProviderId: "chan-x", providers: [provider()] } },
      true,
    );
    expect(isValidAgentConfigExport(data)).toBe(true);
    expect(data.type).toBe("hpp-agent-config-export");
    expect(data.includeApiKeys).toBe(true);
  });

  it("rejects non-matching payloads", () => {
    expect(isValidAgentConfigExport(null)).toBe(false);
    expect(isValidAgentConfigExport({ type: "other", version: 1, agents: {} })).toBe(false);
    expect(isValidAgentConfigExport({ type: "hpp-agent-config-export", version: 99, agents: {} })).toBe(false);
  });

  it("sanitizes api keys when includeApiKeys is false", () => {
    const data = createAgentConfigExportData(
      { pi: { providers: [provider()] } },
      false,
    );
    const sanitized = sanitizeAgentConfigExport(data, false);
    expect(isValidAgentConfigExport(sanitized)).toBe(true);
    expect(sanitized.includeApiKeys).toBe(false);
    expect(sanitized.agents.pi.providers[0].apiKey).toBe("");
  });

  it("keeps api keys when includeApiKeys is true", () => {
    const data = createAgentConfigExportData(
      { pi: { providers: [provider()] } },
      true,
    );
    const sanitized = sanitizeAgentConfigExport(data, true);
    expect(sanitized.agents.pi.providers[0].apiKey).toBe("sk-secret");
  });
});

describe("import conflict resolution", () => {
  it("defaults new provider to create", () => {
    const resolved = resolveImportProviderId(provider(), ["other"]);
    expect(resolved).toEqual({ providerId: "chan-x", action: "create" });
  });

  it("defaults existing provider to overwrite", () => {
    const resolved = resolveImportProviderId(provider(), ["chan-x"]);
    expect(resolved).toEqual({ providerId: "chan-x", action: "overwrite" });
  });

  it("honors explicit skip", () => {
    const resolved = resolveImportProviderId(provider(), ["chan-x"], { action: "skip" });
    expect(resolved.action).toBe("skip");
  });

  it("honors explicit create with a new id", () => {
    const resolved = resolveImportProviderId(
      provider(),
      ["chan-x"],
      { action: "create", newProviderId: "chan-x-copy" },
    );
    expect(resolved).toEqual({ providerId: "chan-x-copy", action: "create" });
  });

  it("generates a new id when create requested without one", () => {
    const existingIds = ["chan-x", "chan-x-copy", "chan-x-copy-2"];
    const resolved = resolveImportProviderId(provider(), existingIds, { action: "create" });
    expect(resolved.action).toBe("create");
    expect(resolved.providerId).toBe("chan-x-copy-3");
  });
});
