import { useEffect } from "react";
import {
  useProjectStore,
  type Project,
  type ProjectSession,
  type SessionForkContext,
  type SessionForkOrigin,
  type SessionReference,
} from "@/stores/project-store";
import {
  getAssistantProcessLastActivityAt,
  hasOpenAssistantProcessState,
  isAgentStartupFailureMessage,
  isUserSpeechMessage,
  normalizeAssistantProcessTerminalState,
  useChatStore,
  type AgentCommentary,
  type ChatMessage,
  type ModelInfo,
  type SessionContextUsage,
} from "@/stores/chat-store";
import { PersistenceFlushScheduler } from "./persistenceScheduler";
import { getChatMessagePreviewText } from "@/lib/chat-message-preview";
import { parseComposerDraftSnapshot } from "@/lib/composer-history";
import { parseComposerDocument } from "@shared/composer-document";

export interface PersistedData {
  projects: Project[];
  activeProjectId: string | null;
  activeSessionId: string | null;
}

interface PersistedMessages {
  sessionMessages: Record<string, ChatMessage[]>;
}

interface PersistedModel {
  modelVersion?: number;
  currentModel?: ModelInfo | null;
  thinkingLevel?: string;
  thinkingLevels?: Record<string, string>;
  /** sessionId -> modelKey -> thinking level */
  thinkingLevelsByModel?: Record<string, Record<string, string>>;
  models?: Record<string, ModelInfo>;
  /** sessionId -> 最近一次上下文用量；重启后仍能显示上次已知值。 */
  contextUsage?: Record<string, SessionContextUsage>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const getString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const getStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const parsePersistedCommentary = (value: unknown): AgentCommentary[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const commentary = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = getString(item.id);
    const content = getString(item.content);
    const timestamp = typeof item.timestamp === "number" && Number.isFinite(item.timestamp)
      ? item.timestamp
      : undefined;
    if (!id || content === undefined || timestamp === undefined) return [];
    return [{ id, content, timestamp, isStreaming: false }];
  });
  return commentary.length > 0 ? commentary : undefined;
};

const parseSessionReference = (value: unknown): SessionReference | null => {
  if (!isRecord(value)) return null;
  const sourceSessionId = getString(value.sourceSessionId);
  const sourceAgentId = getString(value.sourceAgentId);
  const sourceTitle = getString(value.sourceTitle);
  const sourceUpdatedAt = getString(value.sourceUpdatedAt);
  const addedAt = getString(value.addedAt);
  const summary = getString(value.summary);
  if (!sourceSessionId || !sourceAgentId || !sourceTitle || !sourceUpdatedAt || !addedAt || !summary) return null;
  return {
    sourceSessionId,
    sourceAgentId,
    sourceTitle,
    sourceUpdatedAt,
    addedAt,
    summary,
  };
};

const parseSessionForkContext = (value: unknown): SessionForkContext | undefined => {
  if (!isRecord(value)) return undefined;
  const sourceSessionId = getString(value.sourceSessionId);
  const sourceTitle = getString(value.sourceTitle);
  const throughMessageId = getString(value.throughMessageId);
  const createdAt = getString(value.createdAt);
  const context = getString(value.context);
  const messageCount = typeof value.messageCount === "number" ? value.messageCount : undefined;
  if (!sourceSessionId || !sourceTitle || !throughMessageId || !createdAt || !context || messageCount === undefined) {
    return undefined;
  }
  return {
    sourceSessionId,
    sourceTitle,
    throughMessageId,
    createdAt,
    messageCount,
    context,
  };
};

const parseSessionForkOrigin = (value: unknown): SessionForkOrigin | undefined => {
  if (!isRecord(value)) return undefined;
  const sourceSessionId = getString(value.sourceSessionId);
  const sourceTitle = getString(value.sourceTitle);
  const throughMessageId = getString(value.throughMessageId);
  const createdAt = getString(value.createdAt);
  if (!sourceSessionId || !sourceTitle || !throughMessageId || !createdAt) return undefined;
  return {
    sourceSessionId,
    sourceTitle,
    throughMessageId,
    createdAt,
  };
};

const parseProjectSession = (value: unknown): ProjectSession | null => {
  if (!isRecord(value)) return null;
  const id = getString(value.id);
  const agentId = getString(value.agentId);
  const agentSessionId = getString(value.agentSessionId);
  const title = getString(value.title);
  const createdAt = getString(value.createdAt);
  const lastActiveAt = getString(value.lastActiveAt);
  if (!id || !agentId || !agentSessionId || !title || !createdAt || !lastActiveAt) return null;

  const forkContext = parseSessionForkContext(value.forkContext);

  return {
    id,
    agentId,
    agentSessionId,
    title,
    ...(getString(value.preview) ? { preview: getString(value.preview) } : {}),
    createdAt,
    lastActiveAt,
    sessionFilePath: getString(value.sessionFilePath),
    closed: typeof value.closed === "boolean" ? value.closed : undefined,
    references: Array.isArray(value.references)
      ? value.references.map(parseSessionReference).filter((ref): ref is SessionReference => !!ref)
      : undefined,
    forkedFrom: parseSessionForkOrigin(value.forkedFrom) || (forkContext ? parseSessionForkOrigin(forkContext) : undefined),
    forkContext,
  };
};

const parseProject = (value: unknown): Project | null => {
  if (!isRecord(value)) return null;
  const id = getString(value.id);
  const name = getString(value.name);
  const path = getString(value.path);
  const createdAt = getString(value.createdAt);
  if (!id || !name || !path || !createdAt) return null;

  return {
    id,
    name,
    path,
    createdAt,
    agents: getStringArray(value.agents),
    sessions: Array.isArray(value.sessions)
      ? value.sessions.map(parseProjectSession).filter((session): session is ProjectSession => !!session)
      : [],
  };
};

