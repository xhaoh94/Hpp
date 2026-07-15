import { describe, expect, it } from "vitest";
import type { AgentConfigState, AgentProviderConfig } from "@/types";
import { resolvePreferredProviderId } from "./AgentConfigModal";

const provider = (providerId: string): AgentProviderConfig => ({
  providerId,
  displayName: providerId,
  baseUrl: `https://${providerId}.example/v1`,
  apiKey: "key",
  endpoint: "responses",
  models: [{ id: `${providerId}-model`, name: providerId, reasoning: true, imageInput: false }],
});

describe("AgentConfigModal provider selection", () => {
  const state: AgentConfigState = {
    activeProviderId: "ylk",
    providers: [provider("ylk"), provider("wanzi"), provider("pixel")],
  };

  it("selects the current model provider before the active or first provider", () => {
    expect(resolvePreferredProviderId(state, "pixel")).toBe("pixel");
  });

  it("falls back to the active provider and then the first provider", () => {
    expect(resolvePreferredProviderId(state, "missing")).toBe("ylk");
    expect(resolvePreferredProviderId({ providers: state.providers }, "missing")).toBe("ylk");
  });
});
