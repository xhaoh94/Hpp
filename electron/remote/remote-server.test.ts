import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteChatMessage, RemoteRendererPublish } from "../../shared/remote-protocol";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "C:\\hpp-test",
    getPath: () => "C:\\hpp-test",
  },
  BrowserWindow: class {},
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
}));

import { remoteAccessServer } from "./remote-server";

type TestSocket = {
  authenticated: boolean;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
};

type TestServer = {
  applyRendererPublish: (update: RemoteRendererPublish) => void;
  handleRemoteRequest: (
    socket: { deviceId?: string },
    name: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  sendRendererCommand: (name: string, payload: Record<string, unknown>) => Promise<unknown>;
  sockets: Set<TestSocket>;
  catalog: unknown[];
  agents: unknown[];
  revisions: Map<string, number>;
  messages: Map<string, unknown[]>;
  queues: Map<string, unknown[]>;
  interactions: Map<string, unknown>;
  configs: Map<string, unknown>;
  rendererReady: boolean;
  commandResults: Map<string, Map<string, unknown>>;
  inFlightCommandResults: Map<string, Map<string, Promise<unknown>>>;
};

const server = remoteAccessServer as unknown as TestServer;

const createSnapshot = (sessionIds: string[] = ["session-1"]): RemoteRendererPublish => {
  const messages = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, [{
    id: `message-${sessionId}`,
    role: "assistant" as const,
    content: "完成",
    timestamp: 10,
    isStreaming: false,
    process: { startedAt: 1, endedAt: 10, entries: [] },
  }]]));
  const queues = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, [{
    id: `queue-${sessionId}`,
    sessionId,
    displayContent: "下一条",
    status: "queued" as const,
    createdAt: 11,
  }]]));
  const interactions = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, {
    sessionId,
    title: "请选择",
    questions: [],
  }]));
  const configs = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, {
    model: null,
    thinkingLevel: "medium",
    planModeEnabled: false,
    permissionMode: "auto" as const,
  }]));
  return {
    type: "snapshot",
    catalog: sessionIds.length === 0 ? [] : [{
      id: "project",
      name: "Project",
      createdAt: "2026-01-01T00:00:00.000Z",
      sessions: sessionIds.map((sessionId) => ({
        id: sessionId,
        agentId: "codex",
        title: sessionId,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
        closed: false,
        status: "idle",
      })),
    }],
    agents: [],
    messages,
    queues,
    interactions,
    configs,
  };
};

const decodeSentEvents = (socket: TestSocket) => socket.send.mock.calls.map(([value]) => JSON.parse(String(value)));

