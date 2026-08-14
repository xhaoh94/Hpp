import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useChatStore, type ChatMessage } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import type { AgentUIResponse } from "@/types";
import {
  getQuestionTitle,
  getUIResponsePayload,
  markSessionRuntimeTurnSettled,
  resetSessionRuntimeAfterTurn,
  type SessionRuntime,
} from "./agentEventUtils";
import { getQuestionnaireAnswerLabel, type AskQuestionOption } from "./QuestionnairePanel";
import type { PendingUIResponse, PendingUIResponseUpdate } from "./agentEventTypes";

export type PendingUIResponseValue = Exclude<PendingUIResponse, null>;
export type PendingUIResponses = Record<string, PendingUIResponseValue>;

export function applyPendingUIResponseUpdate(
  current: PendingUIResponses,
  activeSessionId: string | null,
  update: PendingUIResponseUpdate,
  openSessionIds?: ReadonlySet<string>,
): PendingUIResponses {
  let next = current;
  if (typeof update !== "function") {
    if (update) {
      if (openSessionIds && !openSessionIds.has(update.sessionId)) {
        return retainPendingUIResponses(current, openSessionIds);
      }
      next = current[update.sessionId] === update
        ? current
        : { ...current, [update.sessionId]: update };
    } else if (activeSessionId && current[activeSessionId]) {
      next = { ...current };
      delete next[activeSessionId];
    }
  } else {
    for (const [sessionId, pending] of Object.entries(current)) {
      const result = update(pending);
      if (result === pending) continue;
      if (next === current) next = { ...current };
      delete next[sessionId];
      if (result) next[result.sessionId] = result;
    }
  }
  return openSessionIds ? retainPendingUIResponses(next, openSessionIds) : next;
}

export function retainPendingUIResponses(
  current: PendingUIResponses,
  openSessionIds: ReadonlySet<string>,
): PendingUIResponses {
  const entries = Object.entries(current).filter(([sessionId]) => openSessionIds.has(sessionId));
  return entries.length === Object.keys(current).length
    ? current
    : Object.fromEntries(entries);
}

type UsePendingUIResponseActionsOptions = {
  activeConfirmation: PendingUIResponse;
  activePermissionChoice: PendingUIResponse;
  activeQuestionnaire: PendingUIResponse;
  addMessage: (message: ChatMessage, sessionId?: string | null) => void;
  enableAutoFollow: () => void;
  inputValueRef: { current: string };
  pendingUIResponse: PendingUIResponse;
  refreshSessionWatchdog: (sessionId: string) => void;
  sessionRuntimeRef: { current: Record<string, SessionRuntime> };
  setComposerInput: (value: string) => void;
  setPendingUIResponseState: (next: PendingUIResponseUpdate) => void;
  setStreaming: (streaming: boolean) => void;
};

export async function settleFailedPendingQuestionTurn(
  targetSessionId: string,
  pendingResponse: PendingUIResponse,
  sessionRuntimeRef: { current: Record<string, SessionRuntime> },
  setStreaming: (streaming: boolean) => void,
  abortSession?: (sessionId: string) => Promise<unknown>,
) {
  const endedAt = Date.now();
  if (pendingResponse?.entryId) {
    useChatStore.getState().updateLastAssistantProcessEntry(pendingResponse.entryId, {
      title: getQuestionTitle(false, true),
      state: "error",
      expanded: false,
    }, targetSessionId);
  }
  const chatStore = useChatStore.getState();
  chatStore.finishAllAssistantProcesses(endedAt, "interrupted", targetSessionId);
  chatStore.interruptSessionCompaction(targetSessionId);

  const runtime = sessionRuntimeRef.current[targetSessionId];
  if (runtime) {
    if (runtime.streamWatchdog) clearTimeout(runtime.streamWatchdog);
    runtime.streamWatchdog = null;
    runtime.activeCompactionId = null;
    runtime.activeCompactionPresentation = null;
    resetSessionRuntimeAfterTurn(runtime);
    const sessionMessages = chatStore.sessionMessages[targetSessionId] || (
      chatStore.activeSessionId === targetSessionId ? chatStore.messages : []
    );
    const latestUserMessage = [...sessionMessages].reverse().find((message) => message.role === "user");
    markSessionRuntimeTurnSettled(runtime, "error", {
      userMessageId: latestUserMessage?.id,
    });
    runtime.autoAbortReason = null;
  }

  const projectStore = useProjectStore.getState();
  if (projectStore.activeSessionId === targetSessionId) setStreaming(false);

  // The UI has already consumed and closed this interaction. If delivery
  // failed, the backend can otherwise remain blocked on the same request and
  // report busy forever. Keep its renderer status running until this abort
  // finishes so the queue dispatcher cannot race a new message into it.
  if (abortSession) {
    try {
      await abortSession(targetSessionId);
    } catch (error) {
      console.error("[agent] abort after UI response failure failed:", error);
    }
  }
  projectStore.setAgentStatus(targetSessionId, "error");
}

