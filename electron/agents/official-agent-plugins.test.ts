import { describe, expect, it, vi } from "vitest";
import {
  isAllowedOfficialPluginUrl,
  listOfficialAgentPlugins,
  validateOfficialPluginCatalog,
  type FetchLike,
} from "./official-agent-plugins";

const validCatalog = {
  schemaVersion: 1,
  plugins: [
    {
      id: "codex",
      name: "Codex",
      version: "1.0.0",
      description: "OpenAI Codex CLI programming agent",
      runtime: "cli",
      command: "codex",
      packageName: "@openai/codex",
      capabilities: {
        planMode: "native",
        guidance: true,
        fork: true,
        configuration: "openai-compatible",
      },
      zipFile: "codex.zip",
      downloadUrl: "https://github.com/xhaoh94/Hpp/releases/latest/download/codex.zip",
    },
  ],
};

function createFetchResponse(overrides: Partial<Awaited<ReturnType<FetchLike>>>): Awaited<ReturnType<FetchLike>> {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => validCatalog,
    arrayBuffer: async () => new ArrayBuffer(0),
    ...overrides,
  };
}

describe("official agent plugins", () => {
  it("normalizes missing providerActivation to none", () => {
    const plugins = validateOfficialPluginCatalog(validCatalog);

    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("codex");
    expect(plugins[0].capabilities.providerActivation).toBe("none");
  });

  it("rejects non-official download URLs", () => {
    expect(isAllowedOfficialPluginUrl("https://example.com/codex.zip", "codex.zip")).toBe(false);
    expect(() => validateOfficialPluginCatalog({
      ...validCatalog,
      plugins: [
        {
          ...validCatalog.plugins[0],
          downloadUrl: "https://example.com/codex.zip",
        },
      ],
    })).toThrow("github.com");
  });

  it("returns a clear error when catalog download fails", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => createFetchResponse({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    }));

    const result = await listOfficialAgentPlugins(fetchImpl);

    expect(result.success).toBe(false);
    expect(result.error).toContain("503");
    expect(result.plugins).toEqual([]);
  });

  it("returns a clear error when catalog JSON is invalid", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => createFetchResponse({
      json: async () => {
        throw new Error("bad json");
      },
    }));

    const result = await listOfficialAgentPlugins(fetchImpl);

    expect(result.success).toBe(false);
    expect(result.error).toContain("有效 JSON");
    expect(result.plugins).toEqual([]);
  });
});
