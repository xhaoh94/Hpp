import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  saveSessionModel,
  saveSessionThinking,
  getSessionModel,
  getSessionThinking,
  purgeDeletedSessionData,
  DISK_USAGE_INVALIDATED_EVENT,
  SESSION_CONFIG_UPDATED_EVENT,
  SESSION_DATA_PURGED_EVENT,
  parsePersistedChatMessage,
} from "./useDataPersistence";

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
