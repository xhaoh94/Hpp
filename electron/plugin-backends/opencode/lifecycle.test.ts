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
  activeOpenCodeUserMessageId: string | null;
  activeOpenCodeUserMessageIds: Set<string>;
  activeTurnDiffs: Array<Record<string, unknown>>;
  activeTurnDiffsAuthoritative: boolean;
  idleSettlementRevision: number;
  idleSettlementInFlight: boolean;
  turnActive: boolean;
  turnRevision: number;
  permissionMode: "ask" | "auto" | "full-access";
  runningToolParts: Set<string>;
  pendingQuestionToolParts: Set<string>;
  handleSSEEvent: (eventType: string, data: unknown) => void;
  handleSSEDisconnect: (request: { destroy: () => void }, detail: string) => void;
  fetchTurnDiff: (userMessageId: string | null, turnRevision: number, settlementRevision?: number) => Promise<void>;
  fetchAssistantMessage: (turnRevision?: number, settlementRevision?: number) => Promise<void>;
  httpGet: (path: string, timeoutMs?: number) => Promise<unknown>;
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

  it("uses diffs embedded in the completed user summary without another REST wait", async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
      const internals = agent as unknown as OpenCodeInternals;
      internals.sessionId = "ses_source";
      internals.turnRevision = 1;
      internals.turnActive = true;
      internals.streamedContent = true;
      internals.eventSource = { destroy: vi.fn() };
      internals.httpGet = vi.fn(async () => []);
      const patch = "Index: src/app.ts\n===\n--- src/app.ts\n+++ src/app.ts\n@@ -1 +1 @@\n-old\n+new";

      internals.handleSSEEvent("message.updated", {
        properties: {
          sessionID: "ses_source",
          info: {
            id: "msg_user_1",
            role: "user",
            summary: { diffs: [{ file: "src/app.ts", patch, additions: 1, deletions: 1 }] },
          },
        },
      });
      internals.handleSSEEvent("session.idle", {
        properties: { sessionID: "ses_source" },
      });
      await vi.advanceTimersByTimeAsync(801);

      expect(internals.httpGet).not.toHaveBeenCalled();
      expect(events).toContainEqual(expect.objectContaining({
        type: "diff_update",
        diffs: [expect.objectContaining({
          file: "src/app.ts",
          patch: expect.stringContaining("diff --git a/src/app.ts b/src/app.ts"),
        })],
      }));
      expect(agent.isIdle()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges authoritative summaries from the initial prompt and guidance", async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
      const internals = agent as unknown as OpenCodeInternals;
      internals.sessionId = "ses_source";
      internals.turnRevision = 1;
      internals.turnActive = true;
      internals.streamedContent = true;
      internals.eventSource = { destroy: vi.fn() };
      internals.httpGet = vi.fn(async () => []);
      const patch = (file: string) => `Index: ${file}\n===\n--- ${file}\n+++ ${file}\n@@ -1 +1 @@\n-old\n+new`;

      for (const [id, file] of [["msg_user_1", "first.ts"], ["msg_guidance", "second.ts"]]) {
        internals.handleSSEEvent("message.updated", {
          properties: {
            sessionID: "ses_source",
            info: {
              id,
              role: "user",
              summary: { diffs: [{ file, patch: patch(file), additions: 1, deletions: 1 }] },
            },
          },
        });
      }
      internals.handleSSEEvent("session.idle", {
        properties: { sessionID: "ses_source" },
      });
      await vi.advanceTimersByTimeAsync(801);

      const diffEvent = events.find((event) => event.type === "diff_update");
      expect(diffEvent?.diffs?.map((diff) => diff.file)).toEqual(["first.ts", "second.ts"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the ordered patch chain when prompt and guidance edit the same file", async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
      const internals = agent as unknown as OpenCodeInternals;
      internals.sessionId = "ses_source";
      internals.turnRevision = 1;
      internals.turnActive = true;
      internals.streamedContent = true;
      internals.eventSource = { destroy: vi.fn() };
      internals.httpGet = vi.fn(async () => []);
      const patch = (from: string, to: string) => `Index: same.ts\n===\n--- same.ts\n+++ same.ts\n@@ -1 +1 @@\n-${from}\n+${to}`;

      for (const [id, from, to] of [
        ["msg_user_1", "old", "middle"],
        ["msg_guidance", "middle", "new"],
      ]) {
        internals.handleSSEEvent("message.updated", {
          properties: {
            sessionID: "ses_source",
            info: {
              id,
              role: "user",
              summary: { diffs: [{ file: "same.ts", patch: patch(from, to), additions: 1, deletions: 1 }] },
            },
          },
        });
      }
      internals.handleSSEEvent("session.idle", { properties: { sessionID: "ses_source" } });
      await vi.advanceTimersByTimeAsync(801);

      const diffs = events.find((event) => event.type === "diff_update")?.diffs || [];
      expect(diffs).toHaveLength(2);
      expect(diffs[0]).toMatchObject({
        file: "same.ts",
        patch: expect.stringContaining("-old\n+middle"),
        additions: 1,
        deletions: 1,
      });
      expect(diffs[1]).toMatchObject({
        file: "same.ts",
        patch: expect.stringContaining("-middle\n+new"),
        additions: 1,
        deletions: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads the message-scoped diff before settling an idle turn", async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
      const internals = agent as unknown as OpenCodeInternals;
      internals.sessionId = "ses_source";
      internals.turnRevision = 1;
      internals.turnActive = true;
      internals.streamedContent = true;
      internals.eventSource = { destroy: vi.fn() };
      internals.httpGet = vi.fn(async () => [{
        file: "src/app.ts",
        before: "old\n",
        after: "new\n",
        additions: 1,
        deletions: 1,
      }]);

      internals.handleSSEEvent("message.updated", {
        properties: {
          sessionID: "ses_source",
          info: { id: "msg_user_1", role: "user" },
        },
      });
      internals.handleSSEEvent("session.idle", {
        properties: { sessionID: "ses_source" },
      });
      await vi.advanceTimersByTimeAsync(801);

      expect(internals.httpGet).toHaveBeenCalledWith(
        "/session/ses_source/diff?messageID=msg_user_1",
        2000,
      );
      const diffIndex = events.findIndex((event) => event.type === "diff_update");
      const endIndex = events.findIndex((event) => event.type === "stream_end");
      expect(diffIndex).toBeGreaterThanOrEqual(0);
      expect(endIndex).toBeGreaterThan(diffIndex);
      expect(events[diffIndex]).toMatchObject({
        diffs: [expect.objectContaining({ patch: expect.stringContaining("-old\n+new") })],
      });
      expect(agent.isIdle()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a persisted user summary when the message-scoped diff is temporarily empty", async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
      const internals = agent as unknown as OpenCodeInternals;
      const patch = "Index: src/app.ts\n===\n--- src/app.ts\n+++ src/app.ts\n@@ -1 +1 @@\n-old\n+new";
      internals.sessionId = "ses_source";
      internals.turnRevision = 1;
      internals.turnActive = true;
      internals.streamedContent = true;
      internals.eventSource = { destroy: vi.fn() };
      internals.httpGet = vi.fn((path) => path.includes("/diff?")
        ? Promise.resolve([])
        : Promise.resolve([{
          info: {
            id: "msg_user_1",
            role: "user",
            summary: { diffs: [{ file: "src/app.ts", patch, additions: 1, deletions: 1 }] },
          },
        }]));

      internals.handleSSEEvent("message.updated", {
        properties: { sessionID: "ses_source", info: { id: "msg_user_1", role: "user" } },
      });
      internals.handleSSEEvent("session.idle", {
        properties: { sessionID: "ses_source" },
      });
      await vi.advanceTimersByTimeAsync(801);

      expect(internals.httpGet).toHaveBeenNthCalledWith(
        1,
        "/session/ses_source/diff?messageID=msg_user_1",
        2000,
      );
      expect(internals.httpGet).toHaveBeenNthCalledWith(
        2,
        "/session/ses_source/message",
        2000,
      );
      expect(events).toContainEqual(expect.objectContaining({
        type: "diff_update",
        diffs: [expect.objectContaining({ file: "src/app.ts" })],
      }));
      expect(agent.isIdle()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the latest non-empty session.diff on older OpenCode versions", async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
      const internals = agent as unknown as OpenCodeInternals;
      internals.sessionId = "ses_source";
      internals.turnRevision = 1;
      internals.turnActive = true;
      internals.streamedContent = true;
      internals.eventSource = { destroy: vi.fn() };
      internals.httpGet = vi.fn(async () => {
        throw new Error("not found");
      });

      internals.handleSSEEvent("message.updated", {
        properties: { sessionID: "ses_source", info: { id: "msg_user_1", role: "user" } },
      });
      internals.handleSSEEvent("session.diff", {
        properties: {
          sessionID: "ses_source",
          diff: [{ file: "old.ts", before: "a\n", after: "b\n", additions: 1, deletions: 1 }],
        },
      });
      expect(events).not.toContainEqual(expect.objectContaining({ type: "diff_update" }));
      internals.handleSSEEvent("session.idle", {
        properties: { sessionID: "ses_source" },
      });
      await vi.advanceTimersByTimeAsync(801);

      expect(events).toContainEqual(expect.objectContaining({
        type: "diff_update",
        diffs: [expect.objectContaining({ file: "old.ts", patch: expect.stringContaining("-a\n+b") })],
      }));
      expect(agent.isIdle()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat an early empty REST diff as more authoritative than a non-empty SSE snapshot", async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
      const internals = agent as unknown as OpenCodeInternals;
      internals.sessionId = "ses_source";
      internals.turnRevision = 1;
      internals.turnActive = true;
      internals.streamedContent = true;
      internals.eventSource = { destroy: vi.fn() };
      internals.httpGet = vi.fn(async () => []);

      internals.handleSSEEvent("message.updated", {
        properties: { sessionID: "ses_source", info: { id: "msg_user_1", role: "user" } },
      });
      internals.handleSSEEvent("session.diff", {
        properties: {
          sessionID: "ses_source",
          diff: [{ file: "old.ts", before: "a", after: "b", additions: 1, deletions: 1 }],
        },
      });
      internals.handleSSEEvent("session.idle", {
        properties: { sessionID: "ses_source" },
      });
      await vi.advanceTimersByTimeAsync(801);

      expect(events).toContainEqual(expect.objectContaining({
        type: "diff_update",
        diffs: [expect.objectContaining({ file: "old.ts" })],
      }));
      expect(agent.isIdle()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a stale message-scoped diff mutate a newer turn", async () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    let resolveDiff!: (value: unknown) => void;
    internals.sessionId = "ses_source";
    internals.turnRevision = 1;
    internals.turnActive = true;
    internals.httpGet = vi.fn(() => new Promise((resolve) => {
      resolveDiff = resolve;
    }));

    const pending = internals.fetchTurnDiff("msg_user_old", 1);
    await Promise.resolve();
    internals.turnRevision = 2;
    internals.turnActive = true;
    resolveDiff([{ file: "old.ts", before: "a", after: "b", additions: 1, deletions: 1 }]);
    await pending;

    expect(events).not.toContainEqual(expect.objectContaining({ type: "diff_update" }));
  });

  it("cancels an in-flight idle diff settlement when the session becomes busy again", async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
      const internals = agent as unknown as OpenCodeInternals;
      let resolveDiff!: (value: unknown) => void;
      internals.sessionId = "ses_source";
      internals.turnRevision = 1;
      internals.turnActive = true;
      internals.streamedContent = true;
      internals.eventSource = { destroy: vi.fn() };
      internals.httpGet = vi.fn(() => new Promise((resolve) => {
        resolveDiff = resolve;
      }));

      internals.handleSSEEvent("message.updated", {
        properties: { sessionID: "ses_source", info: { id: "msg_user_1", role: "user" } },
      });
      internals.handleSSEEvent("session.idle", {
        properties: { sessionID: "ses_source" },
      });
      await vi.advanceTimersByTimeAsync(801);
      internals.handleSSEEvent("session.status", {
        properties: { sessionID: "ses_source", status: { type: "busy" } },
      });
      resolveDiff([{ file: "old.ts", before: "a", after: "b", additions: 1, deletions: 1 }]);
      await Promise.resolve();
      await Promise.resolve();

      expect(agent.isIdle()).toBe(false);
      expect(events).not.toContainEqual(expect.objectContaining({ type: "diff_update" }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: "agent_end" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("reschedules idle settlement when a tail delta arrives during the diff request", async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
      const internals = agent as unknown as OpenCodeInternals;
      let resolveFirst!: (value: unknown) => void;
      let calls = 0;
      internals.sessionId = "ses_source";
      internals.turnRevision = 1;
      internals.turnActive = true;
      internals.streamedContent = true;
      internals.eventSource = { destroy: vi.fn() };
      internals.httpGet = vi.fn(() => {
        calls += 1;
        if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
        return Promise.resolve([]);
      });

      internals.handleSSEEvent("message.updated", {
        properties: { sessionID: "ses_source", info: { id: "msg_user_1", role: "user" } },
      });
      internals.handleSSEEvent("session.idle", {
        properties: { sessionID: "ses_source" },
      });
      await vi.advanceTimersByTimeAsync(801);
      expect(internals.idleSettlementInFlight).toBe(true);
      internals.handleSSEEvent("message.part.delta", {
        properties: { sessionID: "ses_source", partID: "tail", field: "text", delta: "tail" },
      });
      resolveFirst([]);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(801);

      expect(calls).toBe(3);
      expect(agent.isIdle()).toBe(true);
      expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the assistant REST fallback when the session becomes busy again", async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
      const internals = agent as unknown as OpenCodeInternals;
      let resolveMessages!: (value: unknown) => void;
      internals.sessionId = "ses_source";
      internals.turnRevision = 1;
      internals.turnActive = true;
      internals.streamedContent = false;
      internals.eventSource = { destroy: vi.fn() };
      internals.httpGet = vi.fn((path) => path.includes("/diff?")
        ? Promise.resolve([])
        : new Promise((resolve) => { resolveMessages = resolve; }));

      internals.handleSSEEvent("message.updated", {
        properties: { sessionID: "ses_source", info: { id: "msg_user_1", role: "user" } },
      });
      internals.handleSSEEvent("session.idle", {
        properties: { sessionID: "ses_source" },
      });
      await vi.advanceTimersByTimeAsync(801);
      await Promise.resolve();
      internals.handleSSEEvent("session.status", {
        properties: { sessionID: "ses_source", status: { type: "busy" } },
      });
      resolveMessages([{
        info: { id: "msg_assistant_1", role: "assistant" },
        parts: [{ type: "text", text: "stale answer" }],
      }]);
      await Promise.resolve();
      await Promise.resolve();

      expect(agent.isIdle()).toBe(false);
      expect(events).not.toContainEqual(expect.objectContaining({ type: "stream_delta", delta: "stale answer" }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: "agent_end" }));
    } finally {
      vi.useRealTimers();
    }
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

  it("preserves cached file changes when an active turn is aborted", async () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    internals.sessionId = "ses_source";
    internals.turnRevision = 1;
    internals.turnActive = true;
    internals.httpPost = vi.fn(async () => true);
    internals.handleSSEEvent("session.diff", {
      properties: {
        sessionID: "ses_source",
        diff: [{
          file: "changed.ts",
          patch: "Index: changed.ts\n===\n--- changed.ts\n+++ changed.ts\n@@ -1 +1 @@\n-old\n+new",
          additions: 1,
          deletions: 1,
        }],
      },
    });

    await agent.abort();

    expect(events).toContainEqual(expect.objectContaining({
      type: "diff_update",
      diffs: [expect.objectContaining({ file: "changed.ts" })],
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: "aborted" }));
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
    internals.handleSSEEvent("session.diff", {
      properties: {
        sessionID: "ses_source",
        diff: [{
          file: "changed.ts",
          patch: "Index: changed.ts\n===\n--- changed.ts\n+++ changed.ts\n@@ -1 +1 @@\n-old\n+new",
          additions: 1,
          deletions: 1,
        }],
      },
    });

    internals.handleSSEEvent("session.error", {
      properties: {
        sessionID: "ses_source",
        error: { message: "request failed" },
      },
    });

    expect(eventSource.destroy).toHaveBeenCalledOnce();
    expect(agent.isIdle()).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "diff_update",
      diffs: [expect.objectContaining({ file: "changed.ts" })],
    }));
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

  it("defers guidance confirmation until OpenCode starts the steer response", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/session/ses_source/prompt_async") {
        response.writeHead(204);
        response.end();
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
    internals.turnActive = true;
    internals.eventSource = { destroy: vi.fn() };

    await agent.sendGuidance("重点检查 src/main.ts", undefined, { planModeEnabled: false });

    // prompt_async 只把引导排入队列，注入前旧回合的正文输出不得触发确认。
    internals.handleSSEEvent("message.updated", {
      properties: { sessionID: "ses_source", info: { id: "msg_old", role: "assistant" } },
    });
    internals.handleSSEEvent("message.part.updated", {
      properties: { sessionID: "ses_source", part: { type: "text", id: "part-old" }, delta: "still finishing" },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "guidance_response_started" }));

    // prompt_async 会立即发布 steer user 消息，但这只表示消息已入队，不能
    // 提前移动引导气泡。
    internals.handleSSEEvent("message.updated", {
      properties: { sessionID: "ses_source", info: { id: "msg_guidance", role: "user" } },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "guidance_response_started" }));

    // 即使 user 消息已经入队，旧 assistant 的尾部更新仍不算开始响应引导。
    internals.handleSSEEvent("message.updated", {
      properties: {
        sessionID: "ses_source",
        info: { id: "msg_old", role: "assistant", parentID: "msg_original_user" },
      },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "guidance_response_started" }));

    // OpenCode 在真正处理 steer 时创建 parentID 指向该 user 消息的新 assistant
    // 消息；此时才确认，引导气泡落在引导响应的开头。
    internals.handleSSEEvent("message.updated", {
      properties: {
        sessionID: "ses_source",
        info: { id: "msg_guidance_response", role: "assistant", parentID: "msg_guidance" },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "guidance_response_started" }));
    expect(internals.activeOpenCodeUserMessageId).toBe("msg_guidance");
  });

  it("keeps a steer response start that arrives before prompt_async resolves", async () => {
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const server = createServer((request, response) => {
      if (request.url === "/session/ses_source/prompt_async") {
        void promptGate.then(() => {
          response.writeHead(204);
          response.end();
        });
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
    internals.turnActive = true;
    internals.eventSource = { destroy: vi.fn() };

    // OpenCode 可能在 HTTP 204 返回前完成旧输出并开始 steer 对应的新 assistant
    // 消息。user 入队事件本身不能确认，但真正的响应开始事件不能因 IPC 时序丢失。
    const pending = agent.sendGuidance("steer", undefined, { planModeEnabled: false });
    internals.handleSSEEvent("message.updated", {
      properties: { sessionID: "ses_source", info: { id: "msg_guidance", role: "user" } },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "guidance_response_started" }));

    internals.handleSSEEvent("message.updated", {
      properties: {
        sessionID: "ses_source",
        info: { id: "msg_guidance_response", role: "assistant", parentID: "msg_guidance" },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "guidance_response_started" }));

    releasePrompt();
    await pending;
  });

  it("refuses guidance while the session is not running", async () => {
    const agent = new OpenCodeAgent();
    const internals = agent as unknown as OpenCodeInternals;
    internals.sessionId = "ses_source";
    internals.turnActive = false;

    await expect(agent.sendGuidance("steer", undefined, {})).rejects.toThrow("SESSION_NOT_RUNNING");
  });

  it("removes a late-recognized compaction message from diff attribution", () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    internals.sessionId = "ses_source";
    internals.turnActive = true;
    internals.eventSource = { destroy: vi.fn() };

    internals.handleSSEEvent("message.updated", {
      properties: { sessionID: "ses_source", info: { id: "msg_compact_user", role: "user" } },
    });
    expect(internals.activeOpenCodeUserMessageId).toBe("msg_compact_user");
    internals.handleSSEEvent("message.part.updated", {
      properties: {
        sessionID: "ses_source",
        part: { id: "part_compaction", messageID: "msg_compact_user", type: "compaction" },
      },
    });
    expect(internals.activeOpenCodeUserMessageId).toBeNull();
  });

  it("renders an OpenCode compaction summary as a context compaction divider, not conversation text", async () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    internals.sessionId = "ses_source";
    internals.turnActive = true;
    internals.eventSource = { destroy: vi.fn() };

    // OpenCode 会先创建 user 消息，再单独发布 compaction part。普通
    // message.updated 本身不能当成用户正文，也不能误判为压缩已完成。
    internals.handleSSEEvent("message.updated", {
      properties: { sessionID: "ses_source", info: { id: "msg_compact_user", role: "user" } },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "context_compaction" }));

    internals.handleSSEEvent("message.part.updated", {
      properties: {
        sessionID: "ses_source",
        part: {
          id: "part_compaction",
          messageID: "msg_compact_user",
          type: "compaction",
        },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "context_compaction",
      phase: "started",
      id: "msg_compact_user",
    }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "context_compaction", phase: "completed" }));

    events.length = 0;
    // OpenCode 先创建 summary 消息，再开始流式输出；创建消息不表示压缩
    // 已完成，且摘要正文不能进入普通 assistant stream。
    internals.handleSSEEvent("message.updated", {
      properties: {
        sessionID: "ses_source",
        info: {
          id: "msg_compact_summary",
          parentID: "msg_compact_user",
          role: "assistant",
          summary: true,
        },
      },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "context_compaction", phase: "completed" }));

    events.length = 0;
    internals.handleSSEEvent("message.part.delta", {
      properties: {
        sessionID: "ses_source",
        messageID: "msg_compact_summary",
        partID: "p1",
        field: "text",
        delta: "这是被压缩的摘要内容",
      },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "stream_delta" }));

    // 只有 summary 消息最终带上 finish 后，才结束压缩状态。
    internals.handleSSEEvent("message.updated", {
      properties: {
        sessionID: "ses_source",
        info: {
          id: "msg_compact_summary",
          parentID: "msg_compact_user",
          role: "assistant",
          summary: true,
          finish: "stop",
        },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "context_compaction",
      phase: "completed",
      id: "msg_compact_user",
    }));
  });

  it("does not replay a persisted compaction summary through the REST fallback", async () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    internals.sessionId = "ses_source";
    internals.turnActive = true;
    internals.eventSource = { destroy: vi.fn() };
    internals.httpGet = vi.fn(async () => [
      {
        info: { id: "old-assistant", role: "assistant" },
        parts: [{ type: "text", text: "旧的普通回复" }],
      },
      {
        info: { id: "msg_compact_user", role: "user" },
        parts: [{ type: "compaction" }],
      },
      {
        info: {
          id: "msg_compact_summary",
          parentID: "msg_compact_user",
          role: "assistant",
          summary: true,
          finish: "stop",
        },
        parts: [{ type: "text", text: "这段是内部压缩摘要，不应显示" }],
      },
    ]);

    await internals.fetchAssistantMessage();

    expect(events).not.toContainEqual(expect.objectContaining({
      type: "stream_delta",
      delta: expect.stringContaining("内部压缩摘要"),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "context_compaction",
      phase: "completed",
      id: "msg_compact_user",
    }));
  });
});
