import { describe, expect, it } from "vitest";
import { createCopiedProviderId, resolveCompatibleProviderEndpoint } from "./agent-provider-copy";

describe("agent provider copy rules", () => {
  it("keeps supported endpoints and maps OpenAI Chat aliases", () => {
    expect(resolveCompatibleProviderEndpoint("anthropic-messages", ["anthropic-messages", "chat-completions"]))
      .toBe("anthropic-messages");
    expect(resolveCompatibleProviderEndpoint("openai-completions", [{ id: "chat-completions" }]))
      .toBe("chat-completions");
    expect(resolveCompatibleProviderEndpoint("responses", ["chat-completions"]))
      .toBeUndefined();
  });

  it("keeps a free id and suffixes collisions deterministically", () => {
    expect(createCopiedProviderId("opencode", ["other"])).toBe("opencode");
    expect(createCopiedProviderId("opencode", ["opencode"])).toBe("opencode-copy");
    expect(createCopiedProviderId("opencode", ["opencode", "opencode-copy", "opencode-copy-2"]))
      .toBe("opencode-copy-3");
  });
});
