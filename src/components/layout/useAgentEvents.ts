import { useCallback, useEffect, useRef } from "react";
import { useChatStore } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import { createAgentEventController } from "./agentEventController";
import { dispatchAgentEvent } from "./agentEventDispatcher";
import type {
  AgentEventRuntimeController,
  PendingUIResponse,
  PendingUIResponseUpdate,
} from "./agentEventTypes";
import {
  createProcessEntryId,
  createSessionRuntime,
  type SessionRuntime,
} from "./agentEventUtils";

type UseAgentEventsOptions = {
  activeAgentId: string;
  sessionRuntimeRef: { current: Record<string, SessionRuntime> };
  pendingUIResponseRef: { current: PendingUIResponse };
  setPendingUIResponseState: (next: PendingUIResponseUpdate) => void;
  setStreaming: (streaming: boolean) => void;
};

export function useAgentEvents({
  activeAgentId,
  sessionRuntimeRef,
  pendingUIResponseRef,
  setPendingUIResponseState,
  setStreaming,
}: UseAgentEventsOptions) {
  const activeAgentIdRef = useRef(activeAgentId);
  const controllerRef = useRef<AgentEventRuntimeController | null>(null);
  const latestSettersRef = useRef({
    setPendingUIResponseState,
    setStreaming,
  });

  activeAgentIdRef.current = activeAgentId;
  latestSettersRef.current = {
    setPendingUIResponseState,
    setStreaming,
  };

  useEffect(() => {
    const controller = createAgentEventController({
      activeAgentIdRef,
      sessionRuntimeRef,
      pendingUIResponseRef,
      setPendingUIResponse: (next) => {
        latestSettersRef.current.setPendingUIResponseState(next);
      },
      setStreamingState: (streaming) => {
        latestSettersRef.current.setStreaming(streaming);
      },
    });
    controllerRef.current = controller;

    const unsubscribe = window.electronAPI.onAgentEvent((event) => {
      dispatchAgentEvent(event, controller);
    });

    return () => {
      controller.clearAllStreamWatchdogs();
      if (controllerRef.current === controller) controllerRef.current = null;
      unsubscribe();
    };
  }, []);

  const finishManualAbort = useCallback((sessionId: string) => {
    controllerRef.current?.finishManualAbort(sessionId);
  }, []);

  const requestManualAbort = useCallback(async (sessionId: string) => {
    const runtime = sessionRuntimeRef.current[sessionId] || createSessionRuntime();
    sessionRuntimeRef.current[sessionId] = runtime;
    if (runtime.manualAbortRequested) return true;

    runtime.manualAbortRequested = true;
    if (runtime.streamWatchdog) {
      clearTimeout(runtime.streamWatchdog);
      runtime.streamWatchdog = null;
    }
    useChatStore.getState().appendLastAssistantProcessEntry({
      id: createProcessEntryId(),
      timestamp: Date.now(),
      type: "status",
      title: "用户已手动中断",
      state: "interrupted",
      expanded: false,
    }, sessionId);
    latestSettersRef.current.setPendingUIResponseState((current) =>
      current?.sessionId === sessionId ? null : current
    );
    if (useProjectStore.getState().activeSessionId === sessionId) {
      latestSettersRef.current.setStreaming(true);
    }
    useProjectStore.getState().setAgentStatus(sessionId, "running");

    try {
      const result = await window.electronAPI.agentAbort(sessionId);
      finishManualAbort(sessionId);
      if (!result.success) console.error("[agent] abort failed: no active agent");
      return result.success;
    } catch (error) {
      finishManualAbort(sessionId);
      console.error("[agent] abort failed:", error);
      throw error;
    }
  }, [finishManualAbort, sessionRuntimeRef]);

  return { finishManualAbort, requestManualAbort };
}
