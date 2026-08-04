import { useCallback, useEffect, useRef } from "react";
import {
  getAssistantProcessLastActivityAt,
  hasOpenAssistantProcessState,
  useChatStore,
} from "@/stores/chat-store";
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
import { classifyBackendSessionState } from "@/lib/session-command-coordinator";
import type { AgentEvent, AgentPendingUIEventSnapshot } from "@/types";

type UseAgentEventsOptions = {
  activeAgentId: string;
  sessionRuntimeRef: { current: Record<string, SessionRuntime> };
  getPendingUIResponse: (sessionId: string) => PendingUIResponse;
  setPendingUIResponseState: (next: PendingUIResponseUpdate) => void;
  setStreaming: (streaming: boolean) => void;
  preserveAssistantProcessCollapse?: (sessionId: string, action: () => void) => void;
};

// React StrictMode immediately tears down and recreates effects once in
// development. Defer terminal cleanup by one task and suppress it whenever a
// replacement subscription is already live, while still settling turns when
// the renderer genuinely stops listening for agent events.
let activeAgentEventSubscriptions = 0;
export const MANUAL_ABORT_TIMEOUT_MS = 15_000;
const SURVIVING_SESSION_RECONCILE_BATCH_SIZE = 4;

type SurvivingSessionController = Pick<
  AgentEventRuntimeController,
  "ensureAssistantContinuation" | "finishIdleBackendTurn"
> & {
  replayPendingUIRequests?: (
    sessionId: string,
    snapshot: AgentPendingUIEventSnapshot,
  ) => void | Promise<void>;
};

export function replayPendingUISnapshot(
  snapshot: AgentPendingUIEventSnapshot,
  latestObservedRevision: number,
  dispatch: (event: AgentEvent) => void,
) {
  if (latestObservedRevision > snapshot.revision) return false;
  for (const request of snapshot.requests) dispatch(request);
  return true;
}

export async function restorePendingUISnapshot(
  sessionId: string,
  initialSnapshot: AgentPendingUIEventSnapshot,
  getLatestObservedRevision: () => number,
  getLatestSnapshot: (sessionId: string) => Promise<AgentPendingUIEventSnapshot>,
  dispatch: (event: AgentEvent) => void,
  maxAttempts = 3,
): Promise<number | undefined> {
  let snapshot = initialSnapshot;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const latestObservedRevision = getLatestObservedRevision();
    if (replayPendingUISnapshot(snapshot, latestObservedRevision, dispatch)) {
      return snapshot.revision;
    }
    if (attempt + 1 >= maxAttempts) return undefined;
    snapshot = await getLatestSnapshot(sessionId);
  }
  return undefined;
}

/**
 * Reconcile every open session after a renderer remount. The Electron main
 * process can retain several backends while the new renderer starts with no
 * initialized/status state; limiting recovery to the selected session leaves
 * quiet background turns permanently invisible and without a watchdog.
 */
