import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  saveSessionModel,
  saveSessionThinking,
  saveSessionContextUsage,
  getSessionModel,
  getSessionThinking,
  getSessionContextUsage,
  purgeDeletedSessionData,
  DISK_USAGE_INVALIDATED_EVENT,
  SESSION_CONFIG_UPDATED_EVENT,
  SESSION_DATA_PURGED_EVENT,
  applyPersistedMessagesSnapshot,
  applyPersistedProjectSnapshot,
  parsePersistedChatMessage,
} from "./useDataPersistence";
import { useChatStore, type ChatMessage } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";

describe("session config change notifications", () => {
  const dispatchEvent = vi.fn();
  const saveData = vi.fn();
  const purgeSessionData = vi.fn(async () => ({ success: true }));

  beforeEach(() => {
    vi.useFakeTimers();
    dispatchEvent.mockReset();
    saveData.mockReset();
    purgeSessionData.mockClear();
    vi.stubGlobal("window", { dispatchEvent, electronAPI: { saveData, purgeSessionData } });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("notifies the remote bridge after saving a session model", () => {
    saveSessionModel("session-model", {
      id: "gpt-5",
      name: "GPT-5",
      provider: "openai",
      reasoning: true,
    });

    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent<{ sessionId: string }>;
    expect(event.type).toBe(SESSION_CONFIG_UPDATED_EVENT);
    expect(event.detail).toEqual({ sessionId: "session-model" });
  });

  it("persists the last context usage so a restart can still show it", () => {
    saveSessionContextUsage("session-ctx", {
      contextWindow: 300000,
      usedTokens: 160300,
      remainingTokens: 139700,
      usageRatio: 0.534,
      source: "estimated",
      estimated: true,
      model: { provider: "tanwan", id: "deepseek-v4-flash" },
      updatedAt: 1,
    });
    vi.advanceTimersByTime(600);

    const payload = saveData.mock.calls.map((call) => call[1]).find((data) => data && data.contextUsage);
    expect(payload?.contextUsage?.["session-ctx"]).toMatchObject({
      contextWindow: 300000,
      usedTokens: 160300,
    });

    // 清除后不应再写回旧值（例如压缩完成后用量归零）。
    saveSessionContextUsage("session-ctx", null);
    vi.advanceTimersByTime(600);
    const lastPayload = saveData.mock.calls.map((call) => call[1]).filter((data) => data && data.contextUsage).at(-1);
    expect(lastPayload?.contextUsage?.["session-ctx"]).toBeUndefined();
  });

  it("hands the persisted context usage back for the active session", () => {
    saveSessionContextUsage("session-ctx-get", {
      contextWindow: 1050000,
      usedTokens: 601849,
      source: "provider",
      estimated: false,
      updatedAt: 1,
    });
    expect(getSessionContextUsage("session-ctx-get")).toMatchObject({
      contextWindow: 1050000,
      usedTokens: 601849,
    });
    saveSessionContextUsage("session-ctx-get", null);
    expect(getSessionContextUsage("session-ctx-get")).toBeNull();
  });

  it("drops persisted context usage together with deleted sessions", async () => {
    saveSessionContextUsage("deleted-session", {
      contextWindow: 128000,
      usedTokens: 64000,
      source: "estimated",
      estimated: true,
      updatedAt: 1,
    });
    await purgeDeletedSessionData(["deleted-session"], []);
    vi.advanceTimersByTime(600);

    const lastPayload = saveData.mock.calls.map((call) => call[1]).filter((data) => data && data.contextUsage).at(-1);
    expect(lastPayload?.contextUsage?.["deleted-session"]).toBeUndefined();
  });

  it("purges deleted model caches and notifies in-memory history consumers", async () => {
    saveSessionModel("deleted-session", {
      id: "gpt-5",
      name: "GPT-5",
      provider: "openai",
      reasoning: true,
    });
    saveSessionThinking("deleted-session", "high");

    await expect(purgeDeletedSessionData(["deleted-session"], ["deleted-project"]))
      .resolves.toEqual({ success: true });

    expect(getSessionModel("deleted-session")).toBeNull();
    expect(getSessionThinking("deleted-session")).toBeNull();
    expect(purgeSessionData).toHaveBeenCalledWith({
      sessionIds: ["deleted-session"],
      projectIds: ["deleted-project"],
    });
    const purgeEvent = dispatchEvent.mock.calls
      .map(([event]) => event as CustomEvent)
      .find((event) => event.type === SESSION_DATA_PURGED_EVENT);
    expect(purgeEvent?.detail).toEqual({
      sessionIds: ["deleted-session"],
      projectIds: ["deleted-project"],
    });
    expect(dispatchEvent.mock.calls
      .map(([event]) => (event as CustomEvent).type))
      .toContain(DISK_USAGE_INVALIDATED_EVENT);
  });

  it("does not report disk usage invalidation when the atomic purge fails", async () => {
    purgeSessionData.mockResolvedValueOnce({ success: false, error: "disk locked" });

    await expect(purgeDeletedSessionData(["failed-session"]))
      .rejects.toThrow("disk locked");

    expect(dispatchEvent.mock.calls
      .map(([event]) => (event as CustomEvent).type))
      .not.toContain(DISK_USAGE_INVALIDATED_EVENT);
  });

  it("notifies the remote bridge after saving a thinking level", () => {
    saveSessionThinking("session-thinking", "high");

    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent<{ sessionId: string }>;
    expect(event.type).toBe(SESSION_CONFIG_UPDATED_EVENT);
    expect(event.detail).toEqual({ sessionId: "session-thinking" });
  });
});

describe("persisted composer snapshots", () => {
  it("drops surviving renderer runtime flags when applying persisted projects", () => {
    const project = {
      id: "project-hydrated",
      name: "Project",
      path: "C:\\project",
      createdAt: "2026-08-03T00:00:00.000Z",
      agents: ["codex"],
      sessions: [{
        id: "session-hydrated",
        agentId: "codex",
        agentSessionId: "session-hydrated",
        title: "Session",
        createdAt: "2026-08-03T00:00:00.000Z",
        lastActiveAt: "2026-08-03T00:00:00.000Z",
      }],
    };
    useProjectStore.setState({
      agentStatuses: { "session-hydrated": "running" },
      initializedSessionIds: new Set(["session-hydrated"]),
    });

    applyPersistedProjectSnapshot({
      projects: [project],
      activeProjectId: project.id,
      activeSessionId: "session-hydrated",
    });

    expect(useProjectStore.getState().agentStatuses).toEqual({});
    expect(useProjectStore.getState().initializedSessionIds.size).toBe(0);
    expect(useProjectStore.getState().projectDataHydrated).toBe(true);
  });

  it("atomically replaces a surviving active message array during hydration", () => {
    const staleMessage: ChatMessage = {
      id: "stale-active-process",
      role: "assistant",
      content: "",
      timestamp: 100,
      isStreaming: true,
      process: {
        startedAt: 100,
        expanded: true,
        entries: [{
          id: "stale-tool",
          type: "tool",
          title: "running",
          timestamp: 110,
          state: "running",
        }],
      },
    };
    const recoveredMessage = parsePersistedChatMessage(staleMessage);
    if (!recoveredMessage) throw new Error("expected persisted message");
    useChatStore.setState({
      activeSessionId: "session-hydrated",
      messages: [staleMessage],
      sessionMessages: { "session-hydrated": [staleMessage] },
      isStreaming: true,
      compactingSessions: { "session-hydrated": true },
    });

    applyPersistedMessagesSnapshot({ "session-hydrated": [recoveredMessage] }, "session-hydrated");

    const state = useChatStore.getState();
    expect(state.messages).toBe(state.sessionMessages["session-hydrated"]);
    expect(state.messages[0]).toMatchObject({
      isStreaming: false,
      process: {
        endedAt: 110,
        entries: [{ state: "interrupted" }],
      },
    });
    expect(state.isStreaming).toBe(false);
    expect(state.compactingSessions).toEqual({});
  });

  it("atomically clears surviving renderer messages when no valid disk snapshot is available", () => {
    const staleMessage: ChatMessage = {
      id: "stale-active-process",
      role: "assistant",
      content: "",
      timestamp: 100,
      isStreaming: true,
      process: {
        startedAt: 100,
        expanded: true,
        entries: [{
          id: "stale-tool",
          type: "tool",
          title: "running",
          timestamp: 110,
          state: "running",
        }],
      },
    };
    useChatStore.setState({
      activeSessionId: "session-hydrated",
      messages: [staleMessage],
      sessionMessages: { "session-hydrated": [staleMessage] },
      isStreaming: true,
      compactingSessions: { "session-hydrated": true },
    });

    applyPersistedMessagesSnapshot({}, "session-hydrated");

    const state = useChatStore.getState();
    expect(state.activeSessionId).toBe("session-hydrated");
    expect(state.messages).toEqual([]);
    expect(state.sessionMessages).toEqual({});
    expect(state.isStreaming).toBe(false);
    expect(state.compactingSessions).toEqual({});
  });

  it("restores a valid snapshot and discards a damaged one", () => {
    const base = { id: "message", role: "user", content: "display", timestamp: 1 };
    expect(parsePersistedChatMessage({
      ...base,
      composerDraft: {
        text: "raw",
        images: [],
        pendingFiles: [],
        pendingPathAttachments: [],
        sessionReferences: [],
        action: { kind: "skill", name: "review" },
      },
    })?.composerDraft).toMatchObject({ text: "raw", action: { kind: "skill", name: "review" } });
    expect(parsePersistedChatMessage({
      ...base,
      composerDraft: { text: "broken" },
    })?.composerDraft).toBeUndefined();
  });

  it("restores commentary without reviving its streaming indicator", () => {
    expect(parsePersistedChatMessage({
      id: "assistant",
      role: "assistant",
      content: "完成",
      timestamp: 2,
      commentary: [{
        id: "note",
        content: "正在检查。",
        timestamp: 1,
        isStreaming: true,
      }],
    })?.commentary).toEqual([{
      id: "note",
      content: "正在检查。",
      timestamp: 1,
      isStreaming: false,
    }]);
  });

  it("settles a persisted assistant process that cannot still be running after restart", () => {
    expect(parsePersistedChatMessage({
      id: "stale-process",
      role: "assistant",
      content: "已经完成",
      timestamp: 1_000,
      isStreaming: true,
      process: {
        startedAt: 900,
        expanded: true,
        entries: [{
          id: "thinking",
          type: "thinking",
          title: "正在思考",
          timestamp: 1_200,
          state: "running",
        }],
      },
    })).toMatchObject({
      isStreaming: false,
      process: {
        endedAt: 1_200,
        expanded: false,
        entries: [{ state: "completed" }],
      },
    });
  });

  it("repairs nested transient state even when the persisted process already has an end time", () => {
    expect(parsePersistedChatMessage({
      id: "inconsistent-process",
      role: "assistant",
      content: "已经完成",
      timestamp: 1_000,
      process: {
        startedAt: 900,
        endedAt: 1_100,
        expanded: true,
        entries: [{
          id: "subagent",
          type: "subagent",
          title: "子代理",
          timestamp: 1_050,
          state: "completed",
          subagents: [{ id: "child", label: "Child", status: "running" }],
        }],
        planSteps: [{ id: "step", title: "收尾", status: "pending" }],
      },
    })).toMatchObject({
      process: {
        endedAt: 1_100,
        expanded: false,
        entries: [{ state: "completed", subagents: [{ status: "completed" }] }],
        planSteps: [{ status: "completed" }],
      },
    });
  });

  it("uses only finite activity timestamps when recovering a process end time", () => {
    expect(parsePersistedChatMessage({
      id: "invalid-process-times",
      role: "assistant",
      content: "已经完成",
      timestamp: 1_000,
      commentary: [{ id: "note", content: "处理", timestamp: 1_100, isStreaming: true }],
      process: {
        startedAt: Number.NaN,
        endedAt: Number.POSITIVE_INFINITY,
        entries: [{
          id: "tool",
          type: "tool",
          title: "正在读取",
          timestamp: Number.POSITIVE_INFINITY,
          state: "running",
        }],
      },
    })?.process?.endedAt).toBe(1_100);

    expect(parsePersistedChatMessage({
      id: "invalid-message-time",
      role: "assistant",
      content: "",
      timestamp: Number.NaN,
    })).toBeNull();
  });

  it("keeps persisted subagent lifecycle entries", () => {
    expect(parsePersistedChatMessage({
      id: "assistant-subagent",
      role: "assistant",
      content: "done",
      timestamp: 3,
      process: {
        startedAt: 1,
        endedAt: 3,
        entries: [{
          id: "spawn",
          type: "subagent",
          title: "已开始工作",
          timestamp: 2,
          state: "completed",
          phase: "completed",
          action: "spawnAgent",
          subagents: [{ id: "thread-1", label: "Backend", status: "completed" }],
        }],
      },
    })?.process?.entries[0]).toEqual(expect.objectContaining({
      type: "subagent",
      phase: "completed",
      action: "spawnAgent",
      subagents: [{ id: "thread-1", label: "Backend", status: "completed" }],
    }));
  });
});
