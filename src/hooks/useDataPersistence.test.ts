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
  canReplaceSessionMessageRows,
  ensureSessionMessagesLoaded,
  loadOlderSessionMessages,
  parsePersistedChatMessage,
  parsePersistedData,
  pickDefaultActiveSessionId,
  resolveHydratedActiveSessionId,
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
      source: "exact",
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

describe("启动时默认选中第一个会话", () => {
  const makeSession = (id: string, closed = false) => ({
    id,
    agentId: "codex",
    agentSessionId: id,
    title: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    ...(closed ? { closed: true } : {}),
  });
  const makeProject = (id: string, sessions: ReturnType<typeof makeSession>[]) => ({
    id,
    name: id,
    path: `C:\\${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    agents: ["codex"],
    sessions,
  });

  it("没有恢复出活动会话时选中第一个未关闭会话", () => {
    const projects = [
      makeProject("project-1", [makeSession("archived-1", true)]),
      makeProject("project-2", [makeSession("session-2a"), makeSession("session-2b")]),
    ];

    // 已归档会话不在卡片里渲染，不能作为默认选中目标。
    expect(pickDefaultActiveSessionId(projects)).toBe("session-2a");
    expect(resolveHydratedActiveSessionId({
      projects,
      activeProjectId: null,
      activeSessionId: null,
    })).toBe("session-2a");
  });

  it("保留已经恢复的活动会话，不改选其它会话", () => {
    const projects = [makeProject("project-1", [makeSession("session-1"), makeSession("session-2")])];

    expect(resolveHydratedActiveSessionId({
      projects,
      activeProjectId: "project-1",
      activeSessionId: "session-2",
    })).toBe("session-2");
  });

  it("所有会话都已归档时不自动选中", () => {
    expect(resolveHydratedActiveSessionId({
      projects: [makeProject("project-1", [makeSession("archived-1", true)])],
      activeProjectId: null,
      activeSessionId: null,
    })).toBeNull();
  });

  it("自动选中的会话所属项目会同步成为活动项目（侧栏因此展开该项目卡片）", () => {
    const projects = [
      makeProject("project-1", []),
      makeProject("project-2", [makeSession("session-2a")]),
    ];

    const activeSessionId = resolveHydratedActiveSessionId({
      projects,
      activeProjectId: null,
      activeSessionId: null,
    });
    applyPersistedProjectSnapshot({ projects, activeProjectId: null, activeSessionId });

    const state = useProjectStore.getState();
    expect(state.activeSessionId).toBe("session-2a");
    expect(state.activeProjectId).toBe("project-2");
  });
});

describe("会话标题在正文加载前也要可读", () => {
  const makeSession = (overrides: Record<string, unknown> = {}) => ({
    id: "session-one",
    agentId: "codex",
    agentSessionId: "session-one",
    title: "新会话 - 2025/10/15 21:26",
    createdAt: "2025-10-15T13:26:00.000Z",
    lastActiveAt: "2025-10-15T13:26:00.000Z",
    ...overrides,
  });
  const parseFirstSession = (session: Record<string, unknown>) => parsePersistedData({
    projects: [{
      id: "project-one",
      name: "project-one",
      path: "C:\\project-one",
      createdAt: "2025-10-15T13:26:00.000Z",
      agents: ["codex"],
      sessions: [session],
    }],
  })?.projects[0]?.sessions[0];

  it("把仍是占位标题的旧数据迁移成首条用户消息预览", () => {
    expect(parseFirstSession(makeSession({ preview: "修复侧栏会话标题" }))?.title)
      .toBe("修复侧栏会话标题");
  });

  it("已有真实标题或分叉标题不会被 preview 覆盖", () => {
    expect(parseFirstSession(makeSession({ title: "修复侧栏会话标题", preview: "另一个请求" }))?.title)
      .toBe("修复侧栏会话标题");
    expect(parseFirstSession(makeSession({ title: "分叉 - 修复侧栏会话标题", preview: "修复侧栏会话标题" }))?.title)
      .toBe("分叉 - 修复侧栏会话标题");
  });

  it("没有 preview 时保持占位标题，等首条用户消息落盘后再迁移", () => {
    expect(parseFirstSession(makeSession())?.title).toBe("新会话 - 2025/10/15 21:26");
  });
});

describe("按需恢复会话消息", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("只读取目标会话一次，并按分页顺序合并更早消息", async () => {
    const loadPage = vi.fn()
      .mockResolvedValueOnce({
        messages: [
          { id: "message-4", role: "user", content: "第四条", timestamp: 4 },
          { id: "message-5", role: "assistant", content: "第五条", timestamp: 5 },
        ],
        hasMore: true,
        nextBefore: 4,
        firstSequence: 4,
      })
      .mockResolvedValueOnce({
        messages: [
          { id: "message-1", role: "user", content: "第一条", timestamp: 1 },
          { id: "message-2", role: "assistant", content: "第二条", timestamp: 2 },
          { id: "message-3", role: "user", content: "第三条", timestamp: 3 },
        ],
        hasMore: false,
        nextBefore: null,
        firstSequence: 1,
      });
    vi.stubGlobal("window", { electronAPI: { loadSessionMessagesPage: loadPage } });
    useChatStore.setState({ activeSessionId: null, messages: [], sessionMessages: {} });

    await expect(ensureSessionMessagesLoaded("session-on-demand")).resolves.toBe(true);
    await expect(ensureSessionMessagesLoaded("session-on-demand")).resolves.toBe(true);
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().sessionMessages["session-on-demand"]?.map((message) => message.id))
      .toEqual(["message-4", "message-5"]);

    await expect(loadOlderSessionMessages("session-on-demand")).resolves.toBe(true);
    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().sessionMessages["session-on-demand"]?.map((message) => message.id))
      .toEqual(["message-1", "message-2", "message-3", "message-4", "message-5"]);
  });
});

describe("分页会话的落盘保护", () => {
  it("只有完整加载且读取成功的会话才允许整段替换", () => {
    // 未加载过（内存里只有零散快照）时不能 replace。
    expect(canReplaceSessionMessageRows(undefined)).toBe(false);
    expect(canReplaceSessionMessageRows({ loaded: false, loadFailed: false, hasMore: false })).toBe(false);
    // 读取失败时不能用空数组覆盖磁盘。
    expect(canReplaceSessionMessageRows({ loaded: true, loadFailed: true, hasMore: false })).toBe(false);
    // 只加载了最近一页时，磁盘里还有更早的消息。
    expect(canReplaceSessionMessageRows({ loaded: true, loadFailed: false, hasMore: true })).toBe(false);
    expect(canReplaceSessionMessageRows({ loaded: true, loadFailed: false, hasMore: false })).toBe(true);
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
