import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentCommentary,
  AgentProcess,
  AgentProcessEntry,
  AgentProcessFile,
  AgentSubagent,
} from "@/stores/chat-store";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import { ComposerMessageFlow } from "@/components/shared/ComposerMessageFlow";
import {
  composerDocumentHasContent,
  getComposerImageNodes,
  withoutComposerImages,
  type ComposerDocument,
} from "@shared/composer-document";
import {
  formatCommandGroupTitle,
  getCommandStateLabel,
  uiText,
} from "@/i18n/text";
import {
  canMergeAdjacentSubagentEntries,
  createProcessEntryMerger,
  getProcessFileName,
  mergeAdjacentSubagentEntries,
} from "./processEntryMerge";
import { getThinkingPreview, getThinkingPreviewMarkdown, isThinkingSingleLine } from "./agentEventUtils";
import {
  formatProcessDuration,
  getProcessGroupState,
  groupProcessEntries,
  getVisibleProcessEntries,
  getUserGuidanceText,
  isAssistantNarrationProcessEntry,
  isProcessInterrupted,
  isProcessViewRunning,
  isUserGuidanceProcessEntry,
  normalizeProcessForView,
  splitCommandDetail,
  type ProcessTerminalViewState,
} from "@shared/process-view";

type PreserveScroll = (action: () => void, anchor?: HTMLElement | null) => void;