const parsePersistedData = (value: unknown): PersistedData | null => {
  if (!isRecord(value) || !Array.isArray(value.projects)) return null;
  const projects = value.projects.map(parseProject).filter((project): project is Project => !!project);
  const activeProjectId = getString(value.activeProjectId) || null;
  const activeSessionId = getString(value.activeSessionId) || null;

  return {
    projects,
    activeProjectId: activeProjectId && projects.some((project) => project.id === activeProjectId)
      ? activeProjectId
      : null,
    activeSessionId: activeSessionId && projects.some((project) => project.sessions.some((session) => session.id === activeSessionId))
      ? activeSessionId
      : null,
  };
};

/**
 * 启动时没有可恢复的活动会话（例如从未选择过会话）时，默认选中第一个
 * 未关闭会话，让聊天面板和侧栏直接进入可用状态。已归档会话不参与自动选中：
 * 它们在卡片里不渲染，选中后用户看不到。
 */
export const pickDefaultActiveSessionId = (projects: Project[]): string | null => {
  for (const project of projects) {
    const session = project.sessions.find((candidate) => candidate.closed !== true);
    if (session) return session.id;
  }
  return null;
};

/** 保留磁盘上已恢复的会话；缺失时才回退到默认选中。 */
export const resolveHydratedActiveSessionId = (data: PersistedData): string | null => (
  data.activeSessionId || pickDefaultActiveSessionId(data.projects)
);

export const applyPersistedProjectSnapshot = (data: PersistedData) => {
  // 活动项目必须包含活动会话，否则 ChatPanel 找不到当前会话（标题、模型、
  // 输入框都按 activeProjectId + activeSessionId 定位）。
  const sessionProjectId = data.activeSessionId
    ? data.projects.find((project) => project.sessions.some((session) => session.id === data.activeSessionId))?.id
    : undefined;
  useProjectStore.setState({
    projects: data.projects,
    activeProjectId: sessionProjectId
      || data.activeProjectId
      || (data.projects.length > 0 ? data.projects[0].id : null),
    activeSessionId: data.activeSessionId,
    projectDataHydrated: true,
    // These describe renderer/main-process runtime ownership, not persisted
    // project data. A renderer remount must re-probe surviving backends
    // instead of inheriting stale running/initialized flags.
    agentStatuses: {},
    initializedSessionIds: new Set<string>(),
  });
};

export const parsePersistedChatMessage = (value: unknown): ChatMessage | null => {
  if (!isRecord(value)) return null;
  const id = getString(value.id);
  const role = value.role;
  const content = getString(value.content);
  const timestamp = typeof value.timestamp === "number" && Number.isFinite(value.timestamp) && value.timestamp > 0
    ? value.timestamp
    : undefined;
  if (!id || (role !== "user" && role !== "assistant" && role !== "system") || content === undefined || timestamp === undefined) {
    return null;
  }

  const persistedMessage = value as Partial<ChatMessage>;
  const composerDraft = parseComposerDraftSnapshot(value.composerDraft);
  const composerDocument = parseComposerDocument(value.composerDocument) || composerDraft?.document;
  const commentary = parsePersistedCommentary(value.commentary);
  const staleCompaction = persistedMessage.systemType === "context_compaction"
    && persistedMessage.compactionState === "running";
  const recoveredProcessState = content.trim() ? "completed" as const : "interrupted" as const;
  const parsedMessage: ChatMessage = {
    ...persistedMessage,
    id,
    role,
    content: staleCompaction ? "上下文压缩已中断" : content,
    timestamp,
    composerDraft,
    composerDocument,
    commentary,
    compactionState: staleCompaction ? "interrupted" : persistedMessage.compactionState,
    // Never restore a stale streaming state after app restart.
    isStreaming: false,
  };
  if (!hasOpenAssistantProcessState(parsedMessage)) return parsedMessage;
  return normalizeAssistantProcessTerminalState(parsedMessage, {
    endedAt: getAssistantProcessLastActivityAt(parsedMessage) ?? timestamp,
    finalState: recoveredProcessState,
    expanded: false,
  });
};

const updatePersistedSessionPreview = (sessionId: string, preview: string) => {
  if (!preview) return;
  const projects = useProjectStore.getState().projects;
  let changed = false;
  const nextProjects = projects.map((project) => ({
    ...project,
    sessions: project.sessions.map((session) => {
      if (session.id !== sessionId || session.preview === preview) return session;
      changed = true;
      return { ...session, preview };
    }),
  }));
  if (changed) useProjectStore.setState({ projects: nextProjects });
};

/**
 * Apply the persisted chat snapshot atomically. During a renderer remount the
 * Zustand store can still contain the previously active `messages` array.
 * Calling `switchSession()` after replacing `sessionMessages` would first
 * write that old array back into the freshly parsed snapshot and could revive
 * stale streaming/process state that hydration just terminalized.
 */
export const applyPersistedMessagesSnapshot = (
  sessionMessages: Record<string, ChatMessage[]>,
  activeSessionId: string | null,
) => {
  useChatStore.setState({
    sessionMessages,
    messages: activeSessionId ? sessionMessages[activeSessionId] || [] : [],
    activeSessionId,
    isStreaming: false,
    // Compaction is renderer-runtime state and is never valid after hydration.
    compactingSessions: {},
    compactionPostTurnSessions: {},
    contextUsageBySession: {},
  });
};

const stripTransientMessageList = (messages: ChatMessage[]) => (
  messages.filter((message) => !isAgentStartupFailureMessage(message))
);

type PendingSessionMessageChanges = {
  replace: boolean;
  upserts: Map<string, { message: ChatMessage; sequence: number }>;
  deletedIds: Set<string>;
};

