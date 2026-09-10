import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/stores/chat-store";
import { useProjectStore, type ProjectSession } from "@/stores/project-store";
import { setAgentCatalog } from "@/lib/agents";
import {
  IDLE_SESSION_RUNTIME_RELEASE_MS,
  scanIdleSessionRuntimes,
} from "@/hooks/useIdleSessionRuntimeRelease";
import { releaseIdleSessionRuntime } from "@/lib/session-command-coordinator";

const session = (id: string): ProjectSession => ({
  id,
  agentId: "codex",
  agentSessionId: id,
  title: id,
  createdAt: "2026-07-17T00:00:00.000Z",
  lastActiveAt: "2026-07-17T00:00:00.000Z",
});

const electronAPI = {
  agentGetSessionState: vi.fn(async () => ({ success: true, idle: true })),
  agentGetPendingUIRequests: vi.fn(async () => ({ revision: 0, requests: [] })),
  agentRemoveSession: vi.fn(async () => ({ success: true })),
  agentSwitchSession: vi.fn(async () => ({ success: true })),
  agentGetModels: vi.fn(async () => []),
  saveData: vi.fn(async () => ({ success: true })),
  loadData: vi.fn(async () => null),
};

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const STALE = new Date(NOW - IDLE_SESSION_RUNTIME_RELEASE_MS - 60_000).toISOString();
const FRESH = new Date(NOW - 1_000).toISOString();

describe("releaseIdleSessionRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", { electronAPI, dispatchEvent: vi.fn() });
    setAgentCatalog([{
      id: "codex",
      name: "Codex",
      version: "1.0.0",
      minHppVersion: "0.1.0",
      runtime: "cli",
      order: 1,
      source: "plugin",
      removable: false,
      capabilities: {
        planMode: "native",
        permissions: true,
        guidance: true,
        fork: false,
        actions: true,
        configuration: "none",
        providerActivation: "none",
      },
    }]);
    const idle = { ...session("session-idle"), lastActiveAt: STALE };
    const active = session("session-active");
    useProjectStore.setState({
      projects: [{
        id: "project",
        name: "Project",
        path: "C:\\project",
        createdAt: idle.createdAt,
        agents: ["codex"],
        sessions: [idle, active],
      }],
      activeProjectId: "project",
      activeSessionId: active.id,
      agentStatuses: {},
      initializedSessionIds: new Set([idle.id, active.id]),
    });
    useChatStore.setState({
      messages: [],
      sessionMessages: { [idle.id]: [], [active.id]: [] },
      activeSessionId: active.id,
      isStreaming: false,
      currentModel: null,
      availableModels: [],
      thinkingLevel: "medium",
      messageQueues: {},
      compactingSessions: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    setAgentCatalog([]);
  });

  it("releases an idle non-active session backend but keeps the tab", async () => {
    await expect(releaseIdleSessionRuntime("session-idle")).resolves.toEqual({ released: true });
    expect(electronAPI.agentRemoveSession).toHaveBeenCalledWith("session-idle");
    const projectState = useProjectStore.getState();
    expect(projectState.initializedSessionIds.has("session-idle")).toBe(false);
    // 会话本身仍然存在，只是后端被回收；重新初始化时会走既有的懒加载通路。
    expect(projectState.projects[0].sessions.map((item) => item.id)).toEqual(["session-idle", "session-active"]);
    expect(projectState.projects[0].sessions[0].closed).toBeUndefined();
  });

  it("never releases the active session backend", async () => {
    await expect(releaseIdleSessionRuntime("session-active")).resolves.toEqual({
      released: false,
      reason: "active",
    });
    expect(electronAPI.agentRemoveSession).not.toHaveBeenCalled();
    expect(useProjectStore.getState().initializedSessionIds.has("session-active")).toBe(true);
  });

  it("keeps a backend that is still busy with a turn", async () => {
    electronAPI.agentGetSessionState.mockResolvedValueOnce({ success: true, idle: false });
    await expect(releaseIdleSessionRuntime("session-idle")).resolves.toEqual({
      released: false,
      reason: "running",
    });
    expect(electronAPI.agentRemoveSession).not.toHaveBeenCalled();
  });

  it("keeps a backend that still owes the user an interaction response", async () => {
    electronAPI.agentGetPendingUIRequests.mockResolvedValueOnce({
      revision: 3,
      requests: [{ type: "permission_request", requestId: "r1" }],
    });
    await expect(releaseIdleSessionRuntime("session-idle")).resolves.toEqual({
      released: false,
      reason: "pending-interaction",
    });
    expect(electronAPI.agentRemoveSession).not.toHaveBeenCalled();
  });

  it("clears the initialized flag when the backend is already gone", async () => {
    electronAPI.agentGetSessionState.mockResolvedValueOnce({ success: false, idle: true });
    await expect(releaseIdleSessionRuntime("session-idle")).resolves.toEqual({
      released: false,
      reason: "missing",
    });
    expect(electronAPI.agentRemoveSession).not.toHaveBeenCalled();
    expect(useProjectStore.getState().initializedSessionIds.has("session-idle")).toBe(false);
  });
});

