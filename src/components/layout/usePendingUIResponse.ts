import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useChatStore, type ChatMessage } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import {
  getQuestionTitle,
  getUIResponsePayload,
  resetSessionRuntimeAfterTurn,
  type SessionRuntime,
} from "./agentEventUtils";
import { getQuestionnaireAnswerLabel } from "./QuestionnairePanel";
import type { PendingUIResponse, PendingUIResponseUpdate } from "./agentEventTypes";

type UsePendingUIResponseActionsOptions = {
  activeQuestionnaire: PendingUIResponse;
  addMessage: (message: ChatMessage, sessionId?: string | null) => void;
  enableAutoFollow: () => void;
  inputValueRef: { current: string };
  pendingUIResponse: PendingUIResponse;
  sessionRuntimeRef: { current: Record<string, SessionRuntime> };
  setComposerInput: (value: string) => void;
  setPendingUIResponseState: (next: PendingUIResponseUpdate) => void;
};

export function usePendingUIResponse(activeSessionId: string | null) {
  const [pendingUIResponse, setPendingUIResponse] = useState<PendingUIResponse>(null);
  const pendingUIResponseRef = useRef<PendingUIResponse>(null);

  const setPendingUIResponseState = useCallback((next: PendingUIResponseUpdate) => {
    const value = typeof next === "function" ? next(pendingUIResponseRef.current) : next;
    pendingUIResponseRef.current = value;
    setPendingUIResponse(value);
  }, []);

  useEffect(() => {
    pendingUIResponseRef.current = pendingUIResponse;
  }, [pendingUIResponse]);

  const isAwaitingUIResponse = !!activeSessionId && pendingUIResponse?.sessionId === activeSessionId;
  const activeQuestionnaire = useMemo(() => (
    isAwaitingUIResponse && pendingUIResponse?.questions?.length
      ? pendingUIResponse
      : null
  ), [isAwaitingUIResponse, pendingUIResponse]);

  return {
    pendingUIResponse,
    pendingUIResponseRef,
    setPendingUIResponseState,
    isAwaitingUIResponse,
    activeQuestionnaire,
  };
}

export function usePendingUIResponseActions({
  activeQuestionnaire,
  addMessage,
  enableAutoFollow,
  inputValueRef,
  pendingUIResponse,
  sessionRuntimeRef,
  setComposerInput,
  setPendingUIResponseState,
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
    const runtime = sessionRuntimeRef.current[targetSessionId];
    if (!runtime) return;

    if (runtime.streamWatchdog) {
      clearTimeout(runtime.streamWatchdog);
      runtime.streamWatchdog = null;
    }
    resetSessionRuntimeAfterTurn(runtime);
    runtime.autoAbortReason = null;
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
      }, targetSessionId);
      setComposerInput("");
      setPendingUIResponseState(null);
      finishPendingQuestionTurn(targetSessionId, pendingResponse);
    });

    const result = await window.electronAPI.agentSendUIResponse(getUIResponsePayload({
      sessionId: targetSessionId,
      requestId: pendingResponse.requestId,
      method: pendingResponse.method,
      text,
    }));

    if (!result.success) {
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: "发送回答失败",
        timestamp: Date.now(),
      }, targetSessionId);
      finishPendingQuestionEntry(targetSessionId, pendingResponse, true);
    }
  }, [
    addMessage,
    enableAutoFollow,
    finishPendingQuestionEntry,
    finishPendingQuestionTurn,
    inputValueRef,
    pendingUIResponse,
    setComposerInput,
    setPendingUIResponseState,
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
      }, targetSessionId);
      setPendingUIResponseState(null);
      finishPendingQuestionTurn(targetSessionId, pendingResponse);
    });

    const result = await window.electronAPI.agentSendUIResponse({
      sessionId: targetSessionId,
      type: "extension_ui_response",
      id: pendingResponse.requestId,
      method: pendingResponse.method,
      cancelled: false,
      result: { cancelled: false, answers },
      value: answerSummary,
      text: answerSummary,
      answers,
    });

    if (!result.success) {
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: "发送问卷回答失败",
        timestamp: Date.now(),
      }, targetSessionId);
      finishPendingQuestionEntry(targetSessionId, pendingResponse, true);
    }
  }, [
    activeQuestionnaire,
    addMessage,
    finishPendingQuestionEntry,
    finishPendingQuestionTurn,
    setPendingUIResponseState,
  ]);

  const handleCancelQuestionnaire = useCallback(async () => {
    const targetSessionId = useProjectStore.getState().activeSessionId;
    if (!targetSessionId || !activeQuestionnaire || activeQuestionnaire.sessionId !== targetSessionId) return;
    const pendingResponse = activeQuestionnaire;
    setPendingUIResponseState(null);
    finishPendingQuestionTurn(targetSessionId, pendingResponse, true);
    await window.electronAPI.agentSendUIResponse({
      sessionId: targetSessionId,
      type: "extension_ui_response",
      id: pendingResponse.requestId,
      method: pendingResponse.method,
      cancelled: true,
    });
  }, [activeQuestionnaire, finishPendingQuestionTurn, setPendingUIResponseState]);

  return {
    handleSendUIResponse,
    handleSubmitQuestionnaire,
    handleCancelQuestionnaire,
  };
}
