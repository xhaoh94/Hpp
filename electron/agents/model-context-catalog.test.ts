import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MODEL_CONTEXT_CATALOG_MAX_AGE_MS,
  getBundledModelContextCatalogPath,
  getModelContextCatalog,
  getModelContextCatalogCachePath,
  initializeModelContextCatalog,
  refreshModelContextCatalog,
  resetModelContextCatalogForTests,
  resolveModelContextWindowFor,
  withCatalogContextWindows,
} from "./model-context-catalog";
import { MODEL_CONTEXT_CATALOG_VERSION, type ModelContextCatalogData } from "../../shared/model-context-catalog";

const catalog = (overrides: Partial<ModelContextCatalogData> = {}): ModelContextCatalogData => ({
  version: MODEL_CONTEXT_CATALOG_VERSION,
  source: "test",
  fetchedAt: new Date().toISOString(),
  providers: {
    openai: { "gpt-6.2-astra": [1050000, 922000], "gpt-5.3-codex": [400000, 272000] },
    anthropic: { "claude-opus-5-5": [1000000] },
    tanwan: { "private-model": [65536] },
  },
  ...overrides,
});

/** 构造一份过体检（100 providers / 1000 models）的远端响应。 */
const bigRemotePayload = () => {
  const payload: Record<string, unknown> = {};
  for (let p = 0; p < 100; p += 1) {
    const models: Record<string, unknown> = {};
    for (let m = 0; m < 10; m += 1) models[`model-${p}-${m}`] = { limit: { context: 200000, input: 160000 } };
    payload[`provider-${p}`] = { models };
  }
  payload.openai = { models: { "gpt-6.2-astra": { limit: { context: 1050000, input: 922000 } } } };
  return payload;
};

const jsonResponse = (body: unknown, init: { status?: number; etag?: string } = {}) => ({
  ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
  status: init.status ?? 200,
  headers: { get: (name: string) => (name.toLowerCase() === "etag" ? init.etag : null) },
  json: async () => body,
}) as unknown as Response;

let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hpp-model-catalog-"));
  process.env.HPP_DATA_DIR = dataDir;
  resetModelContextCatalogForTests();
});

