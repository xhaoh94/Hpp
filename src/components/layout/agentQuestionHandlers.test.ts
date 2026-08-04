import { describe, expect, it, vi } from "vitest";
import type { AgentEventHandlerContext, PendingUIResponse } from "./agentEventTypes";
import { handleDefaultQuestionEvent } from "./agentQuestionHandlers";

describe("handleDefaultQuestionEvent", () => {
  it.each(["completed", "interrupted", "error"] as const)(
    "does not leave a %s question pending",
    (state) => {
      const pendingUIResponseRef: { current: PendingUIResponse } = {
        current: {
          sessionId: "session-1",
          requestId: "question-1",
          entryId: "question-1",
        },
      };
      const appendProcessEntry = vi.fn();
      const context = {
        getPendingUIResponse: (sessionId: string) => (
          pendingUIResponseRef.current?.sessionId === sessionId ? pendingUIResponseRef.current : null
        ),
        setPendingUIResponse: (next) => {
          pendingUIResponseRef.current = typeof next === "function"
            ? next(pendingUIResponseRef.current)
            : next;
        },
        ensureAssistantContinuation: vi.fn(),
        finishThinkingEntry: vi.fn(),
        appendProcessEntry,
      } as AgentEventHandlerContext;

      expect(handleDefaultQuestionEvent({
        type: "legacy_question",
        mode: "question",
        id: "question-1",
        state,
      }, "session-1", context)).toBe(true);

      expect(pendingUIResponseRef.current).toBeNull();
      expect(appendProcessEntry).toHaveBeenCalledWith("session-1", expect.objectContaining({
        id: "question-1",
        type: "question",
        state,
      }));
    },
  );

  it.each([
    { label: "isError", terminal: { isError: true }, expectedState: "error" },
    { label: "status", terminal: { status: "completed" }, expectedState: "completed" },
    { label: "phase", terminal: { phase: "error" }, expectedState: "error" },
  ] as const)(
    "recognizes a terminal question reported through $label without state",
    ({ terminal, expectedState }) => {
      const pendingUIResponseRef: { current: PendingUIResponse } = {
        current: {
          sessionId: "session-1",
          requestId: "question-1",
          entryId: "question-1",
        },
      };
      const appendProcessEntry = vi.fn();
      const context = {
        getPendingUIResponse: (sessionId: string) => (
          pendingUIResponseRef.current?.sessionId === sessionId ? pendingUIResponseRef.current : null
        ),
        setPendingUIResponse: (next) => {
          pendingUIResponseRef.current = typeof next === "function"
            ? next(pendingUIResponseRef.current)
            : next;
        },
        ensureAssistantContinuation: vi.fn(),
        finishThinkingEntry: vi.fn(),
        appendProcessEntry,
      } as AgentEventHandlerContext;

      expect(handleDefaultQuestionEvent({
        type: "legacy_question",
        mode: "question",
        id: "question-1",
        ...terminal,
      }, "session-1", context)).toBe(true);

      expect(pendingUIResponseRef.current).toBeNull();
      expect(appendProcessEntry).toHaveBeenCalledTimes(1);
      expect(appendProcessEntry).toHaveBeenCalledWith("session-1", expect.objectContaining({
        id: "question-1",
        type: "question",
        state: expectedState,
      }));
    },
  );

  it("settles the current pending entry when a terminal question uses a different id", () => {
    const pendingUIResponseRef: { current: PendingUIResponse } = {
      current: {
        sessionId: "session-1",
        requestId: "request-1",
        entryId: "local-entry-1",
      },
    };
    const appendProcessEntry = vi.fn();
    const context = {
      getPendingUIResponse: (sessionId: string) => (
        pendingUIResponseRef.current?.sessionId === sessionId ? pendingUIResponseRef.current : null
      ),
      setPendingUIResponse: (next) => {
        pendingUIResponseRef.current = typeof next === "function"
          ? next(pendingUIResponseRef.current)
          : next;
      },
      ensureAssistantContinuation: vi.fn(),
      finishThinkingEntry: vi.fn(),
      appendProcessEntry,
    } as AgentEventHandlerContext;

    expect(handleDefaultQuestionEvent({
      type: "process_event",
      entryType: "question",
      id: "terminal-event-1",
      state: "completed",
    }, "session-1", context)).toBe(true);

    expect(pendingUIResponseRef.current).toBeNull();
    expect(appendProcessEntry).toHaveBeenCalledWith("session-1", expect.objectContaining({
      id: "local-entry-1",
      type: "question",
      state: "completed",
    }));
    expect(appendProcessEntry).not.toHaveBeenCalledWith("session-1", expect.objectContaining({
      id: "terminal-event-1",
    }));
  });
});
