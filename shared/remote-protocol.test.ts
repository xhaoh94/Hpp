import { describe, expect, it } from "vitest";
import {
  MAX_REMOTE_IMAGE_BYTES,
  MAX_REMOTE_IMAGES,
  REMOTE_PROTOCOL_VERSION,
  parseRemoteRequest,
  remotePairRequestSchema,
} from "./remote-protocol";

const request = (name: string, payload: unknown) => ({
  version: REMOTE_PROTOCOL_VERSION,
  kind: "request",
  requestId: "request-1",
  name,
  payload,
});

describe("remote protocol", () => {
  it("parses a valid idempotent send request", () => {
    const parsed = parseRemoteRequest(request("session.send", {
      sessionId: "session-1",
      clientMessageId: "mobile-message-1",
      content: "Run the tests",
      planModeEnabled: true,
      images: [],
      sessionReferences: [{ sourceSessionId: "session-2" }],
    }));

    expect(parsed.name).toBe("session.send");
    expect(parsed.payload).toMatchObject({
      sessionId: "session-1",
      clientMessageId: "mobile-message-1",
      planModeEnabled: true,
      sessionReferences: [{ sourceSessionId: "session-2" }],
    });
  });

  it("accepts a reference-only remote message and rejects an empty send", () => {
    expect(parseRemoteRequest(request("session.send", {
      sessionId: "session-1",
      clientMessageId: "message-with-reference",
      sessionReferences: [{ sourceSessionId: "session-2" }],
    })).payload).toMatchObject({
      content: "",
      sessionReferences: [{ sourceSessionId: "session-2" }],
    });
    expect(() => parseRemoteRequest(request("session.send", {
      sessionId: "session-1",
      clientMessageId: "empty-message",
    }))).toThrow();
  });

  it("validates remote session creation identifiers", () => {
    const parsed = parseRemoteRequest(request("session.create", {
      projectId: "project-1",
      agentId: "codex",
      clientSessionId: "mobile-session-1",
    }));

    expect(parsed.name).toBe("session.create");
    expect(parsed.payload).toEqual({
      projectId: "project-1",
      agentId: "codex",
      clientSessionId: "mobile-session-1",
    });
    expect(() => parseRemoteRequest(request("session.create", {
      projectId: "project-1",
      agentId: "",
      clientSessionId: "mobile-session-1",
    }))).toThrow();
  });

  it("validates remote fork targets", () => {
    expect(parseRemoteRequest(request("session.fork", {
      sessionId: "session-1",
      throughMessageId: "message-4",
      clientSessionId: "fork-session-1",
    })).payload).toEqual({
      sessionId: "session-1",
      throughMessageId: "message-4",
      clientSessionId: "fork-session-1",
    });
    expect(() => parseRemoteRequest(request("session.fork", {
      sessionId: "session-1",
      throughMessageId: "",
      clientSessionId: "fork-session-1",
    }))).toThrow();
  });

  it("validates close and reopen session requests", () => {
    expect(parseRemoteRequest(request("session.close", { sessionId: "session-1" })).payload)
      .toEqual({ sessionId: "session-1" });
    expect(parseRemoteRequest(request("session.reopen", { sessionId: "session-1" })).payload)
      .toEqual({ sessionId: "session-1" });
    expect(() => parseRemoteRequest(request("session.close", { sessionId: "" }))).toThrow();
  });

  it("validates current session reload requests", () => {
    expect(parseRemoteRequest(request("session.reload", { sessionId: "session-1" })).payload)
      .toEqual({ sessionId: "session-1" });
    expect(() => parseRemoteRequest(request("session.reload", { sessionId: "" }))).toThrow();
  });

  it("validates queue guide and remove requests", () => {
    expect(parseRemoteRequest(request("session.queue.guide", {
      sessionId: "session-1",
      queueItemId: "queued-message-1",
    })).payload).toEqual({ sessionId: "session-1", queueItemId: "queued-message-1" });
    expect(parseRemoteRequest(request("session.queue.remove", {
      sessionId: "session-1",
      queueItemId: "queued-message-2",
    })).payload).toEqual({ sessionId: "session-1", queueItemId: "queued-message-2" });
    expect(() => parseRemoteRequest(request("session.queue.guide", {
      sessionId: "session-1",
      queueItemId: "",
    }))).toThrow();
  });

  it("validates questionnaire responses", () => {
    expect(parseRemoteRequest(request("interaction.respond", {
      sessionId: "session-1",
      requestId: "question-1",
      method: "opencode.question",
      cancelled: false,
      text: "A",
      answers: [{ id: "approach", selected: ["a"] }],
    })).payload).toEqual({
      sessionId: "session-1",
      requestId: "question-1",
      method: "opencode.question",
      cancelled: false,
      text: "A",
      answers: [{ id: "approach", selected: ["a"] }],
    });
  });

  it("rejects unsupported versions and request names", () => {
    expect(() => parseRemoteRequest({ ...request("catalog.get", {}), version: 2 })).toThrow();
    expect(() => parseRemoteRequest(request("project.delete", {}))).toThrow();
  });

  it("enforces image count and decoded size limits", () => {
    const image = { id: "1", name: "photo.jpg", mimeType: "image/jpeg", data: "a" };
    expect(() => parseRemoteRequest(request("session.send", {
      sessionId: "session-1",
      clientMessageId: "message-1",
      content: "images",
      images: Array.from({ length: MAX_REMOTE_IMAGES + 1 }, (_, index) => ({ ...image, id: String(index) })),
    }))).toThrow();

    expect(() => parseRemoteRequest(request("session.send", {
      sessionId: "session-1",
      clientMessageId: "message-2",
      content: "large image",
      images: [{ ...image, data: "a".repeat(Math.ceil(MAX_REMOTE_IMAGE_BYTES / 0.75) + 8) }],
    }))).toThrow();
  });

  it("requires a complete one-time pairing request", () => {
    expect(remotePairRequestSchema.parse({
      pairingId: "pairing-1",
      secret: "s".repeat(43),
      deviceName: "Pixel",
    })).toMatchObject({ deviceName: "Pixel" });
    expect(() => remotePairRequestSchema.parse({ pairingId: "pairing-1", secret: "short", deviceName: "Pixel" })).toThrow();
  });
});