afterEach(() => {
  delete process.env.HPP_DATA_DIR;
  resetModelContextCatalogForTests();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("getModelContextCatalog", () => {
  it("falls back to the bundled snapshot shipped with the app", () => {
    const data = getModelContextCatalog();
    expect(data).toBeTruthy();
    // 内置快照来自 models.dev，至少要有几百个 provider —— 用来区分「读到了真文件」和「空对象」。
    expect(Object.keys(data!.providers).length).toBeGreaterThan(100);
  });

  it("prefers the refreshed cache over the bundled snapshot", () => {
    writeFileSync(getModelContextCatalogCachePath(), JSON.stringify(catalog()), "utf8");
    resetModelContextCatalogForTests();
    expect(getModelContextCatalog()?.source).toBe("test");
  });

  it("ignores a cache written in an unknown format version", () => {
    writeFileSync(
      getModelContextCatalogCachePath(),
      JSON.stringify({ ...catalog(), version: MODEL_CONTEXT_CATALOG_VERSION + 1 }),
      "utf8",
    );
    resetModelContextCatalogForTests();
    expect(getModelContextCatalog()?.source).toBe("models.dev");
  });

  // 插件后端包是 ESM，没有 __dirname；宿主进程用 HPP_AGENT_BACKEND_DIR 指向
  // out/main。少了这条回退，pi 会以「Agent 启动失败: __dirname is not defined」起不来。
  it("finds the bundled snapshot through HPP_AGENT_BACKEND_DIR", () => {
    const backendDir = mkdtempSync(join(tmpdir(), "hpp-backend-"));
    writeFileSync(join(backendDir, "model-context-catalog.json"), JSON.stringify(catalog({ source: "esm-backend" })), "utf8");
    process.env.HPP_AGENT_BACKEND_DIR = backendDir;
    try {
      resetModelContextCatalogForTests();
      expect(getBundledModelContextCatalogPath()).toBe(join(backendDir, "model-context-catalog.json"));
      expect(getModelContextCatalog()?.source).toBe("esm-backend");
    } finally {
      delete process.env.HPP_AGENT_BACKEND_DIR;
      rmSync(backendDir, { recursive: true, force: true });
    }
  });

  it("never dereferences __dirname without a guard (ESM bundle safety)", () => {
    const source = readFileSync(join(process.cwd(), "electron/agents/model-context-catalog.ts"), "utf8");
    expect(source).not.toContain("join(__dirname");
    expect(source).toContain("typeof __dirname");
  });
});

describe("withCatalogContextWindows", () => {
  beforeEach(() => {
    writeFileSync(getModelContextCatalogCachePath(), JSON.stringify(catalog()), "utf8");
    resetModelContextCatalogForTests();
  });

  it("overrides windows reported by the plugins so one model shows one limit", () => {
    const models = [
      { provider: "codex", id: "gpt-6.2-astra", contextWindow: 258400 },
      { provider: "pi", id: "gpt-6.2-astra", contextWindow: 1050000 },
      { provider: "claude", id: "claude-opus-5-5" },
    ];
    expect(withCatalogContextWindows(models)).toEqual([
      { provider: "codex", id: "gpt-6.2-astra", contextWindow: 922000 },
      { provider: "pi", id: "gpt-6.2-astra", contextWindow: 922000 },
      { provider: "claude", id: "claude-opus-5-5", contextWindow: 1000000 },
    ]);
  });

  it("keeps the plugin value for models the catalog does not know", () => {
    const models = [{ provider: "tanwan", id: "house-model", contextWindow: 32000 }];
    expect(withCatalogContextWindows(models)).toEqual(models);
  });

  it("resolves aggregator models through the family prefix", () => {
    expect(resolveModelContextWindowFor({ provider: "acme", modelId: "gpt-5.3-codex" })).toMatchObject({
      window: 272000,
      matchedBy: "family",
    });
  });
});

describe("refreshModelContextCatalog", () => {
  it("does not fetch while the cached snapshot is fresh", async () => {
    writeFileSync(getModelContextCatalogCachePath(), JSON.stringify(catalog()), "utf8");
    resetModelContextCatalogForTests();
    const fetchImpl = vi.fn();
    const result = await refreshModelContextCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ refreshed: false, reason: "fresh" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("downloads once a day, writes the cache and reloads the in-memory table", async () => {
    writeFileSync(
      getModelContextCatalogCachePath(),
      JSON.stringify(catalog({ fetchedAt: "2020-01-01T00:00:00.000Z" })),
      "utf8",
    );
    resetModelContextCatalogForTests();
    const fetchImpl = vi.fn(async () => jsonResponse(bigRemotePayload(), { etag: 'W/"v1"' }));

    const result = await refreshModelContextCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.refreshed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const written = JSON.parse(readFileSync(getModelContextCatalogCachePath(), "utf8")) as ModelContextCatalogData;
    expect(written.etag).toBe('W/"v1"');
    expect(written.providers.openai["gpt-6.2-astra"]).toEqual([1050000, 922000]);
    expect(resolveModelContextWindowFor({ provider: "openai", modelId: "gpt-6.2-astra" })?.window).toBe(922000);
  });

  it("sends the stored etag and only bumps the timestamp on 304", async () => {
    writeFileSync(
      getModelContextCatalogCachePath(),
      JSON.stringify({ ...catalog({ fetchedAt: "2020-01-01T00:00:00.000Z" }), etag: 'W/"v1"' }),
      "utf8",
    );
    resetModelContextCatalogForTests();
    const fetchImpl = vi.fn(async () => jsonResponse(null, { status: 304 }));
    const now = Date.parse("2026-11-24T12:00:00.000Z");

    const result = await refreshModelContextCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch, now });

    expect(result.refreshed).toBe(true);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["if-none-match"]).toBe('W/"v1"');
    const written = JSON.parse(readFileSync(getModelContextCatalogCachePath(), "utf8")) as ModelContextCatalogData;
    expect(written.fetchedAt).toBe(new Date(now).toISOString());
    expect(written.providers.openai).toBeTruthy();
  });

  it("keeps serving the old table when the network fails", async () => {
    writeFileSync(
      getModelContextCatalogCachePath(),
      JSON.stringify(catalog({ fetchedAt: "2020-01-01T00:00:00.000Z" })),
      "utf8",
    );
    resetModelContextCatalogForTests();
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await refreshModelContextCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toMatchObject({ refreshed: false, reason: "fetch-failed", error: "offline" });
    expect(getModelContextCatalog()?.providers.openai["gpt-6.2-astra"]).toEqual([1050000, 922000]);
    warn.mockRestore();
  });

  it("rejects a truncated payload instead of wiping the table", async () => {
    writeFileSync(
      getModelContextCatalogCachePath(),
      JSON.stringify(catalog({ fetchedAt: "2020-01-01T00:00:00.000Z" })),
      "utf8",
    );
    resetModelContextCatalogForTests();
    const fetchImpl = vi.fn(async () => jsonResponse({ openai: { models: { "gpt-6.2-astra": { limit: { context: 1 } } } } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await refreshModelContextCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toMatchObject({ refreshed: false, reason: "fetch-failed" });
    expect(getModelContextCatalog()?.providers.anthropic).toBeTruthy();
    warn.mockRestore();
  });

  it("initializes idempotently and shares one in-flight request", async () => {
    writeFileSync(
      getModelContextCatalogCachePath(),
      JSON.stringify(catalog({ fetchedAt: "2020-01-01T00:00:00.000Z" })),
      "utf8",
    );
    resetModelContextCatalogForTests();
    const fetchImpl = vi.fn(async () => jsonResponse(bigRemotePayload()));
    const [first, second] = await Promise.all([
      initializeModelContextCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      initializeModelContextCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ]);
    expect(first.refreshed).toBe(true);
    expect(second.refreshed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses a one-day refresh window", () => {
    expect(MODEL_CONTEXT_CATALOG_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});
