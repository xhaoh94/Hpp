import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasOpenAssistantProcessState, useChatStore } from "@/stores/chat-store";
import { useProjectStore, type ProjectSession } from "@/stores/project-store";
import { setAgentCatalog } from "@/lib/agents";
import {
  getSessionThinking,
  saveSessionModel,
  saveSessionThinking,
} from "@/hooks/useDataPersistence";
import { createComposerDocument } from "@shared/composer-document";
import {
  SessionCommandCoordinator,
  classifyBackendSessionState,
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
  permissionMode: "ask",
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
        permissions: true,
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
      compactingSessions: {},
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setAgentCatalog([]);
  });

  it("classifies only an authoritative absent backend as missing", () => {
    expect(classifyBackendSessionState({ success: false, idle: true })).toBe("missing");
    expect(classifyBackendSessionState({ success: true, idle: false })).toBe("busy");
    expect(classifyBackendSessionState({ success: true, idle: true })).toBe("idle");
    expect(classifyBackendSessionState({ success: true, idle: false, stale: true })).toBe("unknown");
    expect(classifyBackendSessionState(undefined)).toBe("unknown");
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
      { planModeEnabled: true, permissionMode: "ask", clientMessageId: "client-message" },
    );
  });

  it("queues a running-session send without producing an early user bubble", async () => {
    useProjectStore.setState({ agentStatuses: { "session-one": "running" } });
    electronAPI.agentGetSessionState.mockResolvedValueOnce({ success: true, idle: false });
    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "queued-message",
      message: { ...message, editableContent: "hello" },
    })).resolves.toMatchObject({ queued: true });

    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().messageQueues["session-one"]).toEqual([
      expect.objectContaining({
        id: "queued-message",
        editableContent: "hello",
        displayContent: "hello",
        permissionMode: "ask",
        status: "queued",
      }),
    ]);
    expect(electronAPI.agentGetModels).not.toHaveBeenCalled();
    expect(electronAPI.agentSetModel).not.toHaveBeenCalled();
    expect(electronAPI.agentSetThinkingLevel).not.toHaveBeenCalled();
    expect(electronAPI.agentSendMessage).not.toHaveBeenCalled();
  });

  it("records a queued guidance message as a user-style process entry", async () => {
    useProjectStore.setState({ agentStatuses: { "session-one": "running" } });
    useChatStore.getState().addMessage({
      id: "assistant-running",
      role: "assistant",
      content: "",
      timestamp: 1,
      isStreaming: true,
      process: { startedAt: 1, expanded: true, entries: [] },
    }, "session-one");
    const document = createComposerDocument([
      { id: "text", type: "text", text: "继续检查 " },
      { id: "file", type: "path", name: "README.md", path: "README.md", kind: "file" },
    ]);
    useChatStore.getState().upsertQueuedMessage({
      id: "queued-guidance",
      sessionId: "session-one",
      displayContent: "继续检查 [file: README.md]",
      sendContent: "继续检查 <file path=\"README.md\" />",
      messageImages: [{ id: "image-1", src: "data:image/png;base64,abc", name: "screen.png" }],
      agentImages: [{ type: "image", data: "abc", mimeType: "image/png" }],
      composerDocument: document,
      planModeEnabled: true,
      permissionMode: "ask",
      createdAt: 2,
      status: "queued",
    });

    await expect(SessionCommandCoordinator.guideQueuedMessage("session-one", "queued-guidance"))
      .resolves.toEqual({ success: true, queueItemId: "queued-guidance" });

    expect(electronAPI.agentSendGuidance).toHaveBeenCalledWith(
      "继续检查 <file path=\"README.md\" />",
      [{ type: "image", data: "abc", mimeType: "image/png" }],
      "session-one",
      { planModeEnabled: true, permissionMode: "ask" },
    );
    const assistant = useChatStore.getState().sessionMessages["session-one"].find((item) => item.id === "assistant-running");
    expect(assistant?.process?.entries).toEqual([expect.objectContaining({
      id: "guidance-queued-guidance",
      kind: "user_guidance",
      toolKind: "guidance_message",
      title: "引导",
      detail: "继续检查 [file: README.md]",
      state: "completed",
      guidanceDocument: document,
      guidanceImages: [{ id: "image-1", src: "data:image/png;base64,abc", name: "screen.png" }],
    })]);
    expect(useChatStore.getState().messageQueues["session-one"]).toEqual([]);
  });

  it("removes an optimistic guidance bubble when guidance fails", async () => {
    useProjectStore.setState({ agentStatuses: { "session-one": "running" } });
    useChatStore.getState().addMessage({
      id: "assistant-failing-guidance",
      role: "assistant",
      content: "",
      timestamp: 1,
      isStreaming: true,
      process: { startedAt: 1, expanded: true, entries: [] },
    }, "session-one");
    useChatStore.getState().upsertQueuedMessage({
      id: "queued-failed-guidance",
      sessionId: "session-one",
      displayContent: "失败的引导",
      sendContent: "失败的引导",
      createdAt: 2,
      status: "queued",
    });
    electronAPI.agentSendGuidance.mockResolvedValueOnce({ success: false, error: "GUIDANCE_FAILED" });

    await expect(SessionCommandCoordinator.guideQueuedMessage("session-one", "queued-failed-guidance"))
      .rejects.toThrow("GUIDANCE_FAILED");

    const assistant = useChatStore.getState().sessionMessages["session-one"].find((item) => item.id === "assistant-failing-guidance");
    expect(assistant?.process?.entries).toEqual([]);
    expect(useChatStore.getState().messageQueues["session-one"]).toEqual([
      expect.objectContaining({ id: "queued-failed-guidance", status: "failed", error: "GUIDANCE_FAILED" }),
    ]);
  });

  it("keeps messages queued while the session is compacting", async () => {
    useChatStore.setState({ compactingSessions: { "session-one": true } });
    electronAPI.agentGetSessionState.mockResolvedValueOnce({ success: true, idle: false });

    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "compaction-queued-message",
      message,
    })).resolves.toMatchObject({ queued: true });

    expect(useChatStore.getState().messageQueues["session-one"]).toEqual([
      expect.objectContaining({ id: "compaction-queued-message", status: "queued" }),
    ]);
    expect(electronAPI.agentSendMessage).not.toHaveBeenCalled();
  });

  it("queues any Agent when its backend is busy even if renderer state was stale", async () => {
    useProjectStore.setState({
      agentStatuses: { "session-one": "idle" },
    });
    electronAPI.agentGetSessionState.mockResolvedValueOnce({ success: true, idle: false });

    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "backend-busy-queued-message",
      message: { ...message, editableContent: "follow up" },
    })).resolves.toMatchObject({ queued: true });

    expect(useProjectStore.getState().agentStatuses["session-one"]).toBe("running");
    expect(useChatStore.getState().messageQueues["session-one"]).toEqual([
      expect.objectContaining({ id: "backend-busy-queued-message", status: "queued" }),
    ]);
    expect(electronAPI.agentGetModels).not.toHaveBeenCalled();
    expect(electronAPI.agentSetModel).not.toHaveBeenCalled();
    expect(electronAPI.agentSetThinkingLevel).not.toHaveBeenCalled();
    expect(electronAPI.agentSendMessage).not.toHaveBeenCalled();
  });

  it("serializes send admission per session so simultaneous senders cannot both enter an idle backend", async () => {
    let backendBusy = false;
    let releaseFirstSend = () => undefined;
    let notifyFirstAccepted = () => undefined;
    const firstAccepted = new Promise<void>((resolve) => {
      notifyFirstAccepted = resolve;
    });
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    electronAPI.agentGetSessionState.mockImplementation(async () => ({
      success: true,
      idle: !backendBusy,
    }));
    electronAPI.agentSendMessage.mockImplementationOnce(async () => {
      backendBusy = true;
      notifyFirstAccepted();
      await firstSendGate;
      return { success: true };
    });

    const first = SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "concurrent-first",
      message,
    });
    await firstAccepted;
    const second = SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "concurrent-second",
      message: { ...message, displayContent: "second", sendContent: "second" },
    });

    releaseFirstSend();
    await expect(first).resolves.toMatchObject({ queued: false });
    await expect(second).resolves.toMatchObject({ queued: true });
    electronAPI.agentGetSessionState.mockImplementation(async () => ({ success: true, idle: true }));

    expect(electronAPI.agentSendMessage).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().messages.filter((candidate) => candidate.role === "user"))
      .toEqual([expect.objectContaining({ id: "concurrent-first" })]);
    expect(useChatStore.getState().messageQueues["session-one"])
      .toEqual([expect.objectContaining({ id: "concurrent-second", status: "queued" })]);
  });

  it("does not block an independent session behind another session's send admission", async () => {
    let releaseFirstSend = () => undefined;
    let notifyFirstStarted = () => undefined;
    let notifySecondStarted = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      notifySecondStarted = resolve;
    });
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    electronAPI.agentSendMessage.mockImplementation(async (_content, _images, sessionId) => {
      if (sessionId === "session-one") {
        notifyFirstStarted();
        await firstSendGate;
      } else {
        notifySecondStarted();
      }
      return { success: true };
    });

    const first = SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "parallel-first",
      message,
    });
    await firstStarted;
    const second = SessionCommandCoordinator.sendMessage({
      sessionId: "session-two",
      clientMessageId: "parallel-second",
      message,
    });
    await secondStarted;

    await expect(second).resolves.toMatchObject({ queued: false });
    releaseFirstSend();
    await expect(first).resolves.toMatchObject({ queued: false });
    electronAPI.agentSendMessage.mockImplementation(async () => ({ success: true }));
  });

  it("keeps a long-running backend queued across repeated probes without changing order", async () => {
    useProjectStore.setState({ agentStatuses: { "session-one": "running" } });
    useChatStore.setState({
      messageQueues: {
        "session-one": [
          {
            id: "queued-first",
            sessionId: "session-one",
            displayContent: "first",
            sendContent: "first",
            createdAt: 10,
            status: "sending",
          },
          {
            id: "queued-second",
            sessionId: "session-one",
            displayContent: "second",
            sendContent: "second",
            createdAt: 20,
            status: "queued",
          },
        ],
      },
    });
    electronAPI.agentGetSessionState.mockResolvedValue({ success: true, idle: false });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(SessionCommandCoordinator.sendMessage({
        sessionId: "session-one",
        clientMessageId: "queued-first",
        message: { displayContent: "first", sendContent: "first" },
      })).resolves.toMatchObject({ queued: true });
    }

    const queue = useChatStore.getState().messageQueues["session-one"];
    expect(queue.map((item) => item.id)).toEqual(["queued-first", "queued-second"]);
    expect(queue[0]).toMatchObject({ status: "queued", createdAt: 10 });
    expect(queue).toHaveLength(2);
    expect(electronAPI.agentGetSessionState).toHaveBeenCalledTimes(4);
    expect(electronAPI.agentSendMessage).not.toHaveBeenCalled();
  });

  it("dispatches a queued item when the backend becomes idle even if renderer terminal events were lost", async () => {
    const chat = useChatStore.getState();
    chat.startAssistantProcess(1, "session-one");
    chat.appendLastAssistantProcessEntry({
      id: "lost-terminal-tool",
      type: "tool",
      title: "still shown as running",
      timestamp: 2,
      state: "running",
    }, "session-one");
    chat.setSessionCompacting("session-one", true);
    chat.appendContextCompactionDivider("lost-terminal-compaction", "session-one", "running");
    useProjectStore.setState({ agentStatuses: { "session-one": "running" } });
    useChatStore.setState({
      messageQueues: {
        "session-one": [
          {
            id: "lost-terminal-first",
            sessionId: "session-one",
            displayContent: "first",
            sendContent: "first",
            createdAt: 10,
            status: "queued",
          },
          {
            id: "lost-terminal-second",
            sessionId: "session-one",
            displayContent: "second",
            sendContent: "second",
            createdAt: 20,
            status: "queued",
          },
        ],
      },
    });
    electronAPI.agentGetSessionState
      .mockResolvedValueOnce({ success: true, idle: false })
      .mockResolvedValue({ success: true, idle: true });

    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "lost-terminal-first",
      message: { displayContent: "first", sendContent: "first" },
    })).resolves.toMatchObject({ queued: true });
    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "lost-terminal-first",
      message: { displayContent: "first", sendContent: "first" },
    })).resolves.toMatchObject({ queued: false });

    expect(electronAPI.agentSendMessage).toHaveBeenCalledTimes(1);
    expect(electronAPI.agentSendMessage).toHaveBeenCalledWith(
      "first",
      undefined,
      "session-one",
      expect.objectContaining({ clientMessageId: "lost-terminal-first" }),
    );
    expect(useChatStore.getState().messageQueues["session-one"].map((item) => item.id))
      .toEqual(["lost-terminal-first", "lost-terminal-second"]);
    expect(useChatStore.getState().compactingSessions["session-one"]).toBeUndefined();
    expect(useChatStore.getState().messages.find((candidate) => (
      candidate.process?.entries.some((entry) => entry.id === "lost-terminal-tool")
    ))?.process?.endedAt).toBe(2);
    expect(useChatStore.getState().messages.some((candidate) => (
      candidate.process?.entries.some((entry) => entry.id === "lost-terminal-tool" && entry.state === "running")
    ))).toBe(false);
  });

  it("cleans stale renderer activity when the backend confirms it is idle", async () => {
    const chat = useChatStore.getState();
    chat.startAssistantProcess(1, "session-one");
    chat.appendLastAssistantProcessEntry({
      id: "stale-tool",
      type: "tool",
      title: "正在读取",
      timestamp: 2,
      state: "running",
    }, "session-one");
    chat.setSessionCompacting("session-one", true);
    chat.appendContextCompactionDivider("stale-compaction", "session-one", "running");
    useProjectStore.setState({ agentStatuses: { "session-one": "running" } });
    let runtimeActive = true;
    const onReconcileCleanup = vi.fn(() => {
      runtimeActive = false;
    });

    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "after-stale-runtime",
      message,
      hooks: {
        isProcessActive: () => runtimeActive,
        onReconcileCleanup,
      },
    })).resolves.toMatchObject({ queued: false });

    const messages = useChatStore.getState().messages;
    const staleAssistant = messages.find((candidate) => candidate.id !== "after-stale-runtime" && candidate.role === "assistant");
    const compaction = messages.find((candidate) => candidate.systemType === "context_compaction");
    expect(staleAssistant).toMatchObject({
      isStreaming: false,
      process: { endedAt: 2, entries: [{ state: "interrupted" }] },
    });
    expect(compaction).toMatchObject({
      compactionState: "interrupted",
      content: "上下文压缩已中断",
    });
    expect(useChatStore.getState().compactingSessions["session-one"]).toBeUndefined();
    expect(onReconcileCleanup).toHaveBeenCalledTimes(1);
    expect(electronAPI.agentSendMessage).toHaveBeenCalledTimes(1);
  });

  it("reconciles an active chat streaming flag even when Agent status is already idle", async () => {
    useChatStore.setState({ isStreaming: true });
    useProjectStore.setState({ agentStatuses: { "session-one": "idle" } });
    const onReconcileCleanup = vi.fn(() => {
      expect(useChatStore.getState().isStreaming).toBe(false);
      expect(useProjectStore.getState().agentStatuses["session-one"]).toBe("idle");
    });

    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "after-stale-streaming",
      message,
      hooks: { onReconcileCleanup },
    })).resolves.toMatchObject({ queued: false });

    expect(onReconcileCleanup).toHaveBeenCalledTimes(1);
    expect(electronAPI.agentSendMessage).toHaveBeenCalledTimes(1);
  });

  it("reconciles an open assistant process without relying on runtime or Agent status", async () => {
    const chat = useChatStore.getState();
    chat.startAssistantProcess(10, "session-one");
    chat.appendLastAssistantProcessEntry({
      id: "orphan-process-entry",
      type: "thinking",
      title: "正在思考",
      timestamp: 11,
      state: "running",
    }, "session-one");
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useProjectStore.getState().agentStatuses["session-one"]).toBeUndefined();
    const onReconcileCleanup = vi.fn();

    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "after-orphan-process",
      message,
      hooks: { onReconcileCleanup },
    })).resolves.toMatchObject({ queued: false });

    const orphan = useChatStore.getState().messages.find((candidate) => (
      candidate.process?.entries.some((entry) => entry.id === "orphan-process-entry")
    ));
    expect(orphan).toMatchObject({
      isStreaming: false,
      process: {
        entries: [{ id: "orphan-process-entry", state: "interrupted" }],
      },
    });
    expect(orphan?.process?.endedAt).toBeGreaterThan(0);
    expect(onReconcileCleanup).toHaveBeenCalledTimes(1);
    expect(electronAPI.agentSendMessage).toHaveBeenCalledTimes(1);
  });

  it("cleans and recreates a renderer-initialized session whose backend is missing", async () => {
    electronAPI.agentGetSessionState
      .mockResolvedValueOnce({
        success: false,
        idle: true,
        error: "No active agent",
      })
      .mockResolvedValueOnce({
        success: false,
        idle: true,
        error: "No active agent",
      });
    const onReconcileCleanup = vi.fn();

    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "recreated-runtime-message",
      message,
      hooks: { onReconcileCleanup },
    })).resolves.toMatchObject({ queued: false });

    expect(onReconcileCleanup).toHaveBeenCalledWith("session-one");
    expect(electronAPI.agentCreateSession).toHaveBeenCalledWith(
      "codex",
      "C:\\project",
      "session-one",
      undefined,
    );
    expect(useProjectStore.getState().initializedSessionIds.has("session-one")).toBe(true);
    expect(electronAPI.agentSendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the renderer running judgment when backend reconciliation throws", async () => {
    useProjectStore.setState({ agentStatuses: { "session-one": "running" } });
    electronAPI.agentGetSessionState.mockRejectedValueOnce(new Error("IPC unavailable"));
    const onReconcileCleanup = vi.fn();

    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "query-failed-message",
      message,
      hooks: { onReconcileCleanup },
    })).resolves.toMatchObject({ queued: true });

    expect(onReconcileCleanup).not.toHaveBeenCalled();
    expect(useProjectStore.getState().agentStatuses["session-one"]).toBe("running");
    expect(electronAPI.agentCreateSession).not.toHaveBeenCalled();
    expect(electronAPI.agentSendMessage).not.toHaveBeenCalled();
  });

  it("queues an existing idle-looking conversation when backend state is unknown", async () => {
    useChatStore.getState().addMessage({
      id: "prior-user-message",
      role: "user",
      content: "previous turn",
      timestamp: 1,
    }, "session-one");
    electronAPI.agentGetSessionState.mockRejectedValueOnce(new Error("IPC unavailable"));

    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "unknown-existing-session",
      message,
    })).resolves.toMatchObject({ queued: true });

    expect(useChatStore.getState().messageQueues["session-one"]).toEqual([
      expect.objectContaining({ id: "unknown-existing-session", status: "queued" }),
    ]);
    expect(electronAPI.agentSendMessage).not.toHaveBeenCalled();
  });

  it("allows a pristine session's first send when the state query is unavailable", async () => {
    electronAPI.agentGetSessionState
      .mockRejectedValueOnce(new Error("IPC unavailable"))
      .mockRejectedValueOnce(new Error("IPC unavailable"));

    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "unknown-pristine-session",
      message,
    })).resolves.toMatchObject({ queued: false });

    expect(useChatStore.getState().messageQueues["session-one"]).toBeUndefined();
    expect(electronAPI.agentSendMessage).toHaveBeenCalledTimes(1);
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

  it("sends remote confirmations without adding a questionnaire answer bubble", async () => {
    const clearPendingInteraction = vi.fn();
    const onResponsePrepared = vi.fn();
    const onResponseAccepted = vi.fn();
    electronAPI.agentSendUIResponse.mockImplementationOnce(async () => {
      expect(onResponsePrepared).toHaveBeenCalledWith("session-one");
      expect(onResponseAccepted).not.toHaveBeenCalled();
      return { success: true };
    });

    await expect(SessionCommandCoordinator.respondToInteraction({
      sessionId: "session-one",
      confirmed: true,
    }, {
      pendingInteraction: {
        sessionId: "session-one",
        requestId: "permission-one",
        method: "confirm",
        title: "Pi 请求权限",
      },
      clearPendingInteraction,
      onResponsePrepared,
      onResponseAccepted,
    })).resolves.toEqual({ cancelled: false });

    expect(electronAPI.agentSendUIResponse).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-one",
      id: "permission-one",
      method: "confirm",
      cancelled: false,
      confirmed: true,
      text: "允许",
    }));
    expect(clearPendingInteraction).toHaveBeenCalledWith("session-one");
    expect(onResponsePrepared).toHaveBeenCalledTimes(1);
    expect(onResponseAccepted).toHaveBeenCalledWith("session-one");
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it("terminalizes a failed remote interaction and clears it like the desktop response path", async () => {
    electronAPI.agentSendUIResponse.mockResolvedValueOnce({
      success: false,
      error: "plugin response failed",
    });
    const clearPendingInteraction = vi.fn();
    const chat = useChatStore.getState();
    chat.startAssistantProcess(1, "session-one");
    chat.appendLastAssistantProcessEntry({
      id: "remote-question-entry",
      type: "question",
      title: "waiting",
      timestamp: 2,
      state: "running",
    }, "session-one");
    useProjectStore.getState().setAgentStatus("session-one", "running");

    await expect(SessionCommandCoordinator.respondToInteraction({
      sessionId: "session-one",
      text: "answer",
    }, {
      pendingInteraction: {
        sessionId: "session-one",
        requestId: "question-one",
        method: "questionnaire",
        entryId: "remote-question-entry",
        questions: [],
      },
      clearPendingInteraction,
    })).rejects.toThrow("plugin response failed");

    expect(clearPendingInteraction).toHaveBeenCalledWith("session-one");
    expect(useProjectStore.getState().agentStatuses["session-one"]).toBe("error");
    expect(useChatStore.getState().messages.some(hasOpenAssistantProcessState)).toBe(false);
    expect(useChatStore.getState().messages).toContainEqual(expect.objectContaining({
      role: "user",
      content: "answer",
    }));
  });

  it("keeps queued sends behind remote interaction failure cleanup", async () => {
    electronAPI.agentSendUIResponse.mockResolvedValueOnce({
      success: false,
      error: "response transport failed",
    });
    useProjectStore.getState().setAgentStatus("session-one", "running");
    let releaseFailureCleanup = () => undefined;
    let notifyFailureCleanupStarted = () => undefined;
    const failureCleanupStarted = new Promise<void>((resolve) => {
      notifyFailureCleanupStarted = resolve;
    });
    const failureCleanupGate = new Promise<void>((resolve) => {
      releaseFailureCleanup = resolve;
    });
    const onResponseFailed = vi.fn(async () => {
      notifyFailureCleanupStarted();
      await failureCleanupGate;
      useProjectStore.getState().setAgentStatus("session-one", "error");
    });
    const pendingInteraction = {
      sessionId: "session-one",
      requestId: "remote-question",
      method: "questionnaire",
    };

    const response = SessionCommandCoordinator.respondToInteraction({
      sessionId: "session-one",
      text: "answer",
    }, {
      pendingInteraction,
      clearPendingInteraction: vi.fn(),
      onResponseFailed,
    });
    await failureCleanupStarted;
    const queuedSend = SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "after-failed-interaction",
      message,
    });
    await Promise.resolve();

    expect(electronAPI.agentGetSessionState).not.toHaveBeenCalled();
    expect(electronAPI.agentSendMessage).not.toHaveBeenCalled();

    releaseFailureCleanup();
    await expect(response).rejects.toThrow("response transport failed");
    await expect(queuedSend).resolves.toMatchObject({ queued: false });
    expect(onResponseFailed).toHaveBeenCalledWith("session-one", pendingInteraction);
    expect(electronAPI.agentSendMessage).toHaveBeenCalledTimes(1);
  });

  it("rechecks the live interaction under the session lock and rejects a duplicate remote response", async () => {
    let releaseResponse = () => undefined;
    let notifyResponseStarted = () => undefined;
    const responseStarted = new Promise<void>((resolve) => {
      notifyResponseStarted = resolve;
    });
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    electronAPI.agentSendUIResponse.mockImplementationOnce(async () => {
      notifyResponseStarted();
      await responseGate;
      return { success: true };
    });
    let currentInteraction: {
      sessionId: string;
      requestId: string;
      method: string;
    } | null = {
      sessionId: "session-one",
      requestId: "single-response",
      method: "confirm",
    };
    const context = {
      getPendingInteraction: () => currentInteraction,
      clearPendingInteraction: () => {
        currentInteraction = null;
      },
    };

    const first = SessionCommandCoordinator.respondToInteraction({
      sessionId: "session-one",
      confirmed: true,
    }, context);
    await responseStarted;
    const duplicate = SessionCommandCoordinator.respondToInteraction({
      sessionId: "session-one",
      confirmed: true,
    }, context);
    releaseResponse();

    await expect(first).resolves.toEqual({ cancelled: false });
    await expect(duplicate).rejects.toThrow("INTERACTION_NOT_FOUND");
    expect(electronAPI.agentSendUIResponse).toHaveBeenCalledTimes(1);
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
    electronAPI.agentGetSessionState.mockResolvedValueOnce({ success: true, idle: false });
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
      hooks: {
        onSendStarted: () => {
          const chat = useChatStore.getState();
          chat.addMessage({
            id: "orphan-process-one",
            role: "assistant",
            content: "",
            timestamp: 10,
            isStreaming: true,
            process: {
              startedAt: 10,
              expanded: true,
              entries: [{
                id: "orphan-tool-one",
                type: "tool",
                title: "still running",
                state: "running",
                timestamp: 10,
              }],
            },
          }, "session-one");
          chat.addMessage({
            id: "orphan-process-two",
            role: "assistant",
            content: "",
            timestamp: 20,
            isStreaming: true,
            process: {
              startedAt: 20,
              expanded: true,
              entries: [{
                id: "orphan-tool-two",
                type: "tool",
                title: "also running",
                state: "running",
                timestamp: 20,
              }],
            },
          }, "session-one");
        },
      },
    });

    expect(result).toMatchObject({ error: "offline" });
    expect(useProjectStore.getState().agentStatuses["session-one"]).toBe("idle");
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().messages.some(hasOpenAssistantProcessState)).toBe(false);
    expect(useChatStore.getState().messages.filter((candidate) => candidate.role === "assistant"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "orphan-process-one",
          isStreaming: false,
          process: expect.objectContaining({ endedAt: expect.any(Number) }),
        }),
        expect.objectContaining({
          id: "orphan-process-two",
          isStreaming: false,
          process: expect.objectContaining({ endedAt: expect.any(Number) }),
        }),
      ]));
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: "system",
      content: "发送失败: offline",
    });
  });

  it("initializes a background session without changing the desktop selection", async () => {
    useProjectStore.setState({ initializedSessionIds: new Set(["session-one"]) });
    electronAPI.agentGetSessionState.mockResolvedValueOnce({
      success: false,
      idle: true,
      error: "No active agent",
    });
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

  it("reuses and monitors a busy backend that survived a renderer reload", async () => {
    useProjectStore.setState({ initializedSessionIds: new Set(["session-one"]) });
    useChatStore.getState().loadSessionMessages("session-two", [{
      id: "persisted-turn",
      role: "assistant",
      content: "",
      timestamp: 10,
      isStreaming: false,
      process: {
        startedAt: 10,
        endedAt: 11,
        expanded: false,
        entries: [{
          id: "old-tool",
          type: "tool",
          title: "interrupted during reload",
          timestamp: 11,
          state: "interrupted",
        }],
      },
    }]);
    electronAPI.agentGetSessionState
      .mockResolvedValueOnce({ success: true, idle: false })
      .mockResolvedValueOnce({ success: true, idle: true });

    await SessionCommandCoordinator.initializeSession("session-two", { activate: true });

    expect(electronAPI.agentCreateSession).not.toHaveBeenCalled();
    expect(useProjectStore.getState().initializedSessionIds.has("session-two")).toBe(true);
    expect(useProjectStore.getState().agentStatuses["session-two"]).toBe("running");
    expect(useChatStore.getState().isStreaming).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(useProjectStore.getState().agentStatuses["session-two"]).toBe("idle");
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it("reuses an idle backend and terminalizes stale renderer-only state", async () => {
    useProjectStore.setState({
      initializedSessionIds: new Set(["session-one"]),
      agentStatuses: { "session-two": "running" },
    });
    useChatStore.getState().loadSessionMessages("session-two", [{
      id: "stale-renderer-turn",
      role: "assistant",
      content: "",
      timestamp: 10,
      isStreaming: true,
      process: {
        startedAt: 10,
        expanded: true,
        entries: [{
          id: "stale-tool",
          type: "tool",
          title: "running",
          timestamp: 11,
          state: "running",
        }],
      },
    }]);
    useChatStore.setState({ compactingSessions: { "session-two": true } });
    electronAPI.agentGetSessionState.mockResolvedValueOnce({ success: true, idle: true });

    await SessionCommandCoordinator.initializeSession("session-two");

    expect(electronAPI.agentCreateSession).not.toHaveBeenCalled();
    expect(useProjectStore.getState().initializedSessionIds.has("session-two")).toBe(true);
    expect(useProjectStore.getState().agentStatuses["session-two"]).toBe("idle");
    expect(useChatStore.getState().compactingSessions["session-two"]).toBeUndefined();
    expect(useChatStore.getState().sessionMessages["session-two"][0]).toMatchObject({
      isStreaming: false,
      process: {
        endedAt: expect.any(Number),
        entries: [{ state: "completed" }],
      },
    });
  });

  it("does not replace a possibly live backend when its state probe is stale", async () => {
    useProjectStore.setState({ initializedSessionIds: new Set(["session-one"]) });
    electronAPI.agentGetSessionState.mockResolvedValueOnce({
      success: true,
      idle: false,
      stale: true,
    });

    const result = await SessionCommandCoordinator.initializeSession("session-two", {
      recordFailure: true,
    });

    expect(result.warning).toBe("SESSION_RUNTIME_STATE_UNKNOWN");
    expect(electronAPI.agentCreateSession).not.toHaveBeenCalled();
    expect(useProjectStore.getState().initializedSessionIds.has("session-two")).toBe(false);
  });

  it("closes and reopens through one lifecycle path", async () => {
    await SessionCommandCoordinator.closeSession("session-one");
    expect(useProjectStore.getState().projects[0].sessions[0].closed).toBe(true);
    expect(useChatStore.getState().activeSessionId).toBeNull();
    expect(electronAPI.agentRemoveSession).toHaveBeenCalledWith("session-one");

    await SessionCommandCoordinator.reopenSession("session-one");
    expect(useProjectStore.getState().projects[0].sessions[0].closed).toBe(false);
  });

  it("rejects new sends to an archived session", async () => {
    await SessionCommandCoordinator.closeSession("session-one");

    await expect(SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "closed-send",
      message,
    })).rejects.toThrow("SESSION_CLOSED");

    expect(electronAPI.agentSendMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().messageQueues["session-one"]).toBeUndefined();
  });

  it("serializes archiving behind an in-flight send and still clears its queue", async () => {
    let releaseSend = () => undefined;
    let notifySendStarted = () => undefined;
    const sendStarted = new Promise<void>((resolve) => {
      notifySendStarted = resolve;
    });
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    electronAPI.agentSendMessage.mockImplementationOnce(async () => {
      notifySendStarted();
      await sendGate;
      return { success: true };
    });
    useChatStore.setState({
      messageQueues: {
        "session-one": [{
          id: "archived-in-flight",
          sessionId: "session-one",
          displayContent: "queued",
          sendContent: "queued",
          createdAt: 1,
          status: "sending",
        }],
      },
    });

    const pendingSend = SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "archived-in-flight",
      message: { displayContent: "queued", sendContent: "queued" },
    });
    await sendStarted;
    const pendingClose = SessionCommandCoordinator.closeSession("session-one");
    releaseSend();

    await expect(pendingSend).resolves.toMatchObject({ queued: false });
    await expect(pendingClose).resolves.toMatchObject({ session: { closed: true } });
    expect(useChatStore.getState().messageQueues["session-one"]).toBeUndefined();
    expect(useChatStore.getState().sessionMessages["session-one"] || [])
      .not.toContainEqual(expect.objectContaining({ role: "system", content: expect.stringContaining("发送失败") }));
  });

  it("does not let a send recreate a runtime while the session is being archived", async () => {
    let releaseRemoval = () => undefined;
    let notifyRemovalStarted = () => undefined;
    const removalStarted = new Promise<void>((resolve) => {
      notifyRemovalStarted = resolve;
    });
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    electronAPI.agentRemoveSession.mockImplementationOnce(async () => {
      notifyRemovalStarted();
      await removalGate;
      return { success: true };
    });

    const pendingClose = SessionCommandCoordinator.closeSession("session-one");
    await removalStarted;
    const pendingSend = SessionCommandCoordinator.sendMessage({
      sessionId: "session-one",
      clientMessageId: "send-during-close",
      message,
    });
    releaseRemoval();

    await expect(pendingClose).resolves.toMatchObject({ session: { closed: true } });
    await expect(pendingSend).rejects.toThrow("SESSION_CLOSED");
    expect(electronAPI.agentSendMessage).not.toHaveBeenCalled();
    expect(electronAPI.agentCreateSession).not.toHaveBeenCalled();
  });

  it("orders a concurrent reopen after archiving completes", async () => {
    let releaseRemoval = () => undefined;
    let notifyRemovalStarted = () => undefined;
    const removalStarted = new Promise<void>((resolve) => {
      notifyRemovalStarted = resolve;
    });
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    electronAPI.agentRemoveSession.mockImplementationOnce(async () => {
      notifyRemovalStarted();
      await removalGate;
      return { success: true };
    });

    const pendingClose = SessionCommandCoordinator.closeSession("session-one");
    await removalStarted;
    const pendingReopen = SessionCommandCoordinator.reopenSession("session-one");
    releaseRemoval();

    await expect(pendingClose).resolves.toMatchObject({ session: { closed: true } });
    await expect(pendingReopen).resolves.toMatchObject({ session: { closed: false } });
    expect(useProjectStore.getState().projects[0].sessions[0].closed).toBe(false);
  });

  it("keeps renderer session state intact when backend disposal fails", async () => {
    electronAPI.agentRemoveSession.mockRejectedValueOnce(new Error("dispose failed"));

    await expect(SessionCommandCoordinator.closeSession("session-one"))
      .rejects.toThrow("dispose failed");

    expect(useProjectStore.getState().projects[0].sessions[0].closed).not.toBe(true);
    expect(useProjectStore.getState().activeSessionId).toBe("session-one");
    expect(useProjectStore.getState().initializedSessionIds.has("session-one")).toBe(true);
    expect(useChatStore.getState().activeSessionId).toBe("session-one");
  });

  it("archives a session when disposal reports an error after the backend was already removed", async () => {
    electronAPI.agentRemoveSession.mockRejectedValueOnce(new Error("dispose cleanup failed"));
    electronAPI.agentGetSessionState.mockResolvedValueOnce({
      success: false,
      idle: true,
      error: "No active agent",
    });

    await expect(SessionCommandCoordinator.closeSession("session-one"))
      .resolves.toMatchObject({
        session: { closed: true },
        warning: "Agent 已关闭，但清理过程报告异常：dispose cleanup failed",
      });

    expect(useChatStore.getState().activeSessionId).toBeNull();
    expect(useProjectStore.getState().initializedSessionIds.has("session-one")).toBe(false);
    expect(useChatStore.getState().messageQueues["session-one"]).toBeUndefined();
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

  it("canonicalizes the none protocol alias while preserving native max", async () => {
    const model = {
      id: "alias-reasoner",
      name: "Alias Reasoner",
      provider: "test",
      reasoning: true,
      supportedThinkingLevels: ["none", "low", "max"],
    };
    saveSessionModel("session-one", model);
    useChatStore.setState({ currentModel: model });

    await expect(SessionCommandCoordinator.setThinking("session-one", "max"))
      .resolves.toMatchObject({ level: "max" });
    expect(electronAPI.agentSetThinkingLevel).toHaveBeenLastCalledWith("max", "session-one");
    expect(getSessionThinking("session-one")).toBe("max");

    await expect(SessionCommandCoordinator.setThinking("session-one", "none"))
      .resolves.toMatchObject({ level: "off" });
    expect(electronAPI.agentSetThinkingLevel).toHaveBeenLastCalledWith("off", "session-one");
    expect(getSessionThinking("session-one")).toBe("off");
  });

  it("normalizes and persists thinking immediately after switching models", async () => {
    const previousModel = {
      id: "reasoner-a",
      name: "Reasoner A",
      provider: "test",
      reasoning: true,
      supportedThinkingLevels: ["off", "minimal", "low", "medium", "high"],
    };
    const nextModel = {
      id: "reasoner-b",
      name: "Reasoner B",
      provider: "test",
      reasoning: true,
      supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    };
    saveSessionModel("session-one", previousModel);
    saveSessionThinking("session-one", "minimal");
    useChatStore.setState({
      currentModel: previousModel,
      availableModels: [previousModel, nextModel],
      thinkingLevel: "minimal",
    });
    electronAPI.agentGetModels.mockResolvedValueOnce([previousModel, nextModel]);

    await expect(SessionCommandCoordinator.setModel("session-one", nextModel, {
      models: [previousModel, nextModel],
    })).resolves.toMatchObject({ model: nextModel });

    expect(electronAPI.agentSetThinkingLevel).toHaveBeenCalledWith("medium", "session-one");
    expect(getSessionThinking("session-one")).toBe("medium");
    expect(useChatStore.getState().thinkingLevel).toBe("medium");
  });

  it("normalizes an inactive session without overwriting the active toolbar", async () => {
    const nextModel = {
      id: "reasoner-inactive",
      name: "Inactive Reasoner",
      provider: "test",
      reasoning: true,
      supportedThinkingLevels: ["off", "low", "medium", "high"],
    };
    saveSessionThinking("session-two", "minimal");
    useChatStore.setState({ thinkingLevel: "high" });
    electronAPI.agentGetModels.mockResolvedValueOnce([nextModel]);

    await SessionCommandCoordinator.setModel("session-two", nextModel, { models: [nextModel] });

    expect(electronAPI.agentSetThinkingLevel).toHaveBeenCalledWith("medium", "session-two");
    expect(getSessionThinking("session-two")).toBe("medium");
    expect(useChatStore.getState().thinkingLevel).toBe("high");
  });

  it("does not invent thinking synchronization when a backend reports no levels", async () => {
    const opaqueModel = {
      id: "opaque",
      name: "Opaque",
      provider: "test",
      reasoning: true,
    };
    saveSessionThinking("session-two", "high");
    electronAPI.agentGetModels.mockResolvedValueOnce([opaqueModel]);

    await SessionCommandCoordinator.setModel("session-two", opaqueModel, { models: [opaqueModel] });

    expect(electronAPI.agentSetThinkingLevel).not.toHaveBeenCalled();
    expect(getSessionThinking("session-two")).toBe("high");
  });

  it("reconciles a persisted level after reloading model configuration", async () => {
    const reloadedModel = {
      id: "reloaded-reasoner",
      name: "Reloaded Reasoner",
      provider: "test",
      reasoning: true,
      supportedThinkingLevels: ["off", "low", "medium", "high"],
    };
    saveSessionThinking("session-one", "minimal");
    electronAPI.agentReloadConfig.mockResolvedValueOnce({
      success: true,
      models: [reloadedModel],
      reloadedSessionIds: ["session-one"],
    });

    await SessionCommandCoordinator.reloadSession("session-one");

    expect(electronAPI.agentSetThinkingLevel).toHaveBeenCalledWith("medium", "session-one");
    expect(getSessionThinking("session-one")).toBe("medium");
  });
});
