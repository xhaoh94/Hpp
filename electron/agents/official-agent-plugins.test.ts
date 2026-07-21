import { describe, expect, it, vi } from "vitest";
import {
  isAllowedOfficialPluginUrl,
  listOfficialAgentPlugins,
  validateOfficialPluginCatalog,
  type FetchLike,
} from "./official-agent-plugins";

const validCatalog = {
  schemaVersion: 2,
  plugins: [
    {
      id: "codex",
      name: "Codex",
      version: "1.0.0",
      minHppVersion: "0.0.1",
      description: "OpenAI Codex CLI programming agent",
      runtime: "cli",
      command: "codex",
      packageName: "@openai/codex",
      order: 10,
      capabilities: {
        planMode: "native",
        guidance: true,
        fork: true,
        configuration: {
          type: "provider",
          storage: "hpp",
          endpoints: [{ id: "responses", label: "Responses" }],
          defaultEndpoint: "responses",
          modelDefaults: { reasoning: true, imageInput: true },
          fixedModelCapabilities: true,
          modelListMode: "configured",
        },
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
    const plugins = validateOfficialPluginCatalog(validCatalog, "0.0.1");

    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("codex");
    expect(plugins[0].order).toBe(10);
    expect(plugins[0].capabilities.configuration).toMatchObject({ defaultEndpoint: "responses" });
    expect(plugins[0].capabilities.providerActivation).toBe("none");
    expect(plugins[0]).toMatchObject({ minHppVersion: "0.0.1", compatible: true });
  });

  it("preserves provider authentication and thinking declarations", () => {
    const plugins = validateOfficialPluginCatalog({
      ...validCatalog,
      plugins: [{
        ...validCatalog.plugins[0],
        capabilities: {
          ...validCatalog.plugins[0].capabilities,
          configuration: {
            ...validCatalog.plugins[0].capabilities.configuration,
            authModes: [
              { id: "bearer", label: "Bearer" },
              { id: "x-api-key", label: "X-Api-Key" },
            ],
            defaultAuthMode: "x-api-key",
            modelDefaults: {
              reasoning: true,
              imageInput: true,
              supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
            },
          },
        },
      }],
    }, "0.1.5");

    expect(plugins[0].capabilities.configuration).toMatchObject({
      defaultAuthMode: "x-api-key",
      authModes: [{ id: "bearer" }, { id: "x-api-key" }],
      modelDefaults: { supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"] },
    });
  });

  it("marks plugins requiring a newer Hpp version as incompatible", () => {
    const plugins = validateOfficialPluginCatalog({
      ...validCatalog,
      plugins: [{ ...validCatalog.plugins[0], minHppVersion: "0.1.0" }],
    }, "0.0.1");

    expect(plugins[0].compatible).toBe(false);
    expect(plugins[0].compatibilityError).toContain("需要 Hpp v0.1.0");
  });

  it("preserves plugin-declared backend model visibility controls", () => {
    const plugins = validateOfficialPluginCatalog({
      ...validCatalog,
      plugins: [{
        ...validCatalog.plugins[0],
        capabilities: {
          ...validCatalog.plugins[0].capabilities,
          configuration: {
            ...validCatalog.plugins[0].capabilities.configuration,
            modelListMode: "merge",
            backendModelVisibility: {
              userConfigurable: true,
              defaultVisible: false,
              label: "显示官方模型",
              description: "关闭后只显示自定义模型",
            },
          },
        },
      }],
    }, "0.0.1");

    expect(plugins[0].capabilities.configuration).toMatchObject({
      backendModelVisibility: {
        userConfigurable: true,
        defaultVisible: false,
        label: "显示官方模型",
      },
    });
  });

  it("rejects legacy catalogs so old Hpp versions fail closed", () => {
    expect(() => validateOfficialPluginCatalog({ ...validCatalog, schemaVersion: 1 }, "0.0.1"))
      .toThrow("GitHub 上还是旧版官方插件列表");
  });

  it("explains when the catalog requires a different Hpp version", () => {
    expect(() => validateOfficialPluginCatalog({ ...validCatalog, schemaVersion: 3 }, "0.0.1"))
      .toThrow("官方插件列表与当前 Hpp 版本不兼容");
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
    }, "0.0.1")).toThrow("github.com");
  });

  it("returns a clear error when catalog download fails", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => createFetchResponse({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    }));

    const result = await listOfficialAgentPlugins("0.0.1", fetchImpl);

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

    const result = await listOfficialAgentPlugins("0.0.1", fetchImpl);

    expect(result.success).toBe(false);
    expect(result.error).toContain("有效 JSON");
    expect(result.plugins).toEqual([]);
  });
});
