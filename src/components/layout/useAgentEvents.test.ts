import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MANUAL_ABORT_TIMEOUT_MS,
  reconcileSurvivingOpenSessions,
  replayPendingUISnapshot,
  restorePendingUISnapshot,
  requestAgentAbortWithTimeout,
} from "./useAgentEvents";
import { useProjectStore } from "@/stores/project-store";
import { useChatStore } from "@/stores/chat-store";

afterEach(() => {
  vi.useRealTimers();
});

describe("requestAgentAbortWithTimeout", () => {
  it("settles renderer state when the abort IPC never resolves", async () => {
    vi.useFakeTimers();
    const requestAbort = vi.fn(() => new Promise<{ success: boolean }>(() => undefined));
    const onSettled = vi.fn();

    const result = requestAgentAbortWithTimeout("session-1", requestAbort, onSettled);
    const rejection = expect(result).rejects.toThrow("Agent abort request timed out");
    await vi.advanceTimersByTimeAsync(MANUAL_ABORT_TIMEOUT_MS);
    await rejection;

    expect(requestAbort).toHaveBeenCalledWith("session-1");
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout after the abort IPC resolves", async () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();

    await expect(requestAgentAbortWithTimeout(
      "session-1",
      vi.fn().mockResolvedValue({ success: true }),
      onSettled,
    )).resolves.toEqual({ success: true });

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("surviving renderer session reconciliation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recovers busy and idle background backends without recreating missing or uncertain ones", async () => {
    const sessionIds = ["busy", "idle", "missing", "unknown"];
    useProjectStore.setState({
      projects: [{
        id: "project",
        name: "Project",
        path: "C:\\project",
        createdAt: "2026-08-03T00:00:00.000Z",
        agents: ["codex"],
        sessions: sessionIds.map((id) => ({
          id,
          agentId: "codex",
          agentSessionId: id,
          title: id,
          createdAt: "2026-08-03T00:00:00.000Z",
          lastActiveAt: "2026-08-03T00:00:00.000Z",
        })),
      }],
      activeProjectId: "project",
      activeSessionId: "busy",
      initializedSessionIds: new Set(["missing", "unknown"]),
      agentStatuses: { missing: "running", unknown: "running" },
    });
    useChatStore.setState({
      activeSessionId: "busy",
      messages: [],
      sessionMessages: Object.fromEntries(sessionIds.map((id) => [id, []])),
      isStreaming: false,
      compactingSessions: {},
    });
    const states = {
      busy: { success: true, idle: false },
      idle: { success: true, idle: true },
      missing: { success: false, idle: true },
      unknown: { success: true, idle: false, stale: true },
    };
    vi.stubGlobal("window", {
      electronAPI: {
        agentGetSessionState: vi.fn(async (sessionId: keyof typeof states) => states[sessionId]),
      },
    });
    const ensureAssistantContinuation = vi.fn();
    const finishIdleBackendTurn = vi.fn();

    await reconcileSurvivingOpenSessions(sessionIds, {
      ensureAssistantContinuation,
      finishIdleBackendTurn,
    });

    expect(ensureAssistantContinuation).toHaveBeenCalledWith("busy");
    expect(finishIdleBackendTurn).toHaveBeenCalledWith("idle");
    expect(useProjectStore.getState().initializedSessionIds.has("busy")).toBe(true);
    expect(useProjectStore.getState().initializedSessionIds.has("idle")).toBe(true);
    expect(useProjectStore.getState().initializedSessionIds.has("missing")).toBe(false);
    expect(useProjectStore.getState().initializedSessionIds.has("unknown")).toBe(true);
    expect(useProjectStore.getState().agentStatuses.missing).toBe("idle");
    expect(useProjectStore.getState().agentStatuses.unknown).toBe("running");
  });

  it("bounds simultaneous backend recovery probes", async () => {
    const sessionIds = Array.from({ length: 9 }, (_, index) => `session-${index}`);
    useProjectStore.setState({
      projects: [{
        id: "project",
        name: "Project",
        path: "C:\\project",
        createdAt: "2026-08-03T00:00:00.000Z",
        agents: ["codex"],
        sessions: sessionIds.map((id) => ({
          id,
          agentId: "codex",
          agentSessionId: id,
          title: id,
          createdAt: "2026-08-03T00:00:00.000Z",
          lastActiveAt: "2026-08-03T00:00:00.000Z",
        })),
      }],
      initializedSessionIds: new Set(),
      agentStatuses: {},
    });
    useChatStore.setState({
      messages: [],
      sessionMessages: Object.fromEntries(sessionIds.map((id) => [id, []])),
      compactingSessions: {},
    });
    let inFlight = 0;
    let maximumInFlight = 0;
    vi.stubGlobal("window", {
      electronAPI: {
        agentGetSessionState: vi.fn(async () => {
          inFlight += 1;
          maximumInFlight = Math.max(maximumInFlight, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          return { success: false, idle: true };
        }),
      },
    });

    await reconcileSurvivingOpenSessions(sessionIds, {
      ensureAssistantContinuation: vi.fn(),
      finishIdleBackendTurn: vi.fn(),
    });

    expect(maximumInFlight).toBe(4);
  });

  it("replays cached UI requests only for a surviving busy backend", async () => {
    const sessionIds = ["busy-question", "idle-question"];
    useProjectStore.setState({
      projects: [{
        id: "project",
        name: "Project",
        path: "C:\\project",
        createdAt: "2026-08-03T00:00:00.000Z",
        agents: ["codex"],
        sessions: sessionIds.map((id) => ({
          id,
          agentId: "codex",
          agentSessionId: id,
          title: id,
          createdAt: "2026-08-03T00:00:00.000Z",
          lastActiveAt: "2026-08-03T00:00:00.000Z",
        })),
      }],
      initializedSessionIds: new Set(),
      agentStatuses: {},
    });
    useChatStore.setState({
      messages: [],
      sessionMessages: Object.fromEntries(sessionIds.map((id) => [id, []])),
      compactingSessions: {},
    });
    const pendingRequest = {
      type: "process_event",
      entryType: "question",
      requestId: "question-1",
      sessionId: "busy-question",
      state: "running",
    };
    const getPendingUIRequests = vi.fn(async () => ({ revision: 1, requests: [pendingRequest] }));
    vi.stubGlobal("window", {
      electronAPI: {
        agentGetSessionState: vi.fn(async (sessionId: string) => ({
          success: true,
          idle: sessionId === "idle-question",
        })),
        agentGetPendingUIRequests: getPendingUIRequests,
      },
    });
    const replayPendingUIRequests = vi.fn();

    await reconcileSurvivingOpenSessions(sessionIds, {
      ensureAssistantContinuation: vi.fn(),
      finishIdleBackendTurn: vi.fn(),
      replayPendingUIRequests,
    });

    expect(getPendingUIRequests).toHaveBeenCalledTimes(1);
    expect(getPendingUIRequests).toHaveBeenCalledWith("busy-question");
    expect(replayPendingUIRequests).toHaveBeenCalledWith("busy-question", {
      revision: 1,
      requests: [pendingRequest],
    });
  });

  it("does not replay a snapshot older than a live terminal event", () => {
    const dispatch = vi.fn();
    const snapshot = {
      revision: 4,
      requests: [{
        type: "process_event",
        entryType: "question",
        requestId: "question-1",
        sessionId: "session-a",
        state: "running",
      }],
    };

    expect(replayPendingUISnapshot(snapshot, 5, dispatch)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(replayPendingUISnapshot(snapshot, 4, dispatch)).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("re-queries a stale snapshot so an unaffected pending request is not lost", async () => {
    const dispatch = vi.fn();
    const getLatestSnapshot = vi.fn().mockResolvedValue({
      revision: 5,
      requests: [{
        type: "process_event",
        entryType: "question",
        requestId: "question-2",
        sessionId: "session-a",
        state: "running",
      }],
    });

    await expect(restorePendingUISnapshot(
      "session-a",
      {
        revision: 4,
        requests: [{
          type: "process_event",
          entryType: "question",
          requestId: "question-1",
          sessionId: "session-a",
          state: "running",
        }],
      },
      () => 5,
      getLatestSnapshot,
      dispatch,
    )).resolves.toBe(5);

    expect(getLatestSnapshot).toHaveBeenCalledWith("session-a");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ requestId: "question-2" }));
  });

  it("does not inflate a stale missing backend process duration to recovery time", async () => {
    const sessionId = "missing-with-old-process";
    useProjectStore.setState({
      projects: [{
        id: "project",
        name: "Project",
        path: "C:\\project",
        createdAt: "2026-08-03T00:00:00.000Z",
        agents: ["codex"],
        sessions: [{
          id: sessionId,
          agentId: "codex",
          agentSessionId: sessionId,
          title: sessionId,
          createdAt: "2026-08-03T00:00:00.000Z",
          lastActiveAt: "2026-08-03T00:00:00.000Z",
        }],
      }],
      initializedSessionIds: new Set([sessionId]),
      agentStatuses: { [sessionId]: "running" },
    });
    useChatStore.setState({
      activeSessionId: null,
      messages: [],
      sessionMessages: {
        [sessionId]: [{
          id: "old-process",
          role: "assistant",
          content: "",
          timestamp: 100,
          isStreaming: true,
          process: {
            startedAt: 100,
            entries: [{
              id: "old-tool",
              type: "tool",
              title: "running",
              timestamp: 150,
              state: "running",
            }],
          },
        }],
      },
      compactingSessions: {},
    });
    vi.stubGlobal("window", {
      electronAPI: {
        agentGetSessionState: vi.fn().mockResolvedValue({ success: false, idle: true }),
      },
    });

    await reconcileSurvivingOpenSessions([sessionId], {
      ensureAssistantContinuation: vi.fn(),
      finishIdleBackendTurn: vi.fn(),
    });

    expect(useChatStore.getState().sessionMessages[sessionId][0]).toMatchObject({
      isStreaming: false,
      process: {
        endedAt: 150,
        entries: [{ state: "interrupted" }],
      },
    });
  });
});
