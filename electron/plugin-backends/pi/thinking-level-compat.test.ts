import { describe, expect, it } from "vitest";

// Keep the implementation in .mjs because it is loaded directly by the Pi
// worker (which runs outside Vite/Electron's TypeScript loader).
import {
  normalizeImplicitOpenAIResponsesPayload,
  usesImplicitOpenAIResponsesThinking,
  withImplicitOpenAIResponsesThinkingLevels,
} from "./thinking-level-compat.mjs";

const proxyModel = {
  id: "gpt-5.6-luna",
  provider: "tanwan",
  api: "openai-responses",
  reasoning: true,
  // Mirrors the Luna catalogue entry Pi can load from models-store.json.
  // Null marks the UI level unsupported, but Pi's Responses adapter can still
  // fall back to the original `minimal` string when it reaches the payload.
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
};

describe("Pi implicit OpenAI Responses thinking compatibility", () => {
  it("recognizes GPT-5.6 proxy models even with null catalogue mappings", () => {
    expect(usesImplicitOpenAIResponsesThinking(proxyModel)).toBe(true);
  });

  it("fills custom and null GPT-5.6 maps without hiding Hpp compatibility choices", () => {
    expect(withImplicitOpenAIResponsesThinkingLevels({
      ...proxyModel,
      thinkingLevelMap: undefined,
    })).toMatchObject({
      thinkingLevelMap: {
        off: "none",
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    });
    expect(withImplicitOpenAIResponsesThinkingLevels(proxyModel)).toMatchObject({
      thinkingLevelMap: {
        off: "none",
        minimal: "minimal",
        xhigh: "xhigh",
        max: "max",
      },
    });
  });

  it("maps minimal to the portable low effort", () => {
    const payload = {
      model: "gpt-5.6-luna",
      reasoning: { effort: "minimal", summary: "auto" },
    };
    expect(normalizeImplicitOpenAIResponsesPayload(payload, proxyModel)).toEqual({
      model: "gpt-5.6-luna",
      reasoning: { effort: "low", summary: "auto" },
    });
  });

  it("removes none reasoning and encrypted-content includes when disabled", () => {
    const payload = {
      model: "gpt-5.6-luna",
      reasoning: { effort: "none" },
      include: ["reasoning.encrypted_content", "output_text"],
    };
    expect(normalizeImplicitOpenAIResponsesPayload(payload, proxyModel)).toEqual({
      model: "gpt-5.6-luna",
      include: ["output_text"],
    });
  });

  it("uses the selected level when the generated payload is stale or incomplete", () => {
    expect(normalizeImplicitOpenAIResponsesPayload({
      reasoning: { effort: "high", summary: "auto" },
      include: [" Reasoning.Encrypted_Content", "output_text"],
    }, proxyModel, "off")).toEqual({ include: ["output_text"] });
    expect(normalizeImplicitOpenAIResponsesPayload({ model: proxyModel.id }, proxyModel, "minimal"))
      .toEqual({ model: proxyModel.id, reasoning: { effort: "low" } });
  });

  it("respects explicit compatible fallbacks for the two Hpp compatibility choices", () => {
    const explicitlyMappedModel = {
      ...proxyModel,
      thinkingLevelMap: {
        ...proxyModel.thinkingLevelMap,
        off: "low",
        minimal: "medium",
      },
    };
    expect(normalizeImplicitOpenAIResponsesPayload({}, explicitlyMappedModel, "off"))
      .toEqual({ reasoning: { effort: "low" } });
    expect(normalizeImplicitOpenAIResponsesPayload({}, explicitlyMappedModel, "minimal"))
      .toEqual({ reasoning: { effort: "medium" } });
  });

  it("does not rewrite unknown Responses gateways or unrelated APIs", () => {
    const payload = { reasoning: { effort: "minimal" } };
    const unknownProxy = {
      ...proxyModel,
      id: "custom-reasoner",
      thinkingLevelMap: undefined,
    };
    expect(usesImplicitOpenAIResponsesThinking(unknownProxy)).toBe(false);
    expect(normalizeImplicitOpenAIResponsesPayload(payload, unknownProxy, "minimal")).toBe(payload);
    expect(withImplicitOpenAIResponsesThinkingLevels(unknownProxy)).toBe(unknownProxy);
    expect(normalizeImplicitOpenAIResponsesPayload(payload, {
      ...proxyModel,
      api: "openai-completions",
    })).toBe(payload);
    expect(normalizeImplicitOpenAIResponsesPayload(payload, {
      ...proxyModel,
      provider: "openai",
      id: "gpt-5.4",
    })).toBe(payload);
  });
});
