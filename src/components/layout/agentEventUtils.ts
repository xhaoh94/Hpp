import type { AgentEvent } from "@/types";
import type {
  AgentProcessChangeSummary,
  AgentProcessEntry,
  AgentProcessFile,
  AgentProcessStep,
  AgentProcessStepStatus,
} from "@/stores/chat-store";
import {
  getCommandNonZeroSummary,
  getPlanStepFallbackTitle,
  getProcessFileEntryTitle,
  getQuestionTitle as getLocalizedQuestionTitle,
  getToolActionSummary,
  getToolWarningSummary,
  isNegativeConfirmResponse,
  uiText,
} from "@/i18n/text";

const THINKING_PREVIEW_CHAR_LIMIT = 240;
const THINKING_PREVIEW_LINE_LIMIT = 2;
/** 折叠预览中单个代码块最多保留的内容行数（不含 fence 行）。 */
const THINKING_PREVIEW_CODE_LINE_LIMIT = 12;
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

export type AgentTurnTerminalReason = "completed" | "aborted" | "disconnected" | "error";

export type AgentTurnIdentity = {
  revision?: string | null;
  userMessageId?: string | null;
};

export type SessionRuntime = {
  streamBuffer: string;
  thinkingBuffer: string;
  thinkingEntryId: string | null;
  processActive: boolean;
  streamStarted: boolean;
  activeToolEntry: Record<string, string>;
  activeToolFile: Record<string, AgentProcessFile[]>;
  activeToolKind: Record<string, NormalizedToolKind>;
  streamWatchdog: ReturnType<typeof setTimeout> | null;
  streamIdleNoticeEntryId: string | null;
  streamIdleSince: number | null;
  autoAbortReason: string | null;
  manualAbortRequested: boolean;
  activeCompactionId: string | null;
  activeCompactionPresentation: "process" | "divider" | null;
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
  /** Task ids changed by the current turn's todo calls, excluding history. */
  nativeTodoPlanStepIds: string[];
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
  turnEventState: "initial" | "active" | "settled";
  activeTurnRevision: string | null;
  activeTurnUserMessageId: string | null;
  settledTurnRevisions: string[];
  settledTurnUserMessageIds: string[];
  turnTerminalReason: AgentTurnTerminalReason | null;
  settledCompactionEventIds: string[];
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

export const isModelRequestFailureTitle = (title: string) => {
  const normalized = title.trim().toLowerCase();
  return normalized.includes("模型请求") ||
    normalized.includes("request failed") ||
    normalized.includes("请求发送失败") ||
    normalized.includes("运行失败") ||
    normalized.includes("已断开") ||
    (normalized.includes("opencode") && normalized.includes("错误")) ||
    normalized.includes("disconnected") ||
    normalized.includes("process failed") ||
    normalized.includes("input failed") ||
    normalized.includes("output pipe closed");
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
  activeToolKind: {},
  streamWatchdog: null,
  streamIdleNoticeEntryId: null,
  streamIdleSince: null,
  autoAbortReason: null,
  manualAbortRequested: false,
  activeCompactionId: null,
  activeCompactionPresentation: null,
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
  nativeTodoPlanStepIds: [],
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
  turnEventState: "initial",
  activeTurnRevision: null,
  activeTurnUserMessageId: null,
  settledTurnRevisions: [],
  settledTurnUserMessageIds: [],
  turnTerminalReason: null,
  settledCompactionEventIds: [],
});

const MAX_SETTLED_TURN_IDENTITIES = 32;

const ensureSessionRuntimeTurnTracking = (runtime: SessionRuntime) => {
  runtime.nativeTodoPlanStepIds ||= [];
  runtime.turnEventState ||= "initial";
  runtime.activeTurnRevision ??= null;
  runtime.activeTurnUserMessageId ??= null;
  runtime.settledTurnRevisions ||= [];
  runtime.settledTurnUserMessageIds ||= [];
  runtime.turnTerminalReason ??= null;
  runtime.settledCompactionEventIds ||= [];
};

const pushBoundedUnique = (values: string[], value: string | null | undefined) => {
  const normalized = value?.trim();
  if (!normalized || values.includes(normalized)) return;
  values.push(normalized);
  if (values.length > MAX_SETTLED_TURN_IDENTITIES) {
    values.splice(0, values.length - MAX_SETTLED_TURN_IDENTITIES);
  }
};

export const normalizeAgentTurnRevision = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
};

