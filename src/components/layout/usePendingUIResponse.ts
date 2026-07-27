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
import { getQuestionnaireAnswerLabel, type AskQuestionOption } from "./QuestionnairePanel";
import type { PendingUIResponse, PendingUIResponseUpdate } from "./agentEventTypes";

type UsePendingUIResponseActionsOptions = {
  activeConfirmation: PendingUIResponse;
  activePermissionChoice: PendingUIResponse;
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
    pendingUIResponse,
    pendingUIResponseRef,
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

  const handleConfirmUIResponse = useCallback(async (confirmed: boolean) => {
    const targetSessionId = useProjectStore.getState().activeSessionId;
    if (!targetSessionId || !activeConfirmation || activeConfirmation.sessionId !== targetSessionId) return;
    const pendingResponse = activeConfirmation;

    flushSync(() => {
      setPendingUIResponseState(null);
      finishPendingQuestionTurn(targetSessionId, pendingResponse);
    });

    const result = await window.electronAPI.agentSendUIResponse(getUIResponsePayload({
      sessionId: targetSessionId,
      requestId: pendingResponse.requestId,
      method: pendingResponse.method,
      text: confirmed ? "是" : "否",
    }));

    if (!result.success) {
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: "发送权限选择失败",
        timestamp: Date.now(),
      }, targetSessionId);
      finishPendingQuestionEntry(targetSessionId, pendingResponse, true);
    }
  }, [
    activeConfirmation,
    addMessage,
    finishPendingQuestionEntry,
    finishPendingQuestionTurn,
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

    const result = await window.electronAPI.agentSendUIResponse({
      sessionId: targetSessionId,
      type: "extension_ui_response",
      id: pendingResponse.requestId,
      method: pendingResponse.method,
      cancelled: false,
      result: { cancelled: false, answers },
      value,
      text: value,
      answers,
    });

    if (!result.success) {
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: "发送权限选择失败",
        timestamp: Date.now(),
      }, targetSessionId);
      finishPendingQuestionEntry(targetSessionId, pendingResponse, true);
    }
  }, [
    activePermissionChoice,
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
    handleConfirmUIResponse,
    handlePermissionChoiceUIResponse,
    handleSendUIResponse,
    handleSubmitQuestionnaire,
    handleCancelQuestionnaire,
  };
}
