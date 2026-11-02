import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/stores/chat-store";
import { useProjectStore, type ProjectSession } from "@/stores/project-store";
import { setAgentCatalog } from "@/lib/agents";
import {
  IDLE_SESSION_RUNTIME_RELEASE_MS,
  WARM_SESSION_EVICT_GRACE_MS,
  WARM_SESSION_POOL_MAX,
  scanIdleSessionRuntimes,
} from "@/hooks/useIdleSessionRuntimeRelease";
import { releaseIdleSessionRuntime } from "@/lib/session-command-coordinator";

const session = (
  id: string,
  lastActiveAt = "2026-07-17T00:00:00.000Z",
): ProjectSession => ({
  id,
  agentId: "codex",
  agentSessionId: id,
  title: id,
  createdAt: "2026-07-17T00:00:00.000Z",
  lastActiveAt,
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
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const STALE = ago(IDLE_SESSION_RUNTIME_RELEASE_MS + 60_000);
const FRESH = ago(1_000);
const MINUTE = 60_000;

const installState = (
  sessions: ProjectSession[],
  activeSessionId: string,
  initializedSessionIds: string[] = sessions.map((item) => item.id),
) => {
  useProjectStore.setState({
    projects: [{
      id: "project",
      name: "Project",
      path: "C:\\project",
      createdAt: sessions[0]?.createdAt || new Date(NOW).toISOString(),
      agents: ["codex"],
      sessions,
    }],
    activeProjectId: "project",
    activeSessionId,
    agentStatuses: {},
    initializedSessionIds: new Set(initializedSessionIds),
  });
  useChatStore.setState({
    messages: [],
    sessionMessages: Object.fromEntries(sessions.map((item) => [item.id, []])),
    sessionMessagesLoaded: {},
    activeSessionId,
    isStreaming: false,
    currentModel: null,
    availableModels: [],
    thinkingLevel: "medium",
    messageQueues: {},
    compactingSessions: {},
  });
};

describe("releaseIdleSessionRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronAPI.agentGetSessionState.mockResolvedValue({ success: true, idle: true });
    electronAPI.agentGetPendingUIRequests.mockResolvedValue({ revision: 0, requests: [] });
    electronAPI.agentRemoveSession.mockResolvedValue({ success: true });
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
    const idle = session("session-idle", STALE);
    const active = session("session-active");
    installState([idle, active], active.id);
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

describe("scanIdleSessionRuntimes (LRU warm pool)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronAPI.agentGetSessionState.mockResolvedValue({ success: true, idle: true });
    electronAPI.agentGetPendingUIRequests.mockResolvedValue({ revision: 0, requests: [] });
    electronAPI.agentRemoveSession.mockResolvedValue({ success: true });
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    setAgentCatalog([]);
  });

  it("releases only sessions that are open, initialized and past the fallback TTL", async () => {
    const active = session("session-active");
    installState([
      session("session-stale", STALE),
      session("session-fresh", FRESH),
      session("session-queued", STALE),
      { ...session("session-closed", STALE), closed: true },
      active,
    ], active.id);
    useChatStore.setState({
      messageQueues: {
        "session-queued": [{
          id: "q1",
          sessionId: "session-queued",
          content: "queued",
          timestamp: NOW,
        } as never],
      },
    });

    await expect(scanIdleSessionRuntimes(NOW)).resolves.toEqual(["session-stale"]);
    expect(electronAPI.agentRemoveSession).toHaveBeenCalledTimes(1);
    expect(electronAPI.agentRemoveSession).toHaveBeenCalledWith("session-stale");
  });

  it("keeps sessions warm while the pool has room", async () => {
    const active = session("session-active");
    installState([
      session("session-a", ago(60 * MINUTE)),
      session("session-b", ago(30 * MINUTE)),
      active,
    ], active.id);

    await expect(scanIdleSessionRuntimes(NOW)).resolves.toEqual([]);
    expect(electronAPI.agentRemoveSession).not.toHaveBeenCalled();
  });

  it("evicts the least recently used sessions when the warm pool overflows", async () => {
    const sessions = Array.from({ length: WARM_SESSION_POOL_MAX + 2 }, (_, index) => (
      session(`session-${index}`, ago((index + 1) * 10 * MINUTE))
    ));
    installState(sessions, "session-0");

    await expect(scanIdleSessionRuntimes(NOW)).resolves.toEqual([
      `session-${WARM_SESSION_POOL_MAX + 1}`,
      `session-${WARM_SESSION_POOL_MAX}`,
    ]);
    expect(electronAPI.agentRemoveSession).toHaveBeenCalledTimes(2);
  });

  it("keeps sessions that were just used even when the pool overflows", async () => {
    const sessions = Array.from({ length: WARM_SESSION_POOL_MAX + 2 }, (_, index) => (
      session(`session-${index}`, ago(30_000))
    ));
    installState(sessions, "session-0");

    await expect(scanIdleSessionRuntimes(NOW)).resolves.toEqual([]);
    expect(electronAPI.agentRemoveSession).not.toHaveBeenCalled();
  });

  it("releases a session past the fallback TTL even when the pool has room", async () => {
    const active = session("session-active");
    installState([
      session("session-abandoned", STALE),
      active,
    ], active.id);

    await expect(scanIdleSessionRuntimes(NOW)).resolves.toEqual(["session-abandoned"]);
  });

  it("never releases the active session, even when it is the stalest", async () => {
    const active = session("session-active", STALE);
    installState([
      active,
      session("session-b", ago(10 * MINUTE)),
    ], active.id);

    await expect(scanIdleSessionRuntimes(NOW)).resolves.toEqual([]);
    expect(electronAPI.agentRemoveSession).not.toHaveBeenCalled();
  });

  it("skips a session whose backend reports an unfinished turn", async () => {
    const active = session("session-active");
    installState([session("session-stale", STALE), active], active.id);
    electronAPI.agentGetSessionState.mockResolvedValueOnce({ success: true, idle: false });

    await expect(scanIdleSessionRuntimes(NOW)).resolves.toEqual([]);
    expect(electronAPI.agentRemoveSession).not.toHaveBeenCalled();
  });

  it("skips a session that is still streaming in the background", async () => {
    const active = session("session-active");
    installState([session("session-stale", STALE), active], active.id);
    useProjectStore.setState({ agentStatuses: { "session-stale": "running" } });

    await expect(scanIdleSessionRuntimes(NOW)).resolves.toEqual([]);
    expect(electronAPI.agentGetSessionState).not.toHaveBeenCalled();
    expect(electronAPI.agentRemoveSession).not.toHaveBeenCalled();
  });

  it("releases the oldest warm sessions in LRU order", async () => {
    const sessions = Array.from({ length: WARM_SESSION_POOL_MAX + 3 }, (_, index) => (
      session(`session-${index}`, ago((index + 1) * 5 * MINUTE))
    ));
    installState(sessions, "session-0");

    await expect(scanIdleSessionRuntimes(NOW)).resolves.toEqual([
      `session-${WARM_SESSION_POOL_MAX + 2}`,
      `session-${WARM_SESSION_POOL_MAX + 1}`,
      `session-${WARM_SESSION_POOL_MAX}`,
    ]);
  });
});
