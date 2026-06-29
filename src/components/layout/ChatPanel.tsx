import { useState, useRef, useEffect, useCallback } from "react";
import { flushSync } from "react-dom";
import { useChatStore, type ModelInfo, type FileDiff, type AgentProcess, type AgentProcessEntry, type AgentProcessFile } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import { useAppStore } from "@/stores/app-store";
import { getAgentName } from "@/lib/agents";
import { applySessionModels, getSessionModel, saveSessionModel, getSessionThinking, saveSessionThinking } from "@/hooks/useDataPersistence";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import "./ChatPanel.css";

const MODEL_FETCH_RETRY_DELAYS = [0, 500, 1000, 2000, 4000, 8000];

const formatProcessDuration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
};

const summarizeProcessEntries = (entries: AgentProcessEntry[]) => {
  if (entries.length === 0) return "等待事件";

  const toolCount = entries.filter((entry) => entry.type === "tool" || entry.type === "question" || entry.type === "error").length;
  const diffCount = entries.filter((entry) => entry.type === "diff").length;
  const isThinking = entries.some((entry) => entry.type === "thinking" && entry.state === "running");
  const thinkingEntry = entries.find((entry) => entry.type === "thinking" && entry.state === "running");
  const runningTool = entries.find((entry) => (entry.type === "tool" || entry.type === "question") && entry.state === "running");

  if (isThinking && thinkingEntry) {
    const thinkingPreview = thinkingEntry.detail ?
      (thinkingEntry.detail.length > 30 ? thinkingEntry.detail.substring(0, 30) + "..." : thinkingEntry.detail) :
      "思考中";
    return `正在思考: ${thinkingPreview}`;
  }

  if (runningTool) {
    return runningTool.title;
  }

  if (toolCount > 0 && diffCount > 0) return `已执行 ${toolCount} 个操作, 修改 ${diffCount} 个文件`;
  if (toolCount > 0) return `已执行 ${toolCount} 个操作`;
  if (diffCount > 0) return `已修改 ${diffCount} 个文件`;

  return `${entries.length} 条事件`;
};

const createProcessEntryId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `process-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

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

const getFileName = (filePath: string) => {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
};

const countPatchChanges = (patch: string) => ({
  additions: (patch.match(/^\+[^+]/gm) || []).length,
  deletions: (patch.match(/^-[^-]/gm) || []).length,
});

const getNestedValue = (value: any, path: string[]): any => {
  let current = value;
  for (const key of path) {
    if (current === undefined || current === null) return undefined;
    current = current[key];
  }
  return current;
};

const findFirstString = (value: any, paths: string[][]) => {
  for (const path of paths) {
    const found = getNestedValue(value, path);
    if (typeof found === "string" && found.trim()) return found;
  }
  return "";
};

const collectStrings = (value: unknown, output: string[] = [], seen = new WeakSet<object>()): string[] => {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    if (seen.has(value)) return output;
    seen.add(value);
    for (const item of value) collectStrings(item, output, seen);
  } else if (value && typeof value === "object") {
    if (seen.has(value)) return output;
    seen.add(value);
    for (const item of Object.values(value)) collectStrings(item, output, seen);
  }
  return output;
};

const extractFilePathFromText = (text: string) => {
  const match = text.match(/[A-Za-z]:[\\/][^\s"'`]+/);
  return match?.[0]?.replace(/[),.;\]]+$/, "") || "";
};

const unwrapToolText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const content = (value as any).content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text" && typeof item.text === "string") return item.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (text.trim()) return text;
  }
  return undefined;
};

const buildProcessFilesFromDiffs = (diffs: FileDiff[]): AgentProcessFile[] =>
  diffs.map((diff) => ({
    file: diff.file,
    label: getFileName(diff.file),
    action: "modified",
    additions: diff.additions,
    deletions: diff.deletions,
    status: diff.status,
  }));

const getToolKey = (event: any) => {
  const raw = event.toolCallId || event.callId || event.id || event.toolName || event.name || "tool";
  return String(raw);
};

const getToolName = (event: any) => {
  return event.toolName || event.name || event.tool || "tool";
};

const normalizeToolName = (toolName: unknown) => String(toolName || "").trim().toLowerCase();

const isAskUserToolName = (toolName: unknown) =>
  ["ask_user", "ask_user_question", "user_ask_question", "droid.ask_user"].includes(normalizeToolName(toolName));

const getAskUserTitle = (toolName: string, running = false) => {
  const prefix = running ? "正在询问用户" : "已处理用户询问";
  return isAskUserToolName(toolName) ? prefix : `${prefix}: ${toolName}`;
};