export function preparePendingQuestionContinuation(
  targetSessionId: string,
  sessionRuntimeRef: { current: Record<string, SessionRuntime> },
) {
  const runtime = sessionRuntimeRef.current[targetSessionId];
  if (!runtime) return;
  if (runtime.streamWatchdog) clearTimeout(runtime.streamWatchdog);
  runtime.streamWatchdog = null;
  resetSessionRuntimeAfterTurn(runtime);
  runtime.autoAbortReason = null;
}

export function usePendingUIResponse(
  activeSessionId: string | null,
  openSessionIds?: ReadonlySet<string>,
) {
  const [pendingUIResponses, setPendingUIResponses] = useState<PendingUIResponses>({});
  const pendingUIResponsesRef = useRef<PendingUIResponses>({});
  const pendingUIResponse = activeSessionId && (!openSessionIds || openSessionIds.has(activeSessionId))
    ? pendingUIResponses[activeSessionId] || null
    : null;

  const setPendingUIResponseState = useCallback((next: PendingUIResponseUpdate) => {
    const value = applyPendingUIResponseUpdate(
      pendingUIResponsesRef.current,
      activeSessionId,
      next,
      openSessionIds,
    );
    if (value === pendingUIResponsesRef.current) return;
    pendingUIResponsesRef.current = value;
    setPendingUIResponses(value);
  }, [activeSessionId, openSessionIds]);

  const getPendingUIResponse = useCallback((sessionId: string): PendingUIResponse => (
    pendingUIResponsesRef.current[sessionId] || null
  ), []);

  const clearPendingUIResponse = useCallback((sessionId: string) => {
    const current = pendingUIResponsesRef.current;
    if (!sessionId || !current[sessionId]) return;
    const next = { ...current };
    delete next[sessionId];
    pendingUIResponsesRef.current = next;
    setPendingUIResponses(next);
  }, []);

  useEffect(() => {
    if (!openSessionIds) return;
    const next = retainPendingUIResponses(pendingUIResponsesRef.current, openSessionIds);
    if (next === pendingUIResponsesRef.current) return;
    pendingUIResponsesRef.current = next;
    setPendingUIResponses(next);
  }, [activeSessionId, openSessionIds, pendingUIResponses]);

  const isAwaitingUIResponse = !!pendingUIResponse;
  const normalizedMethod = pendingUIResponse?.method?.toLowerCase() || "";
  const isConfirmation = normalizedMethod === "confirm";
  const isPermissionChoice = !isConfirmation && normalizedMethod.includes("permission");
  const activeQuestionnaire = useMemo(() => (
    isAwaitingUIResponse && !isConfirmation && !isPermissionChoice && pendingUIResponse?.questions?.length
      ? pendingUIResponse
      : null
  ), [isAwaitingUIResponse, isConfirmation, isPermissionChoice, pendingUIResponse]);
  const activeConfirmation = useMemo(() => (
    isAwaitingUIResponse && isConfirmation
      ? pendingUIResponse
      : null
  ), [isAwaitingUIResponse, isConfirmation, pendingUIResponse]);
  const activePermissionChoice = useMemo(() => (
    isAwaitingUIResponse && isPermissionChoice && pendingUIResponse?.questions?.length
      ? pendingUIResponse
      : null
  ), [isAwaitingUIResponse, isPermissionChoice, pendingUIResponse]);

  return {
    pendingUIResponses,
    pendingUIResponsesRef,
    pendingUIResponse,
    getPendingUIResponse,
    clearPendingUIResponse,
    setPendingUIResponseState,
    isAwaitingUIResponse,
    activeConfirmation,
    activePermissionChoice,
    activeQuestionnaire,
  };
}

