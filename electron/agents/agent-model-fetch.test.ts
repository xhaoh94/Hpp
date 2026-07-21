import { describe, expect, it, vi } from "vitest";
import {
  buildProviderModelsUrl,
  fetchProviderModels,
  normalizeRemoteProviderModels,
} from "./agent-model-fetch";

describe("provider model fetching", () => {
  it("appends the OpenAI-compatible models path", () => {
    expect(buildProviderModelsUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1/models");
    expect(buildProviderModelsUrl("https://api.example.com/v1/models")).toBe("https://api.example.com/v1/models");
  });

  it("normalizes Anthropic API roots to /v1/models", () => {
    expect(buildProviderModelsUrl("https://api.anthropic.com", "anthropic-messages"))
      .toBe("https://api.anthropic.com/v1/models");
    expect(buildProviderModelsUrl("https://gateway.example.com/v1/", "anthropic-messages"))
      .toBe("https://gateway.example.com/v1/models");
  });

  it("normalizes and deduplicates common model responses", () => {
    expect(normalizeRemoteProviderModels({
      data: [
        { id: "model-b", name: "Model B" },
        { id: "model-a" },
        { id: "model-b", name: "Duplicate" },
      ],
    })).toEqual([
      { id: "model-b", name: "Model B" },
      { id: "model-a", name: "model-a" },
    ]);
  });

  it("sends the API key and returns fetched models", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "gpt-test" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(fetchProviderModels("https://api.example.com/v1", "sk-test", fetchImpl)).resolves.toEqual([
      { id: "gpt-test", name: "gpt-test" },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
    }));
  });

  it("uses Anthropic x-api-key headers when configured", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "claude-test" }] }), {
      status: 200,
    }));

    await fetchProviderModels(
      "https://gateway.example.com/v1",
      "anthropic-key",
      "anthropic-messages",
      "x-api-key",
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("https://gateway.example.com/v1/models", expect.objectContaining({
      headers: expect.objectContaining({
        "x-api-key": "anthropic-key",
        "anthropic-version": "2023-06-01",
      }),
    }));
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
  });

  it("returns the provider error message", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid key" } }), {
      status: 401,
    }));

    await expect(fetchProviderModels("https://api.example.com/v1", "bad-key", fetchImpl)).rejects.toThrow(
      "获取模型失败（HTTP 401）：invalid key"
    );
  });
});
