import { useState, useRef, useEffect, useLayoutEffect, useCallback, type PointerEvent as ReactPointerEvent, type UIEvent as ReactUIEvent } from "react";
import { flushSync } from "react-dom";
import { useChatStore, type ModelInfo, type FileDiff, type AgentProcessEntry, type AgentProcessFile } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import { useAppStore } from "@/stores/app-store";
import { getAgentName, getAgentPlanModeTooltip } from "@/lib/agents";
import { applySessionModels, getSessionModel, saveSessionModel, getSessionThinking, saveSessionThinking } from "@/hooks/useDataPersistence";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import { FilePreview } from "@/components/shared/FilePreview";
import { ProcessBlock } from "./ProcessBlock";
import "./ChatPanel.css";

const MODEL_FETCH_RETRY_DELAYS = [0, 500, 1000, 2000, 4000, 8000];
const THINKING_PREVIEW_CHAR_LIMIT = 240;
const QUESTIONNAIRE_RESIZE_MIN_HEIGHT = 180;
const QUESTIONNAIRE_RESIZE_MIN_MESSAGES_HEIGHT = 140;
const THINKING_REPEAT_MIN_PATTERN_LENGTH = 60;
const THINKING_REPEAT_MIN_COUNT = 3;
const SCROLL_BOTTOM_THRESHOLD = 50;
const AGENT_SETTINGS_UPDATED_EVENT = "agent-settings-updated";

const getThinkingPreview = (value?: string) => {
  const preview = value?.replace(/\s+/g, " ").trim();
  if (!preview) return "思考中";
  return preview.length > THINKING_PREVIEW_CHAR_LIMIT
    ? `${preview.slice(0, THINKING_PREVIEW_CHAR_LIMIT)}...`
    : preview;
};

const createProcessEntryId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `process-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

type NormalizedToolKind =
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

const stringifyProcessValue = (value: unknown) => {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const truncateProcessDetail = (value: string) => {
  const maxLength = 1200;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
};

const normalizeThinkingRepeatUnit = (value: string) =>
  value
    .replace(/[`"'“”‘’]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const getRepeatedThinkingPattern = (value: string) => {
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

const getToolKey = (event: any) => {
  const raw = event.toolCallId || event.callId || event.id || event.toolName || event.name || "tool";
  return String(raw);
};

const getToolName = (event: any) => {
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

const getToolProcessFiles = (event: any): AgentProcessFile[] => {
  if (Array.isArray(event.files)) {
    return event.files
      .filter((file: AgentProcessFile) => typeof file?.file === "string" && file.file.trim())
      .map((file: AgentProcessFile) => ({
        ...file,
        label: file.label || getFileName(file.file),
      }));
  }

  if (!event.filePath) return [];
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
    additions: event.additions,
    deletions: event.deletions,
    status: event.patch ? "modified" : undefined,
  }];
};