export async function reconcileSurvivingOpenSessions(
  sessionIds: readonly string[],
  controller: SurvivingSessionController,
  isCancelled: () => boolean = () => false,
) {
  const uniqueSessionIds = [...new Set(sessionIds.filter(Boolean))];
  for (let offset = 0; offset < uniqueSessionIds.length; offset += SURVIVING_SESSION_RECONCILE_BATCH_SIZE) {
    if (isCancelled()) return;
    const batch = uniqueSessionIds.slice(offset, offset + SURVIVING_SESSION_RECONCILE_BATCH_SIZE);
    const results = await Promise.all(batch.map(async (sessionId) => {
      try {
        const state = await window.electronAPI.agentGetSessionState(sessionId);
        const activity = classifyBackendSessionState(state);
        let pendingUISnapshot: AgentPendingUIEventSnapshot = { revision: 0, requests: [] };
        if (
          activity === "busy"
          && typeof window.electronAPI.agentGetPendingUIRequests === "function"
        ) {
          pendingUISnapshot = await window.electronAPI.agentGetPendingUIRequests(sessionId)
            .catch(() => ({ revision: 0, requests: [] }));
        }
        return { sessionId, activity, pendingUISnapshot };
      } catch {
        return {
          sessionId,
          activity: "unknown" as const,
          pendingUISnapshot: { revision: 0, requests: [] } as AgentPendingUIEventSnapshot,
        };
      }
    }));
    if (isCancelled()) return;

    for (const { sessionId, activity, pendingUISnapshot } of results) {
      const sessionStillOpen = useProjectStore.getState().projects.some((project) => (
        project.sessions.some((session) => session.id === sessionId && !session.closed)
      ));
      if (!sessionStillOpen) continue;
      if (activity === "unknown") continue;

      if (activity === "missing") {
        useProjectStore.setState((state) => {
          const initializedSessionIds = new Set(state.initializedSessionIds);
          initializedSessionIds.delete(sessionId);
          return {
            initializedSessionIds,
            agentStatuses: { ...state.agentStatuses, [sessionId]: "idle" },
          };
        });
        const chat = useChatStore.getState();
        const messages = chat.activeSessionId === sessionId
          ? chat.messages
          : chat.sessionMessages[sessionId] || [];
        const latestOpenAssistant = [...messages].reverse().find(hasOpenAssistantProcessState);
        chat.finishAllAssistantProcesses(
          latestOpenAssistant ? getAssistantProcessLastActivityAt(latestOpenAssistant) : undefined,
          "interrupted",
          sessionId,
        );
        chat.interruptSessionCompaction(sessionId);
        if (chat.activeSessionId === sessionId) chat.setStreaming(false);
        continue;
      }

      useProjectStore.getState().markSessionInitialized(sessionId);
      useChatStore.getState().clearAgentStartupErrors(sessionId);
      if (activity === "busy") {
        controller.ensureAssistantContinuation(sessionId);
        await controller.replayPendingUIRequests?.(sessionId, pendingUISnapshot);
        continue;
      }
      controller.finishIdleBackendTurn(sessionId);
      useProjectStore.getState().setAgentStatus(sessionId, "idle");
    }
  }
}

