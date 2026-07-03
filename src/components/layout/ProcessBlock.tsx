import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  AgentProcess,
  AgentProcessChangeSummary,
  AgentProcessEntry,
  AgentProcessFile,
  AgentProcessStep,
} from "@/stores/chat-store";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";

type PreserveScroll = (action: () => void, anchor?: HTMLElement | null) => void;

const THINKING_PREVIEW_CHAR_LIMIT = 240;

const getThinkingPreview = (value?: string) => {
  const preview = value?.replace(/\s+/g, " ").trim();
  if (!preview) return "思考中";
  return preview.length > THINKING_PREVIEW_CHAR_LIMIT
    ? `${preview.slice(0, THINKING_PREVIEW_CHAR_LIMIT)}...`
    : preview;
};

const formatProcessDuration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
};

const summarizeProcessEntries = (entries: AgentProcessEntry[]) => {
  if (entries.length === 0) return "等待事件";

  if (entries.some((entry) => entry.state === "interrupted")) return "已中断";

  const toolCount = entries.filter((entry) => entry.type === "tool" || entry.type === "question" || entry.type === "error").length;
  const diffCount = entries.filter((entry) => entry.type === "diff").length;
  const isThinking = entries.some((entry) => entry.type === "thinking" && entry.state === "running");
  const thinkingEntry = entries.find((entry) => entry.type === "thinking" && entry.state === "running");
  const runningTool = entries.find((entry) => (entry.type === "tool" || entry.type === "question") && entry.state === "running");

  if (isThinking && thinkingEntry) {
    return `正在思考: ${getThinkingPreview(thinkingEntry.detail)}`;
  }

  if (runningTool) {
    return runningTool.title;
  }

  if (toolCount > 0 && diffCount > 0) return `已执行 ${toolCount} 个操作, 修改 ${diffCount} 个文件`;
  if (toolCount > 0) return `已执行 ${toolCount} 个操作`;
  if (diffCount > 0) return `已修改 ${diffCount} 个文件`;

  return `${entries.length} 条事件`;
};

const getStepProgressIndex = (steps: AgentProcessStep[], ended: boolean) => {
  if (steps.length === 0) return 0;
  const runningIndex = steps.findIndex((step) => step.status === "running");
  if (runningIndex >= 0) return runningIndex + 1;

  const terminalIndex = steps.findIndex((step) => step.status === "failed" || step.status === "cancelled");
  if (terminalIndex >= 0) return terminalIndex + 1;

  const completed = steps.filter((step) => step.status === "completed").length;
  if (completed > 0) return Math.min(steps.length, completed);
  return ended ? steps.length : 1;
};

const formatChangeSummary = (summary?: AgentProcessChangeSummary) => {
  if (!summary || summary.filesChanged <= 0) return "";
  const parts = [`${summary.filesChanged} 个文件已更改`];
  if (summary.additions > 0) parts.push(`+${summary.additions}`);
  if (summary.deletions > 0) parts.push(`-${summary.deletions}`);
  return parts.join(" ");
};

const getStepStatusLabel = (status: AgentProcessStep["status"]) => {
  switch (status) {
    case "running": return "进行中";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "cancelled": return "已取消";
    default: return "待处理";
  }
};

