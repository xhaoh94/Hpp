import { create } from "zustand";

export interface FileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
}

export interface AgentProcessEntry {
  id: string;
  type: "status" | "tool" | "diff" | "error" | "info" | "thinking";
  title: string;
  detail?: string;
  timestamp: number;
  state?: "running" | "completed" | "error";
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
  isStreaming: boolean;
  currentModel: ModelInfo | null;
  thinkingLevel: string;
  availableModels: ModelInfo[];
  favoriteModels: ModelInfo[];
  activeAgentId: string;
  highlightedFile: string | null;
  pendingFiles: PendingFile[];

  addMessage: (msg: ChatMessage) => void;
  updateLastAssistant: (content: string) => void;
  appendLastAssistantDiffs: (diffs: FileDiff[]) => void;
  startAssistantProcess: (startedAt?: number) => void;
  appendLastAssistantProcessEntry: (entry: AgentProcessEntry) => void;
  updateLastAssistantProcessEntry: (entryId: string, patch: Partial<Omit<AgentProcessEntry, "id">>) => void;
  finishLastAssistantProcess: (endedAt?: number) => void;
  collapseLastAssistantProcess: () => void;
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

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  sessionMessages: {},
  isStreaming: false,
  currentModel: null,
  thinkingLevel: "medium",
  availableModels: [],
  favoriteModels: [],
  activeAgentId: "pi",
  highlightedFile: null,
  pendingFiles: [],

  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),

  updateLastAssistant: (content) =>
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        msgs[msgs.length - 1] = { ...last, content };
      }
      return { messages: msgs };
    }),

  appendLastAssistantDiffs: (diffs) =>
    set((s) => {
      const msgs = [...s.messages];
      const index = findLastAssistantIndex(msgs);
      if (index >= 0) {
        const msg = msgs[index];
        const existing = msg.diffs || [];
        msgs[index] = { ...msg, diffs: [...existing, ...diffs] };
      }
      return { messages: msgs };
    }),

  startAssistantProcess: (startedAt) =>
    set((s) => {
      const { msgs } = ensureAssistantProcess(s.messages, startedAt);
      return { messages: msgs };
    }),

  appendLastAssistantProcessEntry: (entry) =>
    set((s) => {
      const { msgs, index } = ensureAssistantProcess(s.messages, entry.timestamp);
      const msg = msgs[index];
      const process = msg.process || { startedAt: entry.timestamp, expanded: true, entries: [] };
      const normalizedEntry: AgentProcessEntry = {
        ...entry,
        expanded: entry.expanded ?? (entry.type === "thinking" || entry.state === "running"),
      };
      msgs[index] = {
        ...msg,
        process: {
          ...process,
          entries: [...process.entries, normalizedEntry],
        },
      };
      return { messages: msgs };
    }),

  updateLastAssistantProcessEntry: (entryId, patch) =>
    set((s) => {
      const msgs = [...s.messages];
      const index = findLastAssistantIndex(msgs);
      if (index < 0) return { messages: msgs };

      const msg = msgs[index];
      if (!msg.process) return { messages: msgs };

      msgs[index] = {
        ...msg,
        process: {
          ...msg.process,
          entries: msg.process.entries.map((entry) =>
            entry.id === entryId ? { ...entry, ...patch } : entry
          ),
        },
      };
      return { messages: msgs };
    }),

  finishLastAssistantProcess: (endedAt) =>
    set((s) => {
      const msgs = [...s.messages];
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
                        state: "completed",
                        expanded: entry.type === "thinking" ? entry.expanded : false,
                      }
                    : entry
                ),
              }
            : msg.process,
        };
      }
      return { messages: msgs };
    }),

  collapseLastAssistantProcess: () =>
    set((s) => {
      const msgs = [...s.messages];
      const index = findLastAssistantIndex(msgs);
      if (index >= 0) {
        const msg = msgs[index];
        if (msg.process) {
          msgs[index] = { ...msg, process: { ...msg.process, expanded: false } };
        }
      }
      return { messages: msgs };
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
    // Save current messages to sessionMessages if there's an active session
    // We need to know the previous session ID - use a module-level variable
    if (sessionId) {
      // Load messages for the new session
      const sessionMsgs = state.sessionMessages[sessionId] || [];
      set({ messages: sessionMsgs, pendingFiles: [] });
    } else {
      set({ messages: [], pendingFiles: [] });
    }
  },

  loadSessionMessages: (sessionId, messages) => {
    set((s) => ({
      sessionMessages: { ...s.sessionMessages, [sessionId]: messages },
    }));
  },
}));