const normalizeToolKind = (value: unknown): NormalizedToolKind => {
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

const getQuestionTitle = (running = false, isError = false) => {
  if (isError) return "用户选择处理失败";
  return running ? "等待用户选择" : "已提交选择";
};

const getUIResponsePayload = (response: {
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

type AskQuestionOption = {
  label: string;
  value?: string;
  description?: string;
  preview?: string;
  hasPreview?: boolean;
};

type AskQuestionPayload = {
  id?: string;
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: AskQuestionOption[];
};

const getNestedQuestionValue = (value: any, path: string[]): any => {
  let current = value;
  for (const key of path) {
    if (current === undefined || current === null) return undefined;
    current = current[key];
  }
  return current;
};

const readFirstQuestionValue = (value: any, paths: string[][]): any => {
  for (const path of paths) {
    const found = getNestedQuestionValue(value, path);
    if (found !== undefined && found !== null && found !== "") return found;
  }
  return undefined;
};

const parseJsonQuestionValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const normalizeAskOptions = (value: unknown): AskQuestionOption[] => {
  if (!Array.isArray(value)) return [];
  return value.map((option: any, index) => {
    if (typeof option === "string") return { label: option, value: option };
    return {
      label: String(option?.label ?? option?.value ?? option?.text ?? option?.title ?? `选项 ${index + 1}`),
      value: option?.value === undefined || option?.value === null ? undefined : String(option.value),
      description: typeof option?.description === "string" ? option.description : undefined,
      preview: typeof option?.preview === "string" ? option.preview : undefined,
      hasPreview: !!option?.hasPreview,
    };
  });
};

const normalizeAskQuestions = (value: unknown): AskQuestionPayload[] => {
  const parsedValue = parseJsonQuestionValue(value);
  const rawQuestions = Array.isArray(parsedValue)
    ? parsedValue
    : parsedValue && typeof parsedValue === "object" && Array.isArray((parsedValue as any).questions)
      ? (parsedValue as any).questions
      : [];

  if (rawQuestions.length === 0 && parsedValue && typeof parsedValue === "object") {
    const raw = parsedValue as any;
    const question = readFirstQuestionValue(raw, [
      ["question"],
      ["title"],
      ["prompt"],
      ["message"],
      ["placeholder"],
      ["detail", "question"],
      ["detail", "title"],
      ["detail", "prompt"],
      ["detail", "message"],
      ["params", "question"],
      ["params", "prompt"],
      ["params", "message"],
    ]);
    const options = readFirstQuestionValue(raw, [
      ["options"],
      ["choices"],
      ["items"],
      ["detail", "options"],
      ["detail", "choices"],
      ["params", "options"],
      ["params", "choices"],
    ]);
    if (question || Array.isArray(options)) {
      return [{
        id: typeof raw.id === "string" ? raw.id : undefined,
        question: String(question || "请选择答案"),
        header: typeof raw.header === "string" ? raw.header : undefined,
        multiSelect: !!(raw.multiSelect ?? raw.multiple ?? raw.detail?.multiSelect ?? raw.params?.multiSelect),
        options: normalizeAskOptions(options),
      }];
    }
  }

  if (rawQuestions.length === 0 && typeof parsedValue === "string" && parsedValue.trim()) {
    return [{ question: parsedValue.trim(), options: [] }];
  }

  return rawQuestions.map((raw: any, questionIndex) => {
    const options = normalizeAskOptions(raw?.options ?? raw?.choices);
    return {
      id: typeof raw?.id === "string" ? raw.id : undefined,
      question: String(raw?.question ?? raw?.prompt ?? raw?.title ?? raw?.message ?? `问题 ${questionIndex + 1}`),
      header: typeof raw?.label === "string" ? raw.label : typeof raw?.header === "string" ? raw.header : undefined,
      multiSelect: !!(raw?.multiSelect ?? raw?.multiple),
      options,
    };
  });
};

const normalizeAskQuestionsFromCandidates = (...values: unknown[]): AskQuestionPayload[] => {
  for (const value of values) {
    const questions = normalizeAskQuestions(value);
    if (questions.length > 0) return questions;
  }

  const optionSource = values.find((value: any) =>
    Array.isArray(value?.options) ||
    Array.isArray(value?.choices) ||
    Array.isArray(value?.detail?.options) ||
    Array.isArray(value?.params?.options)
  ) as any;
  const promptSource = values.find((value: any) =>
    typeof value === "string" ||
    typeof value?.question === "string" ||
    typeof value?.prompt === "string" ||
    typeof value?.message === "string" ||
    typeof value?.title === "string" ||
    typeof value?.detail?.question === "string" ||
    typeof value?.detail?.prompt === "string" ||
    typeof value?.detail?.message === "string" ||
    typeof value?.detail?.title === "string"
  ) as any;

  const question = typeof promptSource === "string"
    ? promptSource
    : readFirstQuestionValue(promptSource, [
        ["question"],
        ["prompt"],
        ["message"],
        ["title"],
        ["detail", "question"],
        ["detail", "prompt"],
        ["detail", "message"],
        ["detail", "title"],
      ]);
  const options = readFirstQuestionValue(optionSource, [
    ["options"],
    ["choices"],
    ["detail", "options"],
    ["detail", "choices"],
    ["params", "options"],
    ["params", "choices"],
  ]);

  if (question || Array.isArray(options)) {
    return [{
      question: String(question || "请选择答案"),
      options: normalizeAskOptions(options),
    }];
  }

  return [];
};

const getToolDetail = (event: any) => {
  const detail = typeof event.detail === "string" ? event.detail : "";
  if (detail.trim()) return truncateProcessDetail(detail);
  if (event.isError && event.errorText) return truncateProcessDetail(String(event.errorText));
  if (event.outputText && ["run_command", "search_files", "search_text", "web_fetch", "web_search", "unknown"].includes(normalizeToolKind(event.toolKind))) {
    return truncateProcessDetail(String(event.outputText));
  }
  return undefined;
};

const getToolSummary = (event: any, running = false): string => {
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

const normalizeProcessEntryType = (value: unknown): AgentProcessEntry["type"] => {
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

const normalizeProcessEntryState = (value: unknown): AgentProcessEntry["state"] | undefined => {
  if (value === "running" || value === "completed" || value === "error" || value === "interrupted") return value;
  return undefined;
};

function DiffBlock({ diffs }: { diffs: FileDiff[] }) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const toggleFile = (file: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  return (
    <div className="chat-diffs">
      {diffs.map((diff, i) => {
        const isExpanded = expandedFiles.has(diff.file);
        const fileName = diff.file.split(/[/\\]/).pop() || diff.file;
        return (
          <div key={`${diff.file}-${i}`} className="chat-diff-file">
            <button className="chat-diff-file-header" onClick={() => toggleFile(diff.file)}>
              <svg
                width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
              <span className="chat-diff-file-icon">
                {diff.status === "added" ? "+" : diff.status === "deleted" ? "-" : "~"}
              </span>
              <span className="chat-diff-file-name">{diff.file}</span>
              <span className="chat-diff-file-stats">
                {diff.additions > 0 && <span className="chat-diff-add">+{diff.additions}</span>}
                {diff.deletions > 0 && <span className="chat-diff-del">-{diff.deletions}</span>}
              </span>
            </button>
            {isExpanded && (
              <pre className="chat-diff-content">
                {diff.patch.split("\n").map((line, j) => {
                  let cls = "chat-diff-line";
                  if (line.startsWith("+")) cls += " chat-diff-add-line";
                  else if (line.startsWith("-")) cls += " chat-diff-del-line";
                  else if (line.startsWith("@@")) cls += " chat-diff-header-line";
                  return (
                    <span key={j} className={cls}>
                      {line}
                    </span>
                  );
                })}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function QuestionnairePanel({
  questions,
  onSubmit,
  onCancel,
}: {
  questions: AskQuestionPayload[];
  onSubmit: (answers: unknown[]) => void;
  onCancel: () => void;
}) {
  const [singleChoice, setSingleChoice] = useState<Record<number, string>>({});
  const [multiChoice, setMultiChoice] = useState<Record<number, string[]>>({});
  const [customText, setCustomText] = useState<Record<number, string>>({});

  const buildAnswers = () => questions.map((question, questionIndex) => {
    const custom = customText[questionIndex]?.trim();
    if (custom) {
      return {
        id: question.id || `question-${questionIndex + 1}`,
        questionIndex,
        question: question.question,
        kind: "custom",
        answer: custom,
        value: custom,
        label: custom,
        wasCustom: true,
      };
    }
    if (question.multiSelect) {
      const selectedLabels = multiChoice[questionIndex] || [];
      const selectedOptions = (question.options || []).filter((option) => selectedLabels.includes(option.label));
      return {
        id: question.id || `question-${questionIndex + 1}`,
        questionIndex,
        question: question.question,
        kind: "multi",
        answer: null,
        selected: selectedLabels,
        selectedOptions,
        values: selectedOptions.map((option) => option.value ?? option.label),
      };
    }
    const selectedLabel = singleChoice[questionIndex] || null;
    const selectedOption = selectedLabel
      ? question.options?.find((option) => option.label === selectedLabel)
      : undefined;
    return {
      id: question.id || `question-${questionIndex + 1}`,
      questionIndex,
      question: question.question,
      kind: "option",
      answer: selectedOption?.value ?? selectedLabel,
      value: selectedOption?.value ?? selectedLabel,
      label: selectedLabel,
      wasCustom: false,
      index: selectedOption ? (question.options || []).findIndex((option) => option.label === selectedOption.label) + 1 : undefined,
      selectedOption,
    };
  });

  const hasAnswer = questions.every((question, questionIndex) => {
    if (customText[questionIndex]?.trim()) return true;
    if (question.multiSelect) return (multiChoice[questionIndex] || []).length > 0;
    if (!question.options || question.options.length === 0) return false;
    return !!singleChoice[questionIndex];
  });

  return (
    <div className="chat-questionnaire">
      <div className="chat-questionnaire-header">
        <span>需要你的选择</span>
        <button type="button" onClick={onCancel}>取消</button>
      </div>
      <div className="chat-questionnaire-list">
        {questions.map((question, questionIndex) => (
          <div className="chat-questionnaire-question" key={`${question.question}-${questionIndex}`}>
            <div className="chat-questionnaire-title">
              {question.header && <span>{question.header}</span>}
              <strong>{question.question}</strong>
            </div>
            {!!question.options?.length && (
              <div className="chat-questionnaire-options">
                {question.options.map((option) => {
                  const checked = question.multiSelect
                    ? (multiChoice[questionIndex] || []).includes(option.label)
                    : singleChoice[questionIndex] === option.label;
                  return (
                    <button
                      type="button"
                      key={option.label}
                      className={`chat-questionnaire-option ${checked ? "selected" : ""}`}
                      onClick={() => {
                        if (question.multiSelect) {
                          const prev = multiChoice[questionIndex] || [];
                          setMultiChoice({
                            ...multiChoice,
                            [questionIndex]: checked ? prev.filter((item) => item !== option.label) : [...prev, option.label],
                          });
                        } else {
                          setSingleChoice({ ...singleChoice, [questionIndex]: option.label });
                        }
                      }}
                    >
                      <span className="chat-questionnaire-mark" />
                      <span className="chat-questionnaire-option-text">
                        <span>{option.label}</span>
                        {option.description && <small>{option.description}</small>}
                        {option.preview && <pre>{option.preview}</pre>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {!question.multiSelect && (
              <textarea
                className="chat-questionnaire-custom"
                rows={2}
                placeholder="自定义回答"
                value={customText[questionIndex] || ""}
                onChange={(event) => setCustomText({ ...customText, [questionIndex]: event.target.value })}
              />
            )}
          </div>
        ))}
      </div>
      <div className="chat-questionnaire-actions">
        <button type="button" onClick={() => onSubmit(buildAnswers())} disabled={!hasAnswer}>
          提交回答
        </button>
      </div>
    </div>
  );
}

export function ChatPanel({ sendKey = "Enter" }: { sendKey?: string }) {
  const {
    messages,
    isStreaming,
    activeAgentId,
    addMessage,
    setStreaming,
    currentModel,
    setCurrentModel,
    availableModels,
    setAvailableModels,
    favoriteModels,
    toggleFavorite,
    thinkingLevel,
    setThinkingLevel,
    pendingFiles,
    removePendingFile,
    clearPendingFiles,
    loadSessionMessages,
    sessionMessages,
    toggleAssistantProcess,
    toggleAssistantProcessEntry,
  } = useChatStore();

  const { activeProjectId, projects, activeSessionId, agentStatuses, markSessionInitialized, isSessionInitialized } = useProjectStore();
  const { triggerAddProject } = useAppStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const activeSession = activeProject?.sessions.find((s) => s.id === activeSessionId);
  const activeSessionInitialized = activeSessionId ? isSessionInitialized(activeSessionId) : false;

  const [input, setInput] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [pendingImages, setPendingImages] = useState<{ id: string; src: string; name: string; file: File }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [userMsgHistoryOpen, setUserMsgHistoryOpen] = useState(false);
  const [questionnairePaneHeight, setQuestionnairePaneHeight] = useState<number | null>(null);
  const [planModeEnabled, setPlanModeEnabled] = useState(false);
  const [pendingUIResponse, setPendingUIResponse] = useState<{
    sessionId: string;
    requestId?: string;
    method?: string;
    entryId?: string;
    questions?: AskQuestionPayload[];
  } | null>(null);
  const pendingUIResponseRef = useRef<typeof pendingUIResponse>(null);
  const userMsgHistoryRef = useRef<HTMLDivElement>(null);
  const chatPanelRef = useRef<HTMLDivElement>(null);
  const questionnaireResizeCleanupRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const modelFetchRunIdRef = useRef(0);
  const streamBufferRef = useRef("");
  const thinkingBufferRef = useRef("");
  const thinkingEntryIdRef = useRef<string | null>(null);
  const processActiveRef = useRef(false);
  const activeToolEntryRef = useRef<Record<string, string>>({});
  const activeToolFileRef = useRef<Record<string, AgentProcessFile[]>>({});
  const streamWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRuntimeRef = useRef<Record<string, {
    streamBuffer: string;
    thinkingBuffer: string;
    thinkingEntryId: string | null;
    processActive: boolean;
    streamStarted: boolean;
    activeToolEntry: Record<string, string>;
    activeToolFile: Record<string, AgentProcessFile[]>;
    streamWatchdog: ReturnType<typeof setTimeout> | null;
    autoAbortReason: string | null;
    processTextEntryId: string | null;
    processTextEntryIds: string[];
    processTextHistory: string[];
    processTextBuffer: string;
  }>>({});
  const autoFollowBottomRef = useRef(true);
  const suppressAutoScrollUntilRef = useRef(0);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const currentSessionRunning = activeSessionId ? agentStatuses[activeSessionId] === "running" : isStreaming;
  const isAwaitingUIResponse = !!activeSessionId && pendingUIResponse?.sessionId === activeSessionId;
  const activeQuestionnaire = isAwaitingUIResponse && pendingUIResponse?.questions?.length
    ? pendingUIResponse
    : null;

  const setPendingUIResponseState = (next: typeof pendingUIResponse | ((current: typeof pendingUIResponse) => typeof pendingUIResponse)) => {
    const value = typeof next === "function" ? next(pendingUIResponseRef.current) : next;
    pendingUIResponseRef.current = value;
    setPendingUIResponse(value);
  };

  useEffect(() => {
    pendingUIResponseRef.current = pendingUIResponse;
  }, [pendingUIResponse]);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.loadData("settings").then((data: any) => {
      if (!cancelled) setPlanModeEnabled(!!data?.general?.planModeEnabled);
    });

    const handleAgentSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ planModeEnabled?: boolean }>).detail;
      if (typeof detail?.planModeEnabled === "boolean") {
        setPlanModeEnabled(detail.planModeEnabled);
      }
    };
    window.addEventListener(AGENT_SETTINGS_UPDATED_EVENT, handleAgentSettingsUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(AGENT_SETTINGS_UPDATED_EVENT, handleAgentSettingsUpdated);
    };
  }, []);

  const savePlanModeEnabled = async (nextPlanModeEnabled: boolean) => {
    setPlanModeEnabled(nextPlanModeEnabled);
    setModelOpen(false);
    setThinkingOpen(false);
    setExpandedProvider(null);
    const data = await window.electronAPI.loadData("settings") as any;
    const currentSettings = data && typeof data === "object" ? data : {};
    const nextSettings = {
      ...currentSettings,
      general: {
        ...(currentSettings.general || {}),
        planModeEnabled: nextPlanModeEnabled,
      },
    };
    await window.electronAPI.saveData("settings", nextSettings);
    window.dispatchEvent(new CustomEvent(AGENT_SETTINGS_UPDATED_EVENT, {
      detail: { planModeEnabled: nextPlanModeEnabled },
    }));
  };

  useEffect(() => {
    setQuestionnairePaneHeight(null);
  }, [activeQuestionnaire?.sessionId, activeQuestionnaire?.requestId, activeQuestionnaire?.entryId]);

  useEffect(() => {
    return () => {
      questionnaireResizeCleanupRef.current?.();
    };
  }, []);

  const getQuestionnairePaneHeight = useCallback((clientY: number) => {
    const panel = chatPanelRef.current;
    if (!panel) return null;

    const rect = panel.getBoundingClientRect();
    const header = panel.querySelector<HTMLElement>(".chat-header");
    const headerHeight = header?.offsetHeight ?? 36;
    const minHeight = Math.min(
      QUESTIONNAIRE_RESIZE_MIN_HEIGHT,
      Math.max(120, rect.height - headerHeight - 80)
    );
    const maxHeight = Math.max(
      minHeight,
      rect.height - headerHeight - QUESTIONNAIRE_RESIZE_MIN_MESSAGES_HEIGHT
    );
    const nextHeight = rect.bottom - clientY;

    return Math.min(Math.max(nextHeight, minHeight), maxHeight);
  }, []);

  const handleQuestionnaireResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activeQuestionnaire) return;
    event.preventDefault();
    questionnaireResizeCleanupRef.current?.();

    const applyHeight = (clientY: number) => {
      const nextHeight = getQuestionnairePaneHeight(clientY);
      if (nextHeight !== null) {
        setQuestionnairePaneHeight(nextHeight);
      }
    };

    const handleMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      applyHeight(moveEvent.clientY);
    };

    const stopResize = () => {
      document.body.classList.remove("chat-questionnaire-resizing");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      questionnaireResizeCleanupRef.current = null;
    };

    document.body.classList.add("chat-questionnaire-resizing");
    questionnaireResizeCleanupRef.current = stopResize;
    applyHeight(event.clientY);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }, [activeQuestionnaire, getQuestionnairePaneHeight]);

  const getDistanceFromScrollBottom = useCallback((el: HTMLDivElement) => {
    return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
  }, []);

  const updateScrollBottomState = useCallback((el = scrollRef.current) => {
    if (!el) return false;
    const shouldShow = getDistanceFromScrollBottom(el) > SCROLL_BOTTOM_THRESHOLD;
    setShowScrollBottom(shouldShow);
    return shouldShow;
  }, [getDistanceFromScrollBottom]);

  const handleMessagesScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    const awayFromBottom = updateScrollBottomState(event.currentTarget);
    autoFollowBottomRef.current = !awayFromBottom;
  }, [updateScrollBottomState]);

  // Track scroll position - show scroll-to-bottom button when scrolled up
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const awayFromBottom = updateScrollBottomState(el);
      autoFollowBottomRef.current = !awayFromBottom;
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => el.removeEventListener("scroll", handleScroll);
  }, [updateScrollBottomState]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (autoFollowBottomRef.current && Date.now() >= suppressAutoScrollUntilRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    updateScrollBottomState(el);
  }, [messages, activeSessionId, activeSessionInitialized, questionnairePaneHeight, updateScrollBottomState]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (autoFollowBottomRef.current && Date.now() >= suppressAutoScrollUntilRef.current) {
        el.scrollTop = el.scrollHeight;
      }
      updateScrollBottomState(el);
    });
    observer.observe(el);
    Array.from(el.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [messages, activeSessionId, activeSessionInitialized, updateScrollBottomState]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 150) + "px";
    }
  }, [input]);

  // Close user message history on outside click
  useEffect(() => {
    if (!userMsgHistoryOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (userMsgHistoryRef.current && !userMsgHistoryRef.current.contains(e.target as Node)) {
        setUserMsgHistoryOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [userMsgHistoryOpen]);

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    autoFollowBottomRef.current = true;
    setShowScrollBottom(false);
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (!current) return;
      current.scrollTop = current.scrollHeight;
      updateScrollBottomState(current);
    });
  }, [updateScrollBottomState]);

  // Scroll to a specific message
  const scrollToMessage = useCallback((msgId: string) => {
    const el = scrollRef.current;
    if (!el) return;
    const msgEl = el.querySelector(`[data-msg-id="${msgId}"]`);
    if (msgEl) {
      msgEl.scrollIntoView({ behavior: "smooth", block: "center" });
      // Brief background highlight matching theme
      const htmlEl = msgEl as HTMLElement;
      htmlEl.classList.add("chat-msg-highlight");
      setTimeout(() => {
        htmlEl.classList.remove("chat-msg-highlight");
      }, 1500);
    }
    setUserMsgHistoryOpen(false);
  }, []);

  const preserveScrollDuringLayoutChange = useCallback((action: () => void, anchor?: HTMLElement | null) => {
    const el = scrollRef.current;
    if (!el) {
      action();
      return;
    }

    const anchorTop = anchor?.getBoundingClientRect().top;
    const previousScrollTop = el.scrollTop;
    autoFollowBottomRef.current = false;
    suppressAutoScrollUntilRef.current = Date.now() + 300;

    action();

    requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (!current) return;
      if (anchor && typeof anchorTop === "number") {
        const nextTop = anchor.getBoundingClientRect().top;
        current.scrollTop += nextTop - anchorTop;
      } else {
        current.scrollTop = previousScrollTop;
      }
      const awayFromBottom = updateScrollBottomState(current);
      autoFollowBottomRef.current = !awayFromBottom;
    });
  }, [updateScrollBottomState]);

  const handleToggleAssistantProcess = useCallback((messageId: string, anchor?: HTMLElement | null) => {
    preserveScrollDuringLayoutChange(() => toggleAssistantProcess(messageId), anchor);
  }, [preserveScrollDuringLayoutChange, toggleAssistantProcess]);

  const handleToggleAssistantProcessEntry = useCallback((messageId: string, entryId: string, anchor?: HTMLElement | null) => {
    preserveScrollDuringLayoutChange(() => toggleAssistantProcessEntry(messageId, entryId), anchor);
  }, [preserveScrollDuringLayoutChange, toggleAssistantProcessEntry]);

  // Fetch models for the active session. No local config fallback is used; an
  // empty list should stay visible so backend/model discovery issues are clear.
  const fetchModels = async (sessionId: string, fetchRunId: number) => {
    for (const delay of MODEL_FETCH_RETRY_DELAYS) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const stillCurrent =
        modelFetchRunIdRef.current === fetchRunId &&
        useProjectStore.getState().activeSessionId === sessionId;
      if (!stillCurrent) return;

      try {
        const models = await window.electronAPI.agentGetModels(sessionId);
        const stillCurrentAfterFetch =
          modelFetchRunIdRef.current === fetchRunId &&
          useProjectStore.getState().activeSessionId === sessionId;
        if (!stillCurrentAfterFetch) return;

        if (models && models.length > 0) {
          setAvailableModels(models);
          const currentState = useChatStore.getState();
          const savedModel = currentState.currentModel;

          // Keep current model if available in the new list, otherwise use first
          if (savedModel && models.some(m => m.id === savedModel.id && m.provider === savedModel.provider)) {
            setCurrentModel(savedModel);
          } else {
            // Try to restore per-session persisted model from cache
            const persisted = getSessionModel(sessionId);
            if (persisted && models.some(m => m.id === persisted.id && m.provider === persisted.provider)) {
              setCurrentModel(persisted);
            } else {
              setCurrentModel(models[0]);
            }
          }
          return;
        }
      } catch {
        // Retry below; final empty state is handled after all attempts.
      }
    }

    if (
      modelFetchRunIdRef.current === fetchRunId &&
      useProjectStore.getState().activeSessionId === sessionId
    ) {
      setAvailableModels([]);
      useChatStore.setState({ currentModel: null });
    }
  };

  // Re-fetch models and restore thinking level when the active session backend is ready.
  useEffect(() => {
    const fetchRunId = ++modelFetchRunIdRef.current;

    if (!activeSessionId || !activeSession) {
      setAvailableModels([]);
      useChatStore.setState({ currentModel: null });
      return;
    }

    if (!activeSessionInitialized) {
      setAvailableModels([]);
      useChatStore.setState({ currentModel: null });
      return;
    }

    fetchModels(activeSessionId, fetchRunId);
    // Restore per-session thinking level (default to "medium" if none persisted)
    const persistedThinking = getSessionThinking(activeSessionId);
    const thinkingToSet = persistedThinking || "medium";
    setThinkingLevel(thinkingToSet);
    window.electronAPI.agentSetThinkingLevel(thinkingToSet);
  }, [activeSessionId, activeSession?.agentId, activeSessionInitialized]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
      if (thinkingRef.current && !thinkingRef.current.contains(e.target as Node)) setThinkingOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Auto-scroll to bottom only when user is already near bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !autoFollowBottomRef.current) return;
    if (getDistanceFromScrollBottom(el) < 100) {
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => updateScrollBottomState(el));
    }
  }, [messages, getDistanceFromScrollBottom, updateScrollBottomState]);

  // Instant scroll to bottom on session switch (no animation)
  // Also scroll when session initializes (messages become visible in DOM)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    autoFollowBottomRef.current = true;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      updateScrollBottomState(el);
    });
  }, [activeSessionId, activeSessionInitialized, updateScrollBottomState]);

  // Persist messages to sessionMessages whenever messages change (for restart survival)
  useEffect(() => {
    if (
      activeSessionId &&
      messages.length > 0 &&
      sessionMessages[activeSessionId] !== messages
    ) {
      loadSessionMessages(activeSessionId, messages);
    }
  }, [messages, activeSessionId, sessionMessages, loadSessionMessages]);

  // Subscribe to agent events
  useEffect(() => {
    const getRuntime = (sessionId: string) => {
      const existing = sessionRuntimeRef.current[sessionId];
      if (existing) return existing;
      const runtime = {
        streamBuffer: "",
        thinkingBuffer: "",
        thinkingEntryId: null,
        processActive: false,
        streamStarted: false,
        activeToolEntry: {},
        activeToolFile: {},
        streamWatchdog: null,
        autoAbortReason: null,
        processTextEntryId: null,
        processTextEntryIds: [],
        processTextHistory: [],
        processTextBuffer: "",
      };
      sessionRuntimeRef.current[sessionId] = runtime;
      return runtime;
    };

    const appendProcessEntry = (sessionId: string, entry: Omit<AgentProcessEntry, "id" | "timestamp"> & { id?: string; timestamp?: number }) => {
      const runtime = getRuntime(sessionId);
      if (!runtime.processActive) return;
      useChatStore.getState().appendLastAssistantProcessEntry({
        id: entry.id || createProcessEntryId(),
        timestamp: entry.timestamp || Date.now(),
        type: entry.type,
        title: entry.title,
        detail: entry.detail,
        files: entry.files,
        toolKind: entry.toolKind,
        command: entry.command,
        state: entry.state,
        expanded: entry.expanded,
      }, sessionId);
    };

    const finishThinkingEntry = (sessionId: string) => {
      const runtime = getRuntime(sessionId);
      if (runtime.thinkingEntryId) {
        useChatStore.getState().updateLastAssistantProcessEntry(runtime.thinkingEntryId, {
          state: "completed",
        }, sessionId);
      }
      runtime.thinkingEntryId = null;
      runtime.thinkingBuffer = "";
    };

    const abortRepeatedThinking = (sessionId: string, pattern: string, repeatCount: number) => {
      const runtime = getRuntime(sessionId);
      if (runtime.autoAbortReason) return;

      runtime.autoAbortReason = "repeated-thinking";
      if (runtime.streamWatchdog) {
        clearTimeout(runtime.streamWatchdog);
        runtime.streamWatchdog = null;
      }

      useChatStore.getState().appendLastAssistantProcessEntry({
        id: createProcessEntryId(),
        timestamp: Date.now(),
        type: "error",
        title: "检测到重复思考，已自动中断",
        detail: `最近思考内容连续重复 ${repeatCount} 次:\n${pattern}`,
        state: "interrupted",
        expanded: true,
      }, sessionId);
      useChatStore.getState().finishLastAssistantProcess(Date.now(), "interrupted", sessionId);

      runtime.processActive = false;
      runtime.streamStarted = false;
      runtime.activeToolEntry = {};
      runtime.activeToolFile = {};
      runtime.streamBuffer = "";
      runtime.thinkingBuffer = "";
      runtime.thinkingEntryId = null;
      runtime.processTextEntryId = null;
      runtime.processTextEntryIds = [];
      runtime.processTextHistory = [];
      runtime.processTextBuffer = "";

      setPendingUIResponseState((current) => current?.sessionId === sessionId ? null : current);
      if (sessionId === useProjectStore.getState().activeSessionId) setStreaming(false);
      useProjectStore.getState().setAgentStatus(sessionId, "idle");

      void window.electronAPI.agentAbort(sessionId).catch((err) => {
        console.error("[agent] auto abort repeated thinking failed:", err);
      });
    };

    const appendAssistantProcessText = (sessionId: string, delta: string) => {
      if (!delta) return;
      const runtime = getRuntime(sessionId);
      runtime.streamBuffer += delta;
      runtime.processTextBuffer += delta;

      if (runtime.processTextEntryId) {
        useChatStore.getState().updateLastAssistantProcessEntry(runtime.processTextEntryId, {
          title: "正文输出",
          detail: runtime.processTextBuffer,
          state: "running",
        }, sessionId);
        return;
      }

      const entryId = createProcessEntryId();
      runtime.processTextEntryId = entryId;
      runtime.processTextEntryIds.push(entryId);
      appendProcessEntry(sessionId, {
        id: entryId,
        type: "info",
        title: "正文输出",
        detail: runtime.processTextBuffer,
        state: "running",
      });
    };

    const finishAssistantProcessText = (sessionId: string) => {
      const runtime = getRuntime(sessionId);
      if (runtime.processTextEntryId) {
        useChatStore.getState().updateLastAssistantProcessEntry(runtime.processTextEntryId, {
          title: "正文输出",
          detail: runtime.processTextBuffer,
          state: "completed",
        }, sessionId);
        if (runtime.processTextBuffer.trim()) {
          runtime.processTextHistory.push(runtime.processTextBuffer);
        }
      }
      runtime.processTextEntryId = null;
      runtime.processTextBuffer = "";
    };

    const replaceAssistantProcessText = (sessionId: string, content: string) => {
      const runtime = getRuntime(sessionId);
      const delta = content.startsWith(runtime.streamBuffer)
        ? content.slice(runtime.streamBuffer.length)
        : content;
      if (delta) appendAssistantProcessText(sessionId, delta);
    };

    const normalizeStreamText = (value: string) => value.replace(/\s+/g, " ").trim();

    const stripProcessTextPrefixFromFinal = (sessionId: string, finalContent: string) => {
      const runtime = getRuntime(sessionId);
      let remaining = finalContent.trim();
      for (const text of runtime.processTextHistory.slice(0, -1)) {
        const prefix = text.trim();
        const next = remaining.trimStart();
        if (prefix && next.startsWith(prefix)) {
          remaining = next.slice(prefix.length).trimStart();
        }
      }
      return remaining.trim();
    };

    const moveFinalAssistantProcessTextToBubble = (sessionId: string, finalContent: string) => {
      const runtime = getRuntime(sessionId);
      const lastIndex = runtime.processTextHistory.length - 1;
      if (lastIndex < 0) return;
      const lastText = runtime.processTextHistory[lastIndex];
      const lastEntryId = runtime.processTextEntryIds[lastIndex];
      if (!lastEntryId || normalizeStreamText(lastText) !== normalizeStreamText(finalContent)) return;
      useChatStore.getState().removeLastAssistantProcessEntries([lastEntryId], sessionId);
      runtime.processTextEntryIds.splice(lastIndex, 1);
      runtime.processTextHistory.splice(lastIndex, 1);
    };

    const appendThinkingDelta = (sessionId: string, delta: string) => {
      if (!delta) return;
      const runtime = getRuntime(sessionId);
      runtime.thinkingBuffer += delta;
      const thinkingPreview = getThinkingPreview(runtime.thinkingBuffer);

      if (runtime.thinkingEntryId) {
        useChatStore.getState().updateLastAssistantProcessEntry(runtime.thinkingEntryId, {
          title: `正在思考: ${thinkingPreview}`,
          detail: runtime.thinkingBuffer,
          state: "running",
        }, sessionId);
      } else {
        const entryId = createProcessEntryId();
        runtime.thinkingEntryId = entryId;
        appendProcessEntry(sessionId, {
          id: entryId,
          type: "thinking",
          title: `正在思考: ${thinkingPreview}`,
          detail: runtime.thinkingBuffer,
          state: "running",
          expanded: false,
        });
      }

      const repeatedPattern = getRepeatedThinkingPattern(runtime.thinkingBuffer);
      if (repeatedPattern) {
        abortRepeatedThinking(sessionId, repeatedPattern.pattern, repeatedPattern.repeatCount);
      }
    };

    const getPendingUIFromEvent = (event: any, sessionId: string, entryId: string) => {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      const method = String(event.method || detail.method || event.kind || event.toolName || "").trim();
      const normalizedMethod =
        method === "custom" && detail.kind === "ask_user_question"
          ? "ask_user_question"
          : method;
      const questions = normalizeAskQuestionsFromCandidates(
        event.questions,
        detail.questions,
        event.args?.questions,
        event.input?.questions,
        event,
        detail,
        event.args,
        event.input,
        event.detail
      );
      const fallbackQuestion =
        questions.length > 0
          ? questions
          : normalizeAskQuestionsFromCandidates(
              event.question,
              event.prompt,
              event.message,
              event.title,
              detail.question,
              detail.prompt,
              detail.message,
              detail.title
            );
      return {
        sessionId,
        requestId: typeof event.requestId === "string"
          ? event.requestId
          : typeof event.id === "string"
            ? event.id
            : typeof detail.id === "string"
              ? detail.id
              : undefined,
        method: normalizedMethod || undefined,
        entryId,
        questions: fallbackQuestion.length > 0 ? fallbackQuestion : [{ question: "请回答 Agent 的问题", options: [] }],
      };
    };

    const clearStreamWatchdog = (sessionId?: string) => {
      if (!sessionId) {
        if (streamWatchdogRef.current) {
          clearTimeout(streamWatchdogRef.current);
          streamWatchdogRef.current = null;
        }
        return;
      }
      const runtime = getRuntime(sessionId);
      if (runtime.streamWatchdog) {
        clearTimeout(runtime.streamWatchdog);
        runtime.streamWatchdog = null;
      }
    };

    const completeAssistantStream = (
      currentSessionId: string,
      content?: string,
      timedOut = false
    ) => {
      const runtime = getRuntime(currentSessionId);
      clearStreamWatchdog(currentSessionId);
      finishAssistantProcessText(currentSessionId);
      const finalContent = stripProcessTextPrefixFromFinal(currentSessionId, content || runtime.streamBuffer);
      if (finalContent.trim().length > 0) {
        runtime.streamBuffer = finalContent;
        useChatStore.getState().updateLastAssistant(finalContent, currentSessionId);
        moveFinalAssistantProcessTextToBubble(currentSessionId, finalContent);
        useChatStore.getState().collapseLastAssistantProcess(currentSessionId);
      } else if (timedOut) {
        useChatStore.getState().appendLastAssistantProcessEntry({
          id: createProcessEntryId(),
          timestamp: Date.now(),
          type: "error",
          title: "未收到响应结束事件",
          detail: "Agent 长时间没有返回新的输出，已停止等待。",
          state: "error",
          expanded: true,
        }, currentSessionId);
      }
      finishThinkingEntry(currentSessionId);
      if (currentSessionId === useProjectStore.getState().activeSessionId) setStreaming(false);
      useChatStore.getState().finishLastAssistantProcess(Date.now(), "completed", currentSessionId);
      runtime.processActive = false;
      runtime.streamStarted = false;
      runtime.activeToolEntry = {};
      runtime.activeToolFile = {};
      runtime.thinkingEntryId = null;
      runtime.processTextEntryId = null;
      runtime.processTextEntryIds = [];
      runtime.processTextHistory = [];
      runtime.processTextBuffer = "";
      if (currentSessionId) {
        const activeId = useProjectStore.getState().activeSessionId;
        // Only show "completed" notification if the user wasn't watching this session
        useProjectStore.getState().setAgentStatus(
          currentSessionId,
          currentSessionId === activeId ? "idle" : timedOut ? "error" : "completed"
        );
      }
    };

    const failAssistantStream = (currentSessionId: string, title: string, detail?: string) => {
      const runtime = getRuntime(currentSessionId);
      clearStreamWatchdog(currentSessionId);
      finishAssistantProcessText(currentSessionId);
      finishThinkingEntry(currentSessionId);

      const errorContent = detail?.trim()
        ? `${title}\n\n${detail.trim()}`
        : title;
      if (errorContent.trim()) {
        runtime.streamBuffer = errorContent;
        useChatStore.getState().updateLastAssistant(errorContent, currentSessionId);
      }

      useChatStore.getState().appendLastAssistantProcessEntry({
        id: createProcessEntryId(),
        timestamp: Date.now(),
        type: "error",
        title,
        detail,
        state: "error",
        expanded: true,
      }, currentSessionId);
      useChatStore.getState().finishLastAssistantProcess(Date.now(), "interrupted", currentSessionId);

      runtime.processActive = false;
      runtime.streamStarted = false;
      runtime.activeToolEntry = {};
      runtime.activeToolFile = {};
      runtime.streamBuffer = "";
      runtime.thinkingBuffer = "";
      runtime.thinkingEntryId = null;
      runtime.processTextEntryId = null;
      runtime.processTextEntryIds = [];
      runtime.processTextHistory = [];
      runtime.processTextBuffer = "";
      runtime.autoAbortReason = null;

      if (currentSessionId === useProjectStore.getState().activeSessionId) setStreaming(false);
      useProjectStore.getState().setAgentStatus(currentSessionId, "error");
    };

    const refreshStreamWatchdog = (currentSessionId: string) => {
      const runtime = getRuntime(currentSessionId);
      clearStreamWatchdog(currentSessionId);
      if (!runtime.processActive) return;
      runtime.streamWatchdog = setTimeout(() => {
        completeAssistantStream(currentSessionId, undefined, true);
      }, 45000);
    };

    const ensureAssistantContinuation = (currentSessionId: string) => {
      const runtime = getRuntime(currentSessionId);
      if (runtime.processActive) return runtime;

      runtime.processActive = true;
      runtime.streamStarted = true;
      runtime.autoAbortReason = null;
      useChatStore.getState().startAssistantProcess(Date.now(), currentSessionId);
      if (currentSessionId === useProjectStore.getState().activeSessionId) setStreaming(true);
      useProjectStore.getState().setAgentStatus(currentSessionId, "running");
      return runtime;
    };

    const unsubscribe = window.electronAPI.onAgentEvent((event: any) => {
      // Always read from store to avoid stale closure (useEffect deps=[])
      const currentSessionId = typeof event.sessionId === "string"
        ? event.sessionId
        : useProjectStore.getState().activeSessionId;
      if (!currentSessionId) return;
      const runtime = getRuntime(currentSessionId);
      if (
        event.type !== "message_start" &&
        event.type !== "stream_start" &&
        event.type !== "stream_snapshot" &&
        event.type !== "stream_end" &&
        event.type !== "agent_end" &&
        event.type !== "agent_disconnected"
      ) {
        refreshStreamWatchdog(currentSessionId);
      }
      switch (event.type) {
        case "message_start":
          if (runtime.processActive || runtime.streamStarted) {
            clearStreamWatchdog(currentSessionId);
            finishThinkingEntry(currentSessionId);
            useChatStore.getState().finishLastAssistantProcess(Date.now(), "completed", currentSessionId);
          }
          runtime.streamBuffer = "";
          runtime.thinkingBuffer = "";
          runtime.thinkingEntryId = null;
          runtime.streamStarted = false;
          runtime.activeToolEntry = {};
          runtime.activeToolFile = {};
          runtime.autoAbortReason = null;
          runtime.processTextEntryId = null;
          runtime.processTextEntryIds = [];
          runtime.processTextHistory = [];
          runtime.processTextBuffer = "";
          setPendingUIResponseState((current) => current?.sessionId === currentSessionId ? null : current);
          useChatStore.getState().startAssistantProcess(Date.now(), currentSessionId);
          runtime.processActive = true;
          const messagePreview = event.content ?
            (event.content.length > 50 ? event.content.substring(0, 50) + "..." : event.content) :
            "用户消息";
          appendProcessEntry(currentSessionId, {
            type: "status",
            title: `收到消息: "${messagePreview}"`,
            detail: event.content ? truncateProcessDetail(String(event.content)) : undefined,
            state: "completed",
          });
          break;
        case "stream_start":
          const alreadyStarted = runtime.streamStarted;
          flushSync(() => {
            if (!alreadyStarted) {
              runtime.streamBuffer = "";
              runtime.thinkingBuffer = "";
              runtime.thinkingEntryId = null;
              runtime.processTextEntryId = null;
              runtime.processTextEntryIds = [];
              runtime.processTextHistory = [];
              runtime.processTextBuffer = "";
            }
            if (currentSessionId === useProjectStore.getState().activeSessionId) setStreaming(true);
            runtime.processActive = true;
            runtime.streamStarted = true;
            runtime.autoAbortReason = null;
            runtime.activeToolEntry = {};
            runtime.activeToolFile = {};
            if (!alreadyStarted) {
              useChatStore.getState().startAssistantProcess(Date.now(), currentSessionId);
            }
            if (currentSessionId) useProjectStore.getState().setAgentStatus(currentSessionId, "running");
          });
          if (!alreadyStarted) {
            appendProcessEntry(currentSessionId, {
              type: "status",
              title: "正在分析请求并生成响应",
              state: "running",
            });
          }
          refreshStreamWatchdog(currentSessionId);
          break;
        case "stream_delta":
          if (!event.delta) break;
          ensureAssistantContinuation(currentSessionId);
          finishThinkingEntry(currentSessionId);
          appendAssistantProcessText(currentSessionId, String(event.delta));
          refreshStreamWatchdog(currentSessionId);
          break;
        case "stream_snapshot":
          {
            const content = String(event.content || "");
            if (!content) break;
            ensureAssistantContinuation(currentSessionId);
            finishThinkingEntry(currentSessionId);
            replaceAssistantProcessText(currentSessionId, content);
            refreshStreamWatchdog(currentSessionId);
          }
          break;
        case "thinking_delta":
          ensureAssistantContinuation(currentSessionId);
          finishAssistantProcessText(currentSessionId);
          appendThinkingDelta(currentSessionId, String(event.delta || ""));
          break;
        case "thinking_end":
          finishThinkingEntry(currentSessionId);
          break;
        case "user_ask_question":
        case "ask_user_question":
        case "ask_user":
        case "droid.ask_user":
          {
            finishAssistantProcessText(currentSessionId);
            finishThinkingEntry(currentSessionId);
            const entryId = createProcessEntryId();
            setPendingUIResponseState(getPendingUIFromEvent(event, currentSessionId, entryId));
            appendProcessEntry(currentSessionId, {
              id: entryId,
              type: "question",
              title: getQuestionTitle(true),
              state: "running",
              expanded: false,
            });
          }
          break;
        case "stream_end":
          {
            if (!runtime.processActive) {
              const eventContent = event.content ? String(event.content) : "";
              if (!eventContent.trim()) break;
              ensureAssistantContinuation(currentSessionId);
            }
            if (pendingUIResponseRef.current?.sessionId === currentSessionId && !event.force) break;
            finishAssistantProcessText(currentSessionId);
            finishThinkingEntry(currentSessionId);
            const eventContent = event.content ? String(event.content) : "";
            completeAssistantStream(currentSessionId, eventContent, false);
            setPendingUIResponseState((current) => current?.sessionId === currentSessionId ? null : current);
          }
          break;
        case "agent_end":
          // Some backends can emit agent_end before the assistant stream is
          // actually complete. stream_end is the UI completion signal.
          break;
        case "agent_disconnected":
          if (!runtime.processActive) break;
          finishAssistantProcessText(currentSessionId);
          finishThinkingEntry(currentSessionId);
          completeAssistantStream(currentSessionId, undefined, true);
          setPendingUIResponseState((current) => current?.sessionId === currentSessionId ? null : current);
          break;
        case "tool_start":
          {
            ensureAssistantContinuation(currentSessionId);
            finishAssistantProcessText(currentSessionId);
            finishThinkingEntry(currentSessionId);
            const key = getToolKey(event);
            if (normalizeToolKind(event.toolKind) === "question") {
              runtime.activeToolEntry[key] = "";
              break;
            }
            const existingEntryId = runtime.activeToolEntry[key];
            const toolFiles = getToolProcessFiles(event);
            if (toolFiles.length > 0) runtime.activeToolFile[key] = toolFiles;
            const toolDetail = getToolDetail(event);
            const toolKind = normalizeToolKind(event.toolKind);
            const entryType: AgentProcessEntry["type"] = toolKind === "question" ? "question" : "tool";
            const toolSummary = getToolSummary(event, true);
            if (existingEntryId) {
              useChatStore.getState().updateLastAssistantProcessEntry(existingEntryId, {
                title: toolSummary,
                detail: toolDetail || undefined,
                files: toolFiles.length > 0 ? toolFiles : undefined,
                toolKind,
                command: typeof event.command === "string" ? event.command : undefined,
                state: "running",
                type: entryType,
                expanded: true,
              }, currentSessionId);
            } else {
              const entryId = createProcessEntryId();
              runtime.activeToolEntry[key] = entryId;
              appendProcessEntry(currentSessionId, {
                id: entryId,
                type: entryType,
                title: toolSummary,
                detail: toolDetail || undefined,
                files: toolFiles.length > 0 ? toolFiles : undefined,
                toolKind,
                command: typeof event.command === "string" ? event.command : undefined,
                state: "running",
                expanded: true,
              });
            }
          }
          break;
        case "tool_end":
          {
            finishAssistantProcessText(currentSessionId);
            finishThinkingEntry(currentSessionId);
            const key = getToolKey(event);
            const entryId = runtime.activeToolEntry[key];
            if (normalizeToolKind(event.toolKind) === "question") {
              delete runtime.activeToolEntry[key];
              delete runtime.activeToolFile[key];
              break;
            }
            const toolName = getToolName(event);
            const toolFiles = getToolProcessFiles(event);
            const preservedToolFiles = toolFiles.length > 0 ? toolFiles : runtime.activeToolFile[key] || [];
            const toolDetail = getToolDetail(event);
            const toolSummary = getToolSummary({ ...event, files: preservedToolFiles.length > 0 ? preservedToolFiles : event.files }, false);
            const entryType: AgentProcessEntry["type"] = normalizeToolKind(event.toolKind) === "question"
              ? (event.isError ? "error" : "question")
              : (event.isError ? "error" : "tool");
            const patch = {
              title: toolSummary,
              detail: toolDetail || undefined,
              files: preservedToolFiles.length > 0 && !event.isError ? preservedToolFiles : undefined,
              toolKind: normalizeToolKind(event.toolKind),
              command: typeof event.command === "string" ? event.command : undefined,
              state: event.isError ? "error" : "completed",
              type: entryType,
              expanded: !!event.isError,
            } satisfies Partial<Omit<AgentProcessEntry, "id">>;

            if (entryId) {
              useChatStore.getState().updateLastAssistantProcessEntry(entryId, patch, currentSessionId);
              delete runtime.activeToolEntry[key];
              delete runtime.activeToolFile[key];
            } else {
              appendProcessEntry(currentSessionId, {
                type: entryType,
                title: patch.title || (event.isError ? `${toolName} 执行失败` : `已完成 ${toolName}`),
                detail: patch.detail,
                files: patch.files,
                state: patch.state,
                expanded: patch.expanded,
              });
            }
          }
          break;
        case "diff_update":
          ensureAssistantContinuation(currentSessionId);
          if (event.diffs && event.diffs.length > 0) {
            finishAssistantProcessText(currentSessionId);
            finishThinkingEntry(currentSessionId);
            useChatStore.getState().appendLastAssistantDiffs(event.diffs, currentSessionId);
          }
          break;
        case "process_event":
          ensureAssistantContinuation(currentSessionId);
          finishAssistantProcessText(currentSessionId);
          finishThinkingEntry(currentSessionId);
          const eventType = normalizeProcessEntryType(event.entryType || event.kind || event.mode || event.toolName || event.name);
          const eventTitle = String(event.title || "Agent 事件");
          const eventDetail = event.detail ? truncateProcessDetail(stringifyProcessValue(event.detail)) : undefined;
          const eventState = normalizeProcessEntryState(event.state);
          if (eventType === "error" || eventState === "error") {
            failAssistantStream(currentSessionId, eventTitle, eventDetail);
            setPendingUIResponseState((current) => current?.sessionId === currentSessionId ? null : current);
            break;
          }
          let questionEntryId: string | undefined;
          if (eventType === "question") {
            questionEntryId = createProcessEntryId();
            setPendingUIResponseState(getPendingUIFromEvent(event, currentSessionId, questionEntryId));
          }

          let processedTitle = eventTitle;
          if (eventType === "tool" && !eventTitle.includes("运行") && !eventTitle.includes("已完成") && !eventTitle.includes("失败")) {
            processedTitle = `正在执行: ${eventTitle}`;
          } else if (eventType === "diff" && !eventTitle.includes("修改") && !eventTitle.includes("变更")) {
            processedTitle = `文件变更: ${eventTitle}`;
          } else if (eventType === "thinking" && !eventTitle.includes("思考")) {
            processedTitle = `思考: ${eventTitle}`;
          } else if (eventType === "question" && !eventTitle.includes("询问") && !eventTitle.includes("问题")) {
            processedTitle = `询问用户: ${eventTitle}`;
          }

          appendProcessEntry(currentSessionId, {
            id: questionEntryId,
            type: eventType,
            title: processedTitle,
            detail: eventType === "question" ? undefined : eventDetail,
            files: Array.isArray(event.files) ? getToolProcessFiles(event) : undefined,
            state: eventType === "question" ? eventState || "running" : eventState,
          });
          break;
        case "agent_ready":
          const agentName = getAgentName(String(event.agentId || activeAgentId));
          appendProcessEntry(currentSessionId, {
            type: "status",
            title: `${agentName} 已就绪，可以开始对话`,
            state: "completed",
          });
          // Models are fetched by the useEffect watching activeSessionId
          break;
        case "session_file_path":
          {
            const sessionFilePath = String(event.sessionFilePath || "");
            if (!sessionFilePath) break;
            const project = useProjectStore.getState().projects.find((p) =>
              p.sessions.some((session) => session.id === currentSessionId)
            );
            if (project) {
              useProjectStore.getState().setSessionFilePath(project.id, currentSessionId, sessionFilePath);
            }
          }
          break;
        default:
          if (normalizeToolKind(event.mode || event.entryType || event.kind || event.toolKind) === "question") {
            finishThinkingEntry(currentSessionId);
            const entryId = createProcessEntryId();
            setPendingUIResponseState(getPendingUIFromEvent(event, currentSessionId, entryId));
            appendProcessEntry(currentSessionId, {
              id: entryId,
              type: "question",
              title: getQuestionTitle(true),
              state: normalizeProcessEntryState(event.state) || "running",
              expanded: false,
            });
          }
          break;
      }
    });
    return () => {
      clearStreamWatchdog();
      Object.values(sessionRuntimeRef.current).forEach((runtime) => {
        if (runtime.streamWatchdog) {
          clearTimeout(runtime.streamWatchdog);
          runtime.streamWatchdog = null;
        }
      });
      unsubscribe();
    };
  }, []);

  const handleSendUIResponse = async () => {
    const text = input.trim();
    const targetSessionId = useProjectStore.getState().activeSessionId;
    if (!targetSessionId || pendingUIResponse?.sessionId !== targetSessionId || !text) return;
    const pendingResponse = pendingUIResponse;

    autoFollowBottomRef.current = true;
    flushSync(() => {
      addMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        timestamp: Date.now(),
      }, targetSessionId);
      setInput("");
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
  };

  const finishPendingQuestionEntry = (targetSessionId: string, pendingResponse: typeof pendingUIResponse, failed = false) => {
    if (!pendingResponse?.entryId) return;
    useChatStore.getState().updateLastAssistantProcessEntry(pendingResponse.entryId, {
      title: failed ? getQuestionTitle(false, true) : getQuestionTitle(false),
      state: failed ? "error" : "completed",
      expanded: false,
    }, targetSessionId);
  };

  const resetRuntimeAfterUIResponse = (targetSessionId: string) => {
    const runtime = sessionRuntimeRef.current[targetSessionId];
    if (!runtime) return;

    if (runtime.streamWatchdog) {
      clearTimeout(runtime.streamWatchdog);
      runtime.streamWatchdog = null;
    }
    runtime.streamBuffer = "";
    runtime.thinkingBuffer = "";
    runtime.thinkingEntryId = null;
    runtime.processActive = false;
    runtime.streamStarted = false;
    runtime.activeToolEntry = {};
    runtime.activeToolFile = {};
    runtime.autoAbortReason = null;
  };

  const finishPendingQuestionTurn = (targetSessionId: string, pendingResponse: typeof pendingUIResponse, failed = false) => {
    finishPendingQuestionEntry(targetSessionId, pendingResponse, failed);
    useChatStore.getState().finishLastAssistantProcess(Date.now(), failed ? "interrupted" : "completed", targetSessionId);
    resetRuntimeAfterUIResponse(targetSessionId);
  };

  const handleSubmitQuestionnaire = async (answers: unknown[]) => {
    const targetSessionId = useProjectStore.getState().activeSessionId;
    if (!targetSessionId || !activeQuestionnaire || activeQuestionnaire.sessionId !== targetSessionId) return;
    const pendingResponse = activeQuestionnaire;
    const answerSummary = answers
      .map((answer: any) => answer?.label || answer?.answer || (Array.isArray(answer?.selected) ? answer.selected.join(", ") : ""))
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
  };

  const handleCancelQuestionnaire = async () => {
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
  };

  const handleSend = async () => {
    if (activeQuestionnaire) return;

    if (isAwaitingUIResponse) {
      await handleSendUIResponse();
      return;
    }

    const text = input.trim();
    const targetSessionId = useProjectStore.getState().activeSessionId;
    if (!targetSessionId || (!text && pendingImages.length === 0 && pendingFiles.length === 0) || (agentStatuses[targetSessionId] === "running")) return;

    // Build display content (short refs) and send content (full details)
    let displayContent = text;
    let sendContent = text;

    // Handle pending files - read content and build detailed message
    if (pendingFiles.length > 0) {
      const fileParts: string[] = [];
      const fileRefs: string[] = [];

      for (const pf of pendingFiles) {
        fileRefs.push(`[${pf.fileName}:${pf.startLine}-${pf.endLine}]`);
        try {
          const result = await window.electronAPI.readFile(pf.filePath);
          if (result.success && result.content) {
            const lines = result.content.split("\n");
            const selectedLines = lines.slice(pf.startLine - 1, pf.endLine);
            fileParts.push(
              `<file path="${pf.filePath}" lines="${pf.startLine}-${pf.endLine}">\n${selectedLines.join("\n")}\n</file>`
            );
          } else {
            fileParts.push(`[无法读取文件: ${pf.fileName}]`);
          }
        } catch {
          fileParts.push(`[无法读取文件: ${pf.fileName}]`);
        }
      }

      const fileRefStr = fileRefs.join(" ");
      displayContent = text ? `${text}\n${fileRefStr}` : fileRefStr;
      sendContent = text ? `${text}\n\n${fileParts.join("\n\n")}` : fileParts.join("\n\n");
    }

    // Handle pending images
    let agentImages: Array<{ type: string; data: string; mimeType: string }> | undefined;
    let messageImages: Array<{ id: string; src: string; name: string }> | undefined;
    if (pendingImages.length > 0) {
      // Don't add text refs to displayContent - images are shown visually
      messageImages = pendingImages.map((img) => ({ id: img.id, src: img.src, name: img.name }));
      agentImages = pendingImages.map((img) => ({
        type: "image",
        data: img.src.split(",")[1], // Remove data:image/...;base64, prefix
        mimeType: img.file.type || "image/png",
      }));
    }

    // Force synchronous render so "working..." appears before IPC call
    autoFollowBottomRef.current = true; // New outgoing messages should keep the latest turn visible.
    flushSync(() => {
      addMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: displayContent,
        timestamp: Date.now(),
        images: messageImages,
      }, targetSessionId);
      setInput("");
      setPendingImages([]);
      clearPendingFiles();
      setStreaming(true);
      useProjectStore.getState().setAgentStatus(targetSessionId, "running");
      const runtime = sessionRuntimeRef.current[targetSessionId];
      if (runtime) {
        if (runtime.streamWatchdog) {
          clearTimeout(runtime.streamWatchdog);
          runtime.streamWatchdog = null;
        }
        runtime.streamBuffer = "";
        runtime.thinkingBuffer = "";
        runtime.thinkingEntryId = null;
        runtime.autoAbortReason = null;
      }
    });

    // Scroll to bottom immediately after sending (user wants to see their message)
    const scrollEl = scrollRef.current;
    if (scrollEl) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
      updateScrollBottomState(scrollEl);
    }

    const result = await window.electronAPI.agentSendMessage(sendContent, agentImages, targetSessionId, { planModeEnabled });
    if (!result.success) {
      const runtime = sessionRuntimeRef.current[targetSessionId];
      if (runtime?.streamWatchdog) {
        clearTimeout(runtime.streamWatchdog);
        runtime.streamWatchdog = null;
      }
      useChatStore.getState().finishLastAssistantProcess(Date.now(), "completed", targetSessionId);
      if (runtime) {
        runtime.processActive = false;
        runtime.streamStarted = false;
        runtime.activeToolEntry = {};
        runtime.activeToolFile = {};
      }
      setStreaming(false);
      useProjectStore.getState().setAgentStatus(targetSessionId, "idle");
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: `发送失败: ${result.error || "请先在项目中启动 Agent"}`,
        timestamp: Date.now(),
      }, targetSessionId);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    const shouldSend =
      (sendKey === "Ctrl+Enter" && e.key === "Enter" && e.ctrlKey) ||
      (sendKey === "Enter" && e.key === "Enter" && !e.ctrlKey);

    if (shouldSend) {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const ta = textareaRef.current;
      if (ta) {
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const newValue = input.substring(0, start) + "\n" + input.substring(end);
        setInput(newValue);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 1;
        });
      }
    }
  };

  const handleAbort = () => {
    const currentSessionId = useProjectStore.getState().activeSessionId;
    if (!currentSessionId) return;
    const runtime = sessionRuntimeRef.current[currentSessionId];
    if (runtime?.streamWatchdog) {
      clearTimeout(runtime.streamWatchdog);
      runtime.streamWatchdog = null;
    }
    useChatStore.getState().appendLastAssistantProcessEntry({
      id: createProcessEntryId(),
      timestamp: Date.now(),
      type: "status",
      title: "用户已手动中断",
      state: "interrupted",
      expanded: false,
    }, currentSessionId);
    useChatStore.getState().finishLastAssistantProcess(Date.now(), "interrupted", currentSessionId);
    if (runtime) {
      runtime.processActive = false;
      runtime.streamStarted = false;
      runtime.activeToolEntry = {};
      runtime.activeToolFile = {};
      runtime.streamBuffer = "";
      runtime.thinkingBuffer = "";
      runtime.thinkingEntryId = null;
      runtime.autoAbortReason = null;
    }
    setPendingUIResponseState((current) => current?.sessionId === currentSessionId ? null : current);
    setStreaming(false);
    useProjectStore.getState().setAgentStatus(currentSessionId, "idle");

    void window.electronAPI.agentAbort(currentSessionId).catch((err) => {
      console.error("[agent] abort failed:", err);
    });
  };

  // Image handling
  const addPendingImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setPendingImages((prev) => [...prev, {
        id: crypto.randomUUID(),
        src: reader.result as string,
        name: file.name,
        file,
      }]);
    };
    reader.readAsDataURL(file);
  };

  const removePendingImage = (id: string) => {
    setPendingImages((prev) => prev.filter((img) => img.id !== id));
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addPendingImage(file);
        return;
      }
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      addPendingImage(file);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleSelectModel = async (model: ModelInfo) => {
    setCurrentModel(model);
    setModelOpen(false);
    // Save model selection for this session
    const sessionId = useProjectStore.getState().activeSessionId;
    if (sessionId) saveSessionModel(sessionId, model);
    await window.electronAPI.agentSetModel(model.provider, model.id);
  };

  const handleSelectThinking = async (levelId: string) => {
    setThinkingLevel(levelId);
    setThinkingOpen(false);
    // Save thinking level for this session
    const sessionId = useProjectStore.getState().activeSessionId;
    if (sessionId) saveSessionThinking(sessionId, levelId);
    await window.electronAPI.agentSetThinkingLevel(levelId);
  };

  const thinkingLevels = [
    { id: "off", label: "关闭" },
    { id: "minimal", label: "最低" },
    { id: "low", label: "低" },
    { id: "medium", label: "中" },
    { id: "high", label: "高" },
    { id: "xhigh", label: "极高" },
  ];
  const currentThinking = thinkingLevels.find((l) => l.id === thinkingLevel) || thinkingLevels[3];
  const modelProviders = [...new Set(availableModels.map((m) => m.provider))];

  // No project open - show placeholder
  if (!activeProject) {
    return (
      <div className="chat-panel">
        <div className="chat-empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ color: "var(--text-secondary)", marginBottom: 16, opacity: 0.5 }}>
            <path d="M4 6C4 4.89543 4.89543 4 6 4H10L12 7H18C19.1046 7 20 7.89543 20 9V18C20 19.1046 19.1046 20 18 20H6C4.89543 20 4 19.1046 4 18V6Z" strokeLinejoin="round" />
            <path d="M4 10H20" />
          </svg>
          <div className="chat-empty-title">未打开项目</div>
          <div className="chat-empty-desc">请在左侧创建或选择一个项目以开始对话</div>
          <button
            className="chat-empty-btn"
            onClick={() => triggerAddProject()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
            创建项目
          </button>
        </div>
      </div>
    );
  }

  // Project open but no session - show session selector hint
  if (!activeSession) {
    return (
      <div className="chat-panel">
        <div className="chat-header">
          <div className="chat-agent-dot" />
          <span className="chat-agent-name">{activeProject.name}</span>
        </div>
        <div className="chat-empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ color: "var(--text-secondary)", marginBottom: 16, opacity: 0.5 }}>
            <rect x="2" y="3" width="20" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
            <path d="M7 8L10 11L7 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 14H17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <div className="chat-empty-title">选择或创建会话</div>
          <div className="chat-empty-desc">点击项目卡片上的 Agent 按钮新建会话，或点击下方已有会话</div>
          {(() => {
            const openSessions = activeProject.sessions.filter((s) => !s.closed);
            if (openSessions.length === 0) return null;
            return (
            <div className="chat-session-list">
              {openSessions.map((session) => {
                const msgs = sessionMessages[session.id];
                const firstUserMsg = msgs?.find((m) => m.role === "user");
                return (
                  <button
                    key={session.id}
                    className="chat-session-item"
                    onClick={async () => {
                      // Switch UI immediately
                      useProjectStore.getState().setActiveSession(session.id);
                      useChatStore.getState().setActiveAgent(session.agentId);
                      useChatStore.getState().switchSession(session.id);

                      // Create and switch agent session in background
                      if (activeProject) {
                        window.electronAPI.agentCreateSession(
                          session.agentId, activeProject.path, session.id, session.sessionFilePath
                        ).then(async (result) => {
                          if (result.sessionFilePath) {
                            useProjectStore.getState().setSessionFilePath(activeProject.id, session.id, result.sessionFilePath);
                          }
                          if (useProjectStore.getState().activeSessionId === session.id) {
                            applySessionModels(session.id, result.models);
                          }
                          useProjectStore.getState().markSessionInitialized(session.id);
                          if (useProjectStore.getState().activeSessionId === session.id) {
                            await window.electronAPI.agentSwitchSession(session.id);
                            // Update model list only; model selection is handled by ChatPanel useEffect
                            try {
                              const models = await window.electronAPI.agentGetModels(session.id);
                              if (models && models.length > 0) {
                                useChatStore.getState().setAvailableModels(models);
                              }
                            } catch { /* ignore */ }
                          }
                        });
                      }
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="2" y="3" width="20" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M7 8L10 11L7 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M12 14H17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                    <span>{firstUserMsg ? (firstUserMsg.content.length > 30 ? firstUserMsg.content.substring(0, 30) + "..." : firstUserMsg.content) : session.title}</span>
                  </button>
                );
              })}
            </div>
            );
          })()}
        </div>
      </div>
    );
  }

  return (
    <div ref={chatPanelRef} className="chat-panel">
      {/* Header */}
      <div className="chat-header">
        <div className="chat-agent-dot" />
        <span className="chat-agent-name">{activeProject.name}</span>
        <span className="chat-agent-tag">{getAgentName(activeAgentId)}</span>
        <div style={{ flex: 1 }} />
        <div ref={userMsgHistoryRef} className="relative">
          <button
            className="chat-header-history-btn"
            onClick={() => setUserMsgHistoryOpen(!userMsgHistoryOpen)}
            title="发言记录"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </button>
          {userMsgHistoryOpen && (
            <div className="chat-user-history-popup">
              <div className="chat-user-history-header">发言记录</div>
              {messages.filter((m) => m.role === "user").length === 0 ? (
                <div className="chat-user-history-empty">暂无发言</div>
              ) : (
                <div className="chat-user-history-list">
                  {messages.filter((m) => m.role === "user").map((msg) => (
                    <div
                      key={msg.id}
                      className="chat-user-history-item"
                      onClick={() => scrollToMessage(msg.id)}
                    >
                      <span className="chat-user-history-text">{msg.content}</span>
                      <span className="chat-user-history-time">
                        {(() => {
                          const d = new Date(msg.timestamp);
                          const now = new Date();
                          const isToday = d.toDateString() === now.toDateString();
                          const time = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
                          if (isToday) return time;
                          const mm = String(d.getMonth() + 1).padStart(2, "0");
                          const dd = String(d.getDate()).padStart(2, "0");
                          return `${mm}/${dd} ${time}`;
                        })()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="chat-messages-area">
        <div ref={scrollRef} className="chat-messages" onScroll={handleMessagesScroll}>
          {activeSessionId && !isSessionInitialized(activeSessionId) ? (
            <div className="chat-loading-agent">
              <div className="chat-working-spinner" />
              <span>正在初始化 Agent 会话...</span>
            </div>
          ) : (<>
          {messages.length === 0 && (
            <div className="chat-empty">发送消息开始对话</div>
          )}
          {messages.map((msg) => {
            const processRunning = msg.role === "assistant" && !!msg.process && !msg.process.endedAt;
            const hasImages = !!msg.images?.length;
            const hasDiffs = !!msg.diffs?.length && !processRunning;
            const hasContent = msg.content.trim().length > 0;
            const hasVisibleBubble =
              msg.role === "assistant" ? !processRunning && (hasContent || hasImages || hasDiffs) : hasContent || hasImages || hasDiffs;

            return (
              <div key={msg.id} data-msg-id={msg.id} className="chat-msg-wrapper">
                {msg.role === "assistant" && msg.process && (
                  <ProcessBlock
                    messageId={msg.id}
                    process={msg.process}
                    onToggle={handleToggleAssistantProcess}
                    onToggleEntry={handleToggleAssistantProcessEntry}
                    onOpenFile={setPreviewFile}
                    onPreserveScroll={preserveScrollDuringLayoutChange}
                  />
                )}
                {hasVisibleBubble && (
                <div className={`chat-msg ${msg.role}`}>
                  {hasImages && msg.images && (
                    <div className="chat-images">
                      {msg.images.map((img) => (
                        <img
                          key={img.id}
                          src={img.src}
                          alt={img.name}
                          className="chat-image"
                          onClick={() => setZoomImage(img.src)}
                        />
                      ))}
                    </div>
                  )}
                  {hasContent && (
                    <div className="chat-bubble-row">
                      <div className={`chat-bubble ${msg.role}`}>
                        {msg.role === "assistant" ? (
                          <MarkdownRenderer content={msg.content} />
                        ) : (
                          msg.content
                        )}
                      </div>
                      {msg.role === "user" && (
                      <div className="chat-msg-actions">
                        <button
                          className="chat-copy-btn"
                          onClick={() => setInput(msg.content)}
                          title="编辑"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                        <button
                          className="chat-copy-btn"
                          onClick={() => navigator.clipboard.writeText(msg.content)}
                          title="复制"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </button>
                      </div>
                      )}
                    </div>
                  )}
                  {hasDiffs && msg.diffs && (
                    <DiffBlock diffs={msg.diffs} />
                  )}
                </div>
                )}
              </div>
            );
          })}

          {currentSessionRunning && messages.length > 0 && messages[messages.length - 1].role === "user" && (
            <div className="chat-working">
              <div className="chat-working-spinner" />
              <span>正在处理您的请求...</span>
            </div>
          )}
          </>)}
        </div>

        {showScrollBottom && (
          <button className="chat-scroll-bottom" onClick={scrollToBottom} title="返回底部">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14" />
              <path d="M19 12l-7 7-7-7" />
            </svg>
          </button>
        )}
      </div>

      {activeQuestionnaire && (
        <div
          className="chat-questionnaire-resizer"
          role="separator"
          aria-label="调整问卷面板高度"
          aria-orientation="horizontal"
          title="拖动调整问卷高度"
          onPointerDown={handleQuestionnaireResizeStart}
        />
      )}

      {/* Input area */}
      <div
        className={`chat-input-area${activeQuestionnaire ? " questionnaire-active" : ""}${activeQuestionnaire && questionnairePaneHeight !== null ? " questionnaire-resized" : ""}`}
        style={activeQuestionnaire && questionnairePaneHeight !== null ? { height: questionnairePaneHeight } : undefined}
      >
        {activeQuestionnaire && (
          <QuestionnairePanel
            questions={activeQuestionnaire.questions || []}
            onSubmit={handleSubmitQuestionnaire}
            onCancel={handleCancelQuestionnaire}
          />
        )}

        {/* Combined preview bar for files and images */}
        {(pendingFiles.length > 0 || pendingImages.length > 0) && (
          <div className="chat-preview-bar">
            {pendingFiles.map((pf) => (
              <div key={pf.id} className="chat-file-card">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="chat-file-icon">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="chat-file-name">{pf.fileName}:{pf.startLine}-{pf.endLine}</span>
                <button className="chat-file-remove" onClick={() => removePendingFile(pf.id)}>×</button>
              </div>
            ))}
            {pendingImages.map((img) => (
              <div key={img.id} className="chat-image-card-inline">
                {img.file.type.startsWith("image/") ? (
                  <img src={img.src} alt={img.name} className="chat-image-thumb-inline" onClick={() => setZoomImage(img.src)} />
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="2" className="chat-file-icon">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                )}
                <span className="chat-file-name">{img.name}</span>
                <button className="chat-file-remove" onClick={() => removePendingImage(img.id)}>×</button>
              </div>
            ))}
          </div>
        )}

        {/* Input container */}
        <div className="chat-input-container" onDrop={handleDrop} onDragOver={handleDragOver}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              Array.from(e.target.files || []).forEach(addPendingImage);
              e.target.value = "";
            }}
          />
          <div className="chat-input-actions-left">
            <button className="chat-input-btn" title="上传文件" onClick={() => fileInputRef.current?.click()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={activeQuestionnaire ? "请在上方提交问卷" : sendKey === "Ctrl+Enter" ? "输入消息... (Ctrl+Enter 发送, Enter 换行, 粘贴图片)" : "输入消息... (Enter 发送, Ctrl+Enter 换行, 粘贴图片)"}
            rows={1}
            className="chat-textarea"
            disabled={!!activeQuestionnaire}
          />
          <button
            onClick={currentSessionRunning && !isAwaitingUIResponse ? handleAbort : handleSend}
            disabled={
              activeQuestionnaire
                ? true
                : isAwaitingUIResponse
                  ? !input.trim()
                : !currentSessionRunning && !input.trim() && pendingImages.length === 0 && pendingFiles.length === 0
            }
            className={`chat-send-btn ${currentSessionRunning && !isAwaitingUIResponse ? "abort" : ""}`}
            title={activeQuestionnaire ? "请在上方提交问卷" : currentSessionRunning && !isAwaitingUIResponse ? "停止" : isAwaitingUIResponse ? "发送回答" : "发送"}
          >
            {currentSessionRunning && !isAwaitingUIResponse ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5" />
                <path d="M5 12l7-7 7 7" />
              </svg>
            )}
          </button>
        </div>

        {/* Toolbar below input */}
        <div className="chat-input-toolbar">
          <button
            type="button"
            onClick={() => savePlanModeEnabled(!planModeEnabled)}
            className={`chat-toolbar-select chat-toolbar-plan-toggle ${planModeEnabled ? "active" : ""}`}
            title={getAgentPlanModeTooltip(activeSession?.agentId || activeAgentId)}
            aria-pressed={planModeEnabled}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M9 6h11" />
              <path d="M9 12h11" />
              <path d="M9 18h11" />
              <path d="M4 6l1 1 2-2" />
              <path d="M4 12l1 1 2-2" />
              <path d="M4 18l1 1 2-2" />
            </svg>
            <span>Plan 模式</span>
          </button>

          {/* Model selector */}
          <div ref={modelRef} className="relative">
            <button
              onClick={() => { setModelOpen(!modelOpen); setThinkingOpen(false); if (modelOpen) setExpandedProvider(null); }}
              className="chat-toolbar-select"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <circle cx="15.5" cy="8.5" r="1.5" />
                <path d="M8 14c0 0 1.5 2 4 2s4-2 4-2" />
              </svg>
              <span>{currentModel?.name || "选择模型"}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {modelOpen && (
              <div className="chat-dropdown">
                {modelProviders.length === 0 && (
                  <div className="chat-dropdown-empty">暂无可用模型</div>
                )}
                {modelProviders.map((provider) => {
                  const providerModels = availableModels.filter((m) => m.provider === provider);
                  const isExpanded = expandedProvider === provider;
                  const hasActiveModel = providerModels.some(
                    (m) => m.id === currentModel?.id && m.provider === currentModel?.provider
                  );
                  return (
                    <div key={provider}>
                      <div
                        className={`chat-dropdown-provider ${isExpanded ? "expanded" : ""} ${hasActiveModel ? "has-active" : ""}`}
                        onClick={() => setExpandedProvider(isExpanded ? null : provider)}
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
                        >
                          <path d="M9 18l6-6-6-6" />
                        </svg>
                        <span>{provider}</span>
                        <span className="chat-dropdown-provider-count">{providerModels.length}</span>
                      </div>
                      {isExpanded && providerModels.map((model) => {
                        const isFav = favoriteModels.some((f) => f.id === model.id && f.provider === model.provider);
                        const isActive = currentModel?.id === model.id && currentModel?.provider === model.provider;
                        return (
                          <div
                            key={model.id}
                            className={`chat-dropdown-item ${isActive ? "active" : ""}`}
                            onClick={() => handleSelectModel(model)}
                          >
                            <span className="truncate">{model.name}</span>
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleFavorite(model); }}
                              className={`chat-dropdown-star ${isFav ? "fav" : ""}`}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill={isFav ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
                                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                              </svg>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Thinking level selector */}
          <div ref={thinkingRef} className="relative">
            <button
              onClick={() => { setThinkingOpen(!thinkingOpen); setModelOpen(false); }}
              className="chat-toolbar-select"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
                <path d="M10 21h4" />
              </svg>
              <span>思考: {currentThinking.label}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {thinkingOpen && (
              <div className="chat-thinking-dropdown">
                {thinkingLevels.map((level) => (
                  <button
                    key={level.id}
                    onClick={() => handleSelectThinking(level.id)}
                    className={`chat-thinking-option ${thinkingLevel === level.id ? "active" : ""}`}
                  >
                    {level.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Image zoom modal */}
      {zoomImage && (
        <div className="chat-image-zoom-overlay" onClick={() => setZoomImage(null)}>
          <img src={zoomImage} className="chat-image-zoom" onClick={(e) => e.stopPropagation()} />
          <button className="chat-image-zoom-close" onClick={() => setZoomImage(null)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      <FilePreview filePath={previewFile} onClose={() => setPreviewFile(null)} />
    </div>
  );
}