function ProcessProgressSummary({
  process,
  fallback,
}: {
  process: AgentProcess;
  fallback: string;
}) {
  const steps = process.planSteps || [];
  const changeText = formatChangeSummary(process.changeSummary);
  const hasProgress = steps.length > 0 || !!changeText;

  if (!hasProgress) {
    return <span className="chat-process-summary">{fallback}</span>;
  }

  const stepText = steps.length > 0
    ? `第 ${getStepProgressIndex(steps, !!process.endedAt)} / ${steps.length} 步`
    : "";

  return (
    <span
      className="chat-process-progress"
      tabIndex={0}
      onClick={(event) => event.stopPropagation()}
      aria-label={[stepText, changeText].filter(Boolean).join(" · ")}
    >
      {stepText && <span className="chat-process-progress-step">{stepText}</span>}
      {stepText && changeText && <span className="chat-process-progress-divider">·</span>}
      {changeText && <span className="chat-process-progress-change">{changeText}</span>}
      {steps.length > 0 && (
        <span className="chat-process-step-popover" role="tooltip">
          <span className="chat-process-step-popover-title">步骤进度</span>
          <span className="chat-process-step-list">
            {steps.map((step, index) => (
              <span className="chat-process-step-row" key={step.id || `${step.title}-${index}`}>
                <span className={`chat-process-step-dot ${step.status}`} />
                <span className="chat-process-step-title">{step.title}</span>
                <span className="chat-process-step-status">{getStepStatusLabel(step.status)}</span>
              </span>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}

const getFileName = (filePath: string) => {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
};

const getFileEntryTitle = (
  action: AgentProcessFile["action"] | undefined,
  count: number,
  running = false
) => {
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

const normalizeProcessFileKey = (filePath: string) =>
  filePath.replace(/\\/g, "/").trim().toLowerCase();

const mergeProcessFileCounts = (left?: number, right?: number) => {
  if (typeof left !== "number" && typeof right !== "number") return undefined;
  return (left || 0) + (right || 0);
};

const mergeProcessFiles = (files: AgentProcessFile[]) => {
  const byFile = new Map<string, AgentProcessFile>();

  for (const file of files) {
    if (!file.file?.trim()) continue;

    const key = normalizeProcessFileKey(file.file);
    const existing = byFile.get(key);
    if (!existing) {
      byFile.set(key, { ...file, label: file.label || getFileName(file.file) });
      continue;
    }

    byFile.set(key, {
      ...existing,
      ...file,
      label: existing.label || file.label || getFileName(file.file),
      additions: mergeProcessFileCounts(existing.additions, file.additions),
      deletions: mergeProcessFileCounts(existing.deletions, file.deletions),
    });
  }

  return Array.from(byFile.values());
};

function ProcessEntryIcon({ type, state }: { type: AgentProcessEntry["type"]; state?: AgentProcessEntry["state"] }) {
  if (state === "running") {
    return <span className="chat-process-entry-spinner" />;
  }

  if (state === "interrupted") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="9" />
        <path d="M9 9l6 6M15 9l-6 6" strokeLinecap="round" />
      </svg>
    );
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

function ProcessEntryFiles({
  files,
  onOpenFile,
}: {
  files: AgentProcessFile[];
  onOpenFile: (filePath: string) => void;
}) {
  return (
    <div className="chat-process-files">
      {files.map((file, index) => {
        const action =
          file.action === "read" ? "已读取" :
          file.action === "listed" ? "已查看" :
          file.action === "written" ? "已写入" :
          file.action === "edited" ? "已编辑" :
          "已修改";
        const label = file.label || getFileName(file.file);
        const canOpen = file.action !== "listed";
        return (
          <div className="chat-process-file" key={`${file.file}-${index}`}>
            <span className="chat-process-file-action">{action}</span>
            <button
              className={`chat-process-file-name ${canOpen ? "openable" : ""}`}
              title={file.file}
              onClick={canOpen ? () => onOpenFile(file.file) : undefined}
              disabled={!canOpen}
            >
              {label}
            </button>
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

const splitCommandDetail = (detail?: string, command?: string) => {
  if (!detail) return { command: command || "", output: "" };
  const lines = detail.split("\n");
  const firstLine = lines[0] || "";
  if (firstLine.startsWith("$ ")) {
    return {
      command: command || firstLine.slice(2).trim(),
      output: lines.slice(1).join("\n").trim(),
    };
  }
  return { command: command || "", output: detail.trim() };
};

function CommandDetail({
  entry,
  onPreserveScroll,
}: {
  entry: AgentProcessEntry;
  onPreserveScroll?: PreserveScroll;
}) {
  const [outputExpanded, setOutputExpanded] = useState(entry.state === "running");
  const userToggledRef = useRef(false);
  const { command, output } = useMemo(
    () => splitCommandDetail(entry.detail, entry.command),
    [entry.detail, entry.command]
  );
  const outputLines = useMemo(() => output ? output.split("\n") : [], [output]);
  const isRunning = entry.state === "running";
  const canExpand = outputLines.length > 0;

  useEffect(() => {
    if (!isRunning && !userToggledRef.current) {
      setOutputExpanded(false);
    }
  }, [isRunning]);

  const toggleOutput = (anchor?: HTMLElement | null) => {
    userToggledRef.current = true;
    const action = () => setOutputExpanded((current) => !current);
    if (onPreserveScroll) onPreserveScroll(action, anchor);
    else action();
  };

  return (
    <div className={`chat-command-detail ${outputExpanded || isRunning ? "expanded" : "collapsed"}`}>
      <button
        className="chat-command-header"
        onClick={canExpand ? (event) => toggleOutput(event.currentTarget) : undefined}
        disabled={!canExpand}
      >
        <span className="chat-command-prompt">$_</span>
        <span className="chat-command-text">{command || entry.title}</span>
        <span className="chat-command-state">{isRunning ? "运行中" : entry.state === "error" ? "失败" : entry.state === "interrupted" ? "已中断" : "完成"}</span>
        {canExpand && (
          <svg
            className="chat-command-chevron"
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
            style={{ transform: outputExpanded || isRunning ? "rotate(180deg)" : "rotate(0deg)" }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        )}
      </button>
      {outputLines.length > 0 && (outputExpanded || isRunning) && (
        <div className="chat-command-output">
          <div className="chat-command-lang">BASH</div>
          <pre>{outputLines.join("\n")}</pre>
        </div>
      )}
    </div>
  );
}

function CommandGroup({
  entries,
  onPreserveScroll,
}: {
  entries: AgentProcessEntry[];
  onPreserveScroll: PreserveScroll;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="chat-process-entry tool chat-command-group">
      <span className="chat-process-entry-icon">
        <ProcessEntryIcon type="tool" />
      </span>
      <div className="chat-process-entry-main">
        <button
          className="chat-process-entry-header expandable"
          onClick={(event) => onPreserveScroll(() => setExpanded((current) => !current), event.currentTarget)}
        >
          <span className="chat-process-entry-title">已运行 {entries.length} 条命令</span>
          <svg
            className="chat-process-entry-chevron"
            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        {expanded && (
          <div className="chat-command-group-list">
            {entries.map((entry) => (
              <CommandDetail key={entry.id} entry={entry} onPreserveScroll={onPreserveScroll} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProcessEntryRow({
  messageId,
  entry,
  onToggleEntry,
  onOpenFile,
  onPreserveScroll,
}: {
  messageId: string;
  entry: AgentProcessEntry;
  onToggleEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null) => void;
  onOpenFile: (filePath: string) => void;
  onPreserveScroll: PreserveScroll;
}) {
  const hasDetail = !!entry.detail;
  const files = useMemo(() => mergeProcessFiles(entry.files || []), [entry.files]);
  const isCommandEntry = entry.toolKind === "run_command";
  const canExpand = hasDetail;
  const detailVisible = hasDetail && !isCommandEntry && (!canExpand || entry.expanded);
  const commandVisible = isCommandEntry && hasDetail && (!canExpand || entry.expanded);

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
          onClick={canExpand ? (event) => onToggleEntry(messageId, entry.id, event.currentTarget) : undefined}
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
        {files.length > 0 && <ProcessEntryFiles files={files} onOpenFile={onOpenFile} />}
        {commandVisible && (
          <CommandDetail entry={entry} onPreserveScroll={onPreserveScroll} />
        )}
        {detailVisible && (
          <pre className={`chat-process-entry-detail ${canExpand ? "panel" : ""}`}>{entry.detail}</pre>
        )}
      </div>
    </div>
  );
}

function ProcessEntries({
  entries,
  messageId,
  onToggleEntry,
  onOpenFile,
  onPreserveScroll,
}: {
  entries: AgentProcessEntry[];
  messageId: string;
  onToggleEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null) => void;
  onOpenFile: (filePath: string) => void;
  onPreserveScroll: PreserveScroll;
}) {
  const rows: ReactNode[] = [];
  let commandEntries: AgentProcessEntry[] = [];

  const flushCommands = () => {
    if (commandEntries.length === 0) return;
    rows.push(
      <CommandGroup
        key={`commands-${commandEntries[0].id}`}
        entries={commandEntries}
        onPreserveScroll={onPreserveScroll}
      />
    );
    commandEntries = [];
  };

  entries.forEach((entry) => {
    if (entry.toolKind === "run_command") {
      commandEntries.push(entry);
      return;
    }

    flushCommands();
    rows.push(
      <ProcessEntryRow
        key={entry.id}
        messageId={messageId}
        entry={entry}
        onToggleEntry={onToggleEntry}
        onOpenFile={onOpenFile}
        onPreserveScroll={onPreserveScroll}
      />
    );
  });

  flushCommands();
  return <>{rows}</>;
}

const toolKindToAction = (toolKind: string): AgentProcessFile["action"] => {
  switch (toolKind) {
    case "read_file": return "read";
    case "list_dir": return "listed";
    case "write_file": return "written";
    case "edit_file": return "edited";
    default: return undefined;
  }
};

const mergeProcessEntries = (entries: AgentProcessEntry[]): AgentProcessEntry[] => {
  const merged: AgentProcessEntry[] = [];

  for (const entry of entries) {
    const last = merged[merged.length - 1];
    const entryFiles = entry.files ? mergeProcessFiles(entry.files) : undefined;

    if (
      entry.type === "tool" && last?.type === "tool" &&
      entry.toolKind && last.toolKind === entry.toolKind &&
      entry.state === last.state &&
      last.files && last.files.length > 0 &&
      entryFiles && entryFiles.length > 0
    ) {
      last.files = mergeProcessFiles([...last.files, ...entryFiles]);
      const action = toolKindToAction(entry.toolKind);
      last.title = getFileEntryTitle(action, last.files.length, entry.state === "running");
      last.id = entry.id;
      continue;
    }

    merged.push({ ...entry, files: entryFiles ? [...entryFiles] : undefined });
  }

  return merged;
};

function useProcessTicker(enabled: boolean) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);

  return now;
}

export function ProcessBlock({
  messageId,
  process,
  onToggle,
  onToggleEntry,
  onOpenFile,
  onPreserveScroll,
}: {
  messageId: string;
  process: AgentProcess;
  onToggle: (messageId: string, anchor?: HTMLElement | null) => void;
  onToggleEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null) => void;
  onOpenFile: (filePath: string) => void;
  onPreserveScroll: PreserveScroll;
}) {
  const nowTick = useProcessTicker(!process.endedAt);
  const durationEnd = process.endedAt || nowTick;
  const elapsed = formatProcessDuration(durationEnd - process.startedAt);
  const expanded = !!process.expanded;
  const interrupted = useMemo(
    () => process.entries.some((entry) => entry.state === "interrupted"),
    [process.entries]
  );
  const summary = useMemo(
    () => summarizeProcessEntries(process.entries),
    [process.entries]
  );
  const mergedEntries = useMemo(
    () => expanded ? mergeProcessEntries(process.entries) : [],
    [expanded, process.entries]
  );

  return (
    <div className={`chat-process ${interrupted ? "interrupted" : ""}`}>
      <button className="chat-process-toggle" onClick={(event) => onToggle(messageId, event.currentTarget)}>
        <span>{interrupted ? "已中断" : "处理耗时"} {elapsed}</span>
        <ProcessProgressSummary process={process} fallback={summary} />
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
          ) : (
            <ProcessEntries
              entries={mergedEntries}
              messageId={messageId}
              onToggleEntry={onToggleEntry}
              onOpenFile={onOpenFile}
              onPreserveScroll={onPreserveScroll}
            />
          )}
        </div>
      )}
    </div>
  );
}