export async function requestAgentAbortWithTimeout(
  sessionId: string,
  requestAbort: (sessionId: string) => Promise<{ success: boolean }>,
  onSettled: () => void,
  timeoutMs = MANUAL_ABORT_TIMEOUT_MS,
) {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Agent abort request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([requestAbort(sessionId), timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    onSettled();
  }
}

export function useAgentEvents({
  activeAgentId,
  sessionRuntimeRef,
  getPendingUIResponse,
  setPendingUIResponseState,
  setStreaming,
  preserveAssistantProcessCollapse,
}: UseAgentEventsOptions) {
  const activeAgentIdRef = useRef(activeAgentId);
  const controllerRef = useRef<AgentEventRuntimeController | null>(null);
  const latestSettersRef = useRef({
    setPendingUIResponseState,
    getPendingUIResponse,
    setStreaming,
    preserveAssistantProcessCollapse,
  });

  activeAgentIdRef.current = activeAgentId;
  latestSettersRef.current = {
    setPendingUIResponseState,
    getPendingUIResponse,
    setStreaming,
    preserveAssistantProcessCollapse,
  };

  useEffect(() => {
    activeAgentEventSubscriptions += 1;
    let cancelled = false;
    const reconciledSessionIds = new Set<string>();
    const observedPendingUIRevisions = new Map<string, number>();
    const controller = createAgentEventController({
      activeAgentIdRef,
      sessionRuntimeRef,
      getPendingUIResponse: (sessionId) => (
        latestSettersRef.current.getPendingUIResponse(sessionId)
      ),
      setPendingUIResponse: (next) => {
        latestSettersRef.current.setPendingUIResponseState(next);
      },
      setStreamingState: (streaming) => {
        latestSettersRef.current.setStreaming(streaming);
      },
      preserveAssistantProcessCollapse: (sessionId, action) => {
        const preserve = latestSettersRef.current.preserveAssistantProcessCollapse;
        if (preserve) preserve(sessionId, action);
        else action();
      },
    });
    controllerRef.current = controller;

    const unsubscribe = window.electronAPI.onAgentEvent((event) => {
      if (
        event.sessionId
        && typeof event.pendingUIRevision === "number"
        && Number.isFinite(event.pendingUIRevision)
      ) {
        observedPendingUIRevisions.set(
          event.sessionId,
          Math.max(observedPendingUIRevisions.get(event.sessionId) || 0, event.pendingUIRevision),
        );
      }
      if (event.type === "pending_ui_cache_revision") return;
      dispatchAgentEvent(event, controller);
    });
    let reconcileChain = Promise.resolve();
    const reconcileProjects = (projects = useProjectStore.getState().projects) => {
      const sessionIds = projects.flatMap((project) => project.sessions
        .filter((session) => !session.closed && !reconciledSessionIds.has(session.id))
        .map((session) => session.id));
      for (const sessionId of sessionIds) reconciledSessionIds.add(sessionId);
      if (sessionIds.length === 0) return;
      reconcileChain = reconcileChain.then(() => reconcileSurvivingOpenSessions(
        sessionIds,
        {
          ensureAssistantContinuation: controller.ensureAssistantContinuation,
          finishIdleBackendTurn: controller.finishIdleBackendTurn,
          replayPendingUIRequests: async (sessionId, snapshot) => {
            const replayedRevision = await restorePendingUISnapshot(
              sessionId,
              snapshot,
              () => observedPendingUIRevisions.get(sessionId) || 0,
              (targetSessionId) => window.electronAPI.agentGetPendingUIRequests(targetSessionId)
                .catch(() => ({
                  revision: observedPendingUIRevisions.get(targetSessionId) || 0,
                  requests: [],
                })),
              (event) => dispatchAgentEvent(event, controller),
            );
            if (replayedRevision !== undefined) {
              observedPendingUIRevisions.set(
                sessionId,
                Math.max(observedPendingUIRevisions.get(sessionId) || 0, replayedRevision),
              );
            }
          },
        },
        () => cancelled,
      ));
    };
    let previousProjects = useProjectStore.getState().projects;
    reconcileProjects(previousProjects);
    const unsubscribeProjects = useProjectStore.subscribe((state) => {
      if (state.projects === previousProjects) return;
      previousProjects = state.projects;
      reconcileProjects(state.projects);
    });

    return () => {
      cancelled = true;
      unsubscribeProjects();
      activeAgentEventSubscriptions = Math.max(0, activeAgentEventSubscriptions - 1);
      if (controllerRef.current === controller) controllerRef.current = null;
      unsubscribe();
      const runtimeSessionIds = Object.keys(sessionRuntimeRef.current);
      const chatState = useChatStore.getState();
      const openProcessSessionIds = Object.entries(chatState.sessionMessages)
        .filter(([, messages]) => messages.some(hasOpenAssistantProcessState))
        .map(([sessionId]) => sessionId);
      const runningStatusSessionIds = Object.entries(useProjectStore.getState().agentStatuses)
        .filter(([, status]) => status === "running")
        .map(([sessionId]) => sessionId);
      if (chatState.activeSessionId && chatState.messages.some(hasOpenAssistantProcessState)) {
        openProcessSessionIds.push(chatState.activeSessionId);
      }
      const cleanupSessionIds = [...new Set([
        ...runtimeSessionIds,
        ...openProcessSessionIds,
        ...runningStatusSessionIds,
        ...Object.keys(chatState.compactingSessions),
      ])];
      setTimeout(() => {
        if (activeAgentEventSubscriptions > 0) return;
        for (const sessionId of cleanupSessionIds) {
          const runtime = sessionRuntimeRef.current[sessionId];
          const hasLiveRuntime = !!runtime && (
            runtime.processActive || runtime.streamStarted || !!runtime.activeCompactionId
          );
          const state = useChatStore.getState();
          const messages = state.sessionMessages[sessionId] || (
            state.activeSessionId === sessionId ? state.messages : []
          );
          const hasOpenProcess = messages.some(hasOpenAssistantProcessState);
          const sessionMarkedRunning = useProjectStore.getState().agentStatuses[sessionId] === "running";
          if (hasLiveRuntime || hasOpenProcess || state.compactingSessions[sessionId] || sessionMarkedRunning) {
            controller.finishAbortedTurn(sessionId);
          }
        }
        controller.clearAllStreamWatchdogs();
      }, 0);
    };
  }, []);

  const finishManualAbort = useCallback((sessionId: string) => {
    controllerRef.current?.finishManualAbort(sessionId);
  }, []);

  const refreshSessionWatchdog = useCallback((sessionId: string) => {
    controllerRef.current?.refreshStreamWatchdog(sessionId);
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
      const result = await requestAgentAbortWithTimeout(
        sessionId,
        (targetSessionId) => window.electronAPI.agentAbort(targetSessionId),
        () => finishManualAbort(sessionId),
      );
      if (!result.success) console.error("[agent] abort failed: no active agent");
      return result.success;
    } catch (error) {
      finishManualAbort(sessionId);
      console.error("[agent] abort failed:", error);
      throw error;
    }
  }, [finishManualAbort, sessionRuntimeRef]);

  return { finishManualAbort, refreshSessionWatchdog, requestManualAbort };
}