const parseModelInfo = (value: unknown): ModelInfo | null => {
  if (!isRecord(value)) return null;
  const id = getString(value.id);
  const name = getString(value.name);
  const provider = getString(value.provider);
  if (!id || !name || !provider) return null;
  return {
    id,
    name,
    provider,
    reasoning: typeof value.reasoning === "boolean" ? value.reasoning : false,
    supportsImages: typeof value.supportsImages === "boolean" ? value.supportsImages : undefined,
    supportedThinkingLevels: Array.isArray(value.supportedThinkingLevels)
      ? value.supportedThinkingLevels.filter((level): level is string => typeof level === "string")
      : undefined,
  };
};

const parseModelRecord = (value: unknown): Record<string, ModelInfo> => {
  if (!isRecord(value)) return {};
  const result: Record<string, ModelInfo> = {};
  for (const [sessionId, model] of Object.entries(value)) {
    const parsed = parseModelInfo(model);
    if (parsed) result[sessionId] = parsed;
  }
  return result;
};

const parseStringRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
};

const parseStringRecordMap = (value: unknown): Record<string, Record<string, string>> => {
  if (!isRecord(value)) return {};
  const result: Record<string, Record<string, string>> = {};
  for (const [key, item] of Object.entries(value)) {
    const parsed = parseStringRecord(item);
    if (Object.keys(parsed).length > 0) result[key] = parsed;
  }
  return result;
};

// 旧数据把精确值记为 "provider"；读回时归一成 "exact"，其余未知来源保留 unknown。
const parseContextUsageSource = (value: unknown): SessionContextUsage["source"] => {
  if (value === "provider" || value === "exact") return "exact";
  return value === "official" || value === "estimated" ? value : "unknown";
};

const parseContextUsageRecord = (value: unknown): Record<string, SessionContextUsage> => {
  if (!isRecord(value)) return {};
  const result: Record<string, SessionContextUsage> = {};
  for (const [sessionId, item] of Object.entries(value)) {
    if (!isRecord(item)) continue;
    const contextWindow = Number(item.contextWindow);
    const usedTokens = Number(item.usedTokens);
    if (!Number.isFinite(contextWindow) && !Number.isFinite(usedTokens)) continue;
    const model = isRecord(item.model)
      && typeof item.model.provider === "string" && typeof item.model.id === "string"
      ? { provider: item.model.provider, id: item.model.id }
      : undefined;
    result[sessionId] = {
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
      ...(Number.isFinite(usedTokens) && usedTokens >= 0 ? { usedTokens } : {}),
      ...(Number.isFinite(usedTokens) && Number.isFinite(contextWindow) && contextWindow > 0
        ? { remainingTokens: Math.max(0, contextWindow - usedTokens), usageRatio: Math.min(1, usedTokens / contextWindow) }
        : {}),
      source: parseContextUsageSource(item.source),
      ...(model ? { model } : {}),
      updatedAt: Number(item.updatedAt) || Date.now(),
    };
  }
  return result;
};

const parsePersistedModel = (value: unknown): PersistedModel | null => {
  if (!isRecord(value)) return null;
  return {
    modelVersion: typeof value.modelVersion === "number" ? value.modelVersion : undefined,
    currentModel: parseModelInfo(value.currentModel),
    thinkingLevel: getString(value.thinkingLevel),
    thinkingLevels: parseStringRecord(value.thinkingLevels),
    thinkingLevelsByModel: parseStringRecordMap(value.thinkingLevelsByModel),
    models: parseModelRecord(value.models),
    contextUsage: parseContextUsageRecord(value.contextUsage),
  };
};

// In-memory cache for per-session models and thinking levels, synced to disk.
let _sessionModelsCache: Record<string, ModelInfo> = {};
let _sessionThinkingCache: Record<string, string> = {};
let _sessionModelThinkingCache: Record<string, Record<string, string>> = {};
// 重启后事件流不会重放，因此把最近一次上下文用量随模型数据一起落盘。
let _sessionContextUsageCache: Record<string, SessionContextUsage> = {};
export const SESSION_CONFIG_UPDATED_EVENT = "session-config-updated";
export const SESSION_DATA_PURGED_EVENT = "session-data-purged";
export const DISK_USAGE_INVALIDATED_EVENT = "disk-usage-invalidated";

const notifySessionConfigUpdated = (sessionId: string) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SESSION_CONFIG_UPDATED_EVENT, { detail: { sessionId } }));
};
let _cacheDirty = false;
let _pendingProjectsData: PersistedData | null = null;
let _pendingMessagesData: PersistedMessages | null = null;
let _messagesSnapshotNeedsFullRebuild = true;
const SESSION_MESSAGE_PAGE_SIZE = 500;
type SessionMessagePageState = {
  /** 只要当前会话首次加载完成，即使结果为空也不能重复请求。 */
  loaded: boolean;
  loadFailed: boolean;
  hasMore: boolean;
  beforeSequence: number | null;
  /** 当前内存页在 SQLite 完整消息序列中的绝对起点。 */
  sequenceOffset: number;
  loadedMessages: ChatMessage[];
  loading: Promise<boolean> | null;
};
const sessionMessagePages = new Map<string, SessionMessagePageState>();
const _pendingMessageChanges = new Map<string, PendingSessionMessageChanges>();
const saveScheduler = new PersistenceFlushScheduler();

const getCurrentPersistedMessages = (): PersistedMessages => ({
  // Keep the live record by reference. Transient filtering is intentionally
  // deferred until the debounce actually fires, so a stream update does not
  // walk every historical session before the save timer has elapsed.
  sessionMessages: useChatStore.getState().sessionMessages,
});

const parsePersistedMessageList = (value: unknown): ChatMessage[] => (
  Array.isArray(value)
    ? value
      .map(parsePersistedChatMessage)
      .filter((message): message is ChatMessage => !!message && !isAgentStartupFailureMessage(message))
    : []
);

const createEmptySessionMessagePage = (): SessionMessagePageState => ({
  loaded: false,
  loadFailed: false,
  hasMore: false,
  beforeSequence: null,
  sequenceOffset: 0,
  loadedMessages: [],
  loading: null,
});

