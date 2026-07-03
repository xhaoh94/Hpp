import type { AgentEvent } from "@/types";
import type { AgentProcessEntry, AgentProcessFile } from "@/stores/chat-store";

const THINKING_PREVIEW_CHAR_LIMIT = 240;
const THINKING_REPEAT_MIN_PATTERN_LENGTH = 60;
const THINKING_REPEAT_MIN_COUNT = 3;
const STREAM_RENDER_FLUSH_INTERVAL_MS = 120;
const STREAM_RENDER_MAX_BUFFERED_CHARS = 6000;

export type NormalizedToolKind =
  | "read_file"
  | "list_dir"
  | "write_file"
  | "edit_file"
  | "run_command"
  | "search_files"
  | "search_text"
  | "web_fetch"
  | "web_search"
  | "question"
  | "unknown";

export type UnknownRecord = Record<string, unknown>;

export type SessionRuntime = {
  streamBuffer: string;
  thinkingBuffer: string;
  thinkingEntryId: string | null;
  processActive: boolean;
  streamStarted: boolean;
  activeToolEntry: Record<string, string>;
  activeToolFile: Record<string, AgentProcessFile[]>;
  streamWatchdog: ReturnType<typeof setTimeout> | null;
  streamIdleNoticeEntryId: string | null;
  autoAbortReason: string | null;
  manualAbortRequested: boolean;
  processTextEntryId: string | null;
  processTextEntryIds: string[];
  processTextHistory: string[];
  processTextBuffer: string;
  pendingProcessTextDetail: string;
  pendingThinkingDetail: string;
  pendingThinkingTitle: string | null;
  streamRenderFlushTimer: ReturnType<typeof setTimeout> | null;
  streamRenderBufferedChars: number;
};

export const createProcessEntryId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `process-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const isRecord = (value: unknown): value is UnknownRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const asRecord = (value: unknown): UnknownRecord =>
  isRecord(value) ? value : {};

export const getStringField = (value: UnknownRecord, key: string): string | undefined => {
  const found = value[key];
  return typeof found === "string" ? found : undefined;
};

export const getBooleanField = (value: UnknownRecord, key: string): boolean | undefined => {
  const found = value[key];
  return typeof found === "boolean" ? found : undefined;
};

export const createSessionRuntime = (): SessionRuntime => ({
  streamBuffer: "",
  thinkingBuffer: "",
  thinkingEntryId: null,
  processActive: false,
  streamStarted: false,
  activeToolEntry: {},
  activeToolFile: {},
  streamWatchdog: null,
  streamIdleNoticeEntryId: null,
  autoAbortReason: null,
  manualAbortRequested: false,
  processTextEntryId: null,
  processTextEntryIds: [],
  processTextHistory: [],
  processTextBuffer: "",
  pendingProcessTextDetail: "",
  pendingThinkingDetail: "",
  pendingThinkingTitle: null,
  streamRenderFlushTimer: null,
  streamRenderBufferedChars: 0,
});

export const scheduleRuntimeRenderFlush = (
  runtime: SessionRuntime,
  flush: () => void,
  bufferedChars = 0
) => {
  runtime.streamRenderBufferedChars += bufferedChars;
  if (runtime.streamRenderBufferedChars >= STREAM_RENDER_MAX_BUFFERED_CHARS) {
    if (runtime.streamRenderFlushTimer) {
      clearTimeout(runtime.streamRenderFlushTimer);
      runtime.streamRenderFlushTimer = null;
    }
    flush();
    return;
  }

  if (!runtime.streamRenderFlushTimer) {
    runtime.streamRenderFlushTimer = setTimeout(flush, STREAM_RENDER_FLUSH_INTERVAL_MS);
  }
};

export const clearRuntimeRenderFlush = (runtime: SessionRuntime) => {
  if (runtime.streamRenderFlushTimer) {
    clearTimeout(runtime.streamRenderFlushTimer);
    runtime.streamRenderFlushTimer = null;
  }
  runtime.streamRenderBufferedChars = 0;
};

export const resetSessionRuntimeBuffers = (runtime: SessionRuntime) => {
  clearRuntimeRenderFlush(runtime);
  runtime.streamBuffer = "";
  runtime.thinkingBuffer = "";
  runtime.thinkingEntryId = null;
  runtime.activeToolEntry = {};
  runtime.activeToolFile = {};
  runtime.streamIdleNoticeEntryId = null;
  runtime.processTextEntryId = null;
  runtime.processTextEntryIds = [];
  runtime.processTextHistory = [];
  runtime.processTextBuffer = "";
  runtime.pendingProcessTextDetail = "";
  runtime.pendingThinkingDetail = "";
  runtime.pendingThinkingTitle = null;
};

export const resetSessionRuntimeAfterTurn = (runtime: SessionRuntime) => {
  runtime.processActive = false;
  runtime.streamStarted = false;
  runtime.manualAbortRequested = false;
  resetSessionRuntimeBuffers(runtime);
};

export const stringifyProcessValue = (value: unknown) => {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export const truncateProcessDetail = (value: string) => {
  const maxLength = 1200;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
};

export const getThinkingPreview = (value?: string) => {
  const preview = value?.replace(/\s+/g, " ").trim();
  if (!preview) return "思考中";
  return preview.length > THINKING_PREVIEW_CHAR_LIMIT
    ? `${preview.slice(0, THINKING_PREVIEW_CHAR_LIMIT)}...`
    : preview;
};

const normalizeThinkingRepeatUnit = (value: string) =>
  value
    .replace(/[`"'“”‘’]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export const getRepeatedThinkingPattern = (value: string) => {
  const units = value
    .replace(/[。！？!?]+/g, "$&\n")
    .split(/[\r\n]+/)
    .map(normalizeThinkingRepeatUnit)
    .filter((unit) => unit.length >= 12)
    .slice(-16);

  for (let size = 1; size <= 4; size += 1) {
    if (units.length < size * THINKING_REPEAT_MIN_COUNT) continue;

    const patternUnits = units.slice(units.length - size);
    const pattern = patternUnits.join("\n");
    if (pattern.length < THINKING_REPEAT_MIN_PATTERN_LENGTH) continue;

    let repeatCount = 1;
    for (let index = units.length - size * 2; index >= 0; index -= size) {
      const previous = units.slice(index, index + size).join("\n");
      if (previous !== pattern) break;
      repeatCount += 1;
    }

    if (repeatCount >= THINKING_REPEAT_MIN_COUNT) {
      return { pattern, repeatCount };
    }
  }

  return null;
};

