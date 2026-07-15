import { createServer } from "http";
import type { AddressInfo } from "net";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";
import { OpenCodeAgent } from "./backend";

interface OpenCodeInternals {
  sessionId: string | null;
  host: string;
  port: number;
  eventSource: { destroy: () => void } | null;
  startSSEListener: () => void;
  httpPost: (path: string, data: unknown) => Promise<unknown>;
  handleSSEEvent: (eventType: string, data: unknown) => void;
}

describe("OpenCode native fork", () => {
  it("uses OpenCode-generated message ids and forks at the assistant message", async () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const httpPost = vi.fn(async (path: string) => path.endsWith("/fork") ? { id: "ses_forked" } : "");
    const internals = agent as unknown as OpenCodeInternals;
    internals.sessionId = "ses_source";
    internals.startSSEListener = vi.fn();
    internals.eventSource = { destroy: vi.fn() };
    internals.httpPost = httpPost;

    await agent.sendMessage("hello", undefined, { clientMessageId: "client-message-1" });

    expect(httpPost).toHaveBeenNthCalledWith(1, "/session/ses_source/prompt_async", expect.not.objectContaining({
      messageID: expect.anything(),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "turn_metadata" }));
    internals.handleSSEEvent("message.updated", {
      properties: {
        sessionID: "ses_source",
        info: { id: "msg_assistant1", sessionID: "ses_source", role: "assistant" },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "turn_metadata",
      nativeTurnId: "msg_assistant1",
      clientUserMessageId: "client-message-1",
    }));

    const result = await agent.forkSession({
      newSessionId: "hpp-fork",
      sourceSessionFilePath: "ses_source",
      sourceUserMessageIndex: 0,
      targetTurnId: "msg_assistant1",
    });

    expect(httpPost).toHaveBeenNthCalledWith(2, "/session/ses_source/fork", {
      messageID: "msg_assistant1",
    });
    expect(result).toEqual({
      supported: true,
      success: true,
      sessionFilePath: "ses_forked",
      nativeEntryId: "msg_assistant1",
    });
  });

  it("does not fork an old historical turn at the session head", async () => {
    const agent = new OpenCodeAgent();
    const httpPost = vi.fn(async () => ({ id: "ses_wrong" }));
    const internals = agent as unknown as OpenCodeInternals;
    internals.sessionId = "ses_source";
    internals.httpPost = httpPost;

    const result = await agent.forkSession({
      newSessionId: "hpp-fork",
      sourceSessionFilePath: "ses_source",
      sourceUserMessageIndex: 0,
      rollbackUserMessageCount: 2,
    });

    expect(httpPost).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.reason).toContain("native message id");
  });

  it("returns an error when the OpenCode fork endpoint rejects the request", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 400;
      response.end("invalid message id");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const agent = new OpenCodeAgent();
      const internals = agent as unknown as OpenCodeInternals;
      internals.sessionId = "ses_source";
      internals.host = "127.0.0.1";
      internals.port = (server.address() as AddressInfo).port;

      const result = await agent.forkSession({
        newSessionId: "hpp-fork",
        sourceSessionFilePath: "ses_source",
        sourceUserMessageIndex: 0,
        targetTurnId: "msg_missing",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("400");
      expect(result.error).toContain("invalid message id");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
