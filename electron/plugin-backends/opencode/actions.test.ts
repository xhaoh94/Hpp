import { describe, expect, it, vi } from "vitest";
import { OpenCodeAgent } from "./backend";

interface OpenCodeActionInternals {
  sessionId: string | null;
  eventSource: { destroy: () => void } | null;
  startSSEListener: () => Promise<void>;
  httpGet: (path: string) => Promise<unknown>;
  httpPost: (path: string, body: unknown) => Promise<unknown>;
}

describe("OpenCode actions", () => {
  it("uses OpenCode's native system field for ordinary Plan prompts", async () => {
    const agent = new OpenCodeAgent();
    const internals = agent as unknown as OpenCodeActionInternals;
    internals.sessionId = "session-1";
    const httpPost = vi.fn(async (_path: string, _body: unknown) => true);
    internals.httpPost = httpPost;
    internals.startSSEListener = vi.fn(async () => {
      internals.eventSource = { destroy: vi.fn() };
    });

    await agent.sendMessage("inspect the project", undefined, {
      planModeEnabled: true,
      hostSystemPrompt: "  [HPP] 始终使用简体中文  ",
    });

    expect(httpPost).toHaveBeenCalledWith("/session/session-1/prompt_async", {
      parts: [{ type: "text", text: "inspect the project" }],
      system: "[HPP] 始终使用简体中文",
      agent: "plan",
    });
    await agent.dispose();
  });

  it("filters built-ins and MCP prompts, then uses the native command endpoint", async () => {
    const agent = new OpenCodeAgent();
    const internals = agent as unknown as OpenCodeActionInternals;
    internals.sessionId = "session-1";
    internals.httpGet = vi.fn(async (path: string) => path === "/skill"
      ? [{ name: "review-skill", description: "Review changes", location: "C:\\private\\SKILL.md", content: "secret" }]
      : [
          { name: "release", description: "Prepare release", source: "command" },
          { name: "mcp-prompt", source: "mcp" },
          { name: "init", source: "builtin" },
          { name: "review", source: "builtin" },
        ]);
    const httpPost = vi.fn(async (_path: string, _body: unknown) => true);
    internals.httpPost = httpPost;
    internals.startSSEListener = vi.fn(async () => {
      internals.eventSource = { destroy: vi.fn() };
    });

    await expect(agent.listActions()).resolves.toEqual([
      { kind: "skill", name: "review-skill", description: "Review changes" },
      { kind: "command", name: "release", description: "Prepare release" },
    ]);
    await agent.sendMessage("0.2.0", [{ mimeType: "image/png", data: "aW1hZ2U=" }], {
      action: { kind: "command", name: "release" },
      clientMessageId: "message-1",
      hostSystemPrompt: "[HPP] 始终使用简体中文",
    });
    expect(httpPost).toHaveBeenCalledWith("/session/session-1/command", expect.objectContaining({
      command: "release",
      arguments: "0.2.0",
      parts: [{ type: "file", mime: "image/png", filename: "image-1.png", url: "data:image/png;base64,aW1hZ2U=" }],
    }));
    // OpenCode 1.18's native CommandInput has no system field. Preserve
    // command expansion and never lower host policy into user arguments.
    expect(httpPost.mock.calls.find(([path]) => path === "/session/session-1/command")?.[1])
      .not.toHaveProperty("system");
    await agent.abort();
  });

  it("rejects an action that disappears from the native catalog", async () => {
    const agent = new OpenCodeAgent();
    const internals = agent as unknown as OpenCodeActionInternals;
    internals.sessionId = "session-1";
    internals.httpGet = vi.fn(async () => []);
    await expect(agent.sendMessage("", undefined, { action: { kind: "skill", name: "missing" } }))
      .rejects.toThrow("ACTION_NOT_FOUND");
  });
});