export const compareAgentTurnRevisions = (candidate: string, current: string): number | null => {
  const candidateSeparator = candidate.lastIndexOf(":");
  const currentSeparator = current.lastIndexOf(":");
  if (candidateSeparator <= 0 || currentSeparator <= 0) return null;
  if (candidate.slice(0, candidateSeparator) !== current.slice(0, currentSeparator)) return null;
  const candidateSequence = Number(candidate.slice(candidateSeparator + 1));
  const currentSequence = Number(current.slice(currentSeparator + 1));
  if (!Number.isSafeInteger(candidateSequence) || !Number.isSafeInteger(currentSequence)) return null;
  return Math.sign(candidateSequence - currentSequence);
};

const isSettledTurnRevision = (runtime: SessionRuntime, revision: string) =>
  runtime.settledTurnRevisions.some((settledRevision) => (
    settledRevision === revision || compareAgentTurnRevisions(revision, settledRevision) === -1
  ));

export const activateSessionRuntimeTurn = (
  runtime: SessionRuntime,
  identity: AgentTurnIdentity = {},
) => {
  ensureSessionRuntimeTurnTracking(runtime);
  const revision = normalizeAgentTurnRevision(identity.revision);
  const userMessageId = typeof identity.userMessageId === "string" && identity.userMessageId.trim()
    ? identity.userMessageId.trim()
    : null;

  if (revision && isSettledTurnRevision(runtime, revision)) return false;
  // IPC invoke replies and webContents events use different delivery paths.
  // A failed send can therefore be reconciled by the renderer before the
  // host-owned lifecycle revision for that same user message arrives.  The
  // client message id is an equally authoritative turn identity: once it has
  // been settled, a later revision must not be allowed to reopen it.
  if (userMessageId && runtime.settledTurnUserMessageIds.includes(userMessageId)) return false;
  if (
    runtime.turnEventState === "settled" &&
    !revision &&
    (!userMessageId || runtime.settledTurnUserMessageIds.includes(userMessageId))
  ) {
    return false;
  }
  if (
    runtime.turnEventState === "active" &&
    revision &&
    runtime.activeTurnRevision &&
    runtime.activeTurnRevision !== revision
  ) {
    return false;
  }
  if (
    runtime.turnEventState === "active" &&
    revision &&
    runtime.activeTurnRevision === revision &&
    userMessageId &&
    runtime.activeTurnUserMessageId &&
    runtime.activeTurnUserMessageId !== userMessageId
  ) {
    // A lifecycle revision identifies one host-owned turn. Never let a late
    // or malformed event reuse that revision to replace the active user
    // message identity and contaminate the current turn's terminal barrier.
    return false;
  }

  runtime.turnEventState = "active";
  runtime.turnTerminalReason = null;
  if (revision) runtime.activeTurnRevision = revision;
  if (userMessageId) runtime.activeTurnUserMessageId = userMessageId;
  return true;
};

export const markSessionRuntimeTurnSettled = (
  runtime: SessionRuntime,
  reason: AgentTurnTerminalReason,
  identity: AgentTurnIdentity = {},
) => {
  ensureSessionRuntimeTurnTracking(runtime);
  const revision = normalizeAgentTurnRevision(identity.revision) || runtime.activeTurnRevision;
  const userMessageId = (
    typeof identity.userMessageId === "string" && identity.userMessageId.trim()
      ? identity.userMessageId.trim()
      : runtime.activeTurnUserMessageId
  );
  pushBoundedUnique(runtime.settledTurnRevisions, revision);
  pushBoundedUnique(runtime.settledTurnUserMessageIds, userMessageId);
  runtime.activeTurnRevision = null;
  runtime.activeTurnUserMessageId = null;
  runtime.turnEventState = "settled";
  runtime.turnTerminalReason = reason;
};

export const rememberSettledCompactionEvent = (runtime: SessionRuntime, eventId?: string | null) => {
  ensureSessionRuntimeTurnTracking(runtime);
  pushBoundedUnique(runtime.settledCompactionEventIds, eventId);
};

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
  runtime.activeToolKind = {};
  runtime.streamIdleNoticeEntryId = null;
  runtime.streamIdleSince = null;
  runtime.processTextEntryId = null;
  runtime.processTextEntryIds = [];
  runtime.processTextHistory = [];
  runtime.processTextBuffer = "";
  runtime.pendingProcessTextDetail = "";
  runtime.pendingThinkingDetail = "";
  runtime.pendingThinkingTitle = null;
  runtime.nativePlanSteps = false;
  runtime.nativeTodoPlanStepIds = [];
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

/** Approximate character count that fits in a single line of thinking preview. */
const THINKING_SINGLE_LINE_CHAR_LIMIT = 60;

/** Check whether thinking text is short enough to fit in a single line. */
export const isThinkingSingleLine = (value?: string): boolean => {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return true;
  return text.length <= THINKING_SINGLE_LINE_CHAR_LIMIT;
};

