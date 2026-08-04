import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import { createAgentEventController } from "./agentEventController";
import { dispatchAgentEvent } from "./agentEventDispatcher";
import type { AgentEvent } from "@/types";
import type { PendingUIResponse, PendingUIResponseUpdate } from "./agentEventTypes";
import { resetSessionRuntimeAfterTurn, type SessionRuntime } from "./agentEventUtils";

const SESSION_ID = "lifecycle-session";

const agentGetSessionState = vi.fn(async () => ({ success: true, idle: false }));
const agentAbort = vi.fn(async () => ({ success: true }));
const showNotification = vi.fn(async () => undefined);

type ControllerHarness = ReturnType<typeof createHarness>;

function createHarness() {
  const sessionRuntimeRef: { current: Record<string, SessionRuntime> } = { current: {} };
  const pendingUIResponseRef: { current: PendingUIResponse } = { current: null };
  const streaming = { current: false };
  const setPendingUIResponse = (next: PendingUIResponseUpdate) => {
    pendingUIResponseRef.current = typeof next === "function"
      ? next(pendingUIResponseRef.current)
      : next;
  };
  const controller = createAgentEventController({
    activeAgentIdRef: { current: "codex" },
    sessionRuntimeRef,
    getPendingUIResponse: (sessionId) => (
      pendingUIResponseRef.current?.sessionId === sessionId ? pendingUIResponseRef.current : null
    ),
    setPendingUIResponse,
    setStreamingState: (next) => {
      streaming.current = next;
    },
  });
  return { controller, pendingUIResponseRef, sessionRuntimeRef, streaming };
}

const getMessages = () => {
  const state = useChatStore.getState();
  return state.sessionMessages[SESSION_ID] || (state.activeSessionId === SESSION_ID ? state.messages : []);
};

const startRunningProcess = (harness: ControllerHarness, entryId = "running-entry") => {
  const chat = useChatStore.getState();
  chat.startAssistantProcess(100, SESSION_ID);
  chat.appendLastAssistantProcessEntry({
    id: entryId,
    timestamp: 101,
    type: "thinking",
    title: "正在处理",
    state: "running",
  }, SESSION_ID);
  const runtime = harness.controller.getRuntime(SESSION_ID);
  runtime.processActive = true;
  runtime.streamStarted = true;
  useProjectStore.getState().setAgentStatus(SESSION_ID, "running");
  harness.streaming.current = true;
  return runtime;
};

