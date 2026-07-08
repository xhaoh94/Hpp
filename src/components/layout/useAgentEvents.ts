import { useEffect, useRef } from "react";
import { createAgentEventController } from "./agentEventController";
import { dispatchAgentEvent } from "./agentEventDispatcher";
import type {
  PendingUIResponse,
  PendingUIResponseUpdate,
} from "./agentEventTypes";
import type { SessionRuntime } from "./agentEventUtils";

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

    const unsubscribe = window.electronAPI.onAgentEvent((event) => {
      dispatchAgentEvent(event, controller);
    });

    return () => {
      controller.clearAllStreamWatchdogs();
      unsubscribe();
    };
  }, []);
}
