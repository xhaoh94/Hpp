import { create } from "zustand";
import type { SessionReference } from "./project-store";
import type { AgentImagePayload } from "@/types";
import type { DiffLike } from "@shared/diff-summary";
import type { SharedModel } from "@shared/models";
import type { ProcessEntryView, ProcessSubagentStopReason, ProcessSubagentUsage } from "@shared/process-view";
import type { AgentActionInvocation } from "@shared/agent-actions";
import type { AgentPermissionMode } from "@shared/agent-permissions";
import {
  cloneComposerDocument,
  createComposerDocument,
  getComposerPlainText,
  type ComposerDocument,
} from "@shared/composer-document";

export interface FileDiff extends DiffLike {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
  statusExplicit?: boolean;
}

export interface AgentProcessFile {
  file: string;
  label?: string;
  action?: "read" | "listed" | "edited" | "modified" | "written";
  patch?: string;
  additions?: number;
  deletions?: number;
  status?: "added" | "deleted" | "modified";
  statusExplicit?: boolean;
  changeKey?: string;
}

export type AgentSubagentStatus = "pending" | "running" | "completed" | "error" | "interrupted";
export type AgentSubagentTool = "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent";
export type AgentSubagentActivityKind = "started" | "interacted" | "interrupted";
export type AgentSubagentAction =
  | AgentSubagentTool
  | AgentSubagentActivityKind;

export interface AgentSubagent {
  id: string;
  label: string;
  status?: AgentSubagentStatus;
  model?: string;
  path?: string;
  message?: string;
  prompt?: string;
  stopReason?: ProcessSubagentStopReason;
  usage?: ProcessSubagentUsage;
}

export interface AgentProcessEntry extends ProcessEntryView {
  id: string;
  type: "status" | "tool" | "diff" | "error" | "info" | "thinking" | "question" | "subagent";
  title: string;
  detail?: string;
  prompt?: string;
  files?: AgentProcessFile[];
  toolKind?: string;
  command?: string;
  exitCode?: number;
  timestamp: number;
  state?: "running" | "completed" | "warning" | "error" | "interrupted";
  expanded?: boolean;
  subagents?: AgentSubagent[];
  phase?: "started" | "completed";
  action?: AgentSubagentAction;
  tool?: AgentSubagentTool;
  activityKind?: AgentSubagentActivityKind;
  startedAt?: number;
  completedAt?: number;
  guidanceDocument?: ComposerDocument;
  guidanceImages?: Array<{ id: string; src: string; name: string }>;
}

export type AgentProcessStepStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface AgentProcessStep {
  id: string;
  title: string;
  status: AgentProcessStepStatus;
}

export interface AgentProcessChangeSummary {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface AgentProcess {
  startedAt: number;
  endedAt?: number;
  expanded?: boolean;
  planSteps?: AgentProcessStep[];
  planStepsSource?: "native" | "inferred";
  changeSummary?: AgentProcessChangeSummary;
  entries: AgentProcessEntry[];
}

export type AgentProcessFinalState = "completed" | "interrupted";

export interface AgentCommentary {
  id: string;
  content: string;
  timestamp: number;
  isStreaming?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  systemType?: "context_compaction" | "agent_startup_error";
  compactionState?: "running" | "completed" | "interrupted";
  eventId?: string;
  images?: Array<{ id: string; src: string; name: string }>;
  sessionReferences?: Array<{ sourceSessionId: string; sourceTitle: string }>;
  diffs?: FileDiff[];
  process?: AgentProcess;
  commentary?: AgentCommentary[];
  nativeTurnId?: string;
  action?: AgentActionInvocation;
  composerDraft?: ComposerDraftSnapshot;
  composerDocument?: ComposerDocument;
  /** 回合开始时记录的调用模型名称与思考档位，用于消息底部展示。 */
  modelLabel?: string;
  thinkingLevel?: string;
  /** 本回合累计的输入/输出 token 消耗，cacheInput 为输入中命中缓存的部分。 */
  tokenUsage?: { input: number; output: number; cacheInput?: number };
  /** 该条 user 消息是否为 UI 应答（问卷提交、问题回复等）而非用户在输入框的真实发言。
   *  真实发言不带此标记；UI 应答不计入「发言记录」历史弹窗，也不参与「返回上一条发言」按钮计算。 */
  uiGenerated?: boolean;
}

/** 判断一条消息是否算“真实发言”：仅用户在输入框主动发送的 user 消息。
 *  问卷提交、UI 应答等不算发言记录，历史弹窗与「返回上一条发言」按钮均以此过滤。 */
export const isUserSpeechMessage = (message: Pick<ChatMessage, "role" | "uiGenerated">): boolean =>
  message.role === "user" && !message.uiGenerated;

export interface PendingFile {
  id: string;
  fileName: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface PendingPathAttachment {
  id: string;
  name: string;
  path: string;
  kind: "file" | "folder";
}

export interface PendingImage {
  id: string;
  src: string;
  name: string;
  file: File;
}

export interface QueuedMessageImage {
  id: string;
  src: string;
  name: string;
  mimeType: string;
}

export interface QueuedMessageEditableDraft {
  text: string;
  images: QueuedMessageImage[];
  pendingFiles: PendingFile[];
  pendingPathAttachments: PendingPathAttachment[];
  sessionReferences: SessionReference[];
  document?: ComposerDocument;
  forkContext?: string;
  action?: AgentActionInvocation;
}

export interface ComposerDraftSnapshot {
  text: string;
  images: QueuedMessageImage[];
  pendingFiles: PendingFile[];
  pendingPathAttachments: PendingPathAttachment[];
  sessionReferences: SessionReference[];
  document?: ComposerDocument;
  action?: AgentActionInvocation;
}

export interface ChatDraft {
  text: string;
  document?: ComposerDocument;
  pendingImages: PendingImage[];
  pendingFiles: PendingFile[];
  pendingPathAttachments: PendingPathAttachment[];
  sessionReferences: SessionReference[];
  action?: AgentActionInvocation;
}

export interface ModelInfo extends SharedModel {}

export type QueuedMessageStatus = "queued" | "sending" | "failed";

export interface QueuedMessage {
  id: string;
  sessionId: string;
  editableContent?: string;
  displayContent: string;
  sendContent: string;
  messageImages?: Array<{ id: string; src: string; name: string }>;
  sessionReferences?: Array<{ sourceSessionId: string; sourceTitle: string }>;
  agentImages?: AgentImagePayload;
  planModeEnabled?: boolean;
  permissionMode?: AgentPermissionMode;
  createdAt: number;
  status: QueuedMessageStatus;
  error?: string;
  action?: AgentActionInvocation;
  editableDraft?: QueuedMessageEditableDraft;
  composerDocument?: ComposerDocument;
}

interface ChatState {
  messages: ChatMessage[];
  sessionMessages: Record<string, ChatMessage[]>; // sessionId -> messages
  activeSessionId: string | null;
  isStreaming: boolean;
  currentModel: ModelInfo | null;
  thinkingLevel: string;
  availableModels: ModelInfo[];
  favoriteModels: ModelInfo[];
  activeAgentId: string;
  sessionDrafts: Record<string, ChatDraft>;
  messageQueues: Record<string, QueuedMessage[]>;
  compactingSessions: Record<string, boolean>;

