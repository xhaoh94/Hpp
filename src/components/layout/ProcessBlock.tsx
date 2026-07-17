import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentProcess,
  AgentProcessEntry,
  AgentProcessFile,
} from "@/stores/chat-store";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import {
  formatCommandGroupTitle,
  getCommandStateLabel,
  getProcessFileActionLabel,
  getProcessStepStatusLabel,
  uiText,
} from "@/i18n/text";
import {
  getStepProgressText,
  normalizeInferredStepsForDisplay,
  summarizeProcessEntries,
} from "./processBlockUtils";
import {
  createProcessEntryMerger,
  getProcessFileName,
} from "./processEntryMerge";
import {
  groupProcessEntries,
  getVisibleProcessEntries,
  isProcessInterrupted,
  splitCommandDetail,
} from "@shared/process-view";

type PreserveScroll = (action: () => void, anchor?: HTMLElement | null) => void;

const formatProcessDuration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
};

function ProcessProgressSummary({
  process,
  fallback,
}: {
  process: AgentProcess;
  fallback: string;
}) {
  const steps = normalizeInferredStepsForDisplay(process, process.planSteps || []);
  const hasProgress = steps.length > 0;

  if (!hasProgress) {
    return <span className="chat-process-summary">{fallback}</span>;
  }

  const stepText = getStepProgressText(steps);

  return (
    <span
      className="chat-process-progress"
      tabIndex={0}
      onClick={(event) => event.stopPropagation()}
      aria-label={stepText}
    >
      {stepText && <span className="chat-process-progress-step">{stepText}</span>}
      {steps.length > 0 && (
        <span className="chat-process-step-popover" role="tooltip">
          <span className="chat-process-step-popover-title">{uiText.process.progressTitle}</span>
          <span className="chat-process-step-list">
            {steps.map((step, index) => (
              <span className="chat-process-step-row" key={step.id || `${step.title}-${index}`}>
                <span className={`chat-process-step-dot ${step.status}`} />
                <span className="chat-process-step-title">{step.title}</span>
                <span className="chat-process-step-status">{getProcessStepStatusLabel(step.status)}</span>
              </span>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}

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
        const action = getProcessFileActionLabel(file.action);
        const label = file.label || getProcessFileName(file.file);
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

const tryParseJson = (value: string): unknown | null => {
  const text = value.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const escapeInlineCode = (value: string) => value.replace(/`/g, "\\`");

const escapeMarkdownLabel = (value: string) =>
  value.replace(/([\\`*_{}[\]()#+.!|-])/g, "\\$1");

const formatMarkdownValue = (value: unknown) => {
  if (value === null) return "`null`";
  if (value === undefined) return "`undefined`";
  if (typeof value === "number" || typeof value === "boolean") return `\`${String(value)}\``;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return '`""`';
    if (text.length <= 140 && !text.includes("\n")) return text;
    return `\n\n\`\`\`text\n${text}\n\`\`\``;
  }
  return `\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
};

const formatEmbeddedErrorMessage = (message: string): string | null => {
  const match = message.match(/^(.*?):\s*(\{.*\})(?:,\s*url:\s*(.*?))?(?:,\s*request id:\s*(.*))?$/);
  if (!match) return null;

  const [, prefix, jsonText, url, requestId] = match;
  const embedded = tryParseJson(jsonText);
  if (!embedded || typeof embedded !== "object" || Array.isArray(embedded)) return null;

  const lines = [
    `- **${uiText.process.errorLabel}**: ${prefix.trim()}`,
    ...Object.entries(embedded).map(([key, value]) =>
      `- **${escapeMarkdownLabel(key)}**: ${formatMarkdownValue(value)}`
    ),
  ];
  if (url?.trim()) lines.push(`- **url**: ${url.trim()}`);
  if (requestId?.trim()) lines.push(`- **request id**: \`${escapeInlineCode(requestId.trim())}\``);
  return lines.join("\n");
};

const formatErrorDetailAsMarkdown = (detail?: string) => {
  if (!detail?.trim()) return null;
  const parsed = tryParseJson(detail);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const lines: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "message" && typeof value === "string") {
      const embedded = formatEmbeddedErrorMessage(value);
      if (embedded) {
        lines.push(embedded);
        continue;
      }
    }
    lines.push(`- **${escapeMarkdownLabel(key)}**: ${formatMarkdownValue(value)}`);
  }
  return lines.join("\n");
};

function CommandDetail({
  entry,
  onPreserveScroll,
}: {
  entry: AgentProcessEntry;
  onPreserveScroll?: PreserveScroll;
}) {
  const [outputExpanded, setOutputExpanded] = useState(false);
  const userToggledRef = useRef(false);
  const { command, output } = useMemo(
    () => splitCommandDetail(entry),
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
    <div className={`chat-command-detail ${outputExpanded ? "expanded" : "collapsed"}`}>
      <button
        className="chat-command-header"
        onClick={canExpand ? (event) => toggleOutput(event.currentTarget) : undefined}
        disabled={!canExpand}
      >
        <span className="chat-command-prompt">$_</span>
        <span className="chat-command-text">{command || entry.title}</span>
        <span className="chat-command-state">{getCommandStateLabel(entry.state)}</span>
        {canExpand && (
          <svg
            className="chat-command-chevron"
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
            style={{ transform: outputExpanded ? "rotate(180deg)" : "rotate(0deg)" }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        )}
      </button>
      {outputLines.length > 0 && outputExpanded && (
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
          <span className="chat-process-entry-title">{formatCommandGroupTitle(entries.length)}</span>
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
  const files = entry.files || [];
  const isCommandEntry = entry.toolKind === "run_command";
  const canExpand = hasDetail;
  const detailVisible = hasDetail && !isCommandEntry && (!canExpand || entry.expanded);
  const commandVisible = isCommandEntry && hasDetail && (!canExpand || entry.expanded);
  const errorDetailMarkdown =
    detailVisible && (entry.type === "error" || entry.state === "error")
      ? formatErrorDetailAsMarkdown(entry.detail)
      : null;

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
        {detailVisible && errorDetailMarkdown && (
          <div className={`chat-process-entry-detail chat-process-error-markdown ${canExpand ? "panel" : ""}`}>
            <MarkdownRenderer content={errorDetailMarkdown} />
          </div>
        )}
        {detailVisible && !errorDetailMarkdown && (
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
  return <>{groupProcessEntries(entries).map((group) => group.kind === "commands" ? (
    <CommandGroup
      key={`commands-${group.entries[0].id}`}
      entries={group.entries}
      onPreserveScroll={onPreserveScroll}
    />
  ) : (
    <ProcessEntryRow
      key={group.entry.id}
      messageId={messageId}
      entry={group.entry}
      onToggleEntry={onToggleEntry}
      onOpenFile={onOpenFile}
      onPreserveScroll={onPreserveScroll}
    />
  ))}</>;
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
    () => isProcessInterrupted(process.entries),
    [process.entries]
  );
  const visibleEntries = useMemo(
    () => getVisibleProcessEntries(process.entries),
    [process.entries]
  );
  const summary = useMemo(
    () => summarizeProcessEntries(visibleEntries),
    [visibleEntries]
  );
  const mergeProcessEntriesRef = useRef(createProcessEntryMerger());
  const mergedEntries = useMemo(
    () => expanded ? mergeProcessEntriesRef.current(visibleEntries) : [],
    [expanded, visibleEntries]
  );

  return (
    <div className={`chat-process ${interrupted ? "interrupted" : ""}`}>
      <button className="chat-process-toggle" onClick={(event) => onToggle(messageId, event.currentTarget)}>
        <span>{interrupted ? uiText.process.interrupted : uiText.process.elapsed} {elapsed}</span>
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
          {visibleEntries.length === 0 ? (
            <div className="chat-process-empty">{uiText.process.emptyEvents}</div>
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
