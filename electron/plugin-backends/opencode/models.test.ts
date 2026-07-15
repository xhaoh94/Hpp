import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";
import { OpenCodeAgent } from "./backend";

interface OpenCodeInternals {
  sessionId: string | null;
  eventSource: { destroy: () => void } | null;
  httpGet: (path: string) => Promise<unknown>;
  httpPost: (path: string, data: unknown) => Promise<unknown>;
  startSSEListener: () => Promise<void>;
}

describe("OpenCode models", () => {
  it("reads capabilities and variants from OpenCode provider metadata", async () => {
    const agent = new OpenCodeAgent();
    const internals = agent as unknown as OpenCodeInternals;
    internals.httpGet = vi.fn(async () => ({
      providers: [{
        id: "custom",
        models: [{
          id: "reasoning-model",
          name: "Reasoning Model",
          capabilities: {
            reasoning: true,
            input: { image: true },
          },
          variants: {
            low: {},
            medium: {},
            high: {},
            disabled: { disabled: true },
          },
        }],
      }],
    }));

    await expect(agent.getModels()).resolves.toEqual([{
      id: "reasoning-model",
      name: "Reasoning Model",
      provider: "custom",
      reasoning: true,
      supportsImages: true,
    }]);

    const httpPost = vi.fn(async () => true);
    internals.sessionId = "ses_source";
    internals.httpPost = httpPost;
    internals.startSSEListener = vi.fn(async () => {
      internals.eventSource = { destroy: vi.fn() };
    });

    await agent.setModel("custom", "reasoning-model");
    await agent.setThinkingLevel("high");
    await agent.sendMessage("hello");

    expect(httpPost).toHaveBeenCalledWith("/session/ses_source/prompt_async", expect.objectContaining({
      model: { providerID: "custom", modelID: "reasoning-model" },
      variant: "high",
    }));
  });

  it("falls back to the closest available high-effort variant", async () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    internals.httpGet = vi.fn(async () => ({
      providers: [{
        id: "custom",
        models: {
          model: {
            capabilities: { reasoning: true, attachment: true },
            variants: { low: {}, high: {} },
          },
        },
      }],
    }));
    await agent.getModels();

    const httpPost = vi.fn(async () => true);
    internals.sessionId = "ses_source";
    internals.httpPost = httpPost;
    internals.startSSEListener = vi.fn(async () => {
      internals.eventSource = { destroy: vi.fn() };
    });

    await agent.setModel("custom", "model");
    await agent.setThinkingLevel("xhigh");
    await agent.sendMessage("hello");

    expect(httpPost).toHaveBeenCalledWith("/session/ses_source/prompt_async", expect.objectContaining({
      variant: "high",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "thinking_level_changed",
      level: "xhigh",
    }));
  });
});
