import { describe, expect, it } from "vitest";
import {
  MODEL_CONTEXT_CATALOG_VERSION,
  compactModelContextCatalog,
  getCatalogEntryWindow,
  getCatalogModelIdCandidates,
  resolveModelContextWindow,
  shouldRefreshModelContextCatalog,
  type ModelContextCatalogData,
} from "./model-context-catalog";

const catalog = (providers: ModelContextCatalogData["providers"]): ModelContextCatalogData => ({
  version: MODEL_CONTEXT_CATALOG_VERSION,
  source: "test",
  fetchedAt: "2026-11-24T00:00:00.000Z",
  providers,
});

describe("getCatalogModelIdCandidates", () => {
  it("keeps the raw id first and strips vendor prefixes / release suffixes", () => {
    expect(getCatalogModelIdCandidates("DeepSeek-V4.1-Flash")).toEqual(["deepseek-v4.1-flash"]);
    expect(getCatalogModelIdCandidates("deepseek/deepseek-v4.1-flash")).toEqual([
      "deepseek/deepseek-v4.1-flash",
      "deepseek-v4.1-flash",
    ]);
    expect(getCatalogModelIdCandidates("mimo-v2.5-free:free")).toEqual(["mimo-v2.5-free:free", "mimo-v2.5-free"]);
    expect(getCatalogModelIdCandidates("   ")).toEqual([]);
    expect(getCatalogModelIdCandidates(undefined)).toEqual([]);
  });
});

describe("getCatalogEntryWindow", () => {
  it("prefers the input limit because Hpp measures input tokens", () => {
    expect(getCatalogEntryWindow([400000, 272000])).toBe(272000);
    expect(getCatalogEntryWindow([400000])).toBe(400000);
    expect(getCatalogEntryWindow([0, 0])).toBeUndefined();
    expect(getCatalogEntryWindow(undefined)).toBeUndefined();
  });
});

describe("resolveModelContextWindow", () => {
  const data = catalog({
    openai: { "gpt-6.2-astra": [1050000, 922000], "gpt-5.3-codex": [400000, 272000] },
    anthropic: { "claude-opus-5-5": [1000000] },
    tanwan: { "deepseek-v4.1-flash": [900000] },
    deepseek: { "deepseek-v4-pro": [1048576, 983040] },
    opencode: { "deepseek-v4-flash-free": [200000] },
  });

  it("matches provider + model id exactly", () => {
    expect(resolveModelContextWindow(data, { provider: "tanwan", modelId: "deepseek-v4.1-flash" }))
      .toEqual({ window: 900000, provider: "tanwan", modelId: "deepseek-v4.1-flash", matchedBy: "provider" });
  });

  it("follows provider aliases so codex/claude land on the first-party entries", () => {
    expect(resolveModelContextWindow(data, { provider: "codex", modelId: "gpt-6.2-astra" })?.window)
      .toBe(922000);
    expect(resolveModelContextWindow(data, { provider: "claude", modelId: "claude-opus-5-5" })?.provider)
      .toBe("anthropic");
  });

  it("falls back to the model family when the channel is an aggregator", () => {
    const resolution = resolveModelContextWindow(data, { provider: "acme-router", modelId: "gpt-5.3-codex" });
    expect(resolution).toMatchObject({ window: 272000, provider: "openai", matchedBy: "family" });
  });

  it("aggregates by id across providers and picks the most common window", () => {
    const wide = catalog({
      a: { "mystery-model": [128000] },
      b: { "mystery-model": [200000] },
      c: { "mystery-model": [200000] },
    });
    expect(resolveModelContextWindow(wide, { provider: "private", modelId: "mystery-model" }))
      .toMatchObject({ window: 200000, matchedBy: "aggregate" });
  });

  it("breaks aggregate ties towards the larger window", () => {
    const tied = catalog({ a: { "mystery-model": [128000] }, b: { "mystery-model": [200000] } });
    expect(resolveModelContextWindow(tied, { modelId: "mystery-model" })?.window).toBe(200000);
  });

  it("returns undefined instead of guessing when the id is unknown", () => {
    expect(resolveModelContextWindow(data, { provider: "tanwan", modelId: "my-private-model" })).toBeUndefined();
    expect(resolveModelContextWindow(null, { modelId: "gpt-6.2-astra" })).toBeUndefined();
    expect(resolveModelContextWindow(data, {})).toBeUndefined();
  });
});

describe("compactModelContextCatalog", () => {
  it("keeps only windows, lowercases ids and drops empty providers", () => {
    const compacted = compactModelContextCatalog({
      OpenAI: {
        models: {
          "GPT-6.2-Astra": { limit: { context: 1050000, input: 922000, output: 128000 } },
          "gpt-5.3-codex": { limit: { context: 400000 } },
          "no-window": { limit: {} },
        },
      },
      empty: { models: {} },
    }, { fetchedAt: "2026-11-24T00:00:00.000Z" });

    expect(compacted.version).toBe(MODEL_CONTEXT_CATALOG_VERSION);
    expect(compacted.fetchedAt).toBe("2026-11-24T00:00:00.000Z");
    expect(compacted.providers).toEqual({
      openai: {
        "gpt-6.2-astra": [1050000, 922000],
        "gpt-5.3-codex": [400000],
      },
    });
  });

  it("survives malformed payloads", () => {
    expect(compactModelContextCatalog(null).providers).toEqual({});
    expect(compactModelContextCatalog({ p: { models: { m: null } } }).providers).toEqual({});
  });
});

describe("shouldRefreshModelContextCatalog", () => {
  const now = Date.parse("2026-11-24T12:00:00.000Z");
  const fresh = catalog({ openai: { "gpt-6.2-astra": [1050000, 922000] } });

  it("refreshes when the snapshot is missing, undated or older than the window", () => {
    expect(shouldRefreshModelContextCatalog(null, now, 1000)).toBe(true);
    expect(shouldRefreshModelContextCatalog({ ...fresh, providers: {} }, now, 1000)).toBe(true);
    expect(shouldRefreshModelContextCatalog({ ...fresh, fetchedAt: undefined }, now, 1000)).toBe(true);
    expect(shouldRefreshModelContextCatalog(fresh, now, 60 * 60 * 1000)).toBe(true);
  });

  it("skips the fetch while the snapshot is still fresh", () => {
    expect(shouldRefreshModelContextCatalog(fresh, now, 24 * 60 * 60 * 1000)).toBe(false);
  });
});