const getToolDetail = (event: any) => {
  const lines: string[] = [];
  const args = event.args || event.input || event.parameters;
  const result = event.result || event.output;
  const error = event.error || event.message;
  const resultText = unwrapToolText(result);

  if (args !== undefined) lines.push(`参数: ${stringifyProcessValue(args)}`);
  if (resultText !== undefined) lines.push(resultText);
  else if (result !== undefined) lines.push(`结果: ${stringifyProcessValue(result)}`);
  if (event.isError && error) lines.push(`错误: ${stringifyProcessValue(error)}`);
  if (!event.isError && event.detail) lines.push(stringifyProcessValue(event.detail));

  return truncateProcessDetail(lines.filter(Boolean).join("\n"));
};

const getToolProcessFiles = (event: any, toolName = getToolName(event)): AgentProcessFile[] => {
  const args = event.args || event.input || event.parameters || {};
  const result = event.result || event.output || {};
  const detail = event.detail;
  let filePath = findFirstString(
    { args, result, detail, event },
    [
      ["args", "filePath"],
      ["args", "path"],
      ["args", "file"],
      ["args", "filename"],
      ["args", "fileName"],
      ["result", "filePath"],
      ["result", "path"],
      ["result", "file"],
      ["result", "filename"],
      ["result", "fileName"],
      ["event", "filePath"],
      ["event", "path"],
      ["event", "file"],
      ["event", "filename"],
      ["event", "fileName"],
    ]
  );

  if (!filePath) {
    const textWithPath = collectStrings({ result, detail, event }).find((text) => extractFilePathFromText(text));
    filePath = textWithPath ? extractFilePathFromText(textWithPath) : "";
  }

  if (!filePath) return [];

  const patch = findFirstString(
    { args, result, detail, event },
    [
      ["result", "details", "patch"],
      ["result", "details", "diff"],
      ["result", "patch"],
      ["result", "diff"],
      ["event", "patch"],
      ["event", "diff"],
    ]
  );
  const changes = patch ? countPatchChanges(patch) : { additions: undefined, deletions: undefined };
  const normalizedName = normalizeToolName(toolName);
  const action: AgentProcessFile["action"] =
    ["read", "readfile", "read_file", "view"].includes(normalizedName) ? "read" :
    ["write", "writefile", "write_file", "create"].includes(normalizedName) ? "written" :
    ["edit", "multiedit", "multi_edit", "apply_patch", "str_replace_editor", "str_replace_based_edit_tool"].includes(normalizedName) ? "edited" :
    "modified";

  return [{
    file: filePath,
    label: getFileName(filePath),
    action,
    additions: changes.additions,
    deletions: changes.deletions,
    status: patch ? "modified" : undefined,
  }];
};

const getFileEntryTitle = (action: AgentProcessFile["action"] | undefined, count: number, running = false) => {
  if (running) {
    switch (action) {
      case "read": return `正在读取 ${count} 个文件`;
      case "written": return `正在写入 ${count} 个文件`;
      case "edited": return `正在编辑 ${count} 个文件`;
      default: return `正在修改 ${count} 个文件`;
    }
  }

  switch (action) {
    case "read": return `已读取 ${count} 个文件`;
    case "written": return `已写入 ${count} 个文件`;
    case "edited": return `已编辑 ${count} 个文件`;
    default: return `已修改 ${count} 个文件`;
  }
};