const mergeSessionMessageLists = (loadedMessages: ChatMessage[], currentMessages: ChatMessage[]) => {
  if (currentMessages.length === 0 || loadedMessages === currentMessages) return loadedMessages;
  const currentById = new Map(currentMessages.map((message) => [message.id, message]));
  const loadedIds = new Set(loadedMessages.map((message) => message.id));
  const merged = [
    ...loadedMessages.map((message) => currentById.get(message.id) || message),
    ...currentMessages.filter((message) => !loadedIds.has(message.id)),
  ];
  return merged.length === currentMessages.length
    && merged.every((message, index) => message === currentMessages[index])
    ? currentMessages
    : merged;
};

/**
 * 读取某个会话的首屏页，但不直接改 Chat Store。启动恢复需要先完成
 * 项目快照校验，再原子替换聊天状态；普通切换则通过 ensure... 写入 Store。
 */
const requestInitialSessionMessagePage = (sessionId: string): Promise<boolean> => {
  const existing = sessionMessagePages.get(sessionId);
  if (existing?.loaded) return Promise.resolve(true);
  if (existing?.loading) return existing.loading;

  const loadPage = window.electronAPI?.loadSessionMessagesPage;
  if (typeof loadPage !== "function") return Promise.resolve(false);

  const request = loadPage(
    sessionId,
    undefined,
    SESSION_MESSAGE_PAGE_SIZE,
  ).then(
    (result) => ({ result, failed: false }),
    () => ({
      result: { messages: [], hasMore: false, nextBefore: null, firstSequence: 0 },
      failed: true,
    }),
  ).then(({ result, failed }) => {
      const page = sessionMessagePages.get(sessionId) || createEmptySessionMessagePage();
      page.loaded = true;
      page.loadFailed = failed;
      page.hasMore = result.hasMore === true;
      page.beforeSequence = typeof result.nextBefore === "number" ? result.nextBefore : null;
      page.sequenceOffset = Number.isSafeInteger(result.firstSequence) ? result.firstSequence : 0;
      page.loadedMessages = parsePersistedMessageList(result.messages);
      page.loading = null;
      sessionMessagePages.set(sessionId, page);
      return true;
    });
  sessionMessagePages.set(sessionId, {
    ...(existing || createEmptySessionMessagePage()),
    loading: request,
  });
  return request;
};

/** 非阻塞地恢复侧栏预览，不把摘要混入聊天正文的分页缓存。 */
const loadSessionMessageSummaries = (sessionIds: string[]) => {
  const loadSummaries = window.electronAPI?.loadSessionMessageSummaries;
  if (typeof loadSummaries !== "function" || sessionIds.length === 0) return;
  void loadSummaries(sessionIds).then((summaries) => {
    for (const [sessionId, value] of Object.entries(summaries || {})) {
      const message = parsePersistedChatMessage(value);
      if (message && isUserSpeechMessage(message)) {
        updatePersistedSessionPreview(sessionId, getChatMessagePreviewText(message));
      }
    }
  }).catch(() => undefined);
};

/** 确保指定会话已经从 SQLite 恢复最近一页；未访问的会话不会在启动时触发此函数。 */
export async function ensureSessionMessagesLoaded(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  await requestInitialSessionMessagePage(sessionId);
  const page = sessionMessagePages.get(sessionId);
  if (!page) return false;

  const state = useChatStore.getState();
  const currentMessages = state.sessionMessages[sessionId]
    || (state.activeSessionId === sessionId ? state.messages : []);
  const mergedMessages = mergeSessionMessageLists(page.loadedMessages, currentMessages);
  page.loadedMessages = mergedMessages;
  useChatStore.getState().loadSessionMessages(sessionId, mergedMessages);
  return page.loaded && !page.loadFailed;
}

export function hasOlderSessionMessages(sessionId: string): boolean {
  return sessionMessagePages.get(sessionId)?.loaded === true
    && sessionMessagePages.get(sessionId)?.hasMore === true;
}

export async function loadOlderSessionMessages(sessionId: string): Promise<boolean> {
  let page = sessionMessagePages.get(sessionId);
  if (!page?.loaded) {
    await ensureSessionMessagesLoaded(sessionId);
    page = sessionMessagePages.get(sessionId);
  }
  if (!page?.hasMore) return false;
  if (page.loading) return page.loading;

  const loadPage = window.electronAPI?.loadSessionMessagesPage;
  if (typeof loadPage !== "function") return false;
  const request = loadPage(
    sessionId,
    page.beforeSequence ?? undefined,
    SESSION_MESSAGE_PAGE_SIZE,
  ).then((result) => ({ result, failed: false }), () => ({
    result: { messages: [], hasMore: false, nextBefore: null, firstSequence: page!.sequenceOffset },
    failed: true,
  })).then(({ result, failed }) => {
      const olderMessages = parsePersistedMessageList(result.messages);
      const state = useChatStore.getState();
      const existingMessages = state.sessionMessages[sessionId]
        || (state.activeSessionId === sessionId ? state.messages : []);
      const mergedMessages = mergeSessionMessageLists(olderMessages, existingMessages);
      const currentPage = sessionMessagePages.get(sessionId) || createEmptySessionMessagePage();
      currentPage.loaded = true;
      currentPage.loadFailed = failed;
      if (!failed) {
        currentPage.hasMore = result.hasMore === true;
        currentPage.beforeSequence = typeof result.nextBefore === "number" ? result.nextBefore : null;
      }
      if (olderMessages.length > 0) {
        currentPage.sequenceOffset = Number.isSafeInteger(result.firstSequence)
          ? result.firstSequence
          : currentPage.sequenceOffset;
      }
      currentPage.loadedMessages = mergedMessages;
      currentPage.loading = null;
      sessionMessagePages.set(sessionId, currentPage);
      useChatStore.getState().loadSessionMessages(sessionId, mergedMessages);
      return olderMessages.length > 0;
    });
  page.loading = request;
  return request;
}

