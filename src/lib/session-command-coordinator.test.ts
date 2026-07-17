import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/stores/chat-store";
import { useProjectStore, type ProjectSession } from "@/stores/project-store";
import {
  SessionCommandCoordinator,
  type PreparedSessionMessage,
} from "./session-command-coordinator";

const session = (id: string): ProjectSession => ({
  id,
  agentId: "codex",
  agentSessionId: id,
  title: id,
  createdAt: "2026-07-17T00:00:00.000Z",
  lastActiveAt: "2026-07-17T00:00:00.000Z",
});

const electronAPI = {
  agentCreateSession: vi.fn(async () => ({ success: true, sessionFilePath: "session.json", models: [] })),
  agentSwitchSession: vi.fn(async () => ({ success: true })),
  agentGetModels: vi.fn(async () => []),
  agentGetDefaultThinkingLevel: vi.fn(async () => "medium"),
  agentSetThinkingLevel: vi.fn(async () => ({ success: true })),
  agentSetModel: vi.fn(async () => ({ success: true })),
  agentSendMessage: vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({ success: true })),
  agentRemoveSession: vi.fn(async () => ({ success: true })),
  agentSendGuidance: vi.fn(async () => ({ success: true })),
  agentForkSession: vi.fn(async () => ({ supported: false, success: false })),
  agentReloadConfig: vi.fn(async () => ({ success: true, models: [], reloadedSessionIds: [] })),
  saveData: vi.fn(async () => ({ success: true })),
  loadData: vi.fn(async () => null),
};

const message: PreparedSessionMessage = {
  displayContent: "hello",
  sendContent: "hello",
  planModeEnabled: true,
};

describe("SessionCommandCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      electronAPI,
      dispatchEvent: vi.fn(),
    });
    const first = session("session-one");
    const second = session("session-two");
    useProjectStore.setState({
      projects: [{
        id: "project",
        name: "Project",
        path: "C:\\project",
        createdAt: first.createdAt,
        agents: ["codex"],
        sessions: [first, second],
      }],
      activeProjectId: "project",
      activeSessionId: first.id,
      agentStatuses: {},
      initializedSessionIds: new Set([first.id, second.id]),
    });
    useChatStore.setState({
      messages: [],
      sessionMessages: { [first.id]: [], [second.id]: [] },
      activeSessionId: first.id,
      isStreaming: false,
      currentModel: null,
      availableModels: [],
      thinkingLevel: "medium",
      messageQueues: {},
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses the same optimistic message and runtime state for an immediate send", async () => {
    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "client-message",
      message,
    })).resolves.toMatchObject({ queued: false, clientMessageId: "client-message" });

    expect(useChatStore.getState().messages).toContainEqual(expect.objectContaining({
      id: "client-message",
      role: "user",
      content: "hello",
    }));
    expect(useProjectStore.getState().agentStatuses["session-one"]).toBe("running");
    expect(electronAPI.agentSendMessage).toHaveBeenCalledWith(
      "hello",
      undefined,
      "session-one",
      { planModeEnabled: true, clientMessageId: "client-message" },
    );
  });

  it("queues a running-session send without producing an early user bubble", async () => {
    useProjectStore.setState({ agentStatuses: { "session-one": "running" } });
    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "queued-message",
      message,
    })).resolves.toMatchObject({ queued: true });

    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().messageQueues["session-one"]).toEqual([
      expect.objectContaining({ id: "queued-message", displayContent: "hello", status: "queued" }),
    ]);
    expect(electronAPI.agentSendMessage).not.toHaveBeenCalled();
  });

  it("settles a failed send back to idle and records one visible error", async () => {
    electronAPI.agentSendMessage.mockResolvedValueOnce({ success: false, error: "offline" });
    const result = await SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "failed-message",
      message,
    });

    expect(result).toMatchObject({ error: "offline" });
    expect(useProjectStore.getState().agentStatuses["session-one"]).toBe("idle");
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: "system",
      content: "发送失败: offline",
    });
  });

  it("initializes a background session without changing the desktop selection", async () => {
    useProjectStore.setState({ initializedSessionIds: new Set(["session-one"]) });
    await SessionCommandCoordinator.initializeSession("session-two");
    expect(useProjectStore.getState().activeSessionId).toBe("session-one");
    expect(useChatStore.getState().activeSessionId).toBe("session-one");
    expect(electronAPI.agentCreateSession).toHaveBeenCalledWith(
      "codex",
      "C:\\project",
      "session-two",
      undefined,
    );
  });

  it("closes and reopens through one lifecycle path", async () => {
    await SessionCommandCoordinator.closeSession("session-one");
    expect(useProjectStore.getState().projects[0].sessions[0].closed).toBe(true);
    expect(useChatStore.getState().activeSessionId).toBeNull();
    expect(electronAPI.agentRemoveSession).toHaveBeenCalledWith("session-one");

    await SessionCommandCoordinator.reopenSession("session-one");
    expect(useProjectStore.getState().projects[0].sessions[0].closed).toBe(false);
  });

  it("creates a compatibility fork with the same visible history and hidden context", async () => {
    const sourceMessages = [
      { id: "user", role: "user" as const, content: "question", timestamp: 1 },
      { id: "assistant", role: "assistant" as const, content: "answer", timestamp: 2 },
    ];
    useChatStore.setState({ messages: sourceMessages, sessionMessages: { "session-one": sourceMessages } });
    const result = await SessionCommandCoordinator.forkSession({
      sourceSessionId: "session-one",
      throughMessageId: "assistant",
      sessionId: "forked",
    });

    expect(result.session.forkContext?.sourceSessionId).toBe("session-one");
    expect(useChatStore.getState().sessionMessages.forked).toHaveLength(2);
    expect(useProjectStore.getState().activeSessionId).toBe("session-one");
  });

  it("rejects model and thinking changes while the session is busy", async () => {
    useProjectStore.setState({ agentStatuses: { "session-one": "running" } });
    await expect(SessionCommandCoordinator.setModel("session-one", { provider: "openai", id: "gpt" }))
      .rejects.toThrow("SESSION_BUSY");
    await expect(SessionCommandCoordinator.setThinking("session-one", "high"))
      .rejects.toThrow("SESSION_BUSY");
  });
});