export const getThinkingPreview = (value?: string) => {
  const preview = value?.replace(/\*{2,}/g, "").replace(/\s+/g, " ").trim();
  if (!preview) return uiText.process.thinking;
  return preview.length > THINKING_PREVIEW_CHAR_LIMIT
    ? `${preview.slice(0, THINKING_PREVIEW_CHAR_LIMIT)}...`
    : preview;
};

/**
 * Convert thinking detail into a multi-line Markdown preview that keeps the
 * original block structure (headings, lists, block quotes, fenced code blocks,
 * indentation) so the collapsed state renders the same way as the expanded
 * body. Only the first few lines are kept; lines longer than the character
 * limit are truncated individually. The CSS line-clamp handles visual overflow.
 *
 * Fenced code blocks are kept complete: if a code fence starts within the
 * kept-line boundary, following lines are retained until the closing fence
 * (or a hard cap), so the collapsed preview never renders an unterminated,
 * empty code block box.
 */
export const getThinkingPreviewMarkdown = (value?: string) => {
  const lines = value?.split("\n") ?? [];
  const kept: string[] = [];
  let nonEmptyCount = 0;
  let fenceMarker: string | null = null;
  let codeLines = 0;

  for (const line of lines) {
    if (!line.trim()) {
      if (fenceMarker) {
        // 代码块内部的空行必须保留，否则代码块结构会被破坏。
        kept.push(line);
        continue;
      }
      // 保留空行作为段落分隔（markdown 单换行会渲染成同一段落），
      // 只在已保留内容之后才保留，避免预览以空行开头。
      if (kept.length > 0) kept.push("");
      continue;
    }

    if (!fenceMarker) {
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch && nonEmptyCount < THINKING_PREVIEW_LINE_LIMIT) {
        // 进入代码块：即使已到达 2 行预览边界，也继续保留直到闭合，
        // 避免折叠预览中出现未闭合的空白代码块。
        fenceMarker = fenceMatch[1].charAt(0);
        kept.push(line);
        nonEmptyCount += 1;
        continue;
      }
    } else {
      // 在代码块内：优先查找闭合 fence。
      if (line.trim().startsWith(fenceMarker)) {
        kept.push(line);
        fenceMarker = null;
        break;
      }
      codeLines += 1;
      if (codeLines > THINKING_PREVIEW_CODE_LINE_LIMIT) {
        // 超长代码块：截断并补上闭合 fence，保证渲染为完整代码块而非空白框。
        kept.push(fenceMarker.repeat(3));
        break;
      }
      kept.push(line.length > THINKING_PREVIEW_CHAR_LIMIT
        ? `${line.slice(0, THINKING_PREVIEW_CHAR_LIMIT)}...`
        : line);
      continue;
    }

    nonEmptyCount += 1;
    if (nonEmptyCount > THINKING_PREVIEW_LINE_LIMIT) break;
    kept.push(line.length > THINKING_PREVIEW_CHAR_LIMIT
      ? `${line.slice(0, THINKING_PREVIEW_CHAR_LIMIT)}...`
      : line);
  }

  if (kept.length === 0) return uiText.process.thinking;
  return kept.join("\n").replace(/\n+$/, "");
};

export const getContextCompactionPresentation = (
  phase: "started" | "completed" | "interrupted",
  processActive: boolean,
  activePresentation: SessionRuntime["activeCompactionPresentation"],
) => phase === "started"
  ? processActive ? "process" as const : "divider" as const
  : activePresentation || "divider";

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
        patch: typeof file.patch === "string" ? file.patch : undefined,
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
    patch: typeof event.patch === "string" ? event.patch : undefined,
    additions: typeof event.additions === "number" ? event.additions : undefined,
    deletions: typeof event.deletions === "number" ? event.deletions : undefined,
    status: event.patch ? "modified" : undefined,
  }];
};

export const getQuestionTitle = (running = false, isError = false) => {
  return getLocalizedQuestionTitle(running, isError);
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
    base.confirmed = !isNegativeConfirmResponse(response.text);
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
  if (isCommandNonZeroExit(event)) {
    return getCommandNonZeroSummary(event.exitCode);
  }
  if (event.isError) {
    return getToolWarningSummary(toolKind, toolName);
  }

  if (files.length > 0) return getProcessFileEntryTitle(files[0].action, files.length, running);

  return getToolActionSummary(toolKind, toolName, running);
};

export const isCommandNonZeroExit = (event: AgentEvent): boolean =>
  normalizeToolKind(event.toolKind) === "run_command" &&
  event.isError === true &&
  typeof event.exitCode === "number" &&
  event.exitCode !== 0;

export const normalizeProcessEntryType = (value: unknown): AgentProcessEntry["type"] => {
  if (
    value === "status" ||
    value === "tool" ||
    value === "diff" ||
    value === "error" ||
    value === "info" ||
    value === "thinking" ||
    value === "question" ||
    value === "subagent"
  ) {
    return value;
  }
  return "status";
};

