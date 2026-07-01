import { create } from "zustand";

export interface FileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
}

export interface AgentProcessFile {
  file: string;
  label?: string;
  action?: "read" | "listed" | "edited" | "modified" | "written";
  additions?: number;
  deletions?: number;
  status?: "added" | "deleted" | "modified";
}

export interface AgentProcessEntry {
  id: string;
  type: "status" | "tool" | "diff" | "error" | "info" | "thinking" | "question";
  title: string;
  detail?: string;
  files?: AgentProcessFile[];
  toolKind?: string;
  command?: string;
  timestamp: number;
  state?: "running" | "completed" | "error" | "interrupted";
  expanded?: boolean;
}

export interface AgentProcess {
  startedAt: number;
  endedAt?: number;
  expanded?: boolean;
  entries: AgentProcessEntry[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  images?: Array<{ id: string; src: string; name: string }>;
  diffs?: FileDiff[];
  process?: AgentProcess;
}

export interface PendingFile {
  id: string;
  fileName: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
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
  highlightedFile: string | null;
  pendingFiles: PendingFile[];

  addMessage: (msg: ChatMessage, sessionId?: string | null) => void;
  updateLastAssistant: (content: string, sessionId?: string | null) => void;
  appendLastAssistantDiffs: (diffs: FileDiff[], sessionId?: string | null) => void;
  startAssistantProcess: (startedAt?: number, sessionId?: string | null) => void;
  appendLastAssistantProcessEntry: (entry: AgentProcessEntry, sessionId?: string | null) => void;
  updateLastAssistantProcessEntry: (entryId: string, patch: Partial<Omit<AgentProcessEntry, "id">>, sessionId?: string | null) => void;
  finishLastAssistantProcess: (endedAt?: number, finalState?: "completed" | "interrupted", sessionId?: string | null) => void;
  collapseLastAssistantProcess: (sessionId?: string | null) => void;
  toggleAssistantProcess: (messageId: string) => void;
  toggleAssistantProcessEntry: (messageId: string, entryId: string) => void;
  setStreaming: (v: boolean) => void;
  setCurrentModel: (m: ModelInfo) => void;
  setThinkingLevel: (level: string) => void;
  setAvailableModels: (models: ModelInfo[]) => void;
  toggleFavorite: (model: ModelInfo) => void;
  setActiveAgent: (id: string) => void;
  clearMessages: () => void;
  setHighlightedFile: (path: string | null) => void;
  addPendingFile: (file: PendingFile) => void;
  removePendingFile: (id: string) => void;
  clearPendingFiles: () => void;
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

const ensureAssistantProcess = (messages: ChatMessage[], startedAt = Date.now()) => {
  const msgs = [...messages];
  let index = findLastAssistantIndex(msgs);
  const last = msgs[msgs.length - 1];

  if (!last || last.role !== "assistant" || !last.isStreaming) {
    msgs.push({
      id: createMessageId(),
      role: "assistant",
      content: "",
      timestamp: startedAt,
      isStreaming: true,
      process: { startedAt, expanded: true, entries: [] },
    });
    index = msgs.length - 1;
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

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  sessionMessages: {},
  activeSessionId: null,
  isStreaming: false,
  currentModel: null,
  thinkingLevel: "medium",
  availableModels: [],
  favoriteModels: [],
  activeAgentId: "codex",
  highlightedFile: null,
  pendingFiles: [],

  addMessage: (msg, sessionId) =>
    set((s) => updateSessionMessages(s, sessionId, (messages) => [...messages, msg])),

  updateLastAssistant: (content, sessionId) =>
    set((s) => {
      return updateSessionMessages(s, sessionId, (messages) => {
      const msgs = [...messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        msgs[msgs.length - 1] = { ...last, content };
      }
      return msgs;
      });
    }),

  appendLastAssistantDiffs: (diffs, sessionId) =>
    set((s) => {
      return updateSessionMessages(s, sessionId, (messages) => {
      const msgs = [...messages];
      const index = findLastAssistantIndex(msgs);
      if (index >= 0) {
        const msg = msgs[index];
        const existing = msg.diffs || [];
        msgs[index] = { ...msg, diffs: [...existing, ...diffs] };
      }
      return msgs;
      });
    }),

  startAssistantProcess: (startedAt, sessionId) =>
    set((s) => {
      return updateSessionMessages(s, sessionId, (messages) => {
        const { msgs } = ensureAssistantProcess(messages, startedAt);
        return msgs;
      });
    }),

  appendLastAssistantProcessEntry: (entry, sessionId) =>
    set((s) => {
      return updateSessionMessages(s, sessionId, (messages) => {
      const { msgs, index } = ensureAssistantProcess(messages, entry.timestamp);
      const msg = msgs[index];
      const process = msg.process || { startedAt: entry.timestamp, expanded: true, entries: [] };
      const normalizedEntry: AgentProcessEntry = {
        ...entry,
        expanded: entry.expanded ?? (entry.type === "thinking" ? false : entry.state === "running"),
      };
      msgs[index] = {
        ...msg,
        process: {
          ...process,
          entries: [...process.entries, normalizedEntry],
        },
      };
      return msgs;
      });
    }),

  updateLastAssistantProcessEntry: (entryId, patch, sessionId) =>
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
          entries: msg.process.entries.map((entry) =>
            entry.id === entryId ? { ...entry, ...patch } : entry
          ),
        },
      };
      return msgs;
      });
    }),

  finishLastAssistantProcess: (endedAt, finalState = "completed", sessionId) =>
    set((s) => {
      return updateSessionMessages(s, sessionId, (messages) => {
      const msgs = [...messages];
      const index = findLastAssistantIndex(msgs);
      if (index >= 0) {
        const msg = msgs[index];
        msgs[index] = {
          ...msg,
          isStreaming: false,
          process: msg.process
            ? {
                ...msg.process,
                endedAt: msg.process.endedAt || endedAt || Date.now(),
                entries: msg.process.entries.map((entry) =>
                  entry.state === "running"
                    ? {
                        ...entry,
                        state: finalState,
                        expanded: entry.type === "thinking" ? entry.expanded : false,
                      }
                    : entry
                ),
              }
            : msg.process,
        };
      }
      return msgs;
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
          msgs[index] = { ...msg, process: { ...msg.process, expanded: false } };
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

  toggleAssistantProcessEntry: (messageId, entryId) =>
    set((s) => ({
      messages: s.messages.map((msg) =>
        msg.id === messageId && msg.process
          ? {
              ...msg,
              process: {
                ...msg.process,
                entries: msg.process.entries.map((entry) =>
                  entry.id === entryId ? { ...entry, expanded: !entry.expanded } : entry
                ),
              },
            }
          : msg
      ),
    })),

  setStreaming: (v) => set({ isStreaming: v }),
  setCurrentModel: (m) => set({ currentModel: m }),
  setThinkingLevel: (level) => set({ thinkingLevel: level }),
  setAvailableModels: (models) => set({ availableModels: models }),

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

  setActiveAgent: (id) => set({ activeAgentId: id }),
  clearMessages: () => set({ messages: [] }),
  setHighlightedFile: (path) => set({ highlightedFile: path }),
  addPendingFile: (file) => set((s) => ({ pendingFiles: [...s.pendingFiles, file] })),
  removePendingFile: (id) => set((s) => ({ pendingFiles: s.pendingFiles.filter((f) => f.id !== id) })),
  clearPendingFiles: () => set({ pendingFiles: [] }),

  switchSession: (sessionId) => {
    const state = get();
    const nextSessionMessages = state.activeSessionId
      ? { ...state.sessionMessages, [state.activeSessionId]: state.messages }
      : state.sessionMessages;
    if (sessionId) {
      const sessionMsgs = nextSessionMessages[sessionId] || [];
      set({ messages: sessionMsgs, sessionMessages: nextSessionMessages, activeSessionId: sessionId, pendingFiles: [] });
    } else {
      set({ messages: [], sessionMessages: nextSessionMessages, activeSessionId: null, pendingFiles: [] });
    }
  },

  loadSessionMessages: (sessionId, messages) => {
    set((s) => ({
      sessionMessages: { ...s.sessionMessages, [sessionId]: messages },
      messages: s.activeSessionId === sessionId ? messages : s.messages,
    }));
  },
}));
