import type { AgentEvent } from "@/types";
import type {
  AgentProcessChangeSummary,
  AgentProcessEntry,
  AgentProcessFile,
  AgentProcessStep,
  AgentProcessStepStatus,
} from "@/stores/chat-store";

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
  nativePlanSteps: boolean;
  inferredPlanStepsActive: boolean;
  inferredStepSignal: {
    analyzed: boolean;
    operated: boolean;
    modified: boolean;
    verified: boolean;
    failed: boolean;
    cancelled: boolean;
  };
  changeSummaryFiles: Record<string, { file: string; additions: number; deletions: number }>;
  changeSummarySeenEvents: Record<string, true>;
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

const normalizeEventToken = (value: unknown) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s._:-]+/g, "");

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
  nativePlanSteps: false,
  inferredPlanStepsActive: false,
  inferredStepSignal: {
    analyzed: false,
    operated: false,
    modified: false,
    verified: false,
    failed: false,
    cancelled: false,
  },
  changeSummaryFiles: {},
  changeSummarySeenEvents: {},
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
  runtime.nativePlanSteps = false;
  runtime.inferredPlanStepsActive = false;
  runtime.inferredStepSignal = {
    analyzed: false,
    operated: false,
    modified: false,
    verified: false,
    failed: false,
    cancelled: false,
  };
  runtime.changeSummaryFiles = {};
  runtime.changeSummarySeenEvents = {};
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

const normalizePlanStepStatus = (value: unknown): AgentProcessStepStatus => {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "running" ||
    normalized === "in_progress" ||
    normalized === "inprogress" ||
    normalized === "active" ||
    normalized === "doing"
  ) {
    return "running";
  }
  if (
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "done" ||
    normalized === "success" ||
    normalized === "succeeded"
  ) {
    return "completed";
  }
  if (normalized === "failed" || normalized === "error" || normalized === "failure") {
    return "failed";
  }
  if (
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "skipped" ||
    normalized === "interrupted"
  ) {
    return "cancelled";
  }
  return "pending";
};

const getPlanStepTitle = (step: UnknownRecord, index: number) => {
  const title =
    getStringField(step, "title") ||
    getStringField(step, "text") ||
    getStringField(step, "content") ||
    getStringField(step, "description") ||
    getStringField(step, "name");
  return title?.trim() || `步骤 ${index + 1}`;
};

export const normalizePlanSteps = (value: unknown): AgentProcessStep[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      if (typeof item === "string") {
        const rawTitle = item.trim();
        const statusMatch = rawTitle.match(/^(pending|running|in[_ -]?progress|completed|complete|done|failed|error|cancelled|canceled|skipped|interrupted)\s+(.+)$/i);
        const checkboxMatch = rawTitle.match(/^\[([ xX-])\]\s+(.+)$/);
        const title = statusMatch?.[2]?.trim() || checkboxMatch?.[2]?.trim() || rawTitle;
        if (!title) return null;
        return {
          id: `step-${index}-${title.slice(0, 24)}`,
          title,
          status: checkboxMatch
            ? (checkboxMatch[1].toLowerCase() === "x" ? "completed" : "pending")
            : normalizePlanStepStatus(statusMatch?.[1]),
        };
      }
      if (!isRecord(item)) return null;
      const title = getPlanStepTitle(item, index);
      return {
        id: String(item.id || item.stepId || item.key || `step-${index}-${title.slice(0, 24)}`),
        title,
        status: normalizePlanStepStatus(item.status || item.state || item.phase),
      };
    })
    .filter((step): step is AgentProcessStep => !!step && step.title.trim().length > 0);
};

export const isPlanLikeProcessEvent = (event: AgentEvent) => {
  const tokens = [
    event.entryType,
    event.kind,
    event.mode,
    event.name,
    event.toolName,
    event.title,
  ].map((value) => normalizeEventToken(value));
  return tokens.some((token) =>
    token === "plan" ||
    token === "todo" ||
    token === "step" ||
    token.includes("planupdate") ||
    token.includes("todoupdate") ||
    token.includes("stepupdate")
  );
};

export const normalizePlanStepsFromEvent = (event: AgentEvent): AgentProcessStep[] => {
  const detail = asRecord(event.detail);
  const args = asRecord(event.args);
  const input = asRecord(event.input);
  const candidates = [
    event.steps,
    event.plan,
    event.todos,
    event.items,
    detail.steps,
    detail.plan,
    detail.todos,
    detail.items,
    args.steps,
    args.plan,
    args.todos,
    args.items,
    input.steps,
    input.plan,
    input.todos,
    input.items,
  ];

  for (const candidate of candidates) {
    const steps = normalizePlanSteps(candidate);
    if (steps.length > 0) return steps;
  }

  if (typeof event.detail === "string") {
    const lines = event.detail
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);
    const steps = normalizePlanSteps(lines);
    if (steps.length > 0) return steps;
  }

  return [];
};

