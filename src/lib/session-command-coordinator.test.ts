import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/stores/chat-store";
import { useProjectStore, type ProjectSession } from "@/stores/project-store";
import { setAgentCatalog } from "@/lib/agents";
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
  agentGetSessionState: vi.fn(async () => ({ success: true, idle: true })),
  agentSendMessage: vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({ success: true })),
  agentRemoveSession: vi.fn(async () => ({ success: true })),
  agentSendGuidance: vi.fn(async () => ({ success: true })),
  agentForkSession: vi.fn(async () => ({ supported: false, success: false })),
  agentReloadConfig: vi.fn(async () => ({ success: true, models: [], reloadedSessionIds: [] })),
  agentListActions: vi.fn(async () => [{ kind: "skill" as const, name: "review" }]),
  agentSendUIResponse: vi.fn(async () => ({ success: true })),
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
        guidance: true,
        fork: false,
        actions: true,
        configuration: "none",
        providerActivation: "none",
      },
    }]);
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
    setAgentCatalog([]);
  });

  it("uses the same optimistic message and runtime state for an immediate send", async () => {
    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "client-message",
      message: {
        ...message,
        editableDraft: {
          text: "hello",
          images: [],
          pendingFiles: [],
          pendingPathAttachments: [],
          sessionReferences: [],
          action: { kind: "skill", name: "review" },
        },
      },
    })).resolves.toMatchObject({ queued: false, clientMessageId: "client-message" });

    expect(useChatStore.getState().messages).toContainEqual(expect.objectContaining({
      id: "client-message",
      role: "user",
      content: "hello",
      composerDraft: expect.objectContaining({
        text: "hello",
        action: { kind: "skill", name: "review" },
      }),
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
      message: { ...message, editableContent: "hello" },
    })).resolves.toMatchObject({ queued: true });

    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().messageQueues["session-one"]).toEqual([
      expect.objectContaining({ id: "queued-message", editableContent: "hello", displayContent: "hello", status: "queued" }),
    ]);
    expect(electronAPI.agentGetModels).not.toHaveBeenCalled();
    expect(electronAPI.agentSetModel).not.toHaveBeenCalled();
    expect(electronAPI.agentSetThinkingLevel).not.toHaveBeenCalled();
    expect(electronAPI.agentSendMessage).not.toHaveBeenCalled();
  });

  it("queues Claude when its backend is busy even if renderer state was stale", async () => {
    const project = useProjectStore.getState().projects[0];
    useProjectStore.setState({
      projects: [{
        ...project,
        sessions: project.sessions.map((candidate) => (
          candidate.id === "session-one" ? { ...candidate, agentId: "claude" } : candidate
        )),
      }],
      agentStatuses: { "session-one": "idle" },
    });
    electronAPI.agentGetSessionState.mockResolvedValueOnce({ success: true, idle: false });

    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "claude-queued-message",
      message: { ...message, editableContent: "follow up" },
    })).resolves.toMatchObject({ queued: true });

    expect(useProjectStore.getState().agentStatuses["session-one"]).toBe("running");
    expect(useChatStore.getState().messageQueues["session-one"]).toEqual([
      expect.objectContaining({ id: "claude-queued-message", status: "queued" }),
    ]);
    expect(electronAPI.agentGetModels).not.toHaveBeenCalled();
    expect(electronAPI.agentSetModel).not.toHaveBeenCalled();
    expect(electronAPI.agentSetThinkingLevel).not.toHaveBeenCalled();
    expect(electronAPI.agentSendMessage).not.toHaveBeenCalled();
  });

  it("does not reconfigure an initialized runtime before aborting", async () => {
    const abortSession = vi.fn(async () => true);

    await expect(SessionCommandCoordinator.abortSession("session-one", { abortSession }))
      .resolves.toEqual({ success: true });

    expect(abortSession).toHaveBeenCalledWith("session-one");
    expect(electronAPI.agentCreateSession).not.toHaveBeenCalled();
    expect(electronAPI.agentGetModels).not.toHaveBeenCalled();
    expect(electronAPI.agentSetModel).not.toHaveBeenCalled();
    expect(electronAPI.agentSetThinkingLevel).not.toHaveBeenCalled();
  });

  it("does not add a user bubble when a remote questionnaire is cancelled", async () => {
    const clearPendingInteraction = vi.fn();

    await expect(SessionCommandCoordinator.respondToInteraction({
      sessionId: "session-one",
      cancelled: true,
    }, {
      pendingInteraction: {
        sessionId: "session-one",
        requestId: "question-one",
        method: "questionnaire",
        questions: [],
      },
      clearPendingInteraction,
    })).resolves.toEqual({ cancelled: true });

    expect(electronAPI.agentSendUIResponse).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-one",
      cancelled: true,
      text: "",
    }));
    expect(clearPendingInteraction).toHaveBeenCalledWith("session-one");
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it("replaces a queued message with a rebuilt payload and reorders it", () => {
    useChatStore.setState({
      messageQueues: {
        "session-one": [{
          id: "first",
          sessionId: "session-one",
          editableContent: "old text",
          displayContent: "old text\n[file: notes.txt]",
          sendContent: "<current_user_message>\nold text\n\n<attached_file>private context</attached_file>\n</current_user_message>",
          createdAt: 1,
          status: "failed",
          error: "offline",
        }, {
          id: "second",
          sessionId: "session-one",
          editableContent: "later",
          displayContent: "later",
          sendContent: "later",
          createdAt: 2,
          status: "queued",
        }],
      },
    });

    expect(SessionCommandCoordinator.editQueuedMessage("session-one", "first", {
      editableContent: "new text",
      displayContent: "new text\n[file: notes.txt]",
      sendContent: "<current_user_message>\nnew text\n\n<attached_file>private context</attached_file>\n</current_user_message>",
    }))
      .toMatchObject({ success: true });
    expect(useChatStore.getState().messageQueues["session-one"][0]).toMatchObject({
      editableContent: "new text",
      displayContent: "new text\n[file: notes.txt]",
      sendContent: expect.stringContaining("new text\n\n<attached_file>private context</attached_file>"),
      status: "queued",
      error: undefined,
    });

    SessionCommandCoordinator.reorderQueuedMessage("session-one", "second", 0);
    expect(useChatStore.getState().messageQueues["session-one"].map((item) => item.id))
      .toEqual(["second", "first"]);
  });

  it("sends and queues action-only messages with the same metadata", async () => {
    const actionMessage: PreparedSessionMessage = {
      displayContent: "",
      sendContent: "",
      action: { kind: "skill", name: "review" },
    };
    await SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "action-message",
      message: actionMessage,
    });
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      id: "action-message",
      content: "",
      action: { kind: "skill", name: "review" },
    });
    expect(electronAPI.agentSendMessage).toHaveBeenCalledWith("", undefined, "session-one", {
      planModeEnabled: false,
      clientMessageId: "action-message",
      action: { kind: "skill", name: "review" },
    });

    useProjectStore.setState({ agentStatuses: { "session-one": "running" } });
    await SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "queued-action",
      message: actionMessage,
    });
    expect(useChatStore.getState().messageQueues["session-one"]).toContainEqual(expect.objectContaining({
      id: "queued-action",
      action: { kind: "skill", name: "review" },
    }));
    await expect(SessionCommandCoordinator.guideQueuedMessage("session-one", "queued-action"))
      .rejects.toThrow("GUIDANCE_NOT_SUPPORTED_FOR_ACTION");
  });

  it("rejects actions before sending when the Agent does not declare action support", async () => {
    setAgentCatalog([]);
    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "unsupported-action",
      message: {
        displayContent: "",
        sendContent: "",
        action: { kind: "skill", name: "review" },
      },
    })).rejects.toThrow("ACTION_NOT_SUPPORTED");

    expect(useChatStore.getState().messages).toEqual([]);
    expect(useProjectStore.getState().agentStatuses["session-one"]).toBeUndefined();
    expect(electronAPI.agentSendMessage).not.toHaveBeenCalled();
  });

  it("loads actions for an initialized background session", async () => {
    await expect(SessionCommandCoordinator.getActions("session-two", true)).resolves.toEqual([
      { kind: "skill", name: "review" },
    ]);
    expect(electronAPI.agentListActions).toHaveBeenCalledWith("session-two", { reload: true });
    expect(useProjectStore.getState().activeSessionId).toBe("session-one");
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

  it("rejects thinking levels not supported by the current model", async () => {
    useChatStore.setState({
      currentModel: {
        id: "claude-test",
        name: "Claude Test",
        provider: "anthropic",
        reasoning: true,
        supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
      },
    });

    await expect(SessionCommandCoordinator.setThinking("session-one", "minimal"))
      .rejects.toThrow("UNSUPPORTED_THINKING_LEVEL");
    expect(electronAPI.agentSetThinkingLevel).not.toHaveBeenCalled();
  });
});