describe("scanIdleSessionRuntimes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", { electronAPI, dispatchEvent: vi.fn() });
    const stale = { ...session("session-stale"), lastActiveAt: STALE };
    const fresh = { ...session("session-fresh"), lastActiveAt: FRESH };
    const queued = { ...session("session-queued"), lastActiveAt: STALE };
    const closed = { ...session("session-closed"), lastActiveAt: STALE, closed: true };
    const active = session("session-active");
    useProjectStore.setState({
      projects: [{
        id: "project",
        name: "Project",
        path: "C:\\project",
        createdAt: active.createdAt,
        agents: ["codex"],
        sessions: [stale, fresh, queued, closed, active],
      }],
      activeProjectId: "project",
      activeSessionId: active.id,
      agentStatuses: {},
      initializedSessionIds: new Set([stale.id, fresh.id, queued.id, closed.id, active.id]),
    });
    useChatStore.setState({
      messages: [],
      sessionMessages: {
        [stale.id]: [],
        [fresh.id]: [],
        [queued.id]: [{ id: "m1", role: "user", content: "hi", timestamp: NOW - 1_000 }],
        [closed.id]: [],
        [active.id]: [],
      },
      activeSessionId: active.id,
      isStreaming: false,
      currentModel: null,
      availableModels: [],
      thinkingLevel: "medium",
      messageQueues: {
        [queued.id]: [{
          id: "q1",
          sessionId: queued.id,
          content: "queued",
          timestamp: NOW,
        } as never],
      },
      compactingSessions: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("releases only sessions that are open, initialized and idle past the threshold", async () => {
    await expect(scanIdleSessionRuntimes(NOW)).resolves.toEqual(["session-stale"]);
    expect(electronAPI.agentRemoveSession).toHaveBeenCalledTimes(1);
    expect(electronAPI.agentRemoveSession).toHaveBeenCalledWith("session-stale");
  });

  it("skips a session whose backend reports an unfinished turn", async () => {
    electronAPI.agentGetSessionState.mockResolvedValue({ success: true, idle: false });
    await expect(scanIdleSessionRuntimes(NOW)).resolves.toEqual([]);
    expect(electronAPI.agentRemoveSession).not.toHaveBeenCalled();
  });

  it("skips a session that is still streaming in the background", async () => {
    useProjectStore.setState({ agentStatuses: { "session-stale": "running" } });
    await expect(scanIdleSessionRuntimes(NOW)).resolves.toEqual([]);
    expect(electronAPI.agentGetSessionState).not.toHaveBeenCalled();
    expect(electronAPI.agentRemoveSession).not.toHaveBeenCalled();
  });
});