export function usePendingUIResponseActions({
  activeConfirmation,
  activePermissionChoice,
  activeQuestionnaire,
  addMessage,
  enableAutoFollow,
  inputValueRef,
  pendingUIResponse,
  refreshSessionWatchdog,
  sessionRuntimeRef,
  setComposerInput,
  setPendingUIResponseState,
  setStreaming,
}: UsePendingUIResponseActionsOptions) {
  const finishPendingQuestionEntry = useCallback((
    targetSessionId: string,
    pendingResponse: PendingUIResponse,
    failed = false
  ) => {
    if (!pendingResponse?.entryId) return;
    useChatStore.getState().updateLastAssistantProcessEntry(pendingResponse.entryId, {
      title: failed ? getQuestionTitle(false, true) : getQuestionTitle(false),
      state: failed ? "error" : "completed",
      expanded: false,
    }, targetSessionId);
  }, []);

  const resetRuntimeAfterUIResponse = useCallback((targetSessionId: string) => {
    preparePendingQuestionContinuation(targetSessionId, sessionRuntimeRef);
  }, [sessionRuntimeRef]);

  const finishPendingQuestionTurn = useCallback((
    targetSessionId: string,
    pendingResponse: PendingUIResponse,
    failed = false
  ) => {
    finishPendingQuestionEntry(targetSessionId, pendingResponse, failed);
    const chatStore = useChatStore.getState();
    if (pendingResponse?.entryId) {
      chatStore.finishAssistantProcessContainingEntry(
        pendingResponse.entryId,
        Date.now(),
        failed ? "interrupted" : "completed",
        targetSessionId,
      );
    } else {
      chatStore.finishLastAssistantProcess(
        Date.now(),
        failed ? "interrupted" : "completed",
        targetSessionId,
      );
    }
    resetRuntimeAfterUIResponse(targetSessionId);
  }, [finishPendingQuestionEntry, resetRuntimeAfterUIResponse]);

  const failPendingQuestionTurn = useCallback(async (
    targetSessionId: string,
    pendingResponse: PendingUIResponse,
  ) => {
    await settleFailedPendingQuestionTurn(
      targetSessionId,
      pendingResponse,
      sessionRuntimeRef,
      setStreaming,
      (sessionId) => window.electronAPI.agentAbort(sessionId),
    );
  }, [sessionRuntimeRef, setStreaming]);

  const sendPendingUIResponse = useCallback(async (
    targetSessionId: string,
    pendingResponse: PendingUIResponse,
    payload: AgentUIResponse,
    failureMessage?: string,
  ) => {
    try {
      const result = await window.electronAPI.agentSendUIResponse(payload);
      if (result.success) {
        // The question process has already been closed so continuation output
        // can appear after the user's answer. Keep terminal reconciliation
        // alive in case the backend accepts the answer but emits nothing else.
        refreshSessionWatchdog(targetSessionId);
        return true;
      }
    } catch (error) {
      console.error("[agent] send UI response failed:", error);
    }
    if (failureMessage) {
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: failureMessage,
        timestamp: Date.now(),
      }, targetSessionId);
    }
    await failPendingQuestionTurn(targetSessionId, pendingResponse);
    return false;
  }, [addMessage, failPendingQuestionTurn, refreshSessionWatchdog]);

  const handleSendUIResponse = useCallback(async () => {
    const text = inputValueRef.current.trim();
    const targetSessionId = useProjectStore.getState().activeSessionId;
    if (!targetSessionId || pendingUIResponse?.sessionId !== targetSessionId || !text) return;
    const pendingResponse = pendingUIResponse;

    enableAutoFollow();
    flushSync(() => {
      addMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        timestamp: Date.now(),
        uiGenerated: true,
      }, targetSessionId);
      setComposerInput("");
      setPendingUIResponseState(null);
      finishPendingQuestionTurn(targetSessionId, pendingResponse);
    });

    await sendPendingUIResponse(targetSessionId, pendingResponse, getUIResponsePayload({
      sessionId: targetSessionId,
      requestId: pendingResponse.requestId,
      method: pendingResponse.method,
      text,
    }), "发送回答失败");
  }, [
    addMessage,
    enableAutoFollow,
    failPendingQuestionTurn,
    finishPendingQuestionEntry,
    finishPendingQuestionTurn,
    inputValueRef,
    pendingUIResponse,
    setComposerInput,
    setPendingUIResponseState,
    sendPendingUIResponse,
  ]);

  const handleSubmitQuestionnaire = useCallback(async (answers: unknown[]) => {
    const targetSessionId = useProjectStore.getState().activeSessionId;
    if (!targetSessionId || !activeQuestionnaire || activeQuestionnaire.sessionId !== targetSessionId) return;
    const pendingResponse = activeQuestionnaire;
    const answerSummary = answers
      .map(getQuestionnaireAnswerLabel)
      .filter(Boolean)
      .join("\n");

    flushSync(() => {
      addMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: answerSummary || "已提交问卷回答",
        timestamp: Date.now(),
        uiGenerated: true,
      }, targetSessionId);
      setPendingUIResponseState(null);
      finishPendingQuestionTurn(targetSessionId, pendingResponse);
    });

    await sendPendingUIResponse(targetSessionId, pendingResponse, {
      sessionId: targetSessionId,
      type: "extension_ui_response",
      id: pendingResponse.requestId,
      method: pendingResponse.method,
      cancelled: false,
      result: { cancelled: false, answers },
      value: answerSummary,
      text: answerSummary,
      answers,
    }, "发送问卷回答失败");
  }, [
    activeQuestionnaire,
    addMessage,
    failPendingQuestionTurn,
    finishPendingQuestionEntry,
    finishPendingQuestionTurn,
    sendPendingUIResponse,
    setPendingUIResponseState,
  ]);

  const handleConfirmUIResponse = useCallback(async (confirmed: boolean) => {
    const targetSessionId = useProjectStore.getState().activeSessionId;
    if (!targetSessionId || !activeConfirmation || activeConfirmation.sessionId !== targetSessionId) return;
    const pendingResponse = activeConfirmation;

    flushSync(() => {
      setPendingUIResponseState(null);
      finishPendingQuestionTurn(targetSessionId, pendingResponse);
    });

    await sendPendingUIResponse(targetSessionId, pendingResponse, getUIResponsePayload({
      sessionId: targetSessionId,
      requestId: pendingResponse.requestId,
      method: pendingResponse.method,
      text: confirmed ? "是" : "否",
    }), "发送权限选择失败");
  }, [
    activeConfirmation,
    addMessage,
    failPendingQuestionTurn,
    finishPendingQuestionEntry,
    finishPendingQuestionTurn,
    sendPendingUIResponse,
    setPendingUIResponseState,
  ]);

  const handlePermissionChoiceUIResponse = useCallback(async (option: AskQuestionOption) => {
    const targetSessionId = useProjectStore.getState().activeSessionId;
    if (!targetSessionId || !activePermissionChoice || activePermissionChoice.sessionId !== targetSessionId) return;
    const pendingResponse = activePermissionChoice;
    const question = pendingResponse.questions?.[0];
    const value = String(option.value || option.label);
    const answers = [{
      id: question?.id,
      questionIndex: 0,
      selected: [option.label],
      selectedOptions: [{ ...option, value }],
      values: [value],
    }];

    flushSync(() => {
      setPendingUIResponseState(null);
      finishPendingQuestionTurn(targetSessionId, pendingResponse);
    });

    await sendPendingUIResponse(targetSessionId, pendingResponse, {
      sessionId: targetSessionId,
      type: "extension_ui_response",
      id: pendingResponse.requestId,
      method: pendingResponse.method,
      cancelled: false,
      result: { cancelled: false, answers },
      value,
      text: value,
      answers,
    }, "发送权限选择失败");
  }, [
    activePermissionChoice,
    addMessage,
    failPendingQuestionTurn,
    finishPendingQuestionEntry,
    finishPendingQuestionTurn,
    sendPendingUIResponse,
    setPendingUIResponseState,
  ]);

  const handleCancelQuestionnaire = useCallback(async () => {
    const targetSessionId = useProjectStore.getState().activeSessionId;
    if (!targetSessionId || !activeQuestionnaire || activeQuestionnaire.sessionId !== targetSessionId) return;
    const pendingResponse = activeQuestionnaire;
    setPendingUIResponseState(null);
    finishPendingQuestionTurn(targetSessionId, pendingResponse, true);
    await sendPendingUIResponse(targetSessionId, pendingResponse, {
      sessionId: targetSessionId,
      type: "extension_ui_response",
      id: pendingResponse.requestId,
      method: pendingResponse.method,
      cancelled: true,
    }, "取消问卷失败");
  }, [activeQuestionnaire, finishPendingQuestionTurn, sendPendingUIResponse, setPendingUIResponseState]);

  return {
    handleConfirmUIResponse,
    handlePermissionChoiceUIResponse,
    handleSendUIResponse,
    handleSubmitQuestionnaire,
    handleCancelQuestionnaire,
  };
}