export const normalizeProcessEntryState = (value: unknown): AgentProcessEntry["state"] | undefined => {
  if (value === "running" || value === "completed" || value === "warning" || value === "error" || value === "interrupted") return value;
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
    normalized === "deleted" ||
    normalized === "skipped" ||
    normalized === "interrupted"
  ) {
    return "cancelled";
  }
  return "pending";
};

const getPlanStepTitle = (step: UnknownRecord, index: number) => {
  const title =
    getStringField(step, "step") ||
    getStringField(step, "title") ||
    getStringField(step, "text") ||
    getStringField(step, "content") ||
    getStringField(step, "subject") ||
    getStringField(step, "description") ||
    getStringField(step, "name");
  return title?.trim() || getPlanStepFallbackTitle(index);
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

/**
 * Extract a structured task snapshot from a completed tool result.
 *
 * Pi extensions conventionally return `{ content, details }`; `rpiv-todo`
 * stores its current task list in `details.tasks`. This deliberately only
 * accepts a `tasks` field. Treating arbitrary result `items` as plan steps
 * would make search/list tools appear as task plans in HPP.
 */
export const isTodoPlanToolEvent = (event: AgentEvent) => {
  const tokens = [event.toolName, event.tool, event.name, event.toolKind]
    .map((value) => normalizeEventToken(value));
  return tokens.some((token) => token === "todo" || token.includes("todo"));
};

/**
 * Todo extensions commonly return a complete session-wide snapshot while the
 * result text identifies only the task changed by this call (for example,
 * `Updated #7`). Keep that changed id so the caller can scope the snapshot to
 * the current turn instead of re-displaying historical tasks.
 */
export const getTodoPlanStepIdsFromToolResult = (event: AgentEvent): string[] => {
  if (!isTodoPlanToolEvent(event)) return [];
  let serialized = "";
  try {
    serialized = JSON.stringify([
      event.content,
      event.outputText,
      event.result,
      event.output,
      event.details,
      event.toolResult,
    ]) || "";
  } catch {
    serialized = "";
  }
  const ids: string[] = [];
  for (const match of serialized.matchAll(/#([A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
    const id = match[1];
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
};

export const normalizePlanStepsFromToolResult = (event: AgentEvent): AgentProcessStep[] => {
  const detail = asRecord(event.detail);
  const eventDetails = asRecord(event.details);
  const result = asRecord(event.result);
  const resultDetails = asRecord(result.details);
  const output = asRecord(event.output);
  const outputDetails = asRecord(output.details);
  const toolResult = asRecord(event.toolResult);
  const toolResultDetails = asRecord(toolResult.details);
  const candidates = [
    eventDetails.tasks,
    detail.tasks,
    result.tasks,
    resultDetails.tasks,
    output.tasks,
    outputDetails.tasks,
    toolResult.tasks,
    toolResultDetails.tasks,
  ];

  for (const candidate of candidates) {
    const steps = normalizePlanSteps(candidate);
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
  const hasModified = flags.modified || Object.keys(runtime.changeSummaryFiles).length > 0;
  const hasOperated = flags.operated || hasModified || flags.verified;
  const hasFinished = flags.verified;
  const terminalAtAnalyze = !!terminalStatus && !hasOperated && !hasModified && !flags.verified;
  const terminalAtOperate = !!terminalStatus && hasOperated && !hasModified && !flags.verified;
  const terminalAtModify = !!terminalStatus && hasModified && !flags.verified;
  const terminalAtVerify = !!terminalStatus && flags.verified;
  const steps: AgentProcessStep[] = [
    {
      id: "inferred-analyze",
      title: uiText.process.inferredSteps.analyze,
      status: terminalAtAnalyze
        ? terminalStatus
        : hasOperated || hasModified || hasFinished || terminalAtOperate || terminalAtModify || terminalAtVerify
        ? "completed"
        : flags.analyzed
          ? "running"
          : "pending",
    },
    {
      id: "inferred-operate",
      title: uiText.process.inferredSteps.operate,
      status: terminalAtOperate
        ? terminalStatus
        : hasModified || hasFinished || terminalAtModify || terminalAtVerify
        ? "completed"
        : hasOperated
          ? "running"
          : "pending",
    },
  ];
  if (hasModified) {
    steps.push({
      id: "inferred-modify",
      title: uiText.process.inferredSteps.modify,
      status: terminalAtModify
        ? terminalStatus
        : hasFinished || terminalAtVerify
          ? "completed"
          : "running",
    });
  }
  steps.push({
    id: "inferred-verify",
    title: uiText.process.inferredSteps.verify,
    status: terminalAtVerify ? terminalStatus : hasFinished ? "completed" : "pending",
  });

  return steps;
};