  addMessage: (msg: ChatMessage, sessionId?: string | null) => void;
  updateLastAssistant: (content: string, sessionId?: string | null) => void;
  appendLastAssistantContent: (content: string, sessionId?: string | null) => void;
  setNativeTurnIdForTurn: (clientMessageId: string, nativeTurnId: string, sessionId?: string | null) => void;
  appendLastAssistantDiffs: (diffs: FileDiff[], sessionId?: string | null) => void;
  appendContextCompactionDivider: (
    eventId?: string,
    sessionId?: string | null,
    state?: "running" | "completed" | "interrupted",
  ) => void;
  setSessionCompacting: (sessionId: string, compacting: boolean) => void;
  startAssistantProcess: (startedAt?: number, sessionId?: string | null) => void;
  appendLastAssistantCommentaryDelta: (itemId: string, delta: string, timestamp?: number, sessionId?: string | null) => void;
  finishLastAssistantCommentary: (itemId: string, content?: string, timestamp?: number, sessionId?: string | null) => void;
  appendLastAssistantProcessEntry: (entry: AgentProcessEntry, sessionId?: string | null) => void;
  updateLastAssistantProcessEntry: (entryId: string, patch: Partial<Omit<AgentProcessEntry, "id">>, sessionId?: string | null) => void;
  removeLastAssistantProcessEntries: (entryIds: string[], sessionId?: string | null) => void;
  updateLastAssistantProcessMeta: (patch: { planSteps?: AgentProcessStep[]; planStepsSource?: AgentProcess["planStepsSource"]; changeSummary?: AgentProcessChangeSummary }, sessionId?: string | null) => void;
  addAssistantTokenUsage: (inputTokens: number, outputTokens: number, cacheInputTokens: number, sessionId?: string | null) => void;
  finishLastAssistantProcess: (endedAt?: number, finalState?: "completed" | "interrupted", sessionId?: string | null) => void;
  finishAssistantProcessContainingEntry: (entryId: string, endedAt?: number, finalState?: "completed" | "interrupted", sessionId?: string | null) => void;
  finishAllAssistantProcesses: (endedAt?: number, finalState?: AgentProcessFinalState, sessionId?: string | null) => void;
  interruptSessionCompaction: (sessionId: string) => void;
  collapseLastAssistantProcess: (sessionId?: string | null) => void;
  toggleAssistantProcess: (messageId: string) => void;
  toggleAssistantProcessEntry: (messageId: string, entryId: string, expanded?: boolean) => void;
  setStreaming: (v: boolean) => void;
  setCurrentModel: (m: ModelInfo) => void;
  setThinkingLevel: (level: string) => void;
  setAvailableModels: (models: ModelInfo[]) => void;
  toggleFavorite: (model: ModelInfo) => void;
  setActiveAgent: (id: string) => void;
  clearMessages: () => void;
  clearAgentStartupErrors: (sessionId?: string | null) => void;
  setDraftText: (sessionId: string, text: string) => void;
  setDraftDocument: (sessionId: string, document: ComposerDocument) => void;
  replaceSessionDraft: (sessionId: string, draft: ChatDraft) => void;
  setDraftAction: (sessionId: string, action?: AgentActionInvocation) => void;
  addPendingImage: (image: PendingImage, sessionId?: string | null) => void;
  removePendingImage: (id: string, sessionId?: string | null) => void;
  clearPendingImages: (sessionId?: string | null) => void;
  addPendingFile: (file: PendingFile, sessionId?: string | null) => void;
  removePendingFile: (id: string, sessionId?: string | null) => void;
  clearPendingFiles: (sessionId?: string | null) => void;
  addPendingPathAttachment: (attachment: PendingPathAttachment, sessionId?: string | null) => void;
  removePendingPathAttachment: (id: string, sessionId?: string | null) => void;
  clearPendingPathAttachments: (sessionId?: string | null) => void;
  upsertSessionReference: (reference: SessionReference, sessionId?: string | null) => void;
  removeSessionReference: (sourceSessionId: string, sessionId?: string | null) => void;
  clearSessionReferences: (sessionId?: string | null) => void;
  clearSessionDraft: (sessionId: string) => void;
  enqueueMessage: (item: QueuedMessage) => void;
  upsertQueuedMessage: (item: QueuedMessage) => void;
  reorderQueuedMessage: (sessionId: string, itemId: string, toIndex: number) => void;
  removeQueuedMessage: (sessionId: string, itemId: string) => void;
  markQueuedMessageSending: (sessionId: string, itemId: string) => void;
  markQueuedMessageFailed: (sessionId: string, itemId: string, error: string) => void;
  clearQueuedMessageError: (sessionId: string, itemId: string) => void;
  clearSessionQueue: (sessionId: string) => void;
  deleteSessionMessages: (sessionId: string) => void;
  deleteSessionsMessages: (sessionIds: string[]) => void;
  switchSession: (sessionId: string | null) => void;
  loadSessionMessages: (sessionId: string, messages: ChatMessage[]) => void;
}

const createMessageId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const findLastAssistantIndex = (messages: ChatMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") return i;
  }
  return -1;
};

const ensureAssistantProcess = (
  messages: ChatMessage[],
  startedAt = Date.now(),
  turnModel?: { modelLabel?: string; thinkingLevel?: string },
) => {
  const msgs = [...messages];
  let index = findLastAssistantIndex(msgs);
  const last = msgs[msgs.length - 1];

  if (!last || last.role !== "assistant" || !last.isStreaming) {
    for (let messageIndex = 0; messageIndex < msgs.length; messageIndex += 1) {
      const message = msgs[messageIndex];
      if (!hasOpenAssistantProcessState(message)) continue;
      const processIsOpen = !!message.process && !isFiniteTimestamp(message.process.endedAt);
      const awaitingAnswer = processIsOpen && message.process!.entries.some((entry) => (
        entry.type === "question" && entry.state === "running"
      ));
      if (awaitingAnswer) continue;
      msgs[messageIndex] = normalizeAssistantProcessTerminalState(message, {
        // This is an orphaned process from an earlier renderer turn. Using
        // the new turn's wall-clock start can turn a lost terminal event into
        // hours or days of fake elapsed time; settle it at its own last known
        // activity instead.
        endedAt: getAssistantProcessLastActivityAt(message) ?? startedAt,
        finalState: "completed",
        expanded: false,
      });
    }
    const assistantMessage: ChatMessage = {
      id: createMessageId(),
      role: "assistant",
      content: "",
      timestamp: startedAt,
      isStreaming: true,
      process: { startedAt, expanded: true, entries: [] },
      modelLabel: turnModel?.modelLabel,
      thinkingLevel: turnModel?.thinkingLevel,
    };
    // A provider may resume the same turn after compacting its context. Keep
    // that continuation before the trailing divider so the divider remains
    // after all body output instead of splitting the response in two.
    if (last?.systemType === "context_compaction") {
      msgs.splice(msgs.length - 1, 0, assistantMessage);
      index = msgs.length - 2;
    } else {
      msgs.push(assistantMessage);
      index = msgs.length - 1;
    }
  } else if (index >= 0) {
    const msg = msgs[index];
    msgs[index] = {
      ...msg,
      isStreaming: true,
      process: msg.process || { startedAt, expanded: true, entries: [] },
    };
  }

  return { msgs, index };
};

// 回合创建时快照当前会话的调用模型与思考档位，后续同一回合的追加事件复用首次记录。
const getTurnModelSnapshot = (state: ChatState) => ({
  modelLabel: state.currentModel?.name || state.currentModel?.id,
  thinkingLevel: state.thinkingLevel,
});

const updateSessionMessages = (
  state: ChatState,
  sessionId: string | null | undefined,
  updater: (messages: ChatMessage[]) => ChatMessage[]
) => {
  const targetSessionId = sessionId || state.activeSessionId;
  if (!targetSessionId) {
    return { messages: updater(state.messages) };
  }

  const sourceMessages =
    targetSessionId === state.activeSessionId
      ? state.messages
      : state.sessionMessages[targetSessionId] || [];
  const nextMessages = updater(sourceMessages);
  const nextSessionMessages = {
    ...state.sessionMessages,
    [targetSessionId]: nextMessages,
  };

  return targetSessionId === state.activeSessionId
    ? { messages: nextMessages, sessionMessages: nextSessionMessages }
    : { sessionMessages: nextSessionMessages };
};

const findAssistantProcessEntryIndex = (messages: ChatMessage[], entryId: string) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant" && messages[index].process?.entries.some((entry) => entry.id === entryId)) {
      return index;
    }
  }
  return -1;
};

