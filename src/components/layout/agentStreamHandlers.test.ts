import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/stores/project-store";
import { useChatStore } from "@/stores/chat-store";
import type { AgentEvent } from "@/types";
import { createSessionRuntime } from "./agentEventUtils";
import type { AgentEventHandlerContext } from "./agentEventTypes";
import {
  handleCommentaryDeltaEvent,
  handleCommentaryEndEvent,
  handleMessageStartEvent,
  handleStreamDeltaEvent,
  handleStreamEndEvent,
  handleThinkingDeltaEvent,
} from "./agentStreamHandlers";

describe("handleStreamEndEvent", () => {
  beforeEach(() => {
    useProjectStore.setState({ agentStatuses: {} });
    useChatStore.setState({ messages: [], sessionMessages: {}, activeSessionId: null });
  });

  it("starts terminal-state reconciliation as soon as a message is acknowledged", () => {
    const runtime = createSessionRuntime();
    const context = {
      getPendingUIResponse: () => null,
      setPendingUIResponse: vi.fn(),
      clearStreamWatchdog: vi.fn(),
      completeIdleNotice: vi.fn(),
      finishThinkingEntry: vi.fn(),
      appendProcessEntry: vi.fn(),
      updateInferredPlanSteps: vi.fn(),
      refreshStreamWatchdog: vi.fn(),
    } as unknown as AgentEventHandlerContext;

    handleMessageStartEvent(
      { type: "message_start", content: "hello" } as AgentEvent,
      "session-one",
      runtime,
      context,
    );

    expect(runtime.processActive).toBe(true);
    expect(context.refreshStreamWatchdog).toHaveBeenCalledWith("session-one");
  });

  it("routes generic agent text through the collapsible process narration", () => {
    const runtime = createSessionRuntime();
    const context = {
      ensureAssistantContinuation: vi.fn(() => runtime),
      finishThinkingEntry: vi.fn(),
      appendAssistantProcessText: vi.fn(),
      refreshStreamWatchdog: vi.fn(),
    } as unknown as AgentEventHandlerContext;

    handleStreamDeltaEvent(
      { type: "stream_delta", delta: "我先检查项目配置。" },
      "other-agent-session",
      context,
    );

    expect(context.appendAssistantProcessText).toHaveBeenCalledWith(
      "other-agent-session",
      "我先检查项目配置。",
    );
    expect(context.refreshStreamWatchdog).toHaveBeenCalledWith("other-agent-session");
  });

  it("ignores an empty thinking delta instead of reopening a turn", () => {
    const context = {
      ensureAssistantContinuation: vi.fn(),
      finishAssistantProcessText: vi.fn(),
      appendThinkingDelta: vi.fn(),
    } as unknown as AgentEventHandlerContext;

    handleThinkingDeltaEvent(
      { type: "thinking_delta", delta: "" },
      "session-one",
      context,
    );

    expect(context.ensureAssistantContinuation).not.toHaveBeenCalled();
    expect(context.finishAssistantProcessText).not.toHaveBeenCalled();
    expect(context.appendThinkingDelta).not.toHaveBeenCalled();
  });

  it("shows commentary while it streams and finalizes it without using assistant body output", () => {
    const runtime = createSessionRuntime();
    const context = {
      ensureAssistantContinuation: vi.fn(() => runtime),
      finishAssistantProcessText: vi.fn(),
      finishThinkingEntry: vi.fn(),
      refreshStreamWatchdog: vi.fn(),
    } as unknown as AgentEventHandlerContext;

    handleCommentaryDeltaEvent(
      { type: "commentary_delta", itemId: "note-1", delta: "我会先检查" },
      "session-one",
      context,
    );
    handleCommentaryDeltaEvent(
      { type: "commentary_delta", itemId: "note-1", delta: "现有实现。" },
      "session-one",
      context,
    );
    handleCommentaryEndEvent(
      { type: "commentary_end", itemId: "note-1", content: "我会先检查现有实现。" },
      "session-one",
      context,
    );

    expect(useChatStore.getState().sessionMessages["session-one"]?.[0]).toMatchObject({
      content: "",
      commentary: [{
        id: "note-1",
        content: "我会先检查现有实现。",
        isStreaming: false,
      }],
    });
    expect(context.finishAssistantProcessText).toHaveBeenCalledTimes(3);
    expect(context.refreshStreamWatchdog).toHaveBeenCalledTimes(3);
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
      getPendingUIResponse: () => null,
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

    expect(ensureAssistantContinuation).not.toHaveBeenCalled();
    expect(completeAssistantStream).toHaveBeenCalledWith("session-one", "", false);
  });

  it("settles an empty non-forced end when only the project status is still running", () => {
    const runtime = createSessionRuntime();
    useProjectStore.setState({ agentStatuses: { "session-one": "running" } });
    const ensureAssistantContinuation = vi.fn(() => runtime);
    const completeAssistantStream = vi.fn();
    const context = {
      getPendingUIResponse: () => null,
      setPendingUIResponse: vi.fn(),
      finishAssistantProcessText: vi.fn(),
      finishThinkingEntry: vi.fn(),
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
    expect(completeAssistantStream).toHaveBeenCalledWith("session-one", "", false);
  });

  it("terminalizes runtime identity for an empty end without visible state", () => {
    const runtime = createSessionRuntime();
    const completeAssistantStream = vi.fn();
    const settleRuntimeTurnOnly = vi.fn();
    const context = {
      getPendingUIResponse: () => null,
      completeAssistantStream,
      settleRuntimeTurnOnly,
    } as unknown as AgentEventHandlerContext;

    handleStreamEndEvent(
      { type: "stream_end", content: "" } as AgentEvent,
      "session-one",
      runtime,
      context,
    );

    expect(completeAssistantStream).not.toHaveBeenCalled();
    expect(settleRuntimeTurnOnly).toHaveBeenCalledWith("session-one", "completed");
  });

  it("finishes an empty end when the runtime and project status were lost but the store process is open", () => {
    const runtime = createSessionRuntime();
    const chat = useChatStore.getState();
    chat.startAssistantProcess(1, "session-one");
    chat.appendLastAssistantProcessEntry({
      id: "store-open",
      timestamp: 2,
      type: "status",
      title: "still open",
      state: "running",
    }, "session-one");
    const ensureAssistantContinuation = vi.fn(() => runtime);
    const completeAssistantStream = vi.fn();
    const context = {
      getPendingUIResponse: () => null,
      setPendingUIResponse: vi.fn(),
      finishAssistantProcessText: vi.fn(),
      finishThinkingEntry: vi.fn(),
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
    expect(completeAssistantStream).toHaveBeenCalledWith("session-one", "", false);
  });
});
