import { create } from "zustand";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  thinkingContent?: string;
  images?: Array<{ id: string; src: string; name: string }>;
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
  updateLastAssistantThinking: (thinkingContent: string) => void;
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

  updateLastAssistantThinking: (thinkingContent) =>
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        msgs[msgs.length - 1] = { ...last, thinkingContent };
      }
      return { messages: msgs };
    }),

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