export class PersistenceHydrationGate {
  private generation = 0;
  private hydrated = false;

  begin(): number {
    this.hydrated = false;
    this.generation += 1;
    return this.generation;
  }

  complete(generation: number): boolean {
    if (generation !== this.generation) return false;
    this.hydrated = true;
    return true;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  canPersist(): boolean {
    return this.hydrated;
  }
}

const persistenceHydration = new PersistenceHydrationGate();

function flushProjectsToDisk() {
  if (typeof window === "undefined" || typeof window.electronAPI?.saveData !== "function") return;
  saveScheduler.clear("projects");
  if (!persistenceHydration.canPersist()) {
    _pendingProjectsData = null;
    return;
  }
  if (!_pendingProjectsData) return;
  const data = _pendingProjectsData;
  _pendingProjectsData = null;
  window.electronAPI.saveData("projects", data);
}

function scheduleProjectsSave(data: PersistedData) {
  if (!persistenceHydration.canPersist()) return;
  _pendingProjectsData = data;
  saveScheduler.schedule("projects", 500, flushProjectsToDisk);
}

const queueSessionMessageChanges = (
  sessionId: string,
  previousMessages: ChatMessage[],
  nextMessages: ChatMessage[],
  replace = false,
) => {
  const previous = stripTransientMessageList(previousMessages);
  const next = stripTransientMessageList(nextMessages);
  const sequenceOffset = sessionMessagePages.get(sessionId)?.sequenceOffset || 0;
  const previousById = new Map(previous.map((message, index) => [
    message.id,
    { message, sequence: sequenceOffset + index },
  ]));
  const current = _pendingMessageChanges.get(sessionId) || {
    replace: false,
    upserts: new Map<string, { message: ChatMessage; sequence: number }>(),
    deletedIds: new Set<string>(),
  };
  current.replace ||= replace;

  const nextIds = new Set<string>();
  for (let sequence = 0; sequence < next.length; sequence += 1) {
    const message = next[sequence];
    nextIds.add(message.id);
    const previousEntry = previousById.get(message.id);
    const absoluteSequence = sequenceOffset + sequence;
    if (replace || !previousEntry || previousEntry.message !== message || previousEntry.sequence !== absoluteSequence) {
      current.upserts.set(message.id, { message, sequence: absoluteSequence });
      current.deletedIds.delete(message.id);
    }
  }
  for (const message of previous) {
    if (!nextIds.has(message.id)) {
      current.deletedIds.add(message.id);
      current.upserts.delete(message.id);
    }
  }
  _pendingMessageChanges.set(sessionId, current);
};

function flushMessagesToDisk() {
  if (typeof window === "undefined" || typeof window.electronAPI?.saveSessionMessages !== "function") return;
  saveScheduler.clearMany(["messages", "streamingMessages"]);
  if (!persistenceHydration.canPersist()) {
    _pendingMessagesData = null;
    _pendingMessageChanges.clear();
    return;
  }
  if (!_pendingMessagesData) return;
  const data = _pendingMessagesData;
  _pendingMessagesData = null;

  if (_messagesSnapshotNeedsFullRebuild) {
    for (const [sessionId, messages] of Object.entries(data.sessionMessages)) {
      const persisted = stripTransientMessageList(messages);
      const page = sessionMessagePages.get(sessionId);
      const sequenceOffset = page?.sequenceOffset || 0;
      // 只加载最近一页时，不能 replace 整个会话，否则会误删尚未加载的旧消息。
      const replace = page?.hasMore !== true && page?.loadFailed !== true;
      _pendingMessageChanges.set(sessionId, {
        replace,
        upserts: new Map(persisted.map((message, sequence) => [
          message.id,
          { message, sequence: sequenceOffset + sequence },
        ])),
        deletedIds: new Set(),
      });
    }
    _messagesSnapshotNeedsFullRebuild = false;
  }

  const changes = [..._pendingMessageChanges.entries()];
  _pendingMessageChanges.clear();
  for (const [sessionId, sessionChanges] of changes) {
    void window.electronAPI.saveSessionMessages(sessionId, {
      replace: sessionChanges.replace,
      upserts: [...sessionChanges.upserts.values()],
      deletedIds: [...sessionChanges.deletedIds],
    });
  }
}

function scheduleMessagesSave(data?: PersistedMessages, forceFull = false) {
  if (!persistenceHydration.canPersist()) return;
  _pendingMessagesData = data || getCurrentPersistedMessages();
  if (data || forceFull) _messagesSnapshotNeedsFullRebuild = true;
  saveScheduler.schedule("messages", 1000, flushMessagesToDisk);
}

function scheduleStreamingMessagesSave(data?: PersistedMessages) {
  if (!persistenceHydration.canPersist()) return;
  _pendingMessagesData = data || getCurrentPersistedMessages();
  saveScheduler.schedule("streamingMessages", 8000, flushMessagesToDisk, { reset: false });
}

function flushPendingDataToDisk() {
  if (
    typeof window === "undefined"
    || !window.electronAPI
    || (typeof window.electronAPI.saveData !== "function"
      && typeof window.electronAPI.saveSessionMessages !== "function")
  ) return;
  if (_cacheDirty) {
    flushModelsToDisk();
  }
  flushProjectsToDisk();
  flushMessagesToDisk();
}

function flushModelsToDisk() {
  if (typeof window === "undefined" || typeof window.electronAPI?.saveData !== "function") return;
  saveScheduler.clear("models");
  if (!_cacheDirty) return;
  _cacheDirty = false;
  window.electronAPI.saveData("currentModel", {
    models: { ..._sessionModelsCache },
    thinkingLevels: { ..._sessionThinkingCache },
    thinkingLevelsByModel: { ..._sessionModelThinkingCache },
    contextUsage: { ..._sessionContextUsageCache },
    modelVersion: 6,
  });
}

/** 保存/清除会话的上下文用量（内存立即生效，磁盘防抖写入）。 */
export function saveSessionContextUsage(sessionId: string, usage?: SessionContextUsage | null) {
  if (!sessionId) return;
  if (!usage) {
    if (!Object.prototype.hasOwnProperty.call(_sessionContextUsageCache, sessionId)) return;
    const next = { ..._sessionContextUsageCache };
    delete next[sessionId];
    _sessionContextUsageCache = next;
  } else {
    _sessionContextUsageCache = { ..._sessionContextUsageCache, [sessionId]: usage };
  }
  _cacheDirty = true;
  saveScheduler.schedule("models", 500, flushModelsToDisk);
}

/** 读取磁盘缓存里的上下文用量（用于会话激活时补一次展示值）。 */
export function getSessionContextUsage(sessionId: string): SessionContextUsage | null {
  return _sessionContextUsageCache[sessionId] || null;
}

/** Save a model for a specific session (synchronous cache update, debounced disk write) */
export function saveSessionModel(sessionId: string, model: ModelInfo) {
  _sessionModelsCache[sessionId] = model;
  _cacheDirty = true;
  saveScheduler.schedule("models", 500, flushModelsToDisk);
  notifySessionConfigUpdated(sessionId);
}

/** Get persisted model for a session (synchronous, from cache) */
export function getSessionModel(sessionId: string): ModelInfo | null {
  return _sessionModelsCache[sessionId] || null;
}

/** Save thinking level for a specific session (synchronous cache update, debounced disk write) */
export function saveSessionThinking(sessionId: string, level: string) {
  _sessionThinkingCache[sessionId] = level;
  _cacheDirty = true;
  saveScheduler.schedule("models", 500, flushModelsToDisk);
  notifySessionConfigUpdated(sessionId);
}

/** Get persisted thinking level for a session (synchronous, from cache) */
export function getSessionThinking(sessionId: string): string | null {
  return _sessionThinkingCache[sessionId] || null;
}

const getModelThinkingCacheKey = (model: Pick<ModelInfo, "provider" | "id">) =>
  `${model.provider}:${model.id}`;

/** Save a thinking level for a specific session and model. */
export function saveSessionModelThinking(
  sessionId: string,
  model: Pick<ModelInfo, "provider" | "id">,
  level: string,
) {
  const previous = _sessionModelThinkingCache[sessionId] || {};
  _sessionModelThinkingCache[sessionId] = {
    ...previous,
    [getModelThinkingCacheKey(model)]: level,
  };
  _cacheDirty = true;
  saveScheduler.schedule("models", 500, flushModelsToDisk);
  notifySessionConfigUpdated(sessionId);
}

/** Get a thinking level previously selected for a specific session and model. */
export function getSessionModelThinking(
  sessionId: string,
  model: Pick<ModelInfo, "provider" | "id">,
): string | null {
  return _sessionModelThinkingCache[sessionId]?.[getModelThinkingCacheKey(model)] || null;
}

const withoutSessionKeys = <T>(record: Record<string, T>, sessionIds: Set<string>) =>
  Object.fromEntries(Object.entries(record).filter(([sessionId]) => !sessionIds.has(sessionId)));

export async function purgeDeletedSessionData(sessionIds: string[], projectIds: string[] = []) {
  const normalizedSessionIds = new Set(sessionIds.map((id) => id.trim()).filter(Boolean));
  const normalizedProjectIds = new Set(projectIds.map((id) => id.trim()).filter(Boolean));
  if (normalizedSessionIds.size === 0 && normalizedProjectIds.size === 0) return { success: true };

  const previousModelCount = Object.keys(_sessionModelsCache).length;
  const previousThinkingCount = Object.keys(_sessionThinkingCache).length;
  const previousModelThinkingCount = Object.keys(_sessionModelThinkingCache).length;
  const previousContextUsageCount = Object.keys(_sessionContextUsageCache).length;
  _sessionModelsCache = withoutSessionKeys(_sessionModelsCache, normalizedSessionIds);
  _sessionThinkingCache = withoutSessionKeys(_sessionThinkingCache, normalizedSessionIds);
  _sessionModelThinkingCache = withoutSessionKeys(_sessionModelThinkingCache, normalizedSessionIds);
  _sessionContextUsageCache = withoutSessionKeys(_sessionContextUsageCache, normalizedSessionIds);
  if (
    Object.keys(_sessionModelsCache).length !== previousModelCount ||
    Object.keys(_sessionThinkingCache).length !== previousThinkingCount ||
    Object.keys(_sessionModelThinkingCache).length !== previousModelThinkingCount ||
    Object.keys(_sessionContextUsageCache).length !== previousContextUsageCount
  ) {
    _cacheDirty = true;
    saveScheduler.schedule("models", 500, flushModelsToDisk);
  }

  // 已删会话的分页状态必须一起清掉，否则 hasMore/beforeSequence 会指向已经不存在的行。
  for (const sessionId of normalizedSessionIds) {
    _pendingMessageChanges.delete(sessionId);
    sessionMessagePages.delete(sessionId);
  }
  if (_pendingMessagesData) {
    _pendingMessagesData = {
      sessionMessages: withoutSessionKeys(_pendingMessagesData.sessionMessages, normalizedSessionIds),
    };
  }
  if (_pendingProjectsData) {
    const projects = _pendingProjectsData.projects
      .filter((project) => !normalizedProjectIds.has(project.id))
      .map((project) => ({
        ...project,
        sessions: project.sessions.filter((session) => !normalizedSessionIds.has(session.id)),
      }));
    _pendingProjectsData = {
      projects,
      activeProjectId: _pendingProjectsData.activeProjectId && normalizedProjectIds.has(_pendingProjectsData.activeProjectId)
        ? null
        : _pendingProjectsData.activeProjectId,
      activeSessionId: _pendingProjectsData.activeSessionId && normalizedSessionIds.has(_pendingProjectsData.activeSessionId)
        ? null
        : _pendingProjectsData.activeSessionId,
    };
  }

  window.dispatchEvent(new CustomEvent(SESSION_DATA_PURGED_EVENT, {
    detail: { sessionIds: [...normalizedSessionIds], projectIds: [...normalizedProjectIds] },
  }));
  const result = await window.electronAPI.purgeSessionData({
    sessionIds: [...normalizedSessionIds],
    projectIds: [...normalizedProjectIds],
  });
  if (!result.success) {
    throw new Error(result.error || "Failed to purge deleted session data.");
  }
  window.dispatchEvent(new CustomEvent(DISK_USAGE_INVALIDATED_EVENT));
  return result;
}

export async function getSessionThinkingOrDefault(sessionId: string, agentId?: string): Promise<string> {
  const persisted = getSessionThinking(sessionId);
  if (persisted) return persisted;

  try {
    return await window.electronAPI.agentGetDefaultThinkingLevel(agentId || "");
  } catch {
    return "medium";
  }
}

export function selectSessionModel(sessionId: string, models: ModelInfo[]): ModelInfo | null {
  if (models.length === 0) return null;
  const chatState = useChatStore.getState();

  const persisted = getSessionModel(sessionId);
  const persistedMatch = persisted
    ? models.find(m => m.id === persisted.id && m.provider === persisted.provider)
    : undefined;
  if (persistedMatch) return persistedMatch;

  const currentModel = chatState.currentModel;
  const currentMatch = currentModel
    ? models.find(m => m.id === currentModel.id && m.provider === currentModel.provider)
    : undefined;
  if (currentMatch) return currentMatch;

  return models[0];
}

export function useDataPersistence() {
  // Load everything on mount in a single coordinated flow
  useEffect(() => {
    if (persistenceHydration.canPersist()) {
      flushPendingDataToDisk();
    }
    const hydrationGeneration = persistenceHydration.begin();
    useProjectStore.setState({ projectDataHydrated: false });
    let cancelled = false;
    _pendingProjectsData = null;
    _pendingMessagesData = null;
    _messagesSnapshotNeedsFullRebuild = true;
    _pendingMessageChanges.clear();
    sessionMessagePages.clear();
    saveScheduler.clearMany(["projects", "messages", "streamingMessages"]);

    Promise.all([
      window.electronAPI.loadData("projects").catch(() => null),
      window.electronAPI.loadData("currentModel").catch(() => null),
    ]).then(async ([projectData, modelData]) => {
      if (cancelled || !persistenceHydration.isCurrent(hydrationGeneration)) return;

      // 1. Load projects and restore active session
      let activeSessionId: string | null = null;
      let activeAgentId: string | null = null;
      let activeProject: Project | undefined;
      let activeSession: ProjectSession | undefined;
      let validSessionIds: Set<string> | null = null;
      let hydratedMessagesLoaded = false;

      const d = parsePersistedData(projectData);
      if (d) {
        validSessionIds = new Set(d.projects.flatMap((project) => project.sessions.map((session) => session.id)));
        // 没有恢复出活动会话时默认选中第一个未关闭会话（含侧栏展开），
        // 这样启动后不会停在“没有任何会话被选中”的空状态。
        activeSessionId = resolveHydratedActiveSessionId(d);
        applyPersistedProjectSnapshot({ ...d, activeSessionId });
        if (activeSessionId) {
          activeProject = d.projects.find((p) => p.sessions.some((s) => s.id === activeSessionId));
          activeSession = activeProject?.sessions.find((s) => s.id === activeSessionId);
          if (activeSession) {
            activeAgentId = activeSession.agentId;
            useChatStore.setState({ activeAgentId });
          }
        }
      } else {
        useProjectStore.setState({ projectDataHydrated: true });
      }

      // 2. 只恢复当前活动会话的最近一页。其它会话保留在 SQLite 中，
      // 用户真正切换过去时才通过 ensureSessionMessagesLoaded() 读取，避免
      // 会话数量或历史总量把启动时间线性拉长。
      if (validSessionIds && activeSessionId) {
        await requestInitialSessionMessagePage(activeSessionId);
        if (cancelled || !persistenceHydration.isCurrent(hydrationGeneration)) return;
        const activePage = sessionMessagePages.get(activeSessionId);
        const sessionMessages: Record<string, ChatMessage[]> = {};
        if (activePage && activePage.loadedMessages.length > 0) {
          sessionMessages[activeSessionId] = activePage.loadedMessages;
        }
        hydratedMessagesLoaded = true;
        applyPersistedMessagesSnapshot(sessionMessages, activeSessionId);
      } else {
        // A failed or invalid project snapshot must not inherit renderer memory
        // left behind by a previous mount.
        applyPersistedMessagesSnapshot({}, activeSessionId);
      }

      // 3. Load per-session models and thinking levels into cache, restore active session
      const model = parsePersistedModel(modelData);
      if (model) {

        // Migration: v4 (per-agent→per-session) or older → reset to empty
        if (!model.modelVersion || model.modelVersion < 5) {
          _sessionModelsCache = {};
          _sessionThinkingCache = {};
          _sessionModelThinkingCache = {};
          // Migrate legacy global thinkingLevel if present
          if (model.thinkingLevel) {
            _sessionThinkingCache = {};
          }
          window.electronAPI.saveData("currentModel", {
            models: {},
            thinkingLevels: {},
            thinkingLevelsByModel: {},
            contextUsage: {},
            modelVersion: 6,
          });
        } else {
          if (model.models) _sessionModelsCache = { ...model.models };
          if (model.thinkingLevels) _sessionThinkingCache = { ...model.thinkingLevels };
          if (model.thinkingLevelsByModel) _sessionModelThinkingCache = { ...model.thinkingLevelsByModel };
          if (model.contextUsage) _sessionContextUsageCache = { ...model.contextUsage };
          if (validSessionIds) {
            _sessionModelsCache = Object.fromEntries(
              Object.entries(_sessionModelsCache).filter(([sessionId]) => validSessionIds!.has(sessionId))
            );
            _sessionThinkingCache = Object.fromEntries(
              Object.entries(_sessionThinkingCache).filter(([sessionId]) => validSessionIds!.has(sessionId))
            );
            _sessionModelThinkingCache = Object.fromEntries(
              Object.entries(_sessionModelThinkingCache).filter(([sessionId]) => validSessionIds!.has(sessionId))
            );
            _sessionContextUsageCache = Object.fromEntries(
              Object.entries(_sessionContextUsageCache).filter(([sessionId]) => validSessionIds!.has(sessionId))
            );
          }
        }

        // Restore active session's model from cache
        if (activeSessionId && _sessionModelsCache[activeSessionId]) {
          useChatStore.setState({ currentModel: _sessionModelsCache[activeSessionId] });
        }

        // 重启后没有事件流：先把上次已知的上下文用量恢复到标题栏。
        if (activeSessionId && _sessionContextUsageCache[activeSessionId]) {
          useChatStore.getState().setSessionContextUsage(activeSessionId, _sessionContextUsageCache[activeSessionId]);
        }

        // Restore active session's thinking level from cache
        if (activeSessionId && _sessionThinkingCache[activeSessionId]) {
          useChatStore.setState({ thinkingLevel: _sessionThinkingCache[activeSessionId] });
        }
      }

      if (!persistenceHydration.complete(hydrationGeneration)) return;

      // Store subscriptions intentionally ignore hydration writes. Persist the
      // canonical restored snapshot once after opening the gate so lifecycle
      // normalization (stale processes, commentary and compaction) is not
      // revived again on the next launch when no later chat mutation occurs.
      if (hydratedMessagesLoaded) {
        scheduleMessagesSave(undefined, true);
      }

      if (validSessionIds) {
        loadSessionMessageSummaries([...validSessionIds]);
        void window.electronAPI.purgeSessionData({
          validSessionIds: [...validSessionIds],
          validProjectIds: d?.projects.map((project) => project.id) || [],
        })
          .catch((error) => console.error("[persistence] orphan cleanup failed:", error));
      }

      // The active ChatPanel initializes its restored session through SessionCommandCoordinator.
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Model and thinking settings are persisted by SessionCommandCoordinator.

  // Save projects, activeProjectId, and activeSessionId when they change
  useEffect(() => {
    let lastProjects = useProjectStore.getState().projects;
    let lastActiveProjectId = useProjectStore.getState().activeProjectId;
    let lastActiveSessionId = useProjectStore.getState().activeSessionId;

    const unsubscribe = useProjectStore.subscribe((state) => {
      if (
        state.projects === lastProjects &&
        state.activeProjectId === lastActiveProjectId &&
        state.activeSessionId === lastActiveSessionId
      ) {
        return;
      }

      lastProjects = state.projects;
      lastActiveProjectId = state.activeProjectId;
      lastActiveSessionId = state.activeSessionId;

      if (!persistenceHydration.canPersist()) return;

      scheduleProjectsSave({
        projects: state.projects,
        activeProjectId: state.activeProjectId,
        activeSessionId: state.activeSessionId,
      });
    });
    return unsubscribe;
  }, []);

  // Save session messages when they change. Keep the streaming decision
  // incremental: only arrays whose reference changed can change their open
  // process state. The actual transient filtering waits until flush.
  useEffect(() => {
    let lastSessionMessages = useChatStore.getState().sessionMessages;
    const streamingSessionIds = new Set(
      Object.entries(lastSessionMessages)
        .filter(([, messages]) => messages.some(hasOpenAssistantProcessState))
        .map(([sessionId]) => sessionId),
    );
    const unsubscribe = useChatStore.subscribe((state) => {
      if (state.sessionMessages === lastSessionMessages) return;
      const previousSessionMessages = lastSessionMessages;
      lastSessionMessages = state.sessionMessages;

      for (const sessionId of Object.keys(previousSessionMessages)) {
        if (!(sessionId in state.sessionMessages)) {
          streamingSessionIds.delete(sessionId);
          queueSessionMessageChanges(sessionId, previousSessionMessages[sessionId] || [], []);
        }
      }
      for (const [sessionId, messages] of Object.entries(state.sessionMessages)) {
        const previous = previousSessionMessages[sessionId] || [];
        if (messages === previous) continue;
        const firstUserMessage = messages.find(isUserSpeechMessage);
        if (firstUserMessage) {
          updatePersistedSessionPreview(sessionId, getChatMessagePreviewText(firstUserMessage));
        }
        queueSessionMessageChanges(sessionId, previous, messages);
        if (messages.some(hasOpenAssistantProcessState)) streamingSessionIds.add(sessionId);
        else streamingSessionIds.delete(sessionId);
      }

      if (!persistenceHydration.canPersist()) return;
      if (streamingSessionIds.size > 0) {
        scheduleStreamingMessagesSave();
        return;
      }

      scheduleMessagesSave();
    });
    return unsubscribe;
  }, []);

  // Flush debounced saves before the renderer is suspended or closed.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushPendingDataToDisk();
      }
    };

    window.addEventListener("beforeunload", flushPendingDataToDisk);
    window.addEventListener("pagehide", flushPendingDataToDisk);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("beforeunload", flushPendingDataToDisk);
      window.removeEventListener("pagehide", flushPendingDataToDisk);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      flushPendingDataToDisk();
    };
  }, []);
}