beforeEach(() => {
  agentGetSessionState.mockReset().mockResolvedValue({ success: true, idle: false });
  agentAbort.mockReset().mockResolvedValue({ success: true });
  showNotification.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("window", {
    electronAPI: {
      agentGetSessionState,
      agentAbort,
      showNotification,
    },
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    hasFocus: () => true,
  });
  useProjectStore.setState({
    projects: [{
      id: "project-1",
      name: "Project",
      path: "C:\\project",
      createdAt: "2026-01-01T00:00:00.000Z",
      agents: ["codex"],
      sessions: [{
        id: SESSION_ID,
        agentId: "codex",
        agentSessionId: SESSION_ID,
        title: "Lifecycle",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      }],
    }],
    activeProjectId: "project-1",
    activeSessionId: SESSION_ID,
    agentStatuses: {},
    initializedSessionIds: new Set([SESSION_ID]),
  });
  useChatStore.setState({
    messages: [],
    sessionMessages: { [SESSION_ID]: [] },
    activeSessionId: SESSION_ID,
    isStreaming: false,
    compactingSessions: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("agent event terminal reconciliation", () => {
  it.each([
    { type: "stream_delta", delta: "late text" },
    { type: "stream_snapshot", content: "late snapshot" },
    { type: "commentary_delta", itemId: "late-commentary", delta: "late note" },
    { type: "commentary_end", itemId: "late-commentary", content: "late note" },
    { type: "thinking_delta", delta: "late thought" },
    { type: "thinking_end" },
    { type: "tool_start", toolKind: "read_file", toolCallId: "late-tool" },
    { type: "tool_end", toolKind: "read_file", toolCallId: "late-tool" },
    { type: "diff_update", diffs: [{ file: "late.ts", patch: "+late" }] },
    { type: "plan_update", steps: [{ step: "late plan", status: "in_progress" }] },
    { type: "process_event", entryType: "status", id: "late-process", state: "running" },
    { type: "ask_user_question", id: "late-question", question: "Continue?" },
    { type: "subagent_event", id: "late-subagent", state: "running" },
    { type: "agent_disconnected", detail: "late disconnect" },
    { type: "aborted" },
    { type: "agent_end" },
    { type: "backend_idle" },
  ] satisfies AgentEvent[])(
    "ignores a late $type event from a settled lifecycle revision",
    (lateEvent) => {
      const harness = createHarness();
      useChatStore.getState().addMessage({
        id: "user-turn-1",
        role: "user",
        content: "run",
        timestamp: 90,
      }, SESSION_ID);
      dispatchAgentEvent({
        type: "stream_start",
        lifecycleRevision: "backend:1",
        clientUserMessageId: "user-turn-1",
        sessionId: SESSION_ID,
      }, harness.controller);
      dispatchAgentEvent({
        type: "stream_end",
        lifecycleRevision: "backend:1",
        content: "done",
        sessionId: SESSION_ID,
      }, harness.controller);
      const before = getMessages();

      dispatchAgentEvent({
        ...lateEvent,
        lifecycleRevision: "backend:1",
        sessionId: SESSION_ID,
      }, harness.controller);

      expect(getMessages()).toBe(before);
      expect(harness.controller.getRuntime(SESSION_ID).turnEventState).toBe("settled");
      expect(harness.pendingUIResponseRef.current).toBeNull();
      expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("idle");
    },
  );

  it("keeps a newer turn active when terminal events from an older revision arrive late", () => {
    const harness = createHarness();
    useChatStore.getState().addMessage({
      id: "user-turn-1",
      role: "user",
      content: "first",
      timestamp: 90,
    }, SESSION_ID);
    dispatchAgentEvent({
      type: "stream_start",
      lifecycleRevision: "backend:1",
      sessionId: SESSION_ID,
    }, harness.controller);
    dispatchAgentEvent({
      type: "stream_end",
      lifecycleRevision: "backend:1",
      content: "first done",
      sessionId: SESSION_ID,
    }, harness.controller);

    useChatStore.getState().addMessage({
      id: "user-turn-2",
      role: "user",
      content: "second",
      timestamp: 200,
    }, SESSION_ID);
    dispatchAgentEvent({
      type: "stream_start",
      lifecycleRevision: "backend:2",
      clientUserMessageId: "user-turn-2",
      sessionId: SESSION_ID,
    }, harness.controller);
    dispatchAgentEvent({
      type: "stream_delta",
      lifecycleRevision: "backend:2",
      delta: "second running",
      sessionId: SESSION_ID,
    }, harness.controller);

    dispatchAgentEvent({
      type: "stream_end",
      lifecycleRevision: "backend:1",
      // Even if a generic host can only stamp the currently active client id
      // onto a queued old event, the comparable lower revision must win.
      clientUserMessageId: "user-turn-2",
      content: "stale final",
      sessionId: SESSION_ID,
    }, harness.controller);
    dispatchAgentEvent({
      type: "agent_disconnected",
      lifecycleRevision: "backend:1",
      clientUserMessageId: "user-turn-1",
      sessionId: SESSION_ID,
    }, harness.controller);

    const runtime = harness.controller.getRuntime(SESSION_ID);
    expect(runtime.turnEventState).toBe("active");
    expect(runtime.processActive).toBe(true);
    expect(runtime.activeTurnRevision).toBe("backend:2");
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("running");
    harness.controller.clearAllStreamWatchdogs();
  });

  it("settles a host turn that fails before plugin output and ignores its delayed delta", () => {
    const harness = createHarness();
    useChatStore.getState().addMessage({
      id: "failed-user-turn",
      role: "user",
      content: "run",
      timestamp: 90,
    }, SESSION_ID);
    dispatchAgentEvent({
      type: "turn_lifecycle",
      lifecycleRevision: "backend:failed-1",
      clientUserMessageId: "failed-user-turn",
      sessionId: SESSION_ID,
    }, harness.controller);
    dispatchAgentEvent({
      type: "turn_failed",
      lifecycleRevision: "backend:failed-1",
      clientUserMessageId: "failed-user-turn",
      sessionId: SESSION_ID,
    }, harness.controller);
    const before = getMessages();

    dispatchAgentEvent({
      type: "stream_delta",
      lifecycleRevision: "backend:failed-1",
      clientUserMessageId: "failed-user-turn",
      delta: "late output",
      sessionId: SESSION_ID,
    }, harness.controller);

    expect(getMessages()).toBe(before);
    expect(harness.controller.getRuntime(SESSION_ID).turnEventState).toBe("settled");
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("idle");
  });

  it("settles a missing-terminal stream on backend_idle and rejects later output", () => {
    const harness = createHarness();
    useChatStore.getState().addMessage({
      id: "idle-fallback-user",
      role: "user",
      content: "run",
      timestamp: 90,
    }, SESSION_ID);
    dispatchAgentEvent({
      type: "stream_start",
      lifecycleRevision: "backend:idle-fallback:1",
      clientUserMessageId: "idle-fallback-user",
      sessionId: SESSION_ID,
    }, harness.controller);
    dispatchAgentEvent({
      type: "stream_delta",
      lifecycleRevision: "backend:idle-fallback:1",
      clientUserMessageId: "idle-fallback-user",
      delta: "final output",
      sessionId: SESSION_ID,
    }, harness.controller);
    dispatchAgentEvent({
      type: "backend_idle",
      lifecycleRevision: "backend:idle-fallback:1",
      clientUserMessageId: "idle-fallback-user",
      sessionId: SESSION_ID,
    }, harness.controller);

    const runtime = harness.controller.getRuntime(SESSION_ID);
    expect(runtime.turnEventState).toBe("settled");
    expect(getMessages().find((message) => message.process)?.process?.endedAt).toBeTypeOf("number");
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("idle");
    const settledMessages = getMessages();

    dispatchAgentEvent({
      type: "stream_delta",
      lifecycleRevision: "backend:idle-fallback:1",
      clientUserMessageId: "idle-fallback-user",
      delta: "late output",
      sessionId: SESSION_ID,
    }, harness.controller);

    expect(getMessages()).toBe(settledMessages);
  });

  it("keeps accepting output after a recoverable process error until the backend is idle", () => {
    const harness = createHarness();
    useChatStore.getState().addMessage({
      id: "recoverable-error-user",
      role: "user",
      content: "try another way",
      timestamp: 90,
    }, SESSION_ID);
    const identity = {
      lifecycleRevision: "backend:recoverable-error:1",
      clientUserMessageId: "recoverable-error-user",
      sessionId: SESSION_ID,
    };

    dispatchAgentEvent({ type: "stream_start", ...identity }, harness.controller);
    dispatchAgentEvent({
      type: "process_event",
      id: "failed-tool",
      entryType: "error",
      title: "第一次读取失败",
      detail: "temporary failure",
      state: "error",
      ...identity,
    }, harness.controller);

    const runtime = harness.controller.getRuntime(SESSION_ID);
    expect(runtime.turnEventState).toBe("active");
    expect(runtime.processActive).toBe(true);
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("running");
    expect(getMessages().find((message) => message.process)?.process?.entries)
      .toContainEqual(expect.objectContaining({ id: "failed-tool", state: "error" }));

    dispatchAgentEvent({
      type: "stream_delta",
      delta: "已换用其他方式完成。",
      ...identity,
    }, harness.controller);
    dispatchAgentEvent({ type: "backend_idle", ...identity }, harness.controller);

    expect(runtime.turnEventState).toBe("settled");
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("idle");
    expect(getMessages().some((message) => message.role === "assistant" && message.content === "已换用其他方式完成。"))
      .toBe(true);
  });

  it("does not let backend_idle consume a pending UI question", () => {
    const harness = createHarness();
    useChatStore.getState().addMessage({
      id: "pending-question-user",
      role: "user",
      content: "ask",
      timestamp: 90,
    }, SESSION_ID);
    dispatchAgentEvent({
      type: "stream_start",
      lifecycleRevision: "backend:pending-question:1",
      clientUserMessageId: "pending-question-user",
      sessionId: SESSION_ID,
    }, harness.controller);
    dispatchAgentEvent({
      type: "ask_user_question",
      id: "pending-question",
      lifecycleRevision: "backend:pending-question:1",
      clientUserMessageId: "pending-question-user",
      question: "Continue?",
      sessionId: SESSION_ID,
    }, harness.controller);

    dispatchAgentEvent({
      type: "backend_idle",
      lifecycleRevision: "backend:pending-question:1",
      clientUserMessageId: "pending-question-user",
      sessionId: SESSION_ID,
    }, harness.controller);

    const runtime = harness.controller.getRuntime(SESSION_ID);
    expect(harness.pendingUIResponseRef.current?.requestId).toBe("pending-question");
    expect(runtime.turnEventState).toBe("active");
    expect(runtime.processActive).toBe(true);
    expect(runtime.streamWatchdog).not.toBeNull();
    expect(getMessages().find((message) => message.process)?.process?.endedAt).toBeUndefined();
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("running");

    // Mirror the UI response path: it closes the question block and clears
    // transient render buffers while preserving the active lifecycle identity.
    harness.pendingUIResponseRef.current = null;
    useChatStore.getState().finishLastAssistantProcess(Date.now(), "completed", SESSION_ID);
    resetSessionRuntimeAfterTurn(runtime);
    dispatchAgentEvent({
      type: "backend_idle",
      lifecycleRevision: "backend:pending-question:1",
      clientUserMessageId: "pending-question-user",
      sessionId: SESSION_ID,
    }, harness.controller);

    expect(runtime.turnEventState).toBe("settled");
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("idle");
  });

  it("terminalizes an empty stream_end runtime and allows the next revision", () => {
    const harness = createHarness();
    useChatStore.getState().addMessage({
      id: "empty-stream-user",
      role: "user",
      content: "first",
      timestamp: 90,
    }, SESSION_ID);

    dispatchAgentEvent({
      type: "stream_end",
      lifecycleRevision: "backend:1",
      clientUserMessageId: "empty-stream-user",
      sessionId: SESSION_ID,
    }, harness.controller);

    expect(harness.controller.getRuntime(SESSION_ID).turnEventState).toBe("settled");
    expect(showNotification).not.toHaveBeenCalled();

    useChatStore.getState().addMessage({
      id: "next-stream-user",
      role: "user",
      content: "second",
      timestamp: 100,
    }, SESSION_ID);
    dispatchAgentEvent({
      type: "stream_start",
      lifecycleRevision: "backend:2",
      clientUserMessageId: "next-stream-user",
      sessionId: SESSION_ID,
    }, harness.controller);

    expect(harness.controller.getRuntime(SESSION_ID).turnEventState).toBe("active");
    expect(harness.controller.getRuntime(SESSION_ID).activeTurnRevision).toBe("backend:2");
    harness.controller.clearAllStreamWatchdogs();
  });

  it("terminalizes an empty agent_end after idle reconciliation and allows the next revision", async () => {
    vi.useFakeTimers();
    agentGetSessionState.mockResolvedValue({ success: true, idle: true });
    const harness = createHarness();
    useChatStore.getState().addMessage({
      id: "empty-agent-user",
      role: "user",
      content: "first",
      timestamp: 90,
    }, SESSION_ID);

    dispatchAgentEvent({
      type: "agent_end",
      lifecycleRevision: "backend:1",
      clientUserMessageId: "empty-agent-user",
      sessionId: SESSION_ID,
    }, harness.controller);
    await vi.advanceTimersByTimeAsync(750);

    expect(harness.controller.getRuntime(SESSION_ID).turnEventState).toBe("settled");
    expect(showNotification).not.toHaveBeenCalled();

    useChatStore.getState().addMessage({
      id: "next-agent-user",
      role: "user",
      content: "second",
      timestamp: 100,
    }, SESSION_ID);
    dispatchAgentEvent({
      type: "stream_start",
      lifecycleRevision: "backend:2",
      clientUserMessageId: "next-agent-user",
      sessionId: SESSION_ID,
    }, harness.controller);

    expect(harness.controller.getRuntime(SESSION_ID).activeTurnRevision).toBe("backend:2");
    harness.controller.clearAllStreamWatchdogs();
  });

  it("supersedes stale in-memory runtime state for a host-stamped remote turn", () => {
    const harness = createHarness();
    useChatStore.getState().addMessage({
      id: "desktop-user-1",
      role: "user",
      content: "first",
      timestamp: 90,
    }, SESSION_ID);
    dispatchAgentEvent({
      type: "stream_start",
      lifecycleRevision: "backend:1",
      clientUserMessageId: "desktop-user-1",
      sessionId: SESSION_ID,
    }, harness.controller);

    // Remote command reconciliation can authoritatively close store/status
    // state without access to ChatPanel's in-memory runtime ref.
    useChatStore.getState().finishAllAssistantProcesses(150, "interrupted", SESSION_ID);
    useProjectStore.getState().setAgentStatus(SESSION_ID, "idle");
    useChatStore.getState().addMessage({
      id: "mobile-user-2",
      role: "user",
      content: "second",
      timestamp: 200,
    }, SESSION_ID);

    dispatchAgentEvent({
      type: "tool_start",
      lifecycleRevision: "backend:2",
      clientUserMessageId: "mobile-user-2",
      toolKind: "read_file",
      toolCallId: "remote-first-tool",
      filePath: "README.md",
      sessionId: SESSION_ID,
    }, harness.controller);

    const runtime = harness.controller.getRuntime(SESSION_ID);
    expect(runtime.turnEventState).toBe("active");
    expect(runtime.activeTurnRevision).toBe("backend:2");
    expect(runtime.activeTurnUserMessageId).toBe("mobile-user-2");
    expect(runtime.processActive).toBe(true);
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("running");
    harness.controller.clearAllStreamWatchdogs();
  });

  it("uses a new user message as the fallback identity when an adapter has no revision", () => {
    const harness = createHarness();
    useChatStore.getState().addMessage({
      id: "user-turn-1",
      role: "user",
      content: "first",
      timestamp: 90,
    }, SESSION_ID);
    dispatchAgentEvent({ type: "stream_start", sessionId: SESSION_ID }, harness.controller);
    dispatchAgentEvent({ type: "stream_end", content: "done", sessionId: SESSION_ID }, harness.controller);

    dispatchAgentEvent({ type: "stream_start", sessionId: SESSION_ID }, harness.controller);
    expect(harness.controller.getRuntime(SESSION_ID).turnEventState).toBe("settled");

    useChatStore.getState().addMessage({
      id: "user-turn-2",
      role: "user",
      content: "second",
      timestamp: 200,
    }, SESSION_ID);
    dispatchAgentEvent({ type: "stream_start", sessionId: SESSION_ID }, harness.controller);

    expect(harness.controller.getRuntime(SESSION_ID).turnEventState).toBe("active");
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("running");
    harness.controller.clearAllStreamWatchdogs();
  });

  it("allows post-response compaction once but rejects duplicate starts and compaction after abort", () => {
    const harness = createHarness();
    useChatStore.getState().addMessage({
      id: "user-turn-1",
      role: "user",
      content: "first",
      timestamp: 90,
    }, SESSION_ID);
    dispatchAgentEvent({ type: "stream_start", sessionId: SESSION_ID }, harness.controller);
    dispatchAgentEvent({ type: "stream_end", content: "done", sessionId: SESSION_ID }, harness.controller);
    dispatchAgentEvent({
      type: "context_compaction",
      id: "compact-after-final",
      phase: "started",
      sessionId: SESSION_ID,
    }, harness.controller);
    expect(useChatStore.getState().compactingSessions[SESSION_ID]).toBe(true);
    dispatchAgentEvent({
      type: "context_compaction",
      id: "compact-after-final",
      phase: "completed",
      sessionId: SESSION_ID,
    }, harness.controller);
    expect(useChatStore.getState().compactingSessions[SESSION_ID]).toBeUndefined();

    dispatchAgentEvent({
      type: "context_compaction",
      id: "compact-after-final",
      phase: "started",
      sessionId: SESSION_ID,
    }, harness.controller);
    expect(useChatStore.getState().compactingSessions[SESSION_ID]).toBeUndefined();

    useChatStore.getState().addMessage({
      id: "user-turn-2",
      role: "user",
      content: "second",
      timestamp: 200,
    }, SESSION_ID);
    dispatchAgentEvent({ type: "stream_start", sessionId: SESSION_ID }, harness.controller);
    dispatchAgentEvent({ type: "aborted", sessionId: SESSION_ID }, harness.controller);
    dispatchAgentEvent({
      type: "context_compaction",
      id: "compact-after-abort",
      phase: "started",
      sessionId: SESSION_ID,
    }, harness.controller);
    expect(useChatStore.getState().compactingSessions[SESSION_ID]).toBeUndefined();
  });

  it("completes a post-response compaction when backend_idle replaces a lost completion event", () => {
    const harness = createHarness();
    useChatStore.getState().addMessage({
      id: "user-before-compaction",
      role: "user",
      content: "run",
      timestamp: 90,
    }, SESSION_ID);
    dispatchAgentEvent({
      type: "stream_start",
      lifecycleRevision: "backend:turn:1",
      clientUserMessageId: "user-before-compaction",
      sessionId: SESSION_ID,
    }, harness.controller);
    dispatchAgentEvent({
      type: "stream_end",
      lifecycleRevision: "backend:turn:1",
      content: "done",
      sessionId: SESSION_ID,
    }, harness.controller);
    dispatchAgentEvent({
      type: "context_compaction",
      id: "compact-without-completion",
      phase: "started",
      lifecycleRevision: "backend:compaction:2",
      sessionId: SESSION_ID,
    }, harness.controller);

    expect(useChatStore.getState().compactingSessions[SESSION_ID]).toBe(true);
    dispatchAgentEvent({
      type: "backend_idle",
      lifecycleRevision: "backend:compaction:2",
      sessionId: SESSION_ID,
    }, harness.controller);

    const divider = getMessages().find((message) => message.eventId === "compact-without-completion");
    expect(divider?.compactionState).toBe("completed");
    expect(useChatStore.getState().compactingSessions[SESSION_ID]).toBeUndefined();
    expect(harness.controller.getRuntime(SESSION_ID).turnEventState).toBe("settled");
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("idle");
  });

  it("keeps a closed and reopened session protected from its queued old events", () => {
    const harness = createHarness();
    useChatStore.getState().addMessage({
      id: "user-before-close",
      role: "user",
      content: "run",
      timestamp: 90,
    }, SESSION_ID);
    dispatchAgentEvent({
      type: "stream_start",
      lifecycleRevision: "closed-backend:1",
      sessionId: SESSION_ID,
    }, harness.controller);
    useProjectStore.getState().closeSession("project-1", SESSION_ID);

    dispatchAgentEvent({
      type: "tool_start",
      lifecycleRevision: "closed-backend:1",
      toolKind: "read_file",
      toolCallId: "queued-before-close",
      sessionId: SESSION_ID,
    }, harness.controller);
    const afterClose = getMessages();
    expect(afterClose.every((message) => !message.process || message.process.endedAt !== undefined)).toBe(true);

    useProjectStore.getState().reopenSession("project-1", SESSION_ID);
    dispatchAgentEvent({
      type: "stream_delta",
      lifecycleRevision: "closed-backend:1",
      delta: "late after reopen",
      sessionId: SESSION_ID,
    }, harness.controller);

    expect(getMessages()).toBe(afterClose);
    expect(harness.controller.getRuntime(SESSION_ID).turnEventState).toBe("settled");
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).not.toBe("running");
  });

  it("settles every open process for an aborted event without a manual-abort flag", () => {
    const harness = createHarness();
    const runtime = startRunningProcess(harness);

    dispatchAgentEvent({ type: "aborted", sessionId: SESSION_ID }, harness.controller);

    const process = getMessages().find((message) => message.process)?.process;
    expect(process?.endedAt).toBeTypeOf("number");
    expect(process?.entries[0].state).toBe("interrupted");
    expect(runtime.processActive).toBe(false);
    expect(runtime.streamWatchdog).toBeNull();
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("idle");
  });

  it("uses agent_end grace plus backend idle state when stream_end is missing", async () => {
    vi.useFakeTimers();
    agentGetSessionState.mockResolvedValue({ success: true, idle: true });
    const harness = createHarness();
    startRunningProcess(harness);

    dispatchAgentEvent({ type: "agent_end", sessionId: SESSION_ID }, harness.controller);
    expect(getMessages().find((message) => message.process)?.process?.endedAt).toBeUndefined();

    await vi.advanceTimersByTimeAsync(750);

    expect(agentGetSessionState).toHaveBeenCalledWith(SESSION_ID);
    expect(getMessages().find((message) => message.process)?.process?.endedAt).toBeTypeOf("number");
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("idle");
  });

  it.each(["model_changed", "thinking_level_changed"])(
    "does not let a %s control event cancel agent_end reconciliation",
    async (controlEventType) => {
      vi.useFakeTimers();
      agentGetSessionState.mockResolvedValue({ success: true, idle: true });
      const harness = createHarness();
      startRunningProcess(harness);

      dispatchAgentEvent({
        type: "agent_end",
        lifecycleRevision: "backend:control-event:1",
        sessionId: SESSION_ID,
      }, harness.controller);
      await vi.advanceTimersByTimeAsync(100);
      dispatchAgentEvent({
        type: controlEventType,
        lifecycleRevision: "backend:control-event:1",
        sessionId: SESSION_ID,
      }, harness.controller);
      await vi.advanceTimersByTimeAsync(700);

      expect(agentGetSessionState).toHaveBeenCalledTimes(1);
      expect(harness.controller.getRuntime(SESSION_ID).turnEventState).toBe("settled");
      expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("idle");
    },
  );

  it("does not let a trailing compaction completion cancel agent_end reconciliation", async () => {
    vi.useFakeTimers();
    agentGetSessionState.mockResolvedValue({ success: true, idle: true });
    const harness = createHarness();
    startRunningProcess(harness);

    dispatchAgentEvent({
      type: "agent_end",
      lifecycleRevision: "backend:trailing-compaction:1",
      sessionId: SESSION_ID,
    }, harness.controller);
    await vi.advanceTimersByTimeAsync(100);
    dispatchAgentEvent({
      type: "context_compaction",
      id: "trailing-compaction",
      phase: "completed",
      lifecycleRevision: "backend:trailing-compaction:1",
      sessionId: SESSION_ID,
    }, harness.controller);
    await vi.advanceTimersByTimeAsync(700);

    expect(agentGetSessionState).toHaveBeenCalledTimes(1);
    expect(harness.controller.getRuntime(SESSION_ID).turnEventState).toBe("settled");
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("idle");
  });

  it.each([
    { label: "tool_end", event: { type: "tool_end", toolKind: "read_file", toolCallId: "late-tool" } },
    { label: "thinking_end", event: { type: "thinking_end" } },
    { label: "commentary_end", event: { type: "commentary_end", itemId: "late-commentary" } },
    {
      label: "completed process_event",
      event: { type: "process_event", entryType: "status", id: "late-process-complete", state: "completed" },
    },
    {
      label: "errored process_event",
      event: { type: "process_event", entryType: "error", id: "late-process-error", state: "error" },
    },
    {
      label: "interrupted process_event",
      event: { type: "process_event", entryType: "status", id: "late-process-stop", state: "interrupted" },
    },
    {
      label: "completed subagent_event",
      event: { type: "subagent_event", id: "late-subagent-complete", state: "completed" },
    },
    {
      label: "errored subagent_event",
      event: { type: "subagent_event", id: "late-subagent-error", state: "error" },
    },
    {
      label: "interrupted subagent_event",
      event: { type: "subagent_event", id: "late-subagent-stop", state: "interrupted" },
    },
    {
      label: "diff_update",
      event: { type: "diff_update", diffs: [{ file: "late.ts", patch: "+late" }] },
    },
    {
      label: "completed plan_update",
      event: { type: "plan_update", steps: [{ step: "late plan", status: "completed" }] },
    },
    { label: "empty stream_delta", event: { type: "stream_delta", delta: "" } },
    { label: "empty stream_snapshot", event: { type: "stream_snapshot", content: "" } },
    {
      label: "commentary_delta without an item id",
      event: { type: "commentary_delta", delta: "late note" },
    },
    {
      label: "commentary_delta without content",
      event: { type: "commentary_delta", itemId: "late-commentary", delta: "" },
    },
    { label: "empty thinking_delta", event: { type: "thinking_delta", delta: "" } },
  ] satisfies Array<{ label: string; event: AgentEvent }>)(
    "does not let a trailing $label cancel agent_end reconciliation",
    async ({ event }) => {
      vi.useFakeTimers();
      agentGetSessionState.mockResolvedValue({ success: true, idle: true });
      const harness = createHarness();
      startRunningProcess(harness);

      dispatchAgentEvent({
        type: "agent_end",
        lifecycleRevision: "backend:trailing-terminal:1",
        sessionId: SESSION_ID,
      }, harness.controller);
      await vi.advanceTimersByTimeAsync(100);
      dispatchAgentEvent({
        ...event,
        lifecycleRevision: "backend:trailing-terminal:1",
        sessionId: SESSION_ID,
      }, harness.controller);
      await vi.advanceTimersByTimeAsync(700);

      expect(agentGetSessionState).toHaveBeenCalledTimes(1);
      expect(harness.controller.getRuntime(SESSION_ID).turnEventState).toBe("settled");
      expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("idle");
    },
  );

  it("interrupts an agent_end turn when the backend no longer exists", async () => {
    vi.useFakeTimers();
    agentGetSessionState.mockResolvedValue({
      success: false,
      idle: true,
      error: "No active agent",
    });
    const harness = createHarness();
    startRunningProcess(harness);

    dispatchAgentEvent({ type: "agent_end", sessionId: SESSION_ID }, harness.controller);
    await vi.advanceTimersByTimeAsync(750);

    const process = getMessages().find((message) => message.process)?.process;
    expect(process?.endedAt).toBeTypeOf("number");
    expect(process?.entries[0].state).toBe("interrupted");
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("error");
  });

  it("bounds state-query failures after an explicit agent_end", async () => {
    vi.useFakeTimers();
    agentGetSessionState.mockRejectedValue(new Error("IPC unavailable"));
    const harness = createHarness();
    const runtime = startRunningProcess(harness);

    dispatchAgentEvent({ type: "agent_end", sessionId: SESSION_ID }, harness.controller);
    await vi.advanceTimersByTimeAsync(3_750);

    const process = getMessages().find((message) => message.process)?.process;
    expect(agentGetSessionState).toHaveBeenCalledTimes(3);
    expect(process?.endedAt).toBeTypeOf("number");
    expect(process?.entries[0].state).toBe("interrupted");
    expect(runtime.streamWatchdog).toBeNull();
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("error");
  });

  it("bounds stale cached-busy results after an explicit agent_end", async () => {
    vi.useFakeTimers();
    agentGetSessionState.mockResolvedValue({
      success: true,
      idle: false,
      stale: true,
      error: "idle query failed",
    });
    const harness = createHarness();
    startRunningProcess(harness);

    dispatchAgentEvent({ type: "agent_end", sessionId: SESSION_ID }, harness.controller);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(agentGetSessionState).toHaveBeenCalledTimes(3);
    expect(harness.controller.getRuntime(SESSION_ID).turnEventState).toBe("settled");
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("error");
  });

  it("does not let duplicate agent_end events reset the query-failure bound", async () => {
    vi.useFakeTimers();
    agentGetSessionState.mockRejectedValue(new Error("IPC unavailable"));
    const harness = createHarness();
    startRunningProcess(harness);

    dispatchAgentEvent({ type: "agent_end", sessionId: SESSION_ID }, harness.controller);
    await vi.advanceTimersByTimeAsync(750);
    dispatchAgentEvent({ type: "agent_end", sessionId: SESSION_ID }, harness.controller);
    await vi.advanceTimersByTimeAsync(2_750);

    expect(agentGetSessionState).toHaveBeenCalledTimes(3);
    expect(getMessages().find((message) => message.process)?.process?.endedAt).toBeTypeOf("number");
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("error");
  });

  it("does not count agent_end query failures while a user response is pending", async () => {
    vi.useFakeTimers();
    agentGetSessionState.mockRejectedValue(new Error("IPC unavailable"));
    const harness = createHarness();
    const runtime = startRunningProcess(harness, "pending-agent-end-question");
    harness.pendingUIResponseRef.current = {
      sessionId: SESSION_ID,
      requestId: "pending-agent-end-question",
      entryId: "pending-agent-end-question",
    };

    dispatchAgentEvent({ type: "agent_end", sessionId: SESSION_ID }, harness.controller);
    await vi.advanceTimersByTimeAsync(750);

    expect(agentGetSessionState).toHaveBeenCalledTimes(1);
    expect(getMessages().find((message) => message.process)?.process?.endedAt).toBeUndefined();
    expect(runtime.streamWatchdog).not.toBeNull();
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("running");

    harness.pendingUIResponseRef.current = null;
    await vi.advanceTimersByTimeAsync(48_000);

    expect(agentGetSessionState).toHaveBeenCalledTimes(4);
    expect(getMessages().find((message) => message.process)?.process?.endedAt).toBeTypeOf("number");
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("error");
  });

  it("cancels agent_end grace when a retry emits continuation output", async () => {
    vi.useFakeTimers();
    agentGetSessionState.mockResolvedValue({ success: true, idle: true });
    const harness = createHarness();
    startRunningProcess(harness);

    dispatchAgentEvent({ type: "agent_end", sessionId: SESSION_ID }, harness.controller);
    dispatchAgentEvent({ type: "thinking_delta", delta: "retrying", sessionId: SESSION_ID }, harness.controller);
    await vi.advanceTimersByTimeAsync(750);

    expect(agentGetSessionState).not.toHaveBeenCalled();
    expect(getMessages().find((message) => message.process)?.process?.endedAt).toBeUndefined();
    harness.controller.clearAllStreamWatchdogs();
  });

  it("settles a store-open process and running compaction after runtime state was lost", () => {
    const harness = createHarness();
    const chat = useChatStore.getState();
    chat.startAssistantProcess(100, SESSION_ID);
    chat.appendLastAssistantProcessEntry({
      id: "lost-runtime-entry",
      timestamp: 101,
      type: "tool",
      title: "正在执行",
      state: "running",
    }, SESSION_ID);
    chat.appendContextCompactionDivider("compact-lost", SESSION_ID, "running");
    chat.setSessionCompacting(SESSION_ID, true);
    useProjectStore.getState().setAgentStatus(SESSION_ID, "running");
    expect(harness.controller.getRuntime(SESSION_ID).processActive).toBe(false);

    dispatchAgentEvent({ type: "agent_disconnected", sessionId: SESSION_ID }, harness.controller);

    const messages = getMessages();
    const process = messages.find((message) => message.process)?.process;
    const divider = messages.find((message) => message.eventId === "compact-lost");
    expect(process?.endedAt).toBeTypeOf("number");
    expect(process?.entries.every((entry) => entry.state !== "running")).toBe(true);
    expect(divider?.compactionState).toBe("interrupted");
    expect(useChatStore.getState().compactingSessions[SESSION_ID]).toBeUndefined();
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("error");
  });

  it.each(["completed", "interrupted"] as const)(
    "returns an idle compaction to idle after %s",
    (phase) => {
    const harness = createHarness();

    dispatchAgentEvent({
      type: "context_compaction",
      id: "compact-idle",
      phase: "started",
      sessionId: SESSION_ID,
    }, harness.controller);
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("running");
    expect(useChatStore.getState().compactingSessions[SESSION_ID]).toBe(true);

    dispatchAgentEvent({
      type: "context_compaction",
      id: "compact-idle",
      phase,
      sessionId: SESSION_ID,
    }, harness.controller);

    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("idle");
    expect(useChatStore.getState().compactingSessions[SESSION_ID]).toBeUndefined();
    expect(harness.streaming.current).toBe(false);
    expect(getMessages().find((message) => message.eventId === "compact-idle")?.compactionState).toBe(phase);
    },
  );

  it("does not recreate pending UI for a terminal process question", () => {
    const harness = createHarness();
    dispatchAgentEvent({
      type: "process_event",
      entryType: "question",
      id: "question-1",
      state: "running",
      title: "请选择",
      sessionId: SESSION_ID,
    }, harness.controller);
    expect(harness.pendingUIResponseRef.current?.requestId).toBe("question-1");

    dispatchAgentEvent({
      type: "process_event",
      entryType: "question",
      id: "question-1",
      state: "completed",
      title: "已选择",
      sessionId: SESSION_ID,
    }, harness.controller);

    expect(harness.pendingUIResponseRef.current).toBeNull();
    const question = getMessages()
      .flatMap((message) => message.process?.entries || [])
      .find((entry) => entry.id === "question-1");
    expect(question?.state).toBe("completed");
  });

  it("settles a generic process question when its terminal id drifts", () => {
    const harness = createHarness();
    dispatchAgentEvent({
      type: "process_event",
      entryType: "question",
      id: "generic-question-start",
      state: "running",
      lifecycleRevision: "backend:generic-question:1",
      sessionId: SESSION_ID,
    }, harness.controller);
    dispatchAgentEvent({
      type: "process_event",
      entryType: "question",
      id: "generic-question-end",
      state: "completed",
      lifecycleRevision: "backend:generic-question:1",
      sessionId: SESSION_ID,
    }, harness.controller);

    const questions = getMessages().flatMap((message) => (
      message.process?.entries.filter((entry) => entry.type === "question") || []
    ));
    expect(harness.pendingUIResponseRef.current).toBeNull();
    expect(questions).toEqual([
      expect.objectContaining({ id: "generic-question-start", state: "completed" }),
    ]);
    expect(questions.some((entry) => entry.id === "generic-question-end")).toBe(false);
    harness.controller.clearAllStreamWatchdogs();
  });

  it("clears a generic pending question on an id-drifted error terminal", () => {
    const harness = createHarness();
    dispatchAgentEvent({
      type: "process_event",
      entryType: "question",
      id: "generic-error-start",
      state: "running",
      lifecycleRevision: "backend:generic-error:1",
      sessionId: SESSION_ID,
    }, harness.controller);
    dispatchAgentEvent({
      type: "process_event",
      entryType: "question",
      id: "generic-error-end",
      state: "error",
      lifecycleRevision: "backend:generic-error:1",
      sessionId: SESSION_ID,
    }, harness.controller);

    const questions = getMessages().flatMap((message) => (
      message.process?.entries.filter((entry) => entry.type === "question") || []
    ));
    expect(harness.pendingUIResponseRef.current).toBeNull();
    expect(questions).toEqual([
      expect.objectContaining({ id: "generic-error-start", state: "error" }),
    ]);
    expect(questions.some((entry) => entry.id === "generic-error-end")).toBe(false);
    harness.controller.clearAllStreamWatchdogs();
  });

  it.each([
    { label: "isError", terminal: { isError: true }, expectedState: "error" },
    { label: "status", terminal: { status: "completed" }, expectedState: "completed" },
    { label: "phase", terminal: { phase: "error" }, expectedState: "error" },
  ] as const)(
    "settles an id-drifted generic question whose terminal uses $label without state",
    ({ label, terminal, expectedState }) => {
      const harness = createHarness();
      dispatchAgentEvent({
        type: "process_event",
        entryType: "question",
        id: `generic-${label}-start`,
        state: "running",
        lifecycleRevision: `backend:generic-${label}:1`,
        sessionId: SESSION_ID,
      }, harness.controller);
      dispatchAgentEvent({
        type: "process_event",
        entryType: "question",
        id: `generic-${label}-end`,
        lifecycleRevision: `backend:generic-${label}:1`,
        sessionId: SESSION_ID,
        ...terminal,
      }, harness.controller);

      const questions = getMessages().flatMap((message) => (
        message.process?.entries.filter((entry) => entry.type === "question") || []
      ));
      expect(harness.pendingUIResponseRef.current).toBeNull();
      expect(questions).toEqual([
        expect.objectContaining({ id: `generic-${label}-start`, state: expectedState }),
      ]);
      expect(questions.some((entry) => entry.id === `generic-${label}-end`)).toBe(false);
      harness.controller.clearAllStreamWatchdogs();
    },
  );

  it("does not let a delayed generic terminal close a newer question", () => {
    const harness = createHarness();
    for (const id of ["generic-old-question", "generic-new-question"]) {
      dispatchAgentEvent({
        type: "process_event",
        entryType: "question",
        id,
        state: "running",
        lifecycleRevision: "backend:generic-sequence:1",
        sessionId: SESSION_ID,
      }, harness.controller);
    }

    dispatchAgentEvent({
      type: "process_event",
      entryType: "question",
      id: "generic-old-question",
      state: "completed",
      lifecycleRevision: "backend:generic-sequence:1",
      sessionId: SESSION_ID,
    }, harness.controller);

    const questions = getMessages().flatMap((message) => (
      message.process?.entries.filter((entry) => entry.type === "question") || []
    ));
    expect(harness.pendingUIResponseRef.current?.requestId).toBe("generic-new-question");
    expect(questions.find((entry) => entry.id === "generic-old-question")?.state).toBe("completed");
    expect(questions.find((entry) => entry.id === "generic-new-question")?.state).toBe("running");
    harness.controller.clearAllStreamWatchdogs();
  });

  it("correlates direct questions with default terminal events without consuming a newer question", () => {
    const harness = createHarness();
    for (const id of ["direct-old-question", "direct-new-question"]) {
      dispatchAgentEvent({
        type: "ask_user_question",
        id,
        question: "Continue?",
        lifecycleRevision: "backend:direct-sequence:1",
        sessionId: SESSION_ID,
      }, harness.controller);
    }

    dispatchAgentEvent({
      type: "legacy_question",
      mode: "question",
      id: "direct-old-question",
      state: "completed",
      lifecycleRevision: "backend:direct-sequence:1",
      sessionId: SESSION_ID,
    }, harness.controller);
    expect(harness.pendingUIResponseRef.current?.requestId).toBe("direct-new-question");

    dispatchAgentEvent({
      type: "legacy_question",
      mode: "question",
      id: "direct-new-terminal-id",
      state: "completed",
      lifecycleRevision: "backend:direct-sequence:1",
      sessionId: SESSION_ID,
    }, harness.controller);

    const questions = getMessages().flatMap((message) => (
      message.process?.entries.filter((entry) => entry.type === "question") || []
    ));
    expect(harness.pendingUIResponseRef.current).toBeNull();
    expect(questions.find((entry) => entry.id === "direct-old-question")?.state).toBe("completed");
    expect(questions.find((entry) => entry.id === "direct-new-question")?.state).toBe("completed");
    expect(questions.some((entry) => entry.id === "direct-new-terminal-id")).toBe(false);
    harness.controller.clearAllStreamWatchdogs();
  });

  it("does not consume a newer direct question when the old terminal crosses a user-response boundary", () => {
    const harness = createHarness();
    dispatchAgentEvent({
      type: "ask_user_question",
      id: "question-before-answer",
      question: "First?",
      lifecycleRevision: "backend:cross-boundary:1",
      sessionId: SESSION_ID,
    }, harness.controller);

    const runtime = harness.controller.getRuntime(SESSION_ID);
    harness.pendingUIResponseRef.current = null;
    useChatStore.getState().finishLastAssistantProcess(Date.now(), "completed", SESSION_ID);
    resetSessionRuntimeAfterTurn(runtime);
    useChatStore.getState().addMessage({
      id: "question-answer",
      role: "user",
      content: "yes",
      timestamp: Date.now(),
    }, SESSION_ID);

    dispatchAgentEvent({
      type: "ask_user_question",
      id: "question-after-answer",
      question: "Second?",
      lifecycleRevision: "backend:cross-boundary:1",
      sessionId: SESSION_ID,
    }, harness.controller);
    dispatchAgentEvent({
      type: "legacy_question",
      mode: "question",
      id: "question-before-answer",
      state: "completed",
      lifecycleRevision: "backend:cross-boundary:1",
      sessionId: SESSION_ID,
    }, harness.controller);

    expect(harness.pendingUIResponseRef.current?.requestId).toBe("question-after-answer");
    const questions = getMessages().flatMap((message) => (
      message.process?.entries.filter((entry) => entry.type === "question") || []
    ));
    expect(questions.find((entry) => entry.id === "question-after-answer")?.state).toBe("running");
    harness.controller.clearAllStreamWatchdogs();
  });

  it("clears pending UI and marks a failed question tool terminal", () => {
    const harness = createHarness();
    dispatchAgentEvent({
      type: "tool_start",
      toolKind: "question",
      toolCallId: "question-tool-1",
      id: "request-1",
      title: "是否继续",
      sessionId: SESSION_ID,
    }, harness.controller);
    expect(harness.pendingUIResponseRef.current).not.toBeNull();

    dispatchAgentEvent({
      type: "tool_end",
      toolKind: "question",
      toolCallId: "question-tool-1",
      isError: true,
      errorText: "request cancelled",
      sessionId: SESSION_ID,
    }, harness.controller);

    expect(harness.pendingUIResponseRef.current).toBeNull();
    const question = getMessages()
      .flatMap((message) => message.process?.entries || [])
      .find((entry) => entry.type === "question");
    expect(question?.state).toBe("error");
  });

  it("clears matching pending UI after a successful question tool ends", () => {
    const harness = createHarness();
    dispatchAgentEvent({
      type: "tool_start",
      toolKind: "question",
      toolCallId: "question-tool-success",
      id: "request-success",
      sessionId: SESSION_ID,
    }, harness.controller);
    expect(harness.pendingUIResponseRef.current).not.toBeNull();

    dispatchAgentEvent({
      type: "tool_end",
      toolKind: "question",
      toolCallId: "question-tool-success",
      sessionId: SESSION_ID,
    }, harness.controller);

    expect(harness.pendingUIResponseRef.current).toBeNull();
    const question = getMessages()
      .flatMap((message) => message.process?.entries || [])
      .find((entry) => entry.type === "question");
    expect(question?.state).toBe("completed");
  });

  it("settles a question tool when its end changes id and omits toolKind", () => {
    const harness = createHarness();
    dispatchAgentEvent({
      type: "tool_start",
      toolKind: "question",
      toolCallId: "question-kindless-start",
      requestId: "question-kindless-request",
      lifecycleRevision: "backend:question-kindless:1",
      sessionId: SESSION_ID,
    }, harness.controller);

    dispatchAgentEvent({
      type: "tool_end",
      toolCallId: "question-kindless-end",
      lifecycleRevision: "backend:question-kindless:1",
      sessionId: SESSION_ID,
    }, harness.controller);

    const runtime = harness.controller.getRuntime(SESSION_ID);
    const questions = getMessages().flatMap((message) => (
      message.process?.entries.filter((entry) => entry.type === "question") || []
    ));
    expect(harness.pendingUIResponseRef.current).toBeNull();
    expect(questions).toEqual([expect.objectContaining({ state: "completed" })]);
    expect(runtime.activeToolEntry).toEqual({});
    expect(runtime.activeToolKind).toEqual({});
    harness.controller.clearAllStreamWatchdogs();
  });

  it.each(["read_file", "write_file"] as const)(
    "settles an active %s tool when its end changes id and omits toolKind",
    (toolKind) => {
      const harness = createHarness();
      const filePath = toolKind === "read_file" ? "src/read.ts" : "src/write.ts";
      dispatchAgentEvent({
        type: "tool_start",
        toolKind,
        toolCallId: `${toolKind}-kindless-start`,
        filePath,
        lifecycleRevision: `backend:${toolKind}-kindless:1`,
        sessionId: SESSION_ID,
      }, harness.controller);

      dispatchAgentEvent({
        type: "tool_end",
        toolCallId: `${toolKind}-kindless-end`,
        filePath,
        lifecycleRevision: `backend:${toolKind}-kindless:1`,
        sessionId: SESSION_ID,
      }, harness.controller);

      const runtime = harness.controller.getRuntime(SESSION_ID);
      const tools = getMessages().flatMap((message) => (
        message.process?.entries.filter((entry) => entry.type === "tool") || []
      ));
      expect(tools).toEqual([
        expect.objectContaining({ state: "completed", toolKind }),
      ]);
      expect(tools[0].files).toEqual([
        expect.objectContaining({ file: filePath }),
      ]);
      expect(runtime.activeToolEntry).toEqual({});
      expect(runtime.activeToolFile).toEqual({});
      expect(runtime.activeToolKind).toEqual({});
      harness.controller.clearAllStreamWatchdogs();
    },
  );

  it("interrupts a stale pending question before a genuinely new stream_start", () => {
    const harness = createHarness();
    const chat = useChatStore.getState();
    chat.startAssistantProcess(100, SESSION_ID);
    chat.appendLastAssistantProcessEntry({
      id: "stale-question",
      timestamp: 101,
      type: "question",
      title: "等待回答",
      state: "running",
    }, SESSION_ID);
    harness.pendingUIResponseRef.current = {
      sessionId: SESSION_ID,
      requestId: "stale-question",
      entryId: "stale-question",
    };

    dispatchAgentEvent({ type: "stream_start", sessionId: SESSION_ID }, harness.controller);

    const processes = getMessages().filter((message) => message.process).map((message) => message.process!);
    expect(processes).toHaveLength(2);
    expect(processes[0].endedAt).toBeTypeOf("number");
    expect(processes[0].entries[0].state).toBe("interrupted");
    expect(processes[1].endedAt).toBeUndefined();
    expect(harness.pendingUIResponseRef.current).toBeNull();
  });
});

describe("stream watchdog backend reconciliation", () => {
  it.each([
    {
      label: "a direct question",
      event: { type: "ask_user_question", id: "first-question", question: "Continue?" },
    },
    {
      label: "a generic question",
      event: { type: "extension_event", mode: "question", id: "generic-question", question: "Continue?" },
    },
    {
      label: "a tool result whose start event was lost",
      event: { type: "tool_end", toolKind: "read_file", toolCallId: "first-tool-end", filePath: "README.md" },
    },
  ] satisfies Array<{ label: string; event: AgentEvent }>)(
    "opens and watches the turn when the first event is $label",
    ({ event }) => {
      const harness = createHarness();

      dispatchAgentEvent({
        ...event,
        lifecycleRevision: "plugin-backend:first-event",
        sessionId: SESSION_ID,
      }, harness.controller);

      const runtime = harness.controller.getRuntime(SESSION_ID);
      expect(runtime.processActive).toBe(true);
      expect(runtime.streamWatchdog).not.toBeNull();
      expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("running");
      expect(getMessages().some((message) => message.process)).toBe(true);
      harness.controller.clearAllStreamWatchdogs();
    },
  );

  it("arms the watchdog when a tool event is the first turn event", async () => {
    vi.useFakeTimers();
    agentGetSessionState.mockResolvedValue({ success: true, idle: true });
    const harness = createHarness();

    dispatchAgentEvent({
      type: "tool_start",
      lifecycleRevision: "plugin-backend:1",
      toolKind: "read_file",
      toolCallId: "first-tool",
      filePath: "README.md",
      sessionId: SESSION_ID,
    }, harness.controller);

    const runtime = harness.controller.getRuntime(SESSION_ID);
    expect(runtime.processActive).toBe(true);
    expect(runtime.streamWatchdog).not.toBeNull();
    await vi.advanceTimersByTimeAsync(45_000);

    expect(agentGetSessionState).toHaveBeenCalledWith(SESSION_ID);
    expect(getMessages().find((message) => message.process)?.process?.endedAt).toBeTypeOf("number");
    expect(runtime.turnEventState).toBe("settled");
  });

  it("settles the turn when the backend confirms it is idle", async () => {
    vi.useFakeTimers();
    agentGetSessionState.mockResolvedValue({ success: true, idle: true });
    const harness = createHarness();
    startRunningProcess(harness);

    harness.controller.refreshStreamWatchdog(SESSION_ID);
    await vi.advanceTimersByTimeAsync(45_000);

    expect(agentGetSessionState).toHaveBeenCalledTimes(1);
    expect(getMessages().find((message) => message.process)?.process?.endedAt).toBeTypeOf("number");
  });

  it("interrupts the turn when the backend no longer exists", async () => {
    vi.useFakeTimers();
    agentGetSessionState.mockResolvedValue({
      success: false,
      idle: true,
      error: "No active agent",
    });
    const harness = createHarness();
    const runtime = startRunningProcess(harness);

    harness.controller.refreshStreamWatchdog(SESSION_ID);
    await vi.advanceTimersByTimeAsync(45_000);

    const process = getMessages().find((message) => message.process)?.process;
    expect(agentGetSessionState).toHaveBeenCalledTimes(1);
    expect(process?.endedAt).toBeTypeOf("number");
    expect(process?.entries[0].state).toBe("interrupted");
    expect(runtime.streamWatchdog).toBeNull();
    expect(useProjectStore.getState().agentStatuses[SESSION_ID]).toBe("error");
  });

  it("keeps waiting only when the backend is still busy", async () => {
    vi.useFakeTimers();
    agentGetSessionState.mockResolvedValue({ success: true, idle: false });
    const harness = createHarness();
    const runtime = startRunningProcess(harness);

    harness.controller.refreshStreamWatchdog(SESSION_ID);
    await vi.advanceTimersByTimeAsync(45_000);

    expect(agentGetSessionState).toHaveBeenCalledTimes(1);
    expect(getMessages().find((message) => message.process)?.process?.endedAt).toBeUndefined();
    expect(runtime.streamWatchdog).not.toBeNull();
    expect(getMessages().flatMap((message) => message.process?.entries || []).some((entry) => (
      entry.type === "status" && entry.state === "running"
    ))).toBe(true);
    harness.controller.clearAllStreamWatchdogs();
  });
});
