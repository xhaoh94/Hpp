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

  it("returns the provider error message", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid key" } }), {
      status: 401,
    }));

    await expect(fetchProviderModels("https://api.example.com/v1", "bad-key", fetchImpl)).rejects.toThrow(
      "获取模型失败（HTTP 401）：invalid key"
    );
  });
});