const getFileName = (filePath: string) => {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
};

export const getToolKey = (event: AgentEvent) => {
  const raw = event.toolCallId || event.callId || event.id || event.toolName || event.name || "tool";
  return String(raw);
};

export const getToolName = (event: AgentEvent) => {
  return event.toolName || event.name || event.tool || "tool";
};

const getFileEntryTitle = (action: AgentProcessFile["action"] | undefined, count: number, running = false) => {
  if (running) {
    switch (action) {
      case "read": return `正在读取 ${count} 个文件`;
      case "listed": return `正在查看 ${count} 个目录`;
      case "written": return `正在写入 ${count} 个文件`;
      case "edited": return `正在编辑 ${count} 个文件`;
      default: return `正在修改 ${count} 个文件`;
    }
  }

  switch (action) {
    case "read": return `已读取 ${count} 个文件`;
    case "listed": return `已查看 ${count} 个目录`;
    case "written": return `已写入 ${count} 个文件`;
    case "edited": return `已编辑 ${count} 个文件`;
    default: return `已修改 ${count} 个文件`;
  }
};

export const normalizeToolKind = (value: unknown): NormalizedToolKind => {
  const normalized = String(value || "").trim();
  if (
    normalized === "read_file" ||
    normalized === "list_dir" ||
    normalized === "write_file" ||
    normalized === "edit_file" ||
    normalized === "run_command" ||
    normalized === "search_files" ||
    normalized === "search_text" ||
    normalized === "web_fetch" ||
    normalized === "web_search" ||
    normalized === "question" ||
    normalized === "unknown"
  ) {
    return normalized;
  }
  return "unknown";
};