const isPlaceholderSubagentLabel = (label: string, id: string) => {
  const normalized = label.trim();
  return !normalized ||
    normalized === "Subagent" ||
    normalized === "Sub-agent" ||
    normalized === id ||
    normalized.toLowerCase() === `agent ${id.slice(0, 8)}`.toLowerCase();
};

const mergeProcessEntrySubagents = (
  existing: AgentSubagent[] | undefined,
  incoming: AgentSubagent[] | undefined,
) => {
  if (incoming === undefined) return existing;
  const merged = new Map((existing || []).map((subagent) => [subagent.id, subagent] as const));
  for (const subagent of incoming) {
    const previous = merged.get(subagent.id);
    if (!previous) {
      merged.set(subagent.id, subagent);
      continue;
    }
    merged.set(subagent.id, {
      ...previous,
      ...subagent,
      label: isPlaceholderSubagentLabel(subagent.label, subagent.id) && !isPlaceholderSubagentLabel(previous.label, previous.id)
        ? previous.label
        : subagent.label,
      path: subagent.path || previous.path,
      model: subagent.model || previous.model,
      prompt: subagent.prompt || previous.prompt,
    });
  }
  return Array.from(merged.values());
};

const enrichProcessSubagentIdentities = (entries: AgentProcessEntry[]) => {
  const identities = new Map<string, Pick<AgentSubagent, "id" | "label" | "path" | "model" | "prompt">>();
  for (const entry of entries) {
    for (const subagent of entry.subagents || []) {
      const existing = identities.get(subagent.id);
      if (!existing) {
        identities.set(subagent.id, {
          id: subagent.id,
          label: subagent.label,
          path: subagent.path,
          model: subagent.model,
          prompt: subagent.prompt,
        });
        continue;
      }
      identities.set(subagent.id, {
        id: subagent.id,
        label: !isPlaceholderSubagentLabel(subagent.label, subagent.id) || isPlaceholderSubagentLabel(existing.label, existing.id)
          ? subagent.label
          : existing.label,
        path: subagent.path || existing.path,
        model: subagent.model || existing.model,
        prompt: subagent.prompt || existing.prompt,
      });
    }
  }

  return entries.map((entry) => {
    if (!entry.subagents?.length) return entry;
    let changed = false;
    const subagents = entry.subagents.map((subagent) => {
      const identity = identities.get(subagent.id);
      if (!identity) return subagent;
      const label = !isPlaceholderSubagentLabel(identity.label, identity.id)
        ? identity.label
        : subagent.label;
      const path = subagent.path || identity.path;
      const model = subagent.model || identity.model;
      const prompt = subagent.prompt || identity.prompt;
      if (label === subagent.label && path === subagent.path && model === subagent.model && prompt === subagent.prompt) return subagent;
      changed = true;
      return { ...subagent, label, path, model, prompt };
    });
    return changed ? { ...entry, subagents } : entry;
  });
};

const isFiniteTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

export const getAssistantProcessLastActivityAt = (message: ChatMessage): number | undefined => {
  const candidates: unknown[] = [
    message.timestamp,
    message.process?.startedAt,
    message.process?.endedAt,
    ...(message.commentary || []).map((item) => item.timestamp),
    ...(message.process?.entries || []).flatMap((entry) => [
      entry.timestamp,
      entry.startedAt,
      entry.completedAt,
    ]),
  ];
  let latest: number | undefined;
  for (const candidate of candidates) {
    if (!isFiniteTimestamp(candidate)) continue;
    latest = latest === undefined ? candidate : Math.max(latest, candidate);
  }
  return latest;
};

export const hasOpenAssistantProcessState = (message: ChatMessage) => {
  if (message.role !== "assistant") return false;
  if (message.isStreaming || message.commentary?.some((item) => item.isStreaming)) return true;
  const process = message.process;
  if (!process) return false;
  return !isFiniteTimestamp(process.endedAt)
    || process.entries.some((entry) => (
      entry.state === "running"
      || entry.phase === "started"
      || entry.subagents?.some((subagent) => subagent.status === "pending" || subagent.status === "running")
    ))
    || process.planSteps?.some((step) => step.status === "pending" || step.status === "running")
    || false;
};

interface NormalizeAssistantProcessOptions {
  endedAt?: number;
  finalState?: AgentProcessFinalState;
  expanded?: boolean;
}

/**
 * Collapses a process banner together with every thinking entry inside it, so
 * the thinking trail folds away with the execution steps instead of remaining
 * expanded in the collapsed view.
 */
