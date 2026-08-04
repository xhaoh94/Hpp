import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import { createSessionRuntime } from "./agentEventUtils";
import {
  applyPendingUIResponseUpdate,
  preparePendingQuestionContinuation,
  retainPendingUIResponses,
  settleFailedPendingQuestionTurn,
  type PendingUIResponseValue,
} from "./usePendingUIResponse";

const pending = (sessionId: string): PendingUIResponseValue => ({
  sessionId,
  requestId: `request-${sessionId}`,
  method: "question",
  questions: [],
});

beforeEach(() => {
  useProjectStore.setState({ activeSessionId: "A", agentStatuses: {} });
  useChatStore.setState({
    activeSessionId: "A",
    messages: [],
    sessionMessages: { A: [] },
    compactingSessions: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pending UI responses by session", () => {
  it("prepares a successful remote response for continuation without settling its turn identity", () => {
    vi.useFakeTimers();
    const runtime = createSessionRuntime();
    runtime.processActive = true;
    runtime.streamStarted = true;
    runtime.turnEventState = "active";
    runtime.activeTurnRevision = "backend:1";
    runtime.streamWatchdog = setTimeout(() => undefined, 45_000);

    preparePendingQuestionContinuation("A", { current: { A: runtime } });

    expect(runtime.processActive).toBe(false);
    expect(runtime.streamStarted).toBe(false);
    expect(runtime.streamWatchdog).toBeNull();
    expect(runtime.turnEventState).toBe("active");
    expect(runtime.activeTurnRevision).toBe("backend:1");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps concurrent interactions for sessions A and B", () => {
    const sessionA = pending("A");
    const sessionB = pending("B");
    const withA = applyPendingUIResponseUpdate({}, "A", sessionA);
    const withBoth = applyPendingUIResponseUpdate(withA, "A", sessionB);

    expect(withBoth).toEqual({ A: sessionA, B: sessionB });
  });

  it("direct null clears only the active session", () => {
    const sessionA = pending("A");
    const sessionB = pending("B");

    expect(applyPendingUIResponseUpdate({ A: sessionA, B: sessionB }, "A", null))
      .toEqual({ B: sessionB });
  });

  it("a functional clear deletes only its matching session", () => {
    const sessionA = pending("A");
    const sessionB = pending("B");
    const result = applyPendingUIResponseUpdate(
      { A: sessionA, B: sessionB },
      "A",
      (current) => current?.sessionId === "B" ? null : current,
    );

    expect(result).toEqual({ A: sessionA });
  });

  it("drops interactions when their sessions are no longer open", () => {
    const sessionA = pending("A");
    const sessionB = pending("B");

    expect(retainPendingUIResponses({ A: sessionA, B: sessionB }, new Set(["B"])))
      .toEqual({ B: sessionB });
  });

  it("ignores a late interaction update after its session has closed", () => {
    const sessionA = pending("A");
    const lateSessionB = pending("B");

    expect(applyPendingUIResponseUpdate(
      { A: sessionA },
      "A",
      lateSessionB,
      new Set(["A"]),
    )).toEqual({ A: sessionA });
  });

  it("fully settles the turn and aborts the backend when sending a UI response fails", async () => {
    vi.useFakeTimers();
    const chat = useChatStore.getState();
    chat.startAssistantProcess(1, "A");
    chat.appendLastAssistantProcessEntry({
      id: "question-entry",
      timestamp: 2,
      type: "question",
      title: "waiting",
      state: "running",
    }, "A");
    chat.appendContextCompactionDivider("compaction-1", "A", "running");
    chat.setSessionCompacting("A", true);
    useProjectStore.getState().setAgentStatus("A", "running");
    const runtime = createSessionRuntime();
    runtime.processActive = true;
    runtime.streamStarted = true;
    runtime.streamWatchdog = setTimeout(() => undefined, 45_000);
    runtime.activeCompactionId = "compaction-1";
    runtime.activeCompactionPresentation = "divider";
    const setStreaming = vi.fn();
    let finishAbort!: () => void;
    const abortSession = vi.fn(() => new Promise<void>((resolve) => {
      finishAbort = resolve;
    }));

    const settling = settleFailedPendingQuestionTurn(
      "A",
      { ...pending("A"), entryId: "question-entry" },
      { current: { A: runtime } },
      setStreaming,
      abortSession,
    );

    expect(useProjectStore.getState().agentStatuses.A).toBe("running");
    finishAbort();
    await settling;

    const messages = useChatStore.getState().sessionMessages.A;
    const process = messages.find((message) => message.process)?.process;
    expect(process?.endedAt).toBeTypeOf("number");
    expect(process?.entries.find((entry) => entry.id === "question-entry")?.state).toBe("error");
    expect(messages.find((message) => message.eventId === "compaction-1")?.compactionState)
      .toBe("interrupted");
    expect(useChatStore.getState().compactingSessions.A).toBeUndefined();
    expect(useProjectStore.getState().agentStatuses.A).toBe("error");
    expect(runtime.processActive).toBe(false);
    expect(runtime.turnEventState).toBe("settled");
    expect(runtime.turnTerminalReason).toBe("error");
    expect(runtime.streamWatchdog).toBeNull();
    expect(runtime.activeCompactionId).toBeNull();
    expect(setStreaming).toHaveBeenCalledWith(false);
    expect(abortSession).toHaveBeenCalledWith("A");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the renderer settled when the best-effort backend abort also fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const setStreaming = vi.fn();
    const abortSession = vi.fn(async () => {
      throw new Error("abort transport failed");
    });

    await expect(settleFailedPendingQuestionTurn(
      "A",
      pending("A"),
      { current: {} },
      setStreaming,
      abortSession,
    )).resolves.toBeUndefined();

    expect(abortSession).toHaveBeenCalledWith("A");
    expect(useProjectStore.getState().agentStatuses.A).toBe("error");
    expect(setStreaming).toHaveBeenCalledWith(false);
    consoleError.mockRestore();
  });
});
