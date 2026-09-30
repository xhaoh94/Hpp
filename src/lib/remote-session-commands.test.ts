import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingUIResponse } from "@/components/layout/agentEventTypes";
import { useChatStore } from "@/stores/chat-store";
import { useProjectStore, type ProjectSession } from "@/stores/project-store";
import { SessionCommandCoordinator } from "./session-command-coordinator";
import {
  abortRemoteSession,
  executeRemoteSessionCommand,
  type RemoteCommandContext,
} from "./remote-session-commands";

const createContext = (success: boolean) => {
  const abortSession = vi.fn(async () => success);
  const clearPendingInteraction = vi.fn();
  const getPendingInteraction = vi.fn((_sessionId: string): PendingUIResponse => null);
  const context: RemoteCommandContext = {
    getPendingInteraction,
    abortSession,
    clearPendingInteraction,
  };
  return { abortSession, clearPendingInteraction, getPendingInteraction, context };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("remote session abort", () => {
  it("uses the shared manual-abort coordinator and clears the interaction", async () => {
    const { abortSession, clearPendingInteraction, context } = createContext(true);

    await expect(abortRemoteSession("session-1", context)).resolves.toEqual({ success: true });
    expect(abortSession).toHaveBeenCalledWith("session-1");
    expect(clearPendingInteraction).toHaveBeenCalledWith("session-1");
  });

  it("keeps the interaction when the abort coordinator reports failure", async () => {
    const { clearPendingInteraction, context } = createContext(false);

    await expect(abortRemoteSession("session-1", context)).rejects.toThrow("ABORT_FAILED");
    expect(clearPendingInteraction).not.toHaveBeenCalled();
  });
});

describe("remote interaction response", () => {
  it("reads and clears only the interaction belonging to the requested session", async () => {
    const interactionA = {
      sessionId: "A",
      requestId: "request-A",
      method: "question",
      questions: [],
    };
    const interactionB = {
      sessionId: "B",
      requestId: "request-B",
      method: "question",
      questions: [],
    };
    const interactions: Record<string, typeof interactionA> = { A: interactionA, B: interactionB };
    const clearPendingInteraction = vi.fn((sessionId: string) => {
      delete interactions[sessionId];
    });
    const getPendingInteraction = vi.fn((sessionId: string): PendingUIResponse => interactions[sessionId] || null);
    const onInteractionResponsePrepared = vi.fn();
    const onInteractionResponseAccepted = vi.fn();
    const onInteractionResponseFailed = vi.fn();
    const respondToInteraction = vi.spyOn(SessionCommandCoordinator, "respondToInteraction")
      .mockImplementation(async (input, context) => {
        expect(input.sessionId).toBe("B");
        expect(context.getPendingInteraction?.(input.sessionId)).toBe(interactionB);
        expect(context.onResponsePrepared).toBe(onInteractionResponsePrepared);
        expect(context.onResponseAccepted).toBe(onInteractionResponseAccepted);
        expect(context.onResponseFailed).toBe(onInteractionResponseFailed);
        context.clearPendingInteraction(input.sessionId);
        return { cancelled: false };
      });

    await expect(executeRemoteSessionCommand({
      commandId: "command-1",
      name: "interaction.respond",
      payload: { sessionId: "B", text: "answer B" },
    }, {
      getPendingInteraction,
      clearPendingInteraction,
      abortSession: vi.fn(async () => true),
      onInteractionResponsePrepared,
      onInteractionResponseAccepted,
      onInteractionResponseFailed,
    })).resolves.toEqual({ cancelled: false });

    expect(getPendingInteraction).toHaveBeenCalledTimes(1);
    expect(getPendingInteraction).toHaveBeenCalledWith("B");
    expect(respondToInteraction).toHaveBeenCalledTimes(1);
    expect(clearPendingInteraction).toHaveBeenCalledWith("B");
    expect(interactions).toEqual({ A: interactionA });
  });
});

describe("remote session close", () => {
  const loadPage = vi.fn();
  const purgeSessionData = vi.fn(async () => ({ success: true }));
  const createProjectSession = (id: string): ProjectSession => ({
    id,
    agentId: "codex",
    agentSessionId: id,
    title: "会话",
    createdAt: "2026-07-22T00:00:00.000Z",
    lastActiveAt: "2026-07-22T00:00:00.000Z",
  });

  const setProjects = () => {
    useProjectStore.setState({
      projects: [{
        id: "project",
        name: "Project",
        path: "C:\\project",
        createdAt: "2026-07-22T00:00:00.000Z",
        agents: ["codex"],
        sessions: [createProjectSession("empty-session"), createProjectSession("busy-session")],
      }],
      activeProjectId: "project",
      activeSessionId: null,
      agentStatuses: {},
      initializedSessionIds: new Set<string>(),
    });
  };

  const remainingSessionIds = () =>
    useProjectStore.getState().projects[0].sessions.map((session) => session.id);

  const closeCommand = (sessionId: string) => ({
    commandId: "command-close",
    name: "session.close" as const,
    payload: { sessionId },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    loadPage.mockReset();
    purgeSessionData.mockClear();
    setProjects();
    useChatStore.setState({ messages: [], sessionMessages: {}, activeSessionId: null });
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      electronAPI: {
        loadSessionMessagesPage: loadPage,
        purgeSessionData,
        loadData: vi.fn(async () => null),
      },
    });
    vi.spyOn(SessionCommandCoordinator, "closeSession").mockImplementation(async (sessionId) => ({
      project: useProjectStore.getState().projects[0],
      session: useProjectStore.getState().projects[0].sessions
        .find((session) => session.id === sessionId) ?? createProjectSession(sessionId),
    }));
    vi.spyOn(SessionCommandCoordinator, "getSessionCommandConfig")
      .mockResolvedValue({ model: undefined, thinkingLevel: "medium", availableModels: [] });
    vi.spyOn(SessionCommandCoordinator, "getSessionCommandStatus").mockReturnValue("idle");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discards an empty session and tells the client it is gone", async () => {
    loadPage.mockResolvedValue({ messages: [], hasMore: false, nextBefore: null, firstSequence: 0 });

    const result = await executeRemoteSessionCommand(closeCommand("empty-session"), createContext(true).context);

    // 空对话不留历史：客户端收到 deleted 才会把它从本地列表移除，而不是标成"已关闭"。
    expect(result).toMatchObject({ deleted: true });
    expect(purgeSessionData).toHaveBeenCalledWith({ sessionIds: ["empty-session"], projectIds: [] });
    expect(remainingSessionIds()).toEqual(["busy-session"]);
  });

  it("only archives a session that still has messages", async () => {
    loadPage.mockResolvedValue({
      messages: [{ id: "m", role: "user", content: "hi", timestamp: 1 }],
      hasMore: false,
      nextBefore: null,
      firstSequence: 0,
    });

    const result = await executeRemoteSessionCommand(closeCommand("busy-session"), createContext(true).context);

    expect(result).not.toHaveProperty("deleted");
    expect(purgeSessionData).not.toHaveBeenCalled();
    expect(remainingSessionIds()).toEqual(["empty-session", "busy-session"]);
  });

  it("never deletes the session when the backend could not be closed", async () => {
    loadPage.mockResolvedValue({ messages: [], hasMore: false, nextBefore: null, firstSequence: 0 });
    vi.mocked(SessionCommandCoordinator.closeSession).mockRejectedValueOnce(new Error("backend busy"));

    await expect(
      executeRemoteSessionCommand(closeCommand("empty-session"), createContext(true).context)
    ).rejects.toThrow("backend busy");

    expect(purgeSessionData).not.toHaveBeenCalled();
    expect(remainingSessionIds()).toEqual(["empty-session", "busy-session"]);
  });
});