const collapseProcessWithThinking = (process: AgentProcess): AgentProcess => ({
  ...process,
  expanded: false,
  entries: process.entries.map((entry) =>
    entry.type === "thinking" ? { ...entry, expanded: false } : entry
  ),
});

/**
 * Makes every nested lifecycle marker agree with an assistant message's
 * terminal state. Callers provide the event time so persistence and forks do
 * not accidentally use the current wall-clock time for an old process.
 */
export const normalizeAssistantProcessTerminalState = (
  message: ChatMessage,
  options: NormalizeAssistantProcessOptions = {},
): ChatMessage => {
  const finalState = options.finalState || "completed";
  const terminalStepState: AgentProcessStepStatus = finalState === "completed" ? "completed" : "cancelled";
  const commentary = message.commentary?.map((item) => (
    item.isStreaming ? { ...item, isStreaming: false } : item
  ));
  const process = message.process;
  if (!process) {
    return {
      ...message,
      isStreaming: false,
      commentary,
    };
  }

  const terminalAt = isFiniteTimestamp(process.endedAt)
    ? process.endedAt
    : isFiniteTimestamp(options.endedAt)
      ? options.endedAt
      : getAssistantProcessLastActivityAt(message) ?? Date.now();
  const endedAt = isFiniteTimestamp(process.startedAt)
    ? Math.max(process.startedAt, terminalAt)
    : terminalAt;
  return {
    ...message,
    isStreaming: false,
    commentary,
    process: {
      ...process,
      endedAt,
      ...(options.expanded === undefined ? {} : { expanded: options.expanded }),
      entries: process.entries.map((entry) => {
        const hadStartedPhase = entry.phase === "started";
        const wasRunning = entry.state === "running" || hadStartedPhase;
        return {
          ...entry,
          ...(wasRunning
            ? {
                state: entry.state === "running" || entry.state === undefined
                  ? finalState
                  : entry.state,
                phase: hadStartedPhase ? "completed" as const : entry.phase,
                completedAt: isFiniteTimestamp(entry.completedAt) ? entry.completedAt : endedAt,
                expanded: entry.type === "thinking" ? entry.expanded : false,
              }
            : {}),
          subagents: entry.subagents?.map((subagent) => (
            subagent.status === "pending" || subagent.status === "running"
              ? { ...subagent, status: finalState }
              : subagent
          )),
        };
      }),
      planSteps: process.planSteps?.map((step) => (
        step.status === "pending" || step.status === "running"
          ? { ...step, status: terminalStepState }
          : step
      )),
    },
  };
};

const finishAssistantProcessMessage = (
  message: ChatMessage,
  endedAt: number | undefined,
  finalState: AgentProcessFinalState,
): ChatMessage => normalizeAssistantProcessTerminalState(message, {
  endedAt: isFiniteTimestamp(endedAt) ? endedAt : Date.now(),
  finalState,
});

const setNativeTurnIdForMessages = (
  messages: ChatMessage[],
  clientMessageId: string,
  nativeTurnId: string
) => {
  const normalizedClientMessageId = clientMessageId.trim();
  const normalizedNativeTurnId = nativeTurnId.trim();
  if (!normalizedClientMessageId || !normalizedNativeTurnId) return messages;

  const userIndex = messages.findIndex((message) => message.id === normalizedClientMessageId);
  if (userIndex < 0) return messages;

  let changed = false;
  const nextMessages = [...messages];
  const assign = (index: number) => {
    const message = nextMessages[index];
    if (!message || message.nativeTurnId === normalizedNativeTurnId) return;
    nextMessages[index] = { ...message, nativeTurnId: normalizedNativeTurnId };
    changed = true;
  };

  assign(userIndex);
  for (let index = userIndex + 1; index < nextMessages.length; index += 1) {
    const message = nextMessages[index];
    if (message.role === "user") break;
    if (message.role === "assistant") {
      assign(index);
      break;
    }
  }

  return changed ? nextMessages : messages;
};

export const createEmptyChatDraft = (): ChatDraft => ({
  text: "",
  pendingImages: [],
  pendingFiles: [],
  pendingPathAttachments: [],
  sessionReferences: [],
  action: undefined,
});

export const cloneChatDraft = (draft: ChatDraft): ChatDraft => ({
  text: draft.text,
  document: draft.document ? cloneComposerDocument(draft.document) : createComposerDocument(
    draft.text ? [{ id: "legacy-text", type: "text", text: draft.text }] : [],
  ),
  pendingImages: draft.pendingImages.map((image) => ({ ...image })),
  pendingFiles: draft.pendingFiles.map((file) => ({ ...file })),
  pendingPathAttachments: draft.pendingPathAttachments.map((attachment) => ({ ...attachment })),
  sessionReferences: draft.sessionReferences.map((reference) => ({ ...reference })),
  action: draft.action ? { ...draft.action } : undefined,
});

export const EMPTY_CHAT_DRAFT = createEmptyChatDraft();

export const isAgentStartupFailureMessage = (message: ChatMessage) => {
  return message.role === "system" && message.systemType === "agent_startup_error";
};