describe("remote renderer snapshot publishing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    server.sockets = new Set();
    server.catalog = [];
    server.agents = [];
    server.revisions = new Map();
    server.messages = new Map();
    server.queues = new Map();
    server.interactions = new Map();
    server.configs = new Map();
    server.rendererReady = false;
    server.commandResults = new Map();
    server.inFlightCommandResults = new Map();
  });

  it("does not advance revisions when no authenticated client can observe the snapshot", () => {
    server.revisions.set("session-1", 4);

    server.applyRendererPublish(createSnapshot());

    expect(server.revisions.get("session-1")).toBe(4);
    expect(server.messages.get("session-1")).toHaveLength(1);
    expect(server.queues.get("session-1")).toHaveLength(1);
  });

  it("broadcasts an authoritative session bundle with contiguous revisions", () => {
    const socket: TestSocket = { authenticated: true, readyState: 1, send: vi.fn() };
    server.sockets.add(socket);
    server.revisions.set("session-1", 5);
    const snapshot = createSnapshot();

    server.applyRendererPublish(snapshot);

    const events = decodeSentEvents(socket);
    expect(events.map((event) => event.name)).toEqual([
      "catalog.updated",
      "session.messages.replace",
      "session.queue.updated",
      "session.interaction.updated",
      "session.config.updated",
    ]);
    expect(events.map((event) => event.revision)).toEqual([undefined, 6, 7, 8, 9]);
    expect(events[1].payload).toEqual({
      sessionId: "session-1",
      messages: snapshot.type === "snapshot" ? snapshot.messages["session-1"] : [],
    });
    expect(events[2].payload).toEqual({
      sessionId: "session-1",
      queue: snapshot.type === "snapshot" ? snapshot.queues["session-1"] : [],
    });
    expect(events[3].payload).toEqual({
      sessionId: "session-1",
      interaction: snapshot.type === "snapshot" ? snapshot.interactions["session-1"] : null,
    });
    expect(events[4].payload).toEqual({
      sessionId: "session-1",
      config: snapshot.type === "snapshot" ? snapshot.configs["session-1"] : null,
    });
    expect(server.revisions.get("session-1")).toBe(9);
  });

  it("publishes the authoritative empty catalog and drops deleted session snapshots", () => {
    const socket: TestSocket = { authenticated: true, readyState: 1, send: vi.fn() };
    server.sockets.add(socket);
    server.applyRendererPublish(createSnapshot());
    socket.send.mockClear();

    server.applyRendererPublish(createSnapshot([]));

    const events = decodeSentEvents(socket);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "catalog.updated",
      payload: { projects: [] },
    });
    expect(server.messages.has("session-1")).toBe(false);
    expect(server.queues.has("session-1")).toBe(false);
    expect(server.interactions.has("session-1")).toBe(false);
    expect(server.configs.has("session-1")).toBe(false);
    expect(server.revisions.has("session-1")).toBe(false);
  });

  it("prunes catalog-deleted sessions and cannot resurrect their stale state", () => {
    const snapshot = createSnapshot();
    if (snapshot.type !== "snapshot") throw new Error("Expected snapshot fixture.");
    snapshot.messages["session-1"] = [{
      id: "stale-running-message",
      role: "assistant",
      content: "",
      timestamp: 10,
      isStreaming: true,
      process: { startedAt: 1, entries: [] },
    }];
    server.applyRendererPublish(snapshot);
    server.revisions.set("session-1", 17);

    server.applyRendererPublish({ type: "catalog", catalog: [], agents: [] });

    expect(server.messages.has("session-1")).toBe(false);
    expect(server.queues.has("session-1")).toBe(false);
    expect(server.interactions.has("session-1")).toBe(false);
    expect(server.configs.has("session-1")).toBe(false);
    expect(server.revisions.has("session-1")).toBe(false);

    const delayedStaleMessage = snapshot.messages["session-1"][0];
    server.applyRendererPublish({
      type: "session.message.upsert",
      sessionId: "session-1",
      message: delayedStaleMessage,
    });
    expect(server.messages.has("session-1")).toBe(false);
    expect(server.revisions.has("session-1")).toBe(false);

    server.applyRendererPublish({
      type: "catalog",
      catalog: snapshot.catalog,
      agents: snapshot.agents,
    });
    expect(server.messages.has("session-1")).toBe(false);
    expect(server.revisions.has("session-1")).toBe(false);

    const freshMessage: RemoteChatMessage = {
      id: "fresh-terminal-message",
      role: "assistant",
      content: "Done",
      timestamp: 20,
      isStreaming: false,
      process: { startedAt: 18, endedAt: 20, entries: [] },
    };
    server.applyRendererPublish({
      type: "session.message.upsert",
      sessionId: "session-1",
      message: freshMessage,
    });

    expect(server.messages.get("session-1")).toEqual([freshMessage]);
    expect(server.revisions.get("session-1")).toBe(1);
  });

  it("coalesces concurrent session.send retries until the first command settles", async () => {
    server.rendererReady = true;
    let resolveCommand!: (value: unknown) => void;
    const commandResult = new Promise<unknown>((resolve) => { resolveCommand = resolve; });
    const sendCommand = vi.spyOn(server, "sendRendererCommand").mockReturnValue(commandResult);
    const socket = { deviceId: "device-1" };
    const payload = { sessionId: "session-1", clientMessageId: "client-message-1", message: "hello" };

    const first = server.handleRemoteRequest(socket, "session.send", payload);
    const retry = server.handleRemoteRequest(socket, "session.send", payload);

    expect(sendCommand).toHaveBeenCalledTimes(1);
    resolveCommand({ accepted: true });
    await expect(Promise.all([first, retry])).resolves.toEqual([
      { accepted: true },
      { accepted: true },
    ]);
    await expect(server.handleRemoteRequest(socket, "session.send", payload))
      .resolves.toEqual({ accepted: true });
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it("clears a failed in-flight session.send so the device can retry", async () => {
    server.rendererReady = true;
    const sendCommand = vi.spyOn(server, "sendRendererCommand")
      .mockRejectedValueOnce(new Error("renderer unavailable"))
      .mockResolvedValueOnce({ accepted: true });
    const socket = { deviceId: "device-1" };
    const payload = { sessionId: "session-1", clientMessageId: "client-message-1", message: "hello" };

    await expect(server.handleRemoteRequest(socket, "session.send", payload))
      .rejects.toThrow("renderer unavailable");
    await expect(server.handleRemoteRequest(socket, "session.send", payload))
      .resolves.toEqual({ accepted: true });
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });
});
