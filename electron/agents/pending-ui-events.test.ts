import { afterEach, describe, expect, it } from "vitest";
import {
  clearAllPendingUIEvents,
  clearPendingUIEvents,
  clearPendingUIResponse,
  getPendingUIEventSnapshot,
  getPendingUIEvents,
  hasPendingUIEvents,
  observePendingUIEvent,
} from "./pending-ui-events";

afterEach(() => clearAllPendingUIEvents());

describe("pending UI event cache", () => {
  it("keeps complete replayable question payloads per session and request", () => {
    observePendingUIEvent("session-a", {
      type: "process_event",
      entryType: "question",
      requestId: "question-1",
      method: "permission/request",
      questions: [{ question: "Allow?", options: ["yes", "no"] }],
      state: "running",
    }, "backend-a");
    observePendingUIEvent("session-a", {
      type: "ask_user_question",
      id: "question-2",
      prompt: "Choose",
    }, "backend-a");

    expect(getPendingUIEvents("session-a")).toEqual([
      expect.objectContaining({ sessionId: "session-a", requestId: "question-1", method: "permission/request" }),
      expect.objectContaining({ sessionId: "session-a", id: "question-2", prompt: "Choose" }),
    ]);
  });

  it("clears only the matching request when a question emits a terminal state", () => {
    observePendingUIEvent("session-a", {
      type: "process_event", entryType: "question", requestId: "question-1", state: "running",
    }, "backend-a");
    observePendingUIEvent("session-a", {
      type: "process_event", entryType: "question", requestId: "question-2", state: "running",
    }, "backend-a");

    observePendingUIEvent("session-a", {
      type: "process_event", entryType: "question", requestId: "question-1", state: "completed",
    }, "backend-a");

    expect(getPendingUIEvents("session-a")).toEqual([
      expect.objectContaining({ requestId: "question-2" }),
    ]);
  });

  it("advances the revision and clears one unambiguous question when an adapter changes its terminal ID", () => {
    observePendingUIEvent("session-a", {
      type: "process_event", entryType: "question", requestId: "start-id", state: "running",
    }, "backend-a");
    const pendingSnapshot = getPendingUIEventSnapshot("session-a");

    const terminalRevision = observePendingUIEvent("session-a", {
      type: "process_event", entryType: "question", requestId: "end-id", state: "completed",
    }, "backend-a");

    expect(terminalRevision).toBeGreaterThan(pendingSnapshot.revision);
    expect(getPendingUIEventSnapshot("session-a")).toEqual({
      revision: terminalRevision,
      requests: [],
    });
  });

  it("does not clear a pending question for coarse stream or idle hints", () => {
    observePendingUIEvent("session-a", {
      type: "process_event", entryType: "question", requestId: "question-1", state: "running",
    }, "backend-a");

    observePendingUIEvent("session-a", { type: "stream_end" }, "backend-a");
    observePendingUIEvent("session-a", { type: "backend_idle" }, "backend-a");

    expect(getPendingUIEvents("session-a")).toEqual([
      expect.objectContaining({ requestId: "question-1" }),
    ]);
  });

  it("scopes authoritative terminal cleanup to the backend that emitted it", () => {
    observePendingUIEvent("session-a", {
      type: "process_event", entryType: "question", requestId: "old", state: "running",
    }, "old-backend");
    observePendingUIEvent("session-a", {
      type: "process_event", entryType: "question", requestId: "new", state: "running",
    }, "new-backend");

    observePendingUIEvent("session-a", { type: "aborted" }, "old-backend");

    expect(getPendingUIEvents("session-a")).toEqual([
      expect.objectContaining({ requestId: "new" }),
    ]);
  });

  it("clears only an unambiguous successfully delivered response", () => {
    observePendingUIEvent("session-a", {
      type: "extension_ui_request", id: "question-1", method: "confirm",
    });
    observePendingUIEvent("session-a", {
      type: "extension_ui_request", id: "question-2", method: "confirm",
    });

    clearPendingUIResponse("session-a", { id: "another-question" });
    expect(getPendingUIEvents("session-a")).toHaveLength(2);

    clearPendingUIResponse("session-a", { id: "question-1" });
    expect(getPendingUIEvents("session-a")).toEqual([
      expect.objectContaining({ id: "question-2" }),
    ]);
    clearPendingUIResponse("session-a", { id: "adapter-renamed-question" });
    expect(hasPendingUIEvents("session-a")).toBe(false);
  });

  it("can clear a whole session or one backend source", () => {
    observePendingUIEvent("session-a", { type: "ask_user", id: "one" }, "backend-a");
    observePendingUIEvent("session-a", { type: "ask_user", id: "two" }, "backend-b");

    clearPendingUIEvents("session-a", "backend-a");
    expect(getPendingUIEvents("session-a")).toEqual([expect.objectContaining({ id: "two" })]);

    clearPendingUIEvents("session-a");
    expect(getPendingUIEvents("session-a")).toEqual([]);
  });
});
