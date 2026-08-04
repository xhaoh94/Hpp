import { createServer, type Server } from "http";
import type { ChildProcess } from "child_process";
import type { AddressInfo } from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";
import { OpenCodeAgent } from "./backend";

interface OpenCodeInternals {
  sessionId: string | null;
  host: string;
  port: number;
  process: ChildProcess | null;
  eventSource: { destroy: () => void } | null;
  streamedContent: boolean;
  turnActive: boolean;
  turnRevision: number;
  permissionMode: "ask" | "auto" | "full-access";
  runningToolParts: Set<string>;
  pendingQuestionToolParts: Set<string>;
  handleSSEEvent: (eventType: string, data: unknown) => void;
  handleSSEDisconnect: (request: { destroy: () => void }, detail: string) => void;
  fetchAssistantMessage: (turnRevision?: number) => Promise<void>;
  httpGet: (path: string) => Promise<unknown>;
  httpPost: (path: string, data: unknown) => Promise<unknown>;
  killProcess: () => Promise<void>;
  killProcessTree: (childProcess: ChildProcess) => Promise<void>;
}

describe("OpenCode lifecycle", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("waits for the event stream before sending a prompt and acknowledges abort", async () => {
    let eventStreamConnected = false;
    let promptSentAfterConnection = false;
    const server = createServer((request, response) => {
      if (request.url === "/event") {
        setTimeout(() => {
          eventStreamConnected = true;
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write("data: {\"type\":\"server.connected\",\"properties\":{}}\n\n");
        }, 50);
        return;
      }
      if (request.url === "/session/ses_source/prompt_async") {
        promptSentAfterConnection = eventStreamConnected;
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.url === "/session/ses_source/abort") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("true");
        return;
      }
      response.writeHead(404);
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    internals.sessionId = "ses_source";
    internals.host = "127.0.0.1";
    internals.port = (server.address() as AddressInfo).port;

    await agent.sendMessage("hello", undefined, { clientMessageId: "message-1" });
    expect(promptSentAfterConnection).toBe(true);

    await agent.abort();
    expect(agent.isIdle()).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "aborted" }));
  });

  it("finishes the Hpp turn when the event stream cannot connect", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503);
      response.end("unavailable");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    internals.sessionId = "ses_source";
    internals.host = "127.0.0.1";
    internals.port = (server.address() as AddressInfo).port;

    await agent.sendMessage("hello", undefined, { clientMessageId: "message-1" });

    expect(agent.isIdle()).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "stream_end" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_end" }));
  });

  it("clears unfinished tool bookkeeping when an idle session settles", async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
      const internals = agent as unknown as OpenCodeInternals;
      const eventSource = { destroy: vi.fn() };
      internals.sessionId = "ses_source";
      internals.eventSource = eventSource;
      internals.turnRevision = 1;
      internals.turnActive = true;
      internals.streamedContent = true;
      internals.runningToolParts.add("tool-read");
      internals.pendingQuestionToolParts.add("question-tool");

      internals.handleSSEEvent("session.idle", {
        properties: { sessionID: "ses_source" },
      });
      await vi.advanceTimersByTimeAsync(801);

      expect(eventSource.destroy).toHaveBeenCalledOnce();
      expect(agent.isIdle()).toBe(true);
      expect(events.filter((event) => event.type === "stream_end")).toHaveLength(1);
      expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts idle settlement after a trailing text delta", async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
      const internals = agent as unknown as OpenCodeInternals;
      internals.sessionId = "ses_source";
      internals.eventSource = { destroy: vi.fn() };
      internals.turnRevision = 1;
      internals.turnActive = true;
      internals.streamedContent = true;

      internals.handleSSEEvent("session.idle", {
        properties: { sessionID: "ses_source" },
      });
      await vi.advanceTimersByTimeAsync(400);
      internals.handleSSEEvent("message.part.delta", {
        properties: {
          sessionID: "ses_source",
          partID: "text-tail",
          field: "text",
          delta: "tail",
        },
      });

      await vi.advanceTimersByTimeAsync(799);
      expect(agent.isIdle()).toBe(false);
      expect(events.some((event) => event.type === "agent_end")).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(agent.isIdle()).toBe(true);
      expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears unfinished tool bookkeeping when the session fails", () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    const eventSource = { destroy: vi.fn() };
    internals.sessionId = "ses_source";
    internals.eventSource = eventSource;
    internals.turnRevision = 1;
    internals.turnActive = true;
    internals.runningToolParts.add("tool-write");

    internals.handleSSEEvent("session.error", {
      properties: {
        sessionID: "ses_source",
        error: { message: "request failed" },
      },
    });

    expect(eventSource.destroy).toHaveBeenCalledOnce();
    expect(agent.isIdle()).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "stream_end" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_end" }));
  });

  it("settles an active turn when its SSE connection disconnects", () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    const eventSource = { destroy: vi.fn() };
    internals.eventSource = eventSource;
    internals.turnRevision = 1;
    internals.turnActive = true;
    internals.runningToolParts.add("tool-shell");

    internals.handleSSEDisconnect(eventSource, "connection lost");

    expect(agent.isIdle()).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "process_event",
      state: "error",
      detail: "connection lost",
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: "stream_end" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_end" }));
  });

  it("emits a terminal lifecycle before disposing an active turn", async () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    internals.turnRevision = 1;
    internals.turnActive = true;
    internals.eventSource = { destroy: vi.fn() };

    await agent.dispose();

    expect(agent.isIdle()).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["stream_end", "agent_end"]);
  });

  it("ignores a late REST fallback from an older turn", async () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    let resolveMessages!: (messages: unknown) => void;
    internals.sessionId = "ses_source";
    internals.turnRevision = 1;
    internals.turnActive = true;
    internals.httpGet = vi.fn(() => new Promise((resolve) => {
      resolveMessages = resolve;
    }));

    const oldFallback = internals.fetchAssistantMessage(1);
    await Promise.resolve();

    const currentEventSource = { destroy: vi.fn() };
    internals.turnRevision = 2;
    internals.turnActive = true;
    internals.eventSource = currentEventSource;
    resolveMessages([{
      info: { id: "msg_old", role: "assistant" },
      parts: [{ type: "text", text: "stale answer" }],
    }]);
    await oldFallback;

    expect(internals.eventSource).toBe(currentEventSource);
    expect(currentEventSource.destroy).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({ type: "stream_delta", delta: "stale answer" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "stream_end" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "agent_end" }));
  });

  it("keeps the turn open until an automatic permission reply completes", async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
      const internals = agent as unknown as OpenCodeInternals;
      let resolveReply!: (value: unknown) => void;
      internals.sessionId = "ses_source";
      internals.turnRevision = 1;
      internals.turnActive = true;
      internals.streamedContent = true;
      internals.permissionMode = "auto";
      internals.eventSource = { destroy: vi.fn() };
      internals.httpPost = vi.fn(() => new Promise((resolve) => {
        resolveReply = resolve;
      }));

      internals.handleSSEEvent("permission.asked", {
        properties: {
          id: "permission-read",
          sessionID: "ses_source",
          action: "read",
          resources: ["src/app.ts"],
        },
      });
      internals.handleSSEEvent("session.idle", {
        properties: { sessionID: "ses_source" },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(events).not.toContainEqual(expect.objectContaining({ type: "agent_end" }));

      resolveReply(true);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(801);

      expect(agent.isIdle()).toBe(true);
      expect(events.filter((event) => event.type === "stream_end")).toHaveLength(1);
      expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a late automatic-permission failure from an older turn", async () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    let rejectReply!: (error: Error) => void;
    internals.sessionId = "ses_source";
    internals.turnRevision = 1;
    internals.turnActive = true;
    internals.permissionMode = "auto";
    internals.eventSource = { destroy: vi.fn() };
    internals.httpPost = vi.fn(() => new Promise((_resolve, reject) => {
      rejectReply = reject;
    }));

    internals.handleSSEEvent("permission.asked", {
      properties: {
        id: "permission-read",
        sessionID: "ses_source",
        action: "read",
        resources: ["src/app.ts"],
      },
    });
    internals.handleSSEEvent("session.error", {
      properties: {
        sessionID: "ses_source",
        error: { message: "old turn failed" },
      },
    });

    const newEventSource = { destroy: vi.fn() };
    internals.turnRevision += 1;
    internals.turnActive = true;
    internals.eventSource = newEventSource;
    const eventCountBeforeLateReply = events.length;
    rejectReply(new Error("late permission failure"));
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toHaveLength(eventCountBeforeLateReply);
    expect(internals.eventSource).toBe(newEventSource);
    expect(newEventSource.destroy).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({
      title: "OpenCode permission response failed",
      detail: "late permission failure",
    }));
  });

  it("terminates the full OpenCode process tree", async () => {
    const agent = new OpenCodeAgent();
    const internals = agent as unknown as OpenCodeInternals;
    const childProcess = {
      pid: 1234,
      stdin: { end: vi.fn() },
      kill: vi.fn(),
    } as unknown as ChildProcess;
    internals.process = childProcess;
    internals.killProcessTree = vi.fn(async () => undefined);

    await internals.killProcess();

    expect(childProcess.stdin?.end).toHaveBeenCalled();
    expect(internals.killProcessTree).toHaveBeenCalledWith(childProcess);
    expect(childProcess.kill).not.toHaveBeenCalled();
  });
});
