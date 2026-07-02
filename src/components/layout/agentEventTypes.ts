import type { AgentProcessEntry } from "@/stores/chat-store";
import type { AgentEvent } from "@/types";
import type { AskQuestionPayload } from "./QuestionnairePanel";
import type { SessionRuntime } from "./agentEventUtils";

export type PendingUIResponse = {
  sessionId: string;
  requestId?: string;
  method?: string;
  entryId?: string;
  questions?: AskQuestionPayload[];
} | null;

export type PendingUIResponseUpdate =
  | PendingUIResponse
  | ((current: PendingUIResponse) => PendingUIResponse);

export type ProcessEntryDraft =
  Omit<AgentProcessEntry, "id" | "timestamp"> & {
    id?: string;
    timestamp?: number;
  };

export type AgentEventHandlerContext = {
  pendingUIResponseRef: { current: PendingUIResponse };
  setPendingUIResponse: (next: PendingUIResponseUpdate) => void;
  setStreamingState: (streaming: boolean) => void;
  getRuntime: (sessionId: string) => SessionRuntime;
  appendProcessEntry: (sessionId: string, entry: ProcessEntryDraft) => void;
  completeIdleNotice: (sessionId: string) => void;
  appendOrRefreshAlreadyRunningNotice: (sessionId: string) => void;
  finishThinkingEntry: (sessionId: string) => void;
  appendAssistantProcessText: (sessionId: string, delta: string) => void;
  finishAssistantProcessText: (sessionId: string) => void;
  replaceAssistantProcessText: (sessionId: string, content: string) => void;
  appendThinkingDelta: (sessionId: string, delta: string) => void;
  getPendingUIFromEvent: (event: AgentEvent, sessionId: string, entryId: string) => PendingUIResponse;
  clearStreamWatchdog: (sessionId?: string) => void;
  completeAssistantStream: (currentSessionId: string, content?: string, timedOut?: boolean) => void;
  failAssistantStream: (currentSessionId: string, title: string, detail?: string) => void;
  refreshStreamWatchdog: (currentSessionId: string) => void;
  ensureAssistantContinuation: (currentSessionId: string) => SessionRuntime;
  isAlreadyRunningError: (title: string, detail?: string) => boolean;
};