export const formatIdleDuration = (ms: number) => {
  const seconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

type ProcessTimelineItem =
  | {
      kind: "entry";
      id: string;
      timestamp: number;
      order: number;
      entry: AgentProcessEntry;
    }
  | {
      kind: "commentary";
      id: string;
      timestamp: number;
      order: number;
      commentary: AgentCommentary;
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
  onOpenFile: (filePath: string, options?: { preview?: boolean }) => void;
}) {
  return (
    <div className="chat-process-files">
      {files.map((file, index) => {
        const label = file.label || getProcessFileName(file.file);
        const preview = file.action !== "listed";
        return (
          <div className="chat-process-file" key={`${file.file}-${index}`}>
            <button
              className="chat-process-file-name openable"
              title={file.file}
              onClick={() => onOpenFile(file.file, { preview })}
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
    <div className={`chat-command-detail ${entry.state || ""} ${outputExpanded ? "expanded" : "collapsed"}`}>
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
  const state = getProcessGroupState(entries);
  const warningTitle = entries.find((entry) => entry.state === "warning")?.title;

  return (
    <div className={`chat-process-entry tool chat-command-group ${state}`}>
      <span className="chat-process-entry-icon">
        <ProcessEntryIcon type="tool" state={state} />
      </span>
      <div className="chat-process-entry-main">
        <button
          className="chat-process-entry-header expandable"
          onClick={(event) => onPreserveScroll(() => setExpanded((current) => !current), event.currentTarget)}
        >
          <span className="chat-process-entry-title">{warningTitle || formatCommandGroupTitle(entries.length)}</span>
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

const getSubagentTone = (id: string) => {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 4;
};

const getSubagentStatusLabel = (status?: AgentSubagent["status"]) => {
  switch (status) {
    case "pending": return "等待中";
    case "running": return "工作中";
    case "completed": return "已完成";
    case "error": return "失败";
    case "interrupted": return "已中断";
    default: return "";
  }
};

function SubagentGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 1.8l1.6 3.1 3.45-.55-.55 3.45 3.1 1.6-3.1 1.6.55 3.45-3.45-.55L10 17.2l-1.6-3.3-3.45.55.55-3.45-3.1-1.6 3.1-1.6-.55-3.45 3.45.55L10 1.8z"
        fill="currentColor"
        fillOpacity="0.3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="9.5" r="2.2" fill="currentColor" />
    </svg>
  );
}

const getSubagentTooltip = (subagent: AgentSubagent) => [
  getSubagentStatusLabel(subagent.status),
  subagent.model,
  subagent.path,
  subagent.message,
].filter(Boolean).join(" · ");

function SubagentEntryRow({
  messageId,
  entry,
  onToggleEntry,
}: {
  messageId: string;
  entry: AgentProcessEntry;
  onToggleEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null) => void;
}) {
  const subagents = entry.subagents || [];
  const messages = subagents
    .map((subagent) => subagent.message?.trim())
    .filter((message): message is string => !!message && message !== entry.detail?.trim());
  const detail = [entry.detail?.trim(), ...new Set(messages)].filter(Boolean).join("\n\n");
  const canExpand = detail.length > 0;

  return (
    <div className={`chat-subagent-entry ${entry.state || ""}`}>
      <button
        type="button"
        className={`chat-subagent-event ${canExpand ? "expandable" : ""}`}
        onClick={canExpand ? (event) => onToggleEntry(messageId, entry.id, event.currentTarget) : undefined}
        disabled={!canExpand}
        aria-expanded={canExpand ? !!entry.expanded : undefined}
      >
        <span className="chat-subagent-chips">
          {subagents.map((subagent) => (
            <span
              className={`chat-subagent-chip ${subagent.status || ""}`}
              key={subagent.id}
              title={getSubagentTooltip(subagent) || subagent.label}
            >
              <span className={`chat-subagent-avatar tone-${getSubagentTone(subagent.id)}`}>
                <SubagentGlyph />
              </span>
              <span className="chat-subagent-label">{subagent.label}</span>
            </span>
          ))}
        </span>
        <span className="chat-subagent-event-title">{entry.title}</span>
        {canExpand && (
          <svg
            className="chat-subagent-chevron"
            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            style={{ transform: entry.expanded ? "rotate(90deg)" : "rotate(0deg)" }}
            aria-hidden="true"
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        )}
      </button>
      {canExpand && entry.expanded && (
        <div className="chat-subagent-detail">
          <MarkdownRenderer content={detail} />
        </div>
      )}
    </div>
  );
}

function ProcessEntryRow({
  messageId,
  entry,
  now,
  onToggleEntry,
  onOpenFile,
  onOpenImage,
  onPreserveScroll,
  receivedMessageDocument,
}: {
  messageId: string;
  entry: AgentProcessEntry;
  now: number;
  onToggleEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null) => void;
  onOpenFile: (filePath: string, options?: { preview?: boolean }) => void;
  onOpenImage: (src: string) => void;
  onPreserveScroll: PreserveScroll;
  receivedMessageDocument?: ComposerDocument;
}) {
  const isReceivedMessage = entry.toolKind === "message_received" || entry.title.startsWith("收到消息:");
  const showReceivedMessage = isReceivedMessage && !!receivedMessageDocument;
  const hasDetail = !!entry.detail && !showReceivedMessage;
  const files = entry.files || [];
  const isCommandEntry = entry.toolKind === "run_command";
  const canExpand = hasDetail;
  const detailVisible = hasDetail && !isCommandEntry && (!canExpand || entry.expanded);
  const commandVisible = isCommandEntry && hasDetail && (!canExpand || entry.expanded);
  const idleDuration = entry.toolKind === "stream_idle_notice" && entry.startedAt
    ? formatIdleDuration((entry.completedAt ?? now) - entry.startedAt)
    : null;
  const errorDetailMarkdown =
    detailVisible && (entry.type === "error" || entry.state === "error")
      ? formatErrorDetailAsMarkdown(entry.detail)
      : null;

  // Thinking 展开内容即使处于 expanded 也限制最多显示 10 行：
  // 内容超出时在底部提供"显示更多/收起"切换（纯 UI 状态，不写回 store）。
  const thinkingOutputRef = useRef<HTMLDivElement | null>(null);
  const [thinkingFullVisible, setThinkingFullVisible] = useState(false);
  const [thinkingOverflowing, setThinkingOverflowing] = useState(false);

  useEffect(() => {
    const el = thinkingOutputRef.current;
    if (!el || thinkingFullVisible) return;
    const check = () => setThinkingOverflowing(el.scrollHeight > el.clientHeight + 2);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [entry.detail, thinkingFullVisible]);

  if (entry.type === "subagent") {
    return (
      <SubagentEntryRow
        messageId={messageId}
        entry={entry}
        onToggleEntry={onToggleEntry}
      />
    );
  }

  if (isUserGuidanceProcessEntry(entry)) {
    const sourceDocument = entry.guidanceDocument;
    const guidanceDocument = sourceDocument ? withoutComposerImages(sourceDocument) : undefined;
    const documentImages = sourceDocument ? getComposerImageNodes(sourceDocument) : [];
    const guidanceImages = entry.guidanceImages?.length ? entry.guidanceImages : documentImages;
    const hasDocumentContent = !!guidanceDocument && composerDocumentHasContent(guidanceDocument);
    const fallbackText = !hasDocumentContent && (!sourceDocument || guidanceImages.length === 0)
      ? getUserGuidanceText(entry)
      : "";

    return (
      <div className="chat-process-guidance-row">
        <div className="chat-process-guidance-stack">
          {guidanceImages.length > 0 && (
            <div className="chat-process-guidance-images">
              {guidanceImages.map((image) => (
                <img
                  key={image.id}
                  src={image.src}
                  alt={image.name}
                  className="chat-process-guidance-image"
                  onClick={() => onOpenImage(image.src)}
                />
              ))}
            </div>
          )}
          <div className="chat-process-guidance-content">
            <span className="chat-process-guidance-label">引导</span>
            <div className="chat-bubble user chat-process-guidance-bubble">
              {hasDocumentContent && guidanceDocument ? (
                <ComposerMessageFlow document={guidanceDocument} onOpenImage={onOpenImage} />
              ) : fallbackText ? (
                <span className="chat-process-guidance-text">{fallbackText}</span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Thinking is conversational Markdown, not a tool/status record. Show it
  // directly in the assistant body flow without a redundant title row or a
  // second per-entry disclosure state.
  if (entry.type === "thinking") {
    if (!entry.detail?.trim()) return null;
    const thinkingExpanded = entry.expanded !== false;
    const isSingleLine = isThinkingSingleLine(entry.detail);

    // Single-line thinking: show directly without expand/collapse toggle
    if (isSingleLine) {
      return (
        <div className="chat-process-thinking-row expanded single-line">
          <span className="chat-process-thinking-toggle static">
            <ProcessEntryIcon type="thinking" />
          </span>
          <div className="chat-process-output chat-process-thinking-output">
            <MarkdownRenderer content={entry.detail} />
          </div>
        </div>
      );
    }

    return (
      <div className={`chat-process-thinking-row ${thinkingExpanded ? "expanded" : "collapsed"}`}>
        <button
          type="button"
          className="chat-process-thinking-toggle"
          aria-label={thinkingExpanded ? "折叠思考" : "展开思考"}
          aria-expanded={thinkingExpanded}
          title={thinkingExpanded ? "折叠思考" : "展开思考"}
          onClick={(event) => onToggleEntry(messageId, entry.id, event.currentTarget)}
        >
          <ProcessEntryIcon type="thinking" />
        </button>
        {thinkingExpanded ? (
          <div className="chat-process-thinking-body">
            <div
              ref={thinkingOutputRef}
              className={`chat-process-output chat-process-thinking-output${thinkingFullVisible ? "" : " limited"}`}
            >
              <MarkdownRenderer content={entry.detail} />
            </div>
            {thinkingOverflowing && (
              <button
                type="button"
                className="chat-process-thinking-more"
                onClick={() => setThinkingFullVisible((visible) => !visible)}
              >
                {thinkingFullVisible ? "收起" : "显示更多"}
              </button>
            )}
          </div>
        ) : (
          <div className="chat-process-thinking-preview">
            <MarkdownRenderer content={getThinkingPreviewMarkdown(entry.detail)} />
          </div>
        )}
      </div>
    );
  }

  // Narration is the assistant's actual body text; do not render a
  // redundant "正文输出" process row above it (also handles entries created
  // before the narration kind was attached).
  if (isAssistantNarrationProcessEntry(entry) || entry.title === uiText.process.narration) {
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
        {showReceivedMessage ? (
          <div className="chat-process-entry-header chat-process-received-message">
            <span className="chat-process-received-label">收到消息：</span>
            <ComposerMessageFlow document={receivedMessageDocument} onOpenImage={onOpenImage} />
          </div>
        ) : (
          <button
            className={`chat-process-entry-header ${canExpand ? "expandable" : ""}`}
            onClick={canExpand ? (event) => onToggleEntry(messageId, entry.id, event.currentTarget) : undefined}
            disabled={!canExpand}
          >
            <span className="chat-process-entry-title">
              {entry.title}
              {idleDuration && <span className="chat-process-idle-duration"> · {idleDuration}</span>}
            </span>
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
        )}
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
  now,
  onToggleEntry,
  onOpenFile,
  onOpenImage,
  onPreserveScroll,
  receivedMessageDocument,
}: {
  entries: AgentProcessEntry[];
  messageId: string;
  now: number;
  onToggleEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null) => void;
  onOpenFile: (filePath: string, options?: { preview?: boolean }) => void;
  onOpenImage: (src: string) => void;
  onPreserveScroll: PreserveScroll;
  receivedMessageDocument?: ComposerDocument;
}) {
  return <>{groupProcessEntries(entries).map((group) => group.kind === "commands" ? (
    <CommandGroup
      key={`commands-${group.entries[0].id}`}
      entries={group.entries}
      onPreserveScroll={onPreserveScroll}
    />
  ) : group.kind === "files" ? (
    group.entries.map((entry) => (
      <ProcessEntryRow
        key={entry.id}
        messageId={messageId}
        entry={entry}
        now={now}
        onToggleEntry={onToggleEntry}
        onOpenFile={onOpenFile}
        onOpenImage={onOpenImage}
        onPreserveScroll={onPreserveScroll}
        receivedMessageDocument={receivedMessageDocument}
      />
    ))
  ) : (
    <ProcessEntryRow
      key={group.entry.id}
      messageId={messageId}
      entry={group.entry}
      now={now}
      onToggleEntry={onToggleEntry}
      onOpenFile={onOpenFile}
      onOpenImage={onOpenImage}
      onPreserveScroll={onPreserveScroll}
      receivedMessageDocument={receivedMessageDocument}
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
  commentary = [],
  running = true,
  terminalState = "completed",
  fallbackEndedAt,
  onToggle,
  onToggleEntry,
  onOpenFile,
  onOpenImage,
  onPreserveScroll,
  receivedMessageDocument,
}: {
  messageId: string;
  process: AgentProcess;
  commentary?: AgentCommentary[];
  running?: boolean;
  terminalState?: ProcessTerminalViewState;
  fallbackEndedAt?: number;
  onToggle: (messageId: string, anchor?: HTMLElement | null) => void;
  onToggleEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null) => void;
  onOpenFile: (filePath: string, options?: { preview?: boolean }) => void;
  onOpenImage: (src: string) => void;
  onPreserveScroll: PreserveScroll;
  receivedMessageDocument?: ComposerDocument;
}) {
  const viewProcess = useMemo(() => normalizeProcessForView(process, {
    running,
    terminalState,
    fallbackEndedAt,
  }), [fallbackEndedAt, process, running, terminalState]);
  const processRunning = isProcessViewRunning(viewProcess, running);
  const nowTick = useProcessTicker(processRunning);
  const durationEnd = viewProcess.endedAt ?? nowTick;
  const elapsed = formatProcessDuration(durationEnd - viewProcess.startedAt);
  const expanded = !!viewProcess.expanded;
  const interrupted = useMemo(
    () => isProcessInterrupted(viewProcess.entries),
    [viewProcess.entries]
  );
  const visibleEntries = useMemo(
    () => getVisibleProcessEntries(viewProcess.entries),
    [viewProcess.entries]
  );
  const mergeProcessEntriesRef = useRef(createProcessEntryMerger());
  const mergedEntries = useMemo(
    () => expanded ? mergeProcessEntriesRef.current(visibleEntries) : [],
    [expanded, visibleEntries]
  );
  const visibleCommentary = useMemo(
    () => commentary.filter((item) => item.content.trim().length > 0),
    [commentary]
  );
  const timelineItems = useMemo(() => {
    const items: ProcessTimelineItem[] = [
      ...visibleEntries.map((entry, index) => ({
      kind: "entry" as const,
      id: entry.id,
      timestamp: entry.timestamp,
      order: index,
      entry,
      })),
      ...visibleCommentary.map((item, index) => ({
      kind: "commentary" as const,
      id: item.id,
      timestamp: item.timestamp,
      order: visibleEntries.length + index,
      commentary: item,
      })),
    ].sort((left, right) => left.timestamp - right.timestamp || left.order - right.order);
    const merged: ProcessTimelineItem[] = [];
    for (const item of items) {
      const previous = merged[merged.length - 1];
      if (
        item.kind === "entry" &&
        previous?.kind === "entry" &&
        canMergeAdjacentSubagentEntries(previous.entry, item.entry)
      ) {
        const entry = mergeAdjacentSubagentEntries(previous.entry, item.entry);
        merged[merged.length - 1] = {
          ...previous,
          entry,
          timestamp: Math.min(previous.timestamp, item.timestamp),
        };
      } else {
        merged.push(item);
      }
    }
    return merged;
  }, [visibleCommentary, visibleEntries]);
  const hasCommentaryTimeline = visibleCommentary.length > 0;

  return (
    <>
      <div className={`chat-process ${interrupted ? "interrupted" : ""}`}>
        <button className="chat-process-toggle" onClick={(event) => onToggle(messageId, event.currentTarget)}>
          <span>{interrupted ? uiText.process.interrupted : uiText.process.elapsed} {elapsed}</span>
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
            style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        {expanded && !hasCommentaryTimeline && (visibleEntries.length > 0 || processRunning) && (
          <div className="chat-process-content">
            {visibleEntries.length === 0 ? (
              <div className="chat-process-empty">{uiText.process.emptyEvents}</div>
            ) : (
              <ProcessEntries
                entries={mergedEntries}
                messageId={messageId}
                now={nowTick}
                onToggleEntry={onToggleEntry}
                onOpenFile={onOpenFile}
                onOpenImage={onOpenImage}
                onPreserveScroll={onPreserveScroll}
                receivedMessageDocument={receivedMessageDocument}
              />
            )}
          </div>
        )}
      </div>
      {expanded && hasCommentaryTimeline && (
        <div className="chat-turn-timeline" aria-label="处理说明">
          {timelineItems.map((item) => item.kind === "commentary" ? (
            <div
              key={`commentary-${item.id}`}
              className={`chat-commentary-item ${processRunning && item.commentary.isStreaming ? "streaming" : ""}`}
            >
              <MarkdownRenderer content={item.commentary.content} />
            </div>
          ) : expanded ? (
            <ProcessEntryRow
              key={`process-${item.id}`}
              entry={item.entry}
              messageId={messageId}
              now={nowTick}
              onToggleEntry={onToggleEntry}
              onOpenFile={onOpenFile}
              onOpenImage={onOpenImage}
              onPreserveScroll={onPreserveScroll}
              receivedMessageDocument={receivedMessageDocument}
            />
          ) : null)}
        </div>
      )}
    </>
  );
}