const getToolSummary = (toolName: string, args: any, isError: boolean = false): string => {
  if (isAskUserToolName(toolName)) {
    return isError ? "用户询问处理失败" : getAskUserTitle(toolName, false);
  }

  const normalizedName = normalizeToolName(toolName);
  if (isError) {
    switch (normalizedName) {
      case "read": return "读取文件失败";
      case "readfile": return "读取文件失败";
      case "read_file": return "读取文件失败";
      case "view": return "读取文件失败";
      case "write": return "写入文件失败";
      case "writefile": return "写入文件失败";
      case "write_file": return "写入文件失败";
      case "edit": return "编辑文件失败";
      case "multiedit": return "编辑文件失败";
      case "multi_edit": return "编辑文件失败";
      case "apply_patch": return "编辑文件失败";
      case "str_replace_editor": return "编辑文件失败";
      case "str_replace_based_edit_tool": return "编辑文件失败";
      case "bash": return "命令执行失败";
      case "glob": return "文件搜索失败";
      case "grep": return "内容搜索失败";
      case "search": return "文件搜索失败";
      case "list": return "列出文件失败";
      case "readDir": return "读取目录失败";
      case "webfetch": return "网页获取失败";
      case "websearch": return "网络搜索失败";
      default: return `${toolName} 执行失败`;
    }
  }

  const filePath = args?.filePath || args?.path || args?.file || "";
  const command = args?.command || args?.cmd || "";
  const pattern = args?.pattern || args?.query || "";

  switch (normalizedName) {
    case "read":
    case "readfile":
    case "read_file":
    case "view":
      return filePath ? `已读取文件: ${filePath}` : "已读取文件";
    case "write":
    case "writefile":
    case "write_file":
      return filePath ? `已写入文件: ${filePath}` : "已写入文件";
    case "edit":
    case "multiedit":
    case "multi_edit":
    case "apply_patch":
    case "str_replace_editor":
    case "str_replace_based_edit_tool":
      return filePath ? `已编辑文件: ${filePath}` : "已编辑文件";
    case "bash":
      return command ? `命令执行完成: ${command.length > 30 ? command.substring(0, 30) + "..." : command}` : "命令执行完成";
    case "glob":
      return pattern ? `文件搜索完成: ${pattern}` : "文件搜索完成";
    case "grep":
      return pattern ? `内容搜索完成: ${pattern}` : "内容搜索完成";
    case "search":
      return pattern ? `文件搜索完成: ${pattern}` : "文件搜索完成";
    case "list":
      return filePath ? `文件列表获取完成: ${filePath}` : "文件列表获取完成";
    case "readDir":
      return filePath ? `目录读取完成: ${filePath}` : "目录读取完成";
    case "webfetch":
      return "网页获取完成";
    case "websearch":
      return "网络搜索完成";
    default:
      return `已完成 ${toolName}`;
  }
};

const normalizeProcessEntryType = (value: unknown): AgentProcessEntry["type"] => {
  if (isAskUserToolName(value)) return "question";
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
  if (value === "running" || value === "completed" || value === "error") return value;
  return undefined;
};