const updateSessionDraft = (
  state: ChatState,
  sessionId: string | null | undefined,
  updater: (draft: ChatDraft) => ChatDraft
) => {
  const targetSessionId = sessionId || state.activeSessionId;
  if (!targetSessionId) return {};
  const currentDraft = state.sessionDrafts[targetSessionId] || createEmptyChatDraft();
  const nextDraft = updater(currentDraft);
  return {
    sessionDrafts: {
      ...state.sessionDrafts,
      [targetSessionId]: nextDraft,
    },
  };
};

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  sessionMessages: {},
  activeSessionId: null,
  isStreaming: false,
  currentModel: null,
  thinkingLevel: "medium",
  availableModels: [],
  favoriteModels: [],
  activeAgentId: "",
  sessionDrafts: {},
  messageQueues: {},
  compactingSessions: {},

  addMessage: (msg, sessionId) =>
    set((s) => updateSessionMessages(s, sessionId, (messages) => [...messages, msg])),

  updateLastAssistant: (content, sessionId) =>
    set((s) => {
      return updateSessionMessages(s, sessionId, (messages) => {
      const msgs = [...messages];
      const index = findLastAssistantIndex(msgs);
      if (index >= 0) {
        msgs[index] = { ...msgs[index], content };
      }
      return msgs;
      });
    }),

  appendLastAssistantContent: (content, sessionId) =>
    set((s) => updateSessionMessages(s, sessionId, (messages) => {
      const normalizedContent = content.trim();
      if (!normalizedContent) return messages;
      const { msgs, index } = ensureAssistantProcess(messages, Date.now(), getTurnModelSnapshot(s));
      const message = msgs[index];
      const existingContent = message.content.trimEnd();
      msgs[index] = {
        ...message,
        content: existingContent
          ? `${existingContent}\n\n${normalizedContent}`
          : normalizedContent,
        isStreaming: true,
      };
      return msgs;
    })),

  setNativeTurnIdForTurn: (clientMessageId, nativeTurnId, sessionId) =>
    set((s) => updateSessionMessages(s, sessionId, (messages) =>
      setNativeTurnIdForMessages(messages, clientMessageId, nativeTurnId)
    )),

  appendLastAssistantDiffs: (diffs, sessionId) =>
    set((s) => {
      return updateSessionMessages(s, sessionId, (messages) => {
      const msgs = [...messages];
      const index = findLastAssistantIndex(msgs);
      if (index >= 0) {
        const msg = msgs[index];
        const existing = msg.diffs || [];
        // 每条 diff_update 携带的是该文件「本轮起点 → 当前磁盘」的累计快照。
        // 纯追加会让同一文件堆出多份过期补丁：diff 卡片把一次改动重复计数，
        // 审核撤销则拿到一组互相对不上的补丁，逐份探测后整体拒绝。
        // 同一文件只保留最新一份（后到的覆盖先到的），不同文件保持顺序。
        const byFile = new Map<string, FileDiff>();
        for (const diff of existing) {
          byFile.set(diff.file.replace(/\\/g, "/"), diff);
        }
        for (const diff of diffs) {
          byFile.set(diff.file.replace(/\\/g, "/"), diff);
        }
        msgs[index] = { ...msg, diffs: [...byFile.values()] };
      }
      return msgs;
      });
    }),

  appendContextCompactionDivider: (eventId, sessionId, compactionState = "completed") =>
    set((s) => {
      return updateSessionMessages(s, sessionId, (messages) => {
        const normalizedEventId = eventId?.trim();
        const content = compactionState === "running"
          ? "上下文压缩中"
          : compactionState === "interrupted"
            ? "上下文压缩已中断"
            : "上下文已自动压缩";
        if (normalizedEventId) {
          const existingIndex = messages.findIndex((msg) =>
            msg.systemType === "context_compaction" && msg.eventId === normalizedEventId
          );
          if (existingIndex >= 0) {
            const existing = messages[existingIndex];
            if (existing.compactionState === compactionState && existing.content === content) return messages;
            const nextMessages = [...messages];
            nextMessages[existingIndex] = { ...existing, content, compactionState };
            return nextMessages;
          }
        }

        return [
          ...messages,
          {
            id: normalizedEventId ? `context-compaction-${normalizedEventId}` : createMessageId(),
            role: "system",
            content,
            timestamp: Date.now(),
            systemType: "context_compaction",
            compactionState,
            eventId: normalizedEventId,
          },
        ];
      });
    }),

  setSessionCompacting: (sessionId, compacting) =>
    set((s) => {
      if (!sessionId || s.compactingSessions[sessionId] === compacting) return {};
      const next = { ...s.compactingSessions };
      if (compacting) next[sessionId] = true;
      else delete next[sessionId];
      return { compactingSessions: next };
    }),

  interruptSessionCompaction: (sessionId) =>
    set((s) => {
      if (!sessionId) return {};
      const messageState = updateSessionMessages(s, sessionId, (messages) => {
        let changed = false;
        const nextMessages = messages.map((message) => {
          if (message.systemType !== "context_compaction" || message.compactionState !== "running") {
            return message;
          }
          changed = true;
          return {
            ...message,
            content: "上下文压缩已中断",
            compactionState: "interrupted" as const,
          };
        });
        return changed ? nextMessages : messages;
      });
      const compactingSessions = { ...s.compactingSessions };
      delete compactingSessions[sessionId];
      return { ...messageState, compactingSessions };
    }),

  startAssistantProcess: (startedAt, sessionId) =>
    set((s) => {
      return updateSessionMessages(s, sessionId, (messages) => {
        const { msgs } = ensureAssistantProcess(messages, startedAt, getTurnModelSnapshot(s));
        return msgs;
      });
    }),

  appendLastAssistantCommentaryDelta: (itemId, delta, timestamp = Date.now(), sessionId) =>
    set((s) => updateSessionMessages(s, sessionId, (messages) => {
      if (!itemId || !delta) return messages;
      const { msgs, index } = ensureAssistantProcess(messages, timestamp, getTurnModelSnapshot(s));
      const message = msgs[index];
      const commentary = message.commentary || [];
      const itemIndex = commentary.findIndex((item) => item.id === itemId);
      const nextCommentary = [...commentary];

      if (itemIndex >= 0) {
        const item = commentary[itemIndex];
        nextCommentary[itemIndex] = {
          ...item,
          content: `${item.content}${delta}`,
          isStreaming: true,
        };
      } else {
        nextCommentary.push({ id: itemId, content: delta, timestamp, isStreaming: true });
      }

      msgs[index] = { ...message, commentary: nextCommentary };
      return msgs;
    })),

  finishLastAssistantCommentary: (itemId, content, timestamp = Date.now(), sessionId) =>
    set((s) => updateSessionMessages(s, sessionId, (messages) => {
      if (!itemId) return messages;
      const { msgs, index } = ensureAssistantProcess(messages, timestamp, getTurnModelSnapshot(s));
      const message = msgs[index];
      const commentary = message.commentary || [];
      const itemIndex = commentary.findIndex((item) => item.id === itemId);

      if (itemIndex < 0) {
        if (!content) return msgs;
        msgs[index] = {
          ...message,
          commentary: [...commentary, { id: itemId, content, timestamp, isStreaming: false }],
        };
        return msgs;
      }

      const nextCommentary = [...commentary];
      const item = commentary[itemIndex];
      nextCommentary[itemIndex] = {
        ...item,
        // Some app-server versions finish an item without repeating its full
        // text. Keep the streamed body instead of replacing it with "".
        content: content ? content : item.content,
        isStreaming: false,
      };
      msgs[index] = { ...message, commentary: nextCommentary };
      return msgs;
    })),

  appendLastAssistantProcessEntry: (entry, sessionId) =>
    set((s) => {
      return updateSessionMessages(s, sessionId, (messages) => {
      const { msgs, index } = ensureAssistantProcess(messages, entry.timestamp, getTurnModelSnapshot(s));
      const msg = msgs[index];
      const process = msg.process || { startedAt: entry.timestamp, expanded: true, entries: [] };
      const normalizedEntry: AgentProcessEntry = {
        ...entry,
        // 思考条目保留调用方传入的 expanded：未设置（undefined）时由设置
        // expandThinkingWhileRunning 决定默认展开状态（见 ProcessBlock），
        // 用户手动展开/折叠后以条目自身状态为准；非思考条目默认折叠。
        expanded: entry.type === "thinking" ? entry.expanded : false,
      };
      msgs[index] = {
        ...msg,
        process: {
          ...process,
          entries: enrichProcessSubagentIdentities([...process.entries, normalizedEntry]),
        },
      };
      return msgs;
      });
    }),

  updateLastAssistantProcessEntry: (entryId, patch, sessionId) =>
    set((s) => {
      return updateSessionMessages(s, sessionId, (messages) => {
      const msgs = [...messages];
      const index = findAssistantProcessEntryIndex(msgs, entryId);
      if (index < 0) return msgs;

      const msg = msgs[index];
      if (!msg.process) return msgs;

      const entries = msg.process.entries.map((entry) => entry.id === entryId
        ? {
            ...entry,
            ...patch,
            subagents: mergeProcessEntrySubagents(entry.subagents, patch.subagents),
          }
        : entry
      );
      msgs[index] = {
        ...msg,
        process: {
          ...msg.process,
          entries: enrichProcessSubagentIdentities(entries),
        },
      };
      return msgs;
      });
    }),

  removeLastAssistantProcessEntries: (entryIds, sessionId) =>
    set((s) => {
      if (entryIds.length === 0) return {};
      const entryIdSet = new Set(entryIds);
      return updateSessionMessages(s, sessionId, (messages) => {
      const msgs = [...messages];
      let index = -1;
      for (let messageIndex = msgs.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const message = msgs[messageIndex];
        if (message.role === "assistant" && message.process?.entries.some((entry) => entryIdSet.has(entry.id))) {
          index = messageIndex;
          break;
        }
      }
      if (index < 0) return msgs;

      const msg = msgs[index];
      if (!msg.process) return msgs;

      msgs[index] = {
        ...msg,
        process: {
          ...msg.process,
          entries: msg.process.entries.filter((entry) => !entryIdSet.has(entry.id)),
        },
      };
      return msgs;
      });
    }),

  updateLastAssistantProcessMeta: (patch, sessionId) =>
    set((s) => {
      return updateSessionMessages(s, sessionId, (messages) => {
      const msgs = [...messages];
      const index = findLastAssistantIndex(msgs);
      if (index < 0) return msgs;

      const msg = msgs[index];
      if (!msg.process) return msgs;

      msgs[index] = {
        ...msg,
        process: {
          ...msg.process,
          ...patch,
        },
      };
      return msgs;
      });
    }),

  // 后端上报的 token 用量累加到当前回合的助手消息上（同一回合多次上报时求和）。
  addAssistantTokenUsage: (inputTokens, outputTokens, cacheInputTokens, sessionId) =>
    set((s) => updateSessionMessages(s, sessionId, (messages) => {
      const input = Number(inputTokens) || 0;
      const output = Number(outputTokens) || 0;
      const cacheInput = Number(cacheInputTokens) || 0;
      if (input <= 0 && output <= 0) return messages;
      const index = findLastAssistantIndex(messages);
      if (index < 0) return messages;
      const message = messages[index];
      const previous = message.tokenUsage || { input: 0, output: 0, cacheInput: 0 };
      const msgs = [...messages];
      msgs[index] = {
        ...message,
        tokenUsage: {
          input: previous.input + input,
          output: previous.output + output,
          cacheInput: (previous.cacheInput ?? 0) + cacheInput,
        },
      };
      return msgs;
    })),

  finishLastAssistantProcess: (endedAt, finalState = "completed", sessionId) =>
    set((s) => {
      return updateSessionMessages(s, sessionId, (messages) => {
      const msgs = [...messages];
      const index = findLastAssistantIndex(msgs);
      if (index >= 0) {
        msgs[index] = finishAssistantProcessMessage(msgs[index], endedAt, finalState);
      }
      return msgs;
      });
    }),

  finishAssistantProcessContainingEntry: (entryId, endedAt, finalState = "completed", sessionId) =>
    set((s) => updateSessionMessages(s, sessionId, (messages) => {
      const msgs = [...messages];
      const index = findAssistantProcessEntryIndex(msgs, entryId);
      if (index >= 0) msgs[index] = finishAssistantProcessMessage(msgs[index], endedAt, finalState);
      return msgs;
    })),

  finishAllAssistantProcesses: (endedAt, finalState = "completed", sessionId) =>
    set((s) => {
      const terminalAt = isFiniteTimestamp(endedAt) ? endedAt : Date.now();
      return updateSessionMessages(s, sessionId, (messages) => {
        let lastUserIndex = -1;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index].role !== "user") continue;
          lastUserIndex = index;
          break;
        }
        let currentAssistantIndex = -1;
        for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
          if (messages[index].role !== "assistant") continue;
          currentAssistantIndex = index;
          break;
        }
        let changed = false;
        const nextMessages = messages.map((message, index) => {
          if (!hasOpenAssistantProcessState(message)) return message;
          changed = true;
          return normalizeAssistantProcessTerminalState(message, {
            // Only the assistant turn currently owned by the latest user
            // receives the lifecycle terminal time. Older orphaned turns may
            // be days old; extending all of them to `terminalAt` would leave
            // permanently inflated elapsed durations in history.
            endedAt: index === currentAssistantIndex
              ? terminalAt
              : getAssistantProcessLastActivityAt(message),
            finalState,
          });
        });
        return changed ? nextMessages : messages;
      });
    }),

  collapseLastAssistantProcess: (sessionId) =>
    set((s) => {
      return updateSessionMessages(s, sessionId, (messages) => {
      const msgs = [...messages];
      const index = findLastAssistantIndex(msgs);
      if (index >= 0) {
        const msg = msgs[index];
        if (msg.process) {
          msgs[index] = { ...msg, process: collapseProcessWithThinking(msg.process) };
        }
      }
      return msgs;
      });
    }),

  toggleAssistantProcess: (messageId) =>
    set((s) => ({
      messages: s.messages.map((msg) =>
        msg.id === messageId && msg.process
          ? { ...msg, process: { ...msg.process, expanded: !msg.process.expanded } }
          : msg
      ),
    })),

  toggleAssistantProcessEntry: (messageId, entryId, expanded) =>
    set((s) => ({
      messages: s.messages.map((msg) =>
        msg.id === messageId && msg.process
          ? {
              ...msg,
              process: {
                ...msg.process,
                entries: msg.process.entries.map((entry) =>
                  // 思考条目可能由设置决定显示状态（expanded 未设置时），
                  // 因此调用方会显式传入目标展开状态；未传时保持翻转语义。
                  entry.id === entryId ? { ...entry, expanded: typeof expanded === "boolean" ? expanded : !entry.expanded } : entry
                ),
              },
            }
          : msg
      ),
    })),

  setStreaming: (v) => set((s) => (
    s.isStreaming === v ? {} : { isStreaming: v }
  )),
  setCurrentModel: (m) => set((s) => (
    s.currentModel?.id === m.id &&
    s.currentModel.provider === m.provider &&
    s.currentModel.name === m.name &&
    s.currentModel.reasoning === m.reasoning &&
    s.currentModel.supportsImages === m.supportsImages &&
    s.currentModel.thinkingLevelMode === m.thinkingLevelMode &&
    JSON.stringify(s.currentModel.supportedThinkingLevels) === JSON.stringify(m.supportedThinkingLevels)
      ? {}
      : { currentModel: m }
  )),
  setThinkingLevel: (level) => set((s) => (
    s.thinkingLevel === level ? {} : { thinkingLevel: level }
  )),
  setAvailableModels: (models) => set((s) => {
    if (
      s.availableModels.length === models.length &&
      s.availableModels.every((model, index) =>
        model.id === models[index]?.id &&
        model.provider === models[index]?.provider &&
        model.name === models[index]?.name &&
        model.reasoning === models[index]?.reasoning &&
        model.supportsImages === models[index]?.supportsImages &&
        model.thinkingLevelMode === models[index]?.thinkingLevelMode &&
        JSON.stringify(model.supportedThinkingLevels) === JSON.stringify(models[index]?.supportedThinkingLevels)
      )
    ) {
      return {};
    }
    return { availableModels: models };
  }),

  toggleFavorite: (model) =>
    set((s) => {
      const exists = s.favoriteModels.some(
        (f) => f.id === model.id && f.provider === model.provider
      );
      return {
        favoriteModels: exists
          ? s.favoriteModels.filter(
              (f) => !(f.id === model.id && f.provider === model.provider)
            )
          : [...s.favoriteModels, model],
      };
    }),

  setActiveAgent: (id) => set((s) => (
    s.activeAgentId === id ? {} : { activeAgentId: id }
  )),
  clearMessages: () => set({ messages: [] }),
  clearAgentStartupErrors: (sessionId) =>
    set((s) => updateSessionMessages(s, sessionId, (messages) => messages.filter((message) => !isAgentStartupFailureMessage(message)))),
  setDraftText: (sessionId, text) =>
    set((s) => updateSessionDraft(s, sessionId, (draft) => (
      draft.text === text ? draft : { ...draft, text }
    ))),
  setDraftDocument: (sessionId, document) =>
    set((s) => updateSessionDraft(s, sessionId, (draft) => {
      const incomingDocument = cloneComposerDocument(document);
      const migratedImages: PendingImage[] = incomingDocument.nodes.flatMap((node) => {
        if (node.type !== "image") return [];
        const file = typeof File === "function"
          ? new File([], node.name, { type: node.mimeType })
          : ({ name: node.name, type: node.mimeType, size: 0 } as File);
        return [{ id: node.id, src: node.src, name: node.name, file }];
      });
      const pendingImages = [...draft.pendingImages];
      for (const image of migratedImages) {
        if (!pendingImages.some((current) => current.id === image.id)) pendingImages.push(image);
      }
      const nextDocument = createComposerDocument(incomingDocument.nodes.filter((node) => node.type !== "image"));
      const pendingFiles = nextDocument.nodes.flatMap((node) => node.type === "snippet" ? [{
        id: node.id,
        fileName: node.fileName,
        filePath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
      }] : []);
      const pendingPathAttachments = nextDocument.nodes.flatMap((node) => node.type === "path" ? [{
        id: node.id,
        name: node.name,
        path: node.path,
        kind: node.kind,
      }] : []);
      const sessionReferences = nextDocument.nodes.flatMap((node): SessionReference[] => {
        if (node.type !== "session") return [];
        const reference = node.reference;
        if (!reference.sourceAgentId || !reference.sourceUpdatedAt || !reference.addedAt || reference.summary === undefined) return [];
        return [{
          sourceSessionId: reference.sourceSessionId,
          sourceTitle: reference.sourceTitle,
          sourceAgentId: reference.sourceAgentId,
          sourceUpdatedAt: reference.sourceUpdatedAt,
          addedAt: reference.addedAt,
          summary: reference.summary,
        }];
      });
      return {
        ...draft,
        document: nextDocument,
        text: getComposerPlainText(nextDocument),
        pendingImages,
        pendingFiles,
        pendingPathAttachments,
        sessionReferences,
      };
    })),
  replaceSessionDraft: (sessionId, draft) =>
    set((s) => ({
      sessionDrafts: {
        ...s.sessionDrafts,
        [sessionId]: cloneChatDraft(draft),
      },
    })),
  setDraftAction: (sessionId, action) =>
    set((s) => updateSessionDraft(s, sessionId, (draft) => ({ ...draft, action }))),
  addPendingImage: (image, sessionId) =>
    set((s) => updateSessionDraft(s, sessionId, (draft) => ({
      ...draft,
      pendingImages: [...draft.pendingImages, image],
    }))),
  removePendingImage: (id, sessionId) =>
    set((s) => updateSessionDraft(s, sessionId, (draft) => ({
      ...draft,
      pendingImages: draft.pendingImages.filter((image) => image.id !== id),
    }))),
  clearPendingImages: (sessionId) =>
    set((s) => updateSessionDraft(s, sessionId, (draft) => (
      draft.pendingImages.length === 0 ? draft : { ...draft, pendingImages: [] }
    ))),
  addPendingFile: (file, sessionId) =>
    set((s) => updateSessionDraft(s, sessionId, (draft) => ({
      ...draft,
      pendingFiles: [...draft.pendingFiles, file],
    }))),
  removePendingFile: (id, sessionId) =>
    set((s) => updateSessionDraft(s, sessionId, (draft) => ({
      ...draft,
      pendingFiles: draft.pendingFiles.filter((file) => file.id !== id),
    }))),
  clearPendingFiles: (sessionId) =>
    set((s) => updateSessionDraft(s, sessionId, (draft) => (
      draft.pendingFiles.length === 0 ? draft : { ...draft, pendingFiles: [] }
    ))),
  addPendingPathAttachment: (attachment, sessionId) =>
    set((s) => updateSessionDraft(s, sessionId, (draft) => {
      const exists = draft.pendingPathAttachments.some(
        (item) => item.path === attachment.path && item.kind === attachment.kind
      );
      if (exists) return draft;
      return {
        ...draft,
        pendingPathAttachments: [...draft.pendingPathAttachments, attachment],
      };
    })),
  removePendingPathAttachment: (id, sessionId) =>
    set((s) => updateSessionDraft(s, sessionId, (draft) => ({
      ...draft,
      pendingPathAttachments: draft.pendingPathAttachments.filter((attachment) => attachment.id !== id),
    }))),
  clearPendingPathAttachments: (sessionId) =>
    set((s) => updateSessionDraft(s, sessionId, (draft) => (
      draft.pendingPathAttachments.length === 0 ? draft : { ...draft, pendingPathAttachments: [] }
    ))),
  upsertSessionReference: (reference, sessionId) =>
    set((s) => updateSessionDraft(s, sessionId, (draft) => {
      const nextReferences = [
        ...draft.sessionReferences.filter((item) => item.sourceSessionId !== reference.sourceSessionId),
        reference,
      ];
      return { ...draft, sessionReferences: nextReferences };
    })),
  removeSessionReference: (sourceSessionId, sessionId) =>
    set((s) => updateSessionDraft(s, sessionId, (draft) => ({
      ...draft,
      sessionReferences: draft.sessionReferences.filter((reference) => reference.sourceSessionId !== sourceSessionId),
    }))),
  clearSessionReferences: (sessionId) =>
    set((s) => updateSessionDraft(s, sessionId, (draft) => (
      draft.sessionReferences.length === 0 ? draft : { ...draft, sessionReferences: [] }
    ))),
  clearSessionDraft: (sessionId) =>
    set((s) => {
      if (!s.sessionDrafts[sessionId]) return {};
      const nextSessionDrafts = { ...s.sessionDrafts };
      delete nextSessionDrafts[sessionId];
      return { sessionDrafts: nextSessionDrafts };
    }),
  enqueueMessage: (item) =>
    set((s) => ({
      messageQueues: {
        ...s.messageQueues,
        [item.sessionId]: [...(s.messageQueues[item.sessionId] || []), item],
      },
    })),
  upsertQueuedMessage: (item) =>
    set((s) => {
      const queue = s.messageQueues[item.sessionId] || [];
      const exists = queue.some((queued) => queued.id === item.id);
      return {
        messageQueues: {
          ...s.messageQueues,
          [item.sessionId]: exists
            ? queue.map((queued) => (queued.id === item.id ? item : queued))
            : [item, ...queue],
        },
      };
    }),
  reorderQueuedMessage: (sessionId, itemId, toIndex) =>
    set((s) => {
      const queue = s.messageQueues[sessionId] || [];
      const fromIndex = queue.findIndex((item) => item.id === itemId);
      if (fromIndex < 0 || queue.length < 2) return {};
      const targetIndex = Math.max(0, Math.min(Math.trunc(toIndex), queue.length - 1));
      if (fromIndex === targetIndex) return {};
      const nextQueue = [...queue];
      const [item] = nextQueue.splice(fromIndex, 1);
      nextQueue.splice(targetIndex, 0, item);
      return { messageQueues: { ...s.messageQueues, [sessionId]: nextQueue } };
    }),
  removeQueuedMessage: (sessionId, itemId) =>
    set((s) => ({
      messageQueues: {
        ...s.messageQueues,
        [sessionId]: (s.messageQueues[sessionId] || []).filter((item) => item.id !== itemId),
      },
    })),
  markQueuedMessageSending: (sessionId, itemId) =>
    set((s) => ({
      messageQueues: {
        ...s.messageQueues,
        [sessionId]: (s.messageQueues[sessionId] || []).map((item) =>
          item.id === itemId ? { ...item, status: "sending", error: undefined } : item
        ),
      },
    })),
  markQueuedMessageFailed: (sessionId, itemId, error) =>
    set((s) => ({
      messageQueues: {
        ...s.messageQueues,
        [sessionId]: (s.messageQueues[sessionId] || []).map((item) =>
          item.id === itemId ? { ...item, status: "failed", error } : item
        ),
      },
    })),
  clearQueuedMessageError: (sessionId, itemId) =>
    set((s) => ({
      messageQueues: {
        ...s.messageQueues,
        [sessionId]: (s.messageQueues[sessionId] || []).map((item) =>
          item.id === itemId ? { ...item, status: "queued", error: undefined } : item
        ),
      },
    })),
  clearSessionQueue: (sessionId) =>
    set((s) => {
      const next = { ...s.messageQueues };
      delete next[sessionId];
      return { messageQueues: next };
    }),
  deleteSessionMessages: (sessionId) =>
    set((s) => {
      const nextSessionMessages = { ...s.sessionMessages };
      delete nextSessionMessages[sessionId];
      const nextMessageQueues = { ...s.messageQueues };
      delete nextMessageQueues[sessionId];
      const nextSessionDrafts = { ...s.sessionDrafts };
      delete nextSessionDrafts[sessionId];
      const nextCompactingSessions = { ...s.compactingSessions };
      delete nextCompactingSessions[sessionId];
      return {
        sessionMessages: nextSessionMessages,
        messageQueues: nextMessageQueues,
        sessionDrafts: nextSessionDrafts,
        compactingSessions: nextCompactingSessions,
        messages: s.activeSessionId === sessionId ? [] : s.messages,
        activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
      };
    }),
  deleteSessionsMessages: (sessionIds) =>
    set((s) => {
      if (sessionIds.length === 0) return {};
      const sessionIdSet = new Set(sessionIds);
      const nextSessionMessages = { ...s.sessionMessages };
      const nextMessageQueues = { ...s.messageQueues };
      const nextSessionDrafts = { ...s.sessionDrafts };
      const nextCompactingSessions = { ...s.compactingSessions };
      for (const sessionId of sessionIdSet) {
        delete nextSessionMessages[sessionId];
        delete nextMessageQueues[sessionId];
        delete nextSessionDrafts[sessionId];
        delete nextCompactingSessions[sessionId];
      }
      const deletingActiveSession = !!s.activeSessionId && sessionIdSet.has(s.activeSessionId);
      return {
        sessionMessages: nextSessionMessages,
        messageQueues: nextMessageQueues,
        sessionDrafts: nextSessionDrafts,
        compactingSessions: nextCompactingSessions,
        messages: deletingActiveSession ? [] : s.messages,
        activeSessionId: deletingActiveSession ? null : s.activeSessionId,
      };
    }),

  switchSession: (sessionId) => {
    const state = get();
    if (state.activeSessionId === sessionId) return;
    const nextSessionMessages = state.activeSessionId
      ? { ...state.sessionMessages, [state.activeSessionId]: state.messages }
      : state.sessionMessages;
    if (sessionId) {
      const sessionMsgs = nextSessionMessages[sessionId] || [];
      set({
        messages: sessionMsgs,
        sessionMessages: nextSessionMessages,
        activeSessionId: sessionId,
        // 模型目录和当前模型属于会话运行时状态，不能跨会话沿用。
        // 新会话的模型配置由 useSessionModels 在切换后重新发现。
        currentModel: null,
        availableModels: [],
        thinkingLevel: "medium",
      });
    } else {
      set({
        messages: [],
        sessionMessages: nextSessionMessages,
        activeSessionId: null,
        currentModel: null,
        availableModels: [],
        thinkingLevel: "medium",
      });
    }
  },

  loadSessionMessages: (sessionId, messages) => {
    set((s) => ({
      sessionMessages: { ...s.sessionMessages, [sessionId]: messages },
      messages: s.activeSessionId === sessionId ? messages : s.messages,
    }));
  },
}));