export const normalizeChangeSummaryFileKey = (filePath: string) =>
  filePath.replace(/\\/g, "/").trim().toLowerCase();

export const summarizeRuntimeChanges = (runtime: SessionRuntime): AgentProcessChangeSummary => {
  const values = Object.values(runtime.changeSummaryFiles);
  return {
    filesChanged: values.length,
    additions: values.reduce((total, file) => total + file.additions, 0),
    deletions: values.reduce((total, file) => total + file.deletions, 0),
  };
};

export const mergeRuntimeChangeFile = (
  runtime: SessionRuntime,
  file: { file?: unknown; additions?: unknown; deletions?: unknown; changeKey?: unknown }
) => {
  if (typeof file.file !== "string" || !file.file.trim()) return false;
  const key = normalizeChangeSummaryFileKey(file.file);
  if (!key) return false;

  const changeKey = typeof file.changeKey === "string" && file.changeKey.trim()
    ? file.changeKey.trim()
    : "";
  if (changeKey && runtime.changeSummarySeenEvents[changeKey]) return false;
  if (changeKey) runtime.changeSummarySeenEvents[changeKey] = true;

  const additions = typeof file.additions === "number" ? file.additions : 0;
  const deletions = typeof file.deletions === "number" ? file.deletions : 0;
  const existing = runtime.changeSummaryFiles[key];
  if (!existing) {
    runtime.changeSummaryFiles[key] = { file: file.file, additions, deletions };
    return true;
  }

  if (additions === 0 && deletions === 0) return false;

  runtime.changeSummaryFiles[key] = {
    file: existing.file || file.file,
    additions: existing.additions + additions,
    deletions: existing.deletions + deletions,
  };
  return true;
};

export type InferredStepSignal = "analyze" | "operate" | "modify" | "verify" | "failed" | "cancelled";

export const buildInferredPlanSteps = (
  runtime: SessionRuntime,
  signal?: InferredStepSignal
): AgentProcessStep[] | null => {
  if (runtime.nativePlanSteps) return null;

  if (signal === "analyze") runtime.inferredStepSignal.analyzed = true;
  if (signal === "operate") {
    runtime.inferredStepSignal.analyzed = true;
    runtime.inferredStepSignal.operated = true;
  }
  if (signal === "modify") {
    runtime.inferredStepSignal.analyzed = true;
    runtime.inferredStepSignal.operated = true;
    runtime.inferredStepSignal.modified = true;
  }
  if (signal === "verify") {
    runtime.inferredStepSignal.analyzed = true;
    runtime.inferredStepSignal.operated = true;
    runtime.inferredStepSignal.verified = true;
  }
  if (signal === "failed") runtime.inferredStepSignal.failed = true;
  if (signal === "cancelled") runtime.inferredStepSignal.cancelled = true;

  const flags = runtime.inferredStepSignal;
  if (!flags.analyzed && !flags.operated && !flags.modified && !flags.verified) return null;
  runtime.inferredPlanStepsActive = true;

  const terminalStatus: AgentProcessStepStatus | null =
    flags.cancelled ? "cancelled" : flags.failed ? "failed" : null;
  const hasWorked = flags.operated || flags.modified || Object.keys(runtime.changeSummaryFiles).length > 0;
  const hasFinished = flags.verified;
  const terminalAtAnalyze = !!terminalStatus && !hasWorked && !flags.verified;
  const terminalAtOperate = !!terminalStatus && hasWorked && !flags.verified;
  const terminalAtVerify = !!terminalStatus && flags.verified;
  const steps: AgentProcessStep[] = [
    {
      id: "inferred-analyze",
      title: "分析请求",
      status: terminalAtAnalyze
        ? terminalStatus
        : hasWorked || hasFinished || terminalAtOperate || terminalAtVerify
        ? "completed"
        : flags.analyzed
          ? "running"
          : "pending",
    },
    {
      id: "inferred-operate",
      title: "执行操作",
      status: terminalAtOperate
        ? terminalStatus
        : hasFinished || terminalAtVerify
        ? "completed"
        : hasWorked
          ? "running"
          : "pending",
    },
    {
      id: "inferred-verify",
      title: "验证总结",
      status: terminalAtVerify ? terminalStatus : hasFinished ? "completed" : "pending",
    },
  ];

  return steps;
};
