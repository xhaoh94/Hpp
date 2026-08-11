import { describe, expect, it } from "vitest";
import { buildDroidRuntimeSettings } from "./backend";

describe("Droid context compaction config", () => {
  it("adds a process-local Chat Completions model without dropping user models", () => {
    const settings = buildDroidRuntimeSettings({
      keepMe: true,
      customModels: [{
        id: "custom:user:model",
        model: "user-model",
        displayName: "User model",
      }],
    }, {
      thinkingLevel: "low",
      modelMode: "custom",
      customModel: {
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "",
        modelId: "qwen3:32b",
        api: "openai-completions",
        reasoning: false,
      },
    });

    expect(settings.keepMe).toBe(true);
    expect(settings.compactionModel).toBe("custom:hpp:compaction");
    expect(settings.customModels).toEqual([
      expect.objectContaining({
        id: "custom:user:model",
        model: "user-model",
      }),
      expect.objectContaining({
        id: "custom:hpp:compaction",
        hppCompactionManaged: true,
        model: "qwen3:32b",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "hpp-local",
        provider: "generic-chat-completion-api",
        noImageSupport: true,
      }),
    ]);
  });

  it("uses the Responses provider and replaces stale Hpp runtime models", () => {
    const settings = buildDroidRuntimeSettings({
      customModels: [{
        id: "custom:hpp:compaction",
        hppCompactionManaged: true,
        model: "old-model",
      }],
    }, {
      thinkingLevel: "high",
      modelMode: "custom",
      customModel: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "key",
        modelId: "gpt-5.4-mini",
        api: "openai-responses",
        reasoning: true,
      },
    });

    expect(settings.customModels).toHaveLength(1);
    expect(settings.customModels[0]).toMatchObject({
      id: "custom:hpp:compaction",
      model: "gpt-5.4-mini",
      apiKey: "key",
      provider: "openai",
    });
  });

  it("removes the Hpp-only model and returns to Droid's current-model compaction", () => {
    const settings = buildDroidRuntimeSettings({
      customModels: [{ id: "custom:user:model", model: "keep" }, {
        id: "custom:hpp:compaction",
        hppCompactionManaged: true,
        model: "remove",
      }],
      compactionModel: "custom:hpp:compaction",
    }, {
      thinkingLevel: "low",
      modelMode: "current",
      customModel: {},
    });

    expect(settings.compactionModel).toBe("same");
    expect(settings.customModels).toEqual([
      expect.objectContaining({ id: "custom:user:model", model: "keep" }),
    ]);
  });
});
