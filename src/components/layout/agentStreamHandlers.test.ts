import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/stores/project-store";
import type { AgentEvent } from "@/types";
import { createSessionRuntime } from "./agentEventUtils";
import type { AgentEventHandlerContext } from "./agentEventTypes";
import { handleStreamEndEvent } from "./agentStreamHandlers";

describe("handleStreamEndEvent", () => {
  beforeEach(() => {
    useProjectStore.setState({ agentStatuses: {} });
  });

  it("finishes a forced Claude end when the renderer runtime was stale", () => {
    const runtime = createSessionRuntime();
    useProjectStore.setState({ agentStatuses: { "session-one": "running" } });
    const ensureAssistantContinuation = vi.fn(() => {
      runtime.processActive = true;
      return runtime;
    });
    const completeAssistantStream = vi.fn();
    const context = {
      pendingUIResponseRef: { current: null },
      setPendingUIResponse: vi.fn(),
      finishAssistantProcessText: vi.fn(),
      finishThinkingEntry: vi.fn(),
      completeAssistantStream,
      ensureAssistantContinuation,
    } as unknown as AgentEventHandlerContext;

    handleStreamEndEvent(
      { type: "stream_end", content: "", force: true } as AgentEvent,
      "session-one",
      runtime,
      context,
    );

    expect(ensureAssistantContinuation).toHaveBeenCalledWith("session-one");
    expect(completeAssistantStream).toHaveBeenCalledWith("session-one", "", false);
  });

  it("ignores an empty non-forced end without an active renderer process", () => {
    const runtime = createSessionRuntime();
    useProjectStore.setState({ agentStatuses: { "session-one": "running" } });
    const ensureAssistantContinuation = vi.fn(() => runtime);
    const completeAssistantStream = vi.fn();
    const context = {
      pendingUIResponseRef: { current: null },
      ensureAssistantContinuation,
      completeAssistantStream,
    } as unknown as AgentEventHandlerContext;

    handleStreamEndEvent(
      { type: "stream_end", content: "" } as AgentEvent,
      "session-one",
      runtime,
      context,
    );

    expect(ensureAssistantContinuation).not.toHaveBeenCalled();
    expect(completeAssistantStream).not.toHaveBeenCalled();
  });
});
