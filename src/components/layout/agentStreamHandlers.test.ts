import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/stores/project-store";
import { useChatStore } from "@/stores/chat-store";
import type { AgentEvent } from "@/types";
import { createSessionRuntime } from "./agentEventUtils";
import type { AgentEventHandlerContext } from "./agentEventTypes";
import {
  handleCommentaryDeltaEvent,
  handleCommentaryEndEvent,
  handleStreamDeltaEvent,
  handleStreamEndEvent,
} from "./agentStreamHandlers";

describe("handleStreamEndEvent", () => {
  beforeEach(() => {
    useProjectStore.setState({ agentStatuses: {} });
    useChatStore.setState({ messages: [], sessionMessages: {}, activeSessionId: null });
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