function ProcessEntryIcon({ type, state }: { type: AgentProcessEntry["type"]; state?: AgentProcessEntry["state"] }) {
  if (state === "running") {
    return <span className="chat-process-entry-spinner" />;
  }

  if (type === "tool") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M8 9l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M13 15h4" strokeLinecap="round" />
      </svg>
    );
  }

  if (type === "diff") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
        <path d="M14 2v5h5" />
        <path d="M9 13h6M12 10v6" strokeLinecap="round" />
      </svg>
    );
  }

  if (type === "thinking") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 3a6 6 0 0 1 4 10.47V16a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.53A6 6 0 0 1 12 3z" />
        <path d="M10 21h4" strokeLinecap="round" />
      </svg>
    );
  }

  if (type === "question") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="9" />
        <path d="M9.75 9a2.35 2.35 0 0 1 4.5 1c0 1.5-1.2 2.05-2.25 2.8V14" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 17h.01" strokeLinecap="round" />
      </svg>
    );
  }

  if (type === "error" || state === "error") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16h.01" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ProcessEntryFiles({ files }: { files: AgentProcessFile[] }) {
  return (
    <div className="chat-process-files">
      {files.map((file, index) => {
        const action =
          file.action === "read" ? "已读取" :
          file.action === "written" ? "已写入" :
          file.action === "edited" ? "已编辑" :
          "已修改";
        const label = file.label || getFileName(file.file);
        return (
          <div className="chat-process-file" key={`${file.file}-${index}`}>
            <span className="chat-process-file-action">{action}</span>
            <span className="chat-process-file-name" title={file.file}>{label}</span>
            {typeof file.additions === "number" && file.additions > 0 && (
              <span className="chat-process-file-add">+{file.additions}</span>
            )}
            {typeof file.deletions === "number" && file.deletions > 0 && (
              <span className="chat-process-file-del">-{file.deletions}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ProcessEntryRow({
  messageId,
  entry,
  onToggleEntry,
}: {
  messageId: string;
  entry: AgentProcessEntry;
  onToggleEntry: (messageId: string, entryId: string) => void;
}) {
  const hasDetail = !!entry.detail;
  const files = entry.files || [];
  const canExpand = hasDetail && entry.type !== "thinking";
  const detailVisible = hasDetail && (!canExpand || entry.expanded);

  if (entry.type === "info") {
    return (
      <div className="chat-process-output">
        <MarkdownRenderer content={entry.detail || entry.title} />
      </div>
    );
  }

  return (
    <div className={`chat-process-entry ${entry.state || ""} ${entry.type}`}>
      <span className="chat-process-entry-icon">
        <ProcessEntryIcon type={entry.type} state={entry.state} />
      </span>
      <div className="chat-process-entry-main">
        <button
          className={`chat-process-entry-header ${canExpand ? "expandable" : ""}`}
          onClick={canExpand ? () => onToggleEntry(messageId, entry.id) : undefined}
          disabled={!canExpand}
        >
          <span className="chat-process-entry-title">{entry.title}</span>
          {canExpand && (
            <svg
              className="chat-process-entry-chevron"
              width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              style={{ transform: entry.expanded ? "rotate(90deg)" : "rotate(0deg)" }}
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          )}
        </button>
        {files.length > 0 && <ProcessEntryFiles files={files} />}
        {detailVisible && (
          <pre className={`chat-process-entry-detail ${canExpand ? "panel" : ""}`}>{entry.detail}</pre>
        )}
      </div>
    </div>
  );
}

function ProcessBlock({
  messageId,
  process,
  onToggle,
  onToggleEntry,
}: {
  messageId: string;
  process: AgentProcess;
  onToggle: (messageId: string) => void;
  onToggleEntry: (messageId: string, entryId: string) => void;
}) {
  const nowTick = useProcessTicker(!process.endedAt);
  const durationEnd = process.endedAt || nowTick;
  const elapsed = formatProcessDuration(durationEnd - process.startedAt);
  const expanded = !!process.expanded;

  return (
    <div className="chat-process">
      <button className="chat-process-toggle" onClick={() => onToggle(messageId)}>
        <span>处理耗时 {elapsed}</span>
        <span className="chat-process-summary">{summarizeProcessEntries(process.entries)}</span>
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
          style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
      {expanded && (
        <div className="chat-process-content">
          {process.entries.length === 0 ? (
            <div className="chat-process-empty">等待 agent 事件...</div>
          ) : process.entries.map((entry) => (
            <ProcessEntryRow
              key={entry.id}
              messageId={messageId}
              entry={entry}
              onToggleEntry={onToggleEntry}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function useProcessTicker(enabled: boolean) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);

  return now;
}

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
  const [userMsgHistoryOpen, setUserMsgHistoryOpen] = useState(false);
  const userMsgHistoryRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const modelFetchRunIdRef = useRef(0);
  const streamBufferRef = useRef("");
  const preFinalStreamBufferRef = useRef("");
  const processOutputBufferRef = useRef("");
  const processOutputEntryIdRef = useRef<string | null>(null);
  const processOutputFlushedRef = useRef(false);
  const processOutputFlushedTextRef = useRef("");
  const thinkingBufferRef = useRef("");
  const thinkingEntryIdRef = useRef<string | null>(null);
  const processActiveRef = useRef(false);
  const activeToolEntryRef = useRef<Record<string, string>>({});
  const activeToolFileRef = useRef<Record<string, AgentProcessFile[]>>({});
  const streamWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUserScrollingRef = useRef(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track user scrolling - stop auto-scroll when user scrolls up
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      if (!atBottom) {
        isUserScrollingRef.current = true;
      } else {
        isUserScrollingRef.current = false;
      }
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

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
    if (!el || isUserScrollingRef.current) return;
    // Check if already near bottom (within 100px)
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (atBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Instant scroll to bottom on session switch (no animation)
  // Also scroll when session initializes (messages become visible in DOM)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    isUserScrollingRef.current = false;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [activeSessionId, activeSessionInitialized]);

  // Persist messages to sessionMessages whenever messages change (for restart survival)
  useEffect(() => {
    if (activeSessionId && messages.length > 0) {
      loadSessionMessages(activeSessionId, messages);
    }
  }, [messages, activeSessionId]);

  // Subscribe to agent events
  useEffect(() => {
    const appendProcessEntry = (entry: Omit<AgentProcessEntry, "id" | "timestamp"> & { id?: string; timestamp?: number }) => {
      if (!processActiveRef.current) return;
      useChatStore.getState().appendLastAssistantProcessEntry({
        id: entry.id || createProcessEntryId(),
        timestamp: entry.timestamp || Date.now(),
        type: entry.type,
        title: entry.title,
        detail: entry.detail,
        files: entry.files,
        state: entry.state,
        expanded: entry.expanded,
      });
    };

    const finishThinkingEntry = () => {
      if (thinkingEntryIdRef.current) {
        useChatStore.getState().updateLastAssistantProcessEntry(thinkingEntryIdRef.current, {
          state: "completed",
        });
      }
      thinkingEntryIdRef.current = null;
      thinkingBufferRef.current = "";
    };

    const appendThinkingDelta = (delta: string) => {
      if (!delta) return;
      thinkingBufferRef.current += delta;
      const thinkingPreview = thinkingBufferRef.current ?
        (thinkingBufferRef.current.length > 50 ? thinkingBufferRef.current.substring(0, 50) + "..." : thinkingBufferRef.current) :
        "思考中";

      if (thinkingEntryIdRef.current) {
        useChatStore.getState().updateLastAssistantProcessEntry(thinkingEntryIdRef.current, {
          title: `正在思考: ${thinkingPreview}`,
          detail: thinkingBufferRef.current,
          state: "running",
        });
      } else {
        const entryId = createProcessEntryId();
        thinkingEntryIdRef.current = entryId;
        appendProcessEntry({
          id: entryId,
          type: "thinking",
          title: `正在思考: ${thinkingPreview}`,
          detail: thinkingBufferRef.current,
          state: "running",
          expanded: true,
        });
      }
    };

    const appendProcessOutput = (delta: string) => {
      processOutputBufferRef.current += delta;
    };

    const flushProcessOutput = () => {
      const rawOutput = processOutputBufferRef.current;
      const output = processOutputBufferRef.current.trim();
      if (!output) return;
      finishThinkingEntry();
      const entryId = createProcessEntryId();
      appendProcessEntry({
        id: entryId,
        type: "info",
        title: output,
        detail: output,
        state: "completed",
        expanded: true,
      });
      processOutputFlushedRef.current = true;
      processOutputFlushedTextRef.current += rawOutput;
      processOutputEntryIdRef.current = null;
      processOutputBufferRef.current = "";
    };

    const clearStreamWatchdog = () => {
      if (streamWatchdogRef.current) {
        clearTimeout(streamWatchdogRef.current);
        streamWatchdogRef.current = null;
      }
    };

    const completeAssistantStream = (
      currentSessionId: string | null,
      content?: string,
      timedOut = false
    ) => {
      clearStreamWatchdog();
      const pendingFinalContent = processOutputBufferRef.current.trim();
      const rawFinalContent = (content || streamBufferRef.current || pendingFinalContent).trim();
      const flushedContent = processOutputFlushedTextRef.current.trim();
      const finalContent = processOutputFlushedRef.current
        ? pendingFinalContent ||
          (flushedContent && rawFinalContent.startsWith(flushedContent)
            ? rawFinalContent.slice(flushedContent.length).trim()
            : rawFinalContent)
        : rawFinalContent;
      if (finalContent.trim().length > 0) {
        streamBufferRef.current = finalContent;
        useChatStore.getState().updateLastAssistant(finalContent);
        useChatStore.getState().collapseLastAssistantProcess();
      } else if (timedOut) {
        useChatStore.getState().appendLastAssistantProcessEntry({
          id: createProcessEntryId(),
          timestamp: Date.now(),
          type: "error",
          title: "未收到响应结束事件",
          detail: "Agent 长时间没有返回新的输出，已停止等待。",
          state: "error",
          expanded: true,
        });
      }
      finishThinkingEntry();
      setStreaming(false);
      useChatStore.getState().finishLastAssistantProcess(Date.now());
      processActiveRef.current = false;
      activeToolEntryRef.current = {};
      activeToolFileRef.current = {};
      thinkingEntryIdRef.current = null;
      processOutputEntryIdRef.current = null;
      processOutputBufferRef.current = "";
      processOutputFlushedRef.current = false;
      processOutputFlushedTextRef.current = "";
      if (currentSessionId) useProjectStore.getState().setAgentStatus(currentSessionId, timedOut ? "error" : "completed");
    };

    const refreshStreamWatchdog = (currentSessionId: string | null) => {
      clearStreamWatchdog();
      if (!processActiveRef.current) return;
      streamWatchdogRef.current = setTimeout(() => {
        completeAssistantStream(currentSessionId, undefined, true);
      }, 45000);
    };

    const unsubscribe = window.electronAPI.onAgentEvent((event: any) => {
      // Always read from store to avoid stale closure (useEffect deps=[])
      const currentSessionId = useProjectStore.getState().activeSessionId;
      if (
        event.type !== "message_start" &&
        event.type !== "stream_start" &&
        event.type !== "stream_end" &&
        event.type !== "agent_end" &&
        event.type !== "agent_disconnected"
      ) {
        refreshStreamWatchdog(currentSessionId);
      }
      switch (event.type) {
        case "message_start":
          processActiveRef.current = true;
          const messagePreview = event.content ?
            (event.content.length > 50 ? event.content.substring(0, 50) + "..." : event.content) :
            "用户消息";
          appendProcessEntry({
            type: "status",
            title: `收到消息: "${messagePreview}"`,
            detail: event.content ? truncateProcessDetail(String(event.content)) : undefined,
            state: "completed",
          });
          break;
        case "stream_start":
          flushSync(() => {
            streamBufferRef.current = "";
            preFinalStreamBufferRef.current = "";
            processOutputBufferRef.current = "";
            processOutputEntryIdRef.current = null;
            processOutputFlushedRef.current = false;
            processOutputFlushedTextRef.current = "";
            thinkingBufferRef.current = "";
            thinkingEntryIdRef.current = null;
            setStreaming(true);
            processActiveRef.current = true;
            activeToolEntryRef.current = {};
            activeToolFileRef.current = {};
            useChatStore.getState().startAssistantProcess(Date.now());
            if (currentSessionId) useProjectStore.getState().setAgentStatus(currentSessionId, "running");
          });
          appendProcessEntry({ type: "status", title: "正在分析请求并生成响应", state: "running" });
          refreshStreamWatchdog(currentSessionId);
          break;
        case "stream_delta":
          if (!event.delta) break;
          finishThinkingEntry();
          preFinalStreamBufferRef.current += event.delta;
          appendProcessOutput(String(event.delta));
          break;
        case "thinking_delta":
          appendThinkingDelta(String(event.delta || ""));
          break;
        case "thinking_end":
          finishThinkingEntry();
          break;
        case "user_ask_question":
        case "ask_user_question":
        case "ask_user":
        case "droid.ask_user":
          {
            finishThinkingEntry();
            flushProcessOutput();
            const questionDetail = event.detail ?? event.question ?? event.prompt ?? event.args ?? event.input ?? event;
            appendProcessEntry({
              type: "question",
              title: getAskUserTitle(String(event.type), false),
              detail: truncateProcessDetail(stringifyProcessValue(questionDetail)),
              state: "completed",
              expanded: false,
            });
          }
          break;
        case "stream_end":
          {
            finishThinkingEntry();
            const eventContent = event.content ? String(event.content) : "";
            completeAssistantStream(currentSessionId, eventContent, false);
          }
          break;
        case "agent_end":
          // Some backends can emit agent_end before the assistant stream is
          // actually complete. stream_end is the UI completion signal.
          break;
        case "agent_disconnected":
          finishThinkingEntry();
          completeAssistantStream(currentSessionId, undefined, true);
          break;
        case "tool_start":
          {
            finishThinkingEntry();
            flushProcessOutput();
            const toolName = getToolName(event);
            const key = getToolKey(event);
            const existingEntryId = activeToolEntryRef.current[key];
            const args = event.args || event.input || event.parameters || {};
            const toolFiles = getToolProcessFiles(event, toolName);
            if (toolFiles.length > 0) activeToolFileRef.current[key] = toolFiles;
            const toolDetail = toolFiles.length > 0 ? "" : getToolDetail(event);
            const filePath = args.filePath || args.path || args.file || "";
            const command = args.command || args.cmd || "";
            const pattern = args.pattern || args.query || "";
            const normalizedName = normalizeToolName(toolName);
            
            let toolSummary: string;
            switch (normalizedName) {
              case "read":
              case "readfile":
              case "read_file":
              case "view":
                toolSummary = filePath ? `正在读取文件: ${filePath}` : "正在读取文件";
                break;
              case "write":
              case "writefile":
              case "write_file":
                toolSummary = filePath ? `正在写入文件: ${filePath}` : "正在写入文件";
                break;
              case "edit":
              case "multiedit":
              case "multi_edit":
              case "apply_patch":
              case "str_replace_editor":
              case "str_replace_based_edit_tool":
                toolSummary = filePath ? `正在编辑文件: ${filePath}` : "正在编辑文件";
                break;
              case "bash":
                toolSummary = command ? `正在执行命令: ${command.length > 30 ? command.substring(0, 30) + "..." : command}` : "正在执行命令";
                break;
              case "glob":
                toolSummary = pattern ? `正在搜索文件: ${pattern}` : "正在搜索文件";
                break;
              case "grep":
                toolSummary = pattern ? `正在搜索内容: ${pattern}` : "正在搜索内容";
                break;
              case "search":
                toolSummary = pattern ? `正在搜索文件: ${pattern}` : "正在搜索文件";
                break;
              case "list":
                toolSummary = filePath ? `正在列出文件: ${filePath}` : "正在列出文件";
                break;
              case "readDir":
                toolSummary = filePath ? `正在读取目录: ${filePath}` : "正在读取目录";
                break;
              case "webfetch":
                toolSummary = "正在获取网页内容";
                break;
              case "websearch":
                toolSummary = "正在搜索网络";
                break;
              default:
                toolSummary = `正在运行 ${toolName}`;
            }
            const entryType: AgentProcessEntry["type"] = isAskUserToolName(toolName) ? "question" : "tool";
            if (entryType === "question") {
              toolSummary = getAskUserTitle(toolName, true);
            } else if (toolFiles.length > 0) {
              toolSummary = getFileEntryTitle(toolFiles[0].action, toolFiles.length, true);
            }
            if (existingEntryId) {
              useChatStore.getState().updateLastAssistantProcessEntry(existingEntryId, {
                title: toolSummary,
                detail: toolDetail || undefined,
                files: toolFiles.length > 0 ? toolFiles : undefined,
                state: "running",
                type: entryType,
                expanded: true,
              });
            } else {
              const entryId = createProcessEntryId();
              activeToolEntryRef.current[key] = entryId;
              appendProcessEntry({
                id: entryId,
                type: entryType,
                title: toolSummary,
                detail: toolDetail || undefined,
                files: toolFiles.length > 0 ? toolFiles : undefined,
                state: "running",
                expanded: true,
              });
            }
          }
          break;
        case "tool_end":
          {
            finishThinkingEntry();
            const key = getToolKey(event);
            const entryId = activeToolEntryRef.current[key];
            const toolName = getToolName(event);
            const args = event.args || event.input || event.parameters || {};
            const toolFiles = getToolProcessFiles(event, toolName);
            const preservedToolFiles = toolFiles.length > 0 ? toolFiles : activeToolFileRef.current[key] || [];
            const toolDetail = toolFiles.length > 0 && !event.isError ? "" : getToolDetail(event);
            const finalToolDetail = preservedToolFiles.length > 0 && !event.isError ? "" : toolDetail;
            const toolSummary = preservedToolFiles.length > 0 && !event.isError
              ? getFileEntryTitle(preservedToolFiles[0].action, preservedToolFiles.length, false)
              : getToolSummary(toolName, args, event.isError);
            const entryType: AgentProcessEntry["type"] = isAskUserToolName(toolName)
              ? (event.isError ? "error" : "question")
              : (event.isError ? "error" : "tool");
            const patch = {
              title: toolSummary,
              detail: finalToolDetail || undefined,
              files: preservedToolFiles.length > 0 && !event.isError ? preservedToolFiles : undefined,
              state: event.isError ? "error" : "completed",
              type: entryType,
              expanded: !!event.isError,
            } satisfies Partial<Omit<AgentProcessEntry, "id">>;

            if (entryId) {
              useChatStore.getState().updateLastAssistantProcessEntry(entryId, patch);
              delete activeToolEntryRef.current[key];
              delete activeToolFileRef.current[key];
            } else {
              appendProcessEntry({
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
          if (event.diffs && event.diffs.length > 0) {
            finishThinkingEntry();
            flushProcessOutput();
            useChatStore.getState().appendLastAssistantDiffs(event.diffs);
            const fileNames = event.diffs.map((diff: FileDiff) => {
              const parts = diff.file.split(/[/\\]/);
              return parts[parts.length - 1];
            });
            const diffTitle = event.diffs.length === 1 ?
              "已修改文件" :
              `已修改 ${event.diffs.length} 个文件`;
            appendProcessEntry({
              type: "diff",
              title: diffTitle,
              files: buildProcessFilesFromDiffs(event.diffs),
              state: "completed",
              expanded: false,
            });
          }
          break;
        case "process_event":
          finishThinkingEntry();
          flushProcessOutput();
          const eventType = normalizeProcessEntryType(event.entryType || event.kind || event.mode || event.toolName || event.name);
          const eventTitle = String(event.title || "Agent 事件");
          const eventDetail = event.detail ? truncateProcessDetail(stringifyProcessValue(event.detail)) : undefined;
          const eventState = normalizeProcessEntryState(event.state);

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

          appendProcessEntry({
            type: eventType,
            title: processedTitle,
            detail: eventDetail,
            state: eventState,
          });
          break;
        case "agent_ready":
          const agentName = getAgentName(String(event.agentId || activeAgentId));
          appendProcessEntry({
            type: "status",
            title: `${agentName} 已就绪，可以开始对话`,
            state: "completed",
          });
          // Models are fetched by the useEffect watching activeSessionId
          break;
        default:
          if (isAskUserToolName(event.mode || event.entryType || event.kind || event.toolName || event.name)) {
            finishThinkingEntry();
            flushProcessOutput();
            const questionDetail = event.detail ?? event.question ?? event.prompt ?? event.args ?? event.input ?? event;
            appendProcessEntry({
              type: "question",
              title: getAskUserTitle(String(event.mode || event.type || "user_ask_question"), false),
              detail: truncateProcessDetail(stringifyProcessValue(questionDetail)),
              state: normalizeProcessEntryState(event.state) || "completed",
              expanded: false,
            });
          }
          break;
      }
    });
    return () => {
      clearStreamWatchdog();
      unsubscribe();
    };
  }, []);

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && pendingImages.length === 0 && pendingFiles.length === 0) || isStreaming) return;

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
    isUserScrollingRef.current = false; // Reset so auto-scroll follows new message
    if (streamWatchdogRef.current) {
      clearTimeout(streamWatchdogRef.current);
      streamWatchdogRef.current = null;
    }
    flushSync(() => {
      addMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: displayContent,
        timestamp: Date.now(),
        images: messageImages,
      });
      setInput("");
      setPendingImages([]);
      clearPendingFiles();
      setStreaming(true);
      thinkingBufferRef.current = "";
      thinkingEntryIdRef.current = null;
      processOutputBufferRef.current = "";
      processOutputEntryIdRef.current = null;
      processOutputFlushedTextRef.current = "";
    });

    const result = await window.electronAPI.agentSendMessage(sendContent, agentImages);
    if (!result.success) {
      if (streamWatchdogRef.current) {
        clearTimeout(streamWatchdogRef.current);
        streamWatchdogRef.current = null;
      }
      useChatStore.getState().finishLastAssistantProcess(Date.now());
      processActiveRef.current = false;
      activeToolEntryRef.current = {};
      activeToolFileRef.current = {};
      processOutputBufferRef.current = "";
      processOutputEntryIdRef.current = null;
      processOutputFlushedTextRef.current = "";
      setStreaming(false);
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: `发送失败: ${result.error || "请先在项目中启动 Agent"}`,
        timestamp: Date.now(),
      });
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

  const handleAbort = async () => {
    await window.electronAPI.agentAbort();
    if (streamWatchdogRef.current) {
      clearTimeout(streamWatchdogRef.current);
      streamWatchdogRef.current = null;
    }
    useChatStore.getState().finishLastAssistantProcess(Date.now());
    processActiveRef.current = false;
    activeToolEntryRef.current = {};
    activeToolFileRef.current = {};
    thinkingEntryIdRef.current = null;
    processOutputBufferRef.current = "";
    processOutputEntryIdRef.current = null;
    processOutputFlushedTextRef.current = "";
    setStreaming(false);
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
          {activeProject.sessions.length > 0 && (
            <div className="chat-session-list">
              {activeProject.sessions.map((session) => {
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
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="chat-panel">
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
      <div ref={scrollRef} className="chat-messages">
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
                  onToggle={toggleAssistantProcess}
                  onToggleEntry={toggleAssistantProcessEntry}
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

        {isStreaming && messages.length > 0 && messages[messages.length - 1].role === "user" && (
          <div className="chat-working">
            <div className="chat-working-spinner" />
            <span>正在处理您的请求...</span>
          </div>
        )}
        </>)}
      </div>

      {/* Input area */}
      <div className="chat-input-area">
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
            placeholder={sendKey === "Ctrl+Enter" ? "输入消息... (Ctrl+Enter 发送, Enter 换行, 粘贴图片)" : "输入消息... (Enter 发送, Ctrl+Enter 换行, 粘贴图片)"}
            rows={1}
            className="chat-textarea"
          />
          <button
            onClick={isStreaming ? handleAbort : handleSend}
            disabled={!isStreaming && !input.trim() && pendingImages.length === 0 && pendingFiles.length === 0}
            className={`chat-send-btn ${isStreaming ? "abort" : ""}`}
            title={isStreaming ? "停止" : "发送"}
          >
            {isStreaming ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 2L11 13" />
                <path d="M22 2L15 22L11 13L2 9L22 2Z" />
              </svg>
            )}
          </button>
        </div>

        {/* Toolbar below input */}
        <div className="chat-input-toolbar">
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
    </div>
  );
}