export const getToolProcessFiles = (event: AgentEvent): AgentProcessFile[] => {
  if (Array.isArray(event.files)) {
    return event.files
      .filter((file): file is AgentProcessFile => isRecord(file) && typeof file.file === "string" && file.file.trim().length > 0)
      .map((file) => ({
        ...file,
        label: file.label || getFileName(file.file),
      }));
  }

  if (typeof event.filePath !== "string" || !event.filePath) return [];
  const toolKind = normalizeToolKind(event.toolKind);
  const action: AgentProcessFile["action"] =
    toolKind === "read_file" ? "read" :
    toolKind === "list_dir" ? "listed" :
    toolKind === "write_file" ? "written" :
    toolKind === "edit_file" ? "edited" :
    undefined;

  if (!action) return [];

  return [{
    file: event.filePath,
    label: getFileName(event.filePath),
    action,
    additions: typeof event.additions === "number" ? event.additions : undefined,
    deletions: typeof event.deletions === "number" ? event.deletions : undefined,
    status: event.patch ? "modified" : undefined,
  }];
};

export const getQuestionTitle = (running = false, isError = false) => {
  if (isError) return "用户选择处理失败";
  return running ? "等待用户选择" : "已提交选择";
};

export const getUIResponsePayload = (response: {
  sessionId: string;
  requestId?: string;
  method?: string;
  text: string;
}) => {
  const base: Record<string, unknown> = {
    sessionId: response.sessionId,
    text: response.text,
    value: response.text,
    answers: [{ value: response.text }],
    cancelled: false,
  };

  if (response.requestId) {
    base.type = "extension_ui_response";
    base.id = response.requestId;
  }

  if (response.method) {
    base.method = response.method;
  }

  if (response.method === "confirm") {
    base.confirmed = !["no", "n", "false", "否", "取消"].includes(response.text.trim().toLowerCase());
  }

  return base;
};

export const getToolDetail = (event: AgentEvent) => {
  const detail = typeof event.detail === "string" ? event.detail : "";
  if (detail.trim()) return truncateProcessDetail(detail);
  if (event.isError && event.errorText) return truncateProcessDetail(String(event.errorText));
  if (event.outputText && ["run_command", "search_files", "search_text", "web_fetch", "web_search", "unknown"].includes(normalizeToolKind(event.toolKind))) {
    return truncateProcessDetail(String(event.outputText));
  }
  return undefined;
};

export const getToolSummary = (event: AgentEvent, running = false): string => {
  const toolKind = normalizeToolKind(event.toolKind);
  const toolName = getToolName(event);
  const files = getToolProcessFiles(event);
  if (event.isError) {
    switch (toolKind) {
      case "read_file": return "读取文件失败";
      case "list_dir": return "读取目录失败";
      case "write_file": return "写入文件失败";
      case "edit_file": return "编辑文件失败";
      case "run_command": return "命令执行失败";
      case "search_files": return "文件搜索失败";
      case "search_text": return "内容搜索失败";
      case "web_fetch": return "网页获取失败";
      case "web_search": return "网络搜索失败";
      case "question": return getQuestionTitle(false, true);
      default: return `${toolName} 执行失败`;
    }
  }

  if (files.length > 0) return getFileEntryTitle(files[0].action, files.length, running);

  const prefix = running ? "正在运行" : "已运行";
  const completedPrefix = running ? "正在" : "已完成";

  switch (toolKind) {
    case "run_command":
      return toolName ? `${prefix} ${toolName}` : `${prefix}命令`;
    case "search_files":
      return `${completedPrefix}搜索文件`;
    case "search_text":
      return `${completedPrefix}搜索内容`;
    case "web_fetch":
      return `${completedPrefix}获取网页内容`;
    case "web_search":
      return `${completedPrefix}搜索网络`;
    case "question":
      return getQuestionTitle(running, false);
    default:
      return toolName ? `${prefix} ${toolName}` : `${prefix}工具`;
  }
};

export const normalizeProcessEntryType = (value: unknown): AgentProcessEntry["type"] => {
  if (
    value === "status" ||
    value === "tool" ||
    value === "diff" ||
    value === "error" ||
    value === "info" ||
    value === "thinking" ||
    value === "question"
  ) {
    return value;
  }
  return "status";
};

export const normalizeProcessEntryState = (value: unknown): AgentProcessEntry["state"] | undefined => {
  if (value === "running" || value === "completed" || value === "error" || value === "interrupted") return value;
  return undefined;
};
