import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentCommentary,
  AgentProcess,
  AgentProcessEntry,
  AgentProcessFile,
  AgentSubagent,
} from "@/stores/chat-store";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import { ComposerMessageFlow } from "@/components/shared/ComposerMessageFlow";
import { CornerDownRight } from "lucide-react";
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
  running = true,
  expandThinkingWhileRunning = false,
  onToggleEntry,
  onOpenFile,
  onOpenImage,
  onPreserveScroll,
  onThinkingRowRef,
  receivedMessageDocument,
}: {
  messageId: string;
  entry: AgentProcessEntry;
  now: number;
  running?: boolean;
  expandThinkingWhileRunning?: boolean;
  onToggleEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null, expanded?: boolean) => void;
  onOpenFile: (filePath: string, options?: { preview?: boolean }) => void;
  onOpenImage: (src: string) => void;
  onPreserveScroll: PreserveScroll;
  onThinkingRowRef?: (entryId: string, el: HTMLElement | null) => void;
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
  const thinkingRowRef = useCallback((element: HTMLElement | null) => {
    onThinkingRowRef?.(entry.id, element);
  }, [entry.id, onThinkingRowRef]);

  // Thinking 正文不再截断显示：展开时完整渲染（设置“处理中是否展开”
  // 只控制处理过程中的默认展开状态，见 thinkingExpanded）。

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
            <span className="chat-process-guidance-label" title="引导">
              <CornerDownRight size={14} strokeWidth={2} />
            </span>
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
    // 默认展开状态由设置 expandThinkingWhileRunning 决定，贯穿处理中与
    // 处理结束后：关闭时思考默认折叠（避免长思考刷屏，且插入新对话/新
    // 处理过程后旧 turn 的思考也不会自动全部展开），开启时默认展开。
    // 用户手动展开（expanded === true）或折叠（expanded === false）的
    // 单条思考始终优先于设置。
    const thinkingExpanded = entry.expanded === true || (entry.expanded !== false && expandThinkingWhileRunning !== false);
    const isSingleLine = isThinkingSingleLine(entry.detail);
    // 正在思考时给灯泡加上运行标记，折叠预览据此触发扫光；结束后恢复静态图标。
    const thinkingRunning = running && entry.state === "running";
    // 折叠预览：代码块在边界时会被保留为完整代码块，预览因此可能超过 2 行，
    // 此时需要解除 CSS line-clamp 才能完整显示（而不是渲染成空白代码块框）。
    const thinkingPreviewMarkdown = getThinkingPreviewMarkdown(entry.detail);
    const thinkingPreviewHasCodeBlock = /^\s*(`{3,}|~{3,})/m.test(thinkingPreviewMarkdown);

    // Single-line thinking: show directly without expand/collapse toggle
    if (isSingleLine) {
      return (
        <div className="chat-process-thinking-row expanded single-line">
          <span className={`chat-process-thinking-toggle static${thinkingRunning ? " running" : ""}`}>
            <ProcessEntryIcon type="thinking" />
          </span>
          <div className="chat-process-output chat-process-thinking-output">
            <MarkdownRenderer content={entry.detail} />
          </div>
        </div>
      );
    }

    return (
      <div
        ref={thinkingRowRef}
        className={`chat-process-thinking-row ${thinkingExpanded ? "expanded" : "collapsed"}`}
      >
        <button
          type="button"
          className={`chat-process-thinking-toggle${thinkingRunning ? " running" : ""}`}
          aria-label={thinkingExpanded ? "折叠思考" : "展开思考"}
          aria-expanded={thinkingExpanded}
          title={thinkingExpanded ? "折叠思考" : "展开思考"}
          onClick={(event) => onToggleEntry(messageId, entry.id, event.currentTarget, !thinkingExpanded)}
        >
          <ProcessEntryIcon type="thinking" />
        </button>
        {thinkingExpanded ? (
          <div className="chat-process-thinking-body">
            <div className="chat-process-output chat-process-thinking-output">
              <MarkdownRenderer content={entry.detail} />
            </div>
          </div>
        ) : (
          <div className={`chat-process-thinking-preview${thinkingPreviewHasCodeBlock ? " has-code-block" : ""}`}>
            <MarkdownRenderer content={thinkingPreviewMarkdown} />
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
  running = true,
  expandThinkingWhileRunning = false,
  onToggleEntry,
  onOpenFile,
  onOpenImage,
  onPreserveScroll,
  onThinkingRowRef,
  receivedMessageDocument,
}: {
  entries: AgentProcessEntry[];
  messageId: string;
  now: number;
  running?: boolean;
  expandThinkingWhileRunning?: boolean;
  onToggleEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null, expanded?: boolean) => void;
  onOpenFile: (filePath: string, options?: { preview?: boolean }) => void;
  onOpenImage: (src: string) => void;
  onPreserveScroll: PreserveScroll;
  onThinkingRowRef?: (entryId: string, el: HTMLElement | null) => void;
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
        running={running}
        expandThinkingWhileRunning={expandThinkingWhileRunning}
        onToggleEntry={onToggleEntry}
        onOpenFile={onOpenFile}
        onOpenImage={onOpenImage}
        onPreserveScroll={onPreserveScroll}
        onThinkingRowRef={onThinkingRowRef}
        receivedMessageDocument={receivedMessageDocument}
      />
    ))
  ) : (
    <ProcessEntryRow
      key={group.entry.id}
      messageId={messageId}
      entry={group.entry}
      now={now}
      running={running}
      expandThinkingWhileRunning={expandThinkingWhileRunning}
      onToggleEntry={onToggleEntry}
      onOpenFile={onOpenFile}
      onOpenImage={onOpenImage}
      onPreserveScroll={onPreserveScroll}
      onThinkingRowRef={onThinkingRowRef}
      receivedMessageDocument={receivedMessageDocument}
    />
  ))}</>;
}

function findScrollContainer(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll|overlay)/.test(style.overflowY)) return current;
    current = current.parentElement;
  }
  return null;
}

const STICKY_CONTROL_GAP = 4;
const STICKY_TARGET_GAP = 20;
const STICKY_CONTENT_MIN_LINES = 10;

export const isRenderedContentOverLineLimit = (
  contentHeight: number,
  lineHeight: number,
  lineLimit = STICKY_CONTENT_MIN_LINES,
) => contentHeight > lineHeight * lineLimit;

const getRenderedContentMetrics = (element: HTMLElement | null) => {
  if (!element) return { contentHeight: 0, lineHeight: 0 };
  const style = window.getComputedStyle(element);
  const fontSize = Number.parseFloat(style.fontSize || "0");
  const lineHeight = Number.parseFloat(style.lineHeight || "0") || fontSize * 1.65;
  const verticalPadding = Number.parseFloat(style.paddingTop || "0") +
    Number.parseFloat(style.paddingBottom || "0");
  return {
    contentHeight: Math.max(0, element.scrollHeight - verticalPadding),
    lineHeight,
  };
};

export const isThinkingPastStickyBoundary = (
  rowTop: number,
  rowBottom: number,
  boundary: number,
  expanded: boolean,
) => expanded && rowTop < boundary && rowBottom > boundary;

export const getStickyButtonStackHeight = (
  buttonHeights: number[],
  gap = STICKY_CONTROL_GAP,
) => buttonHeights.reduce((total, height) => total + Math.max(0, height), 0) +
  Math.max(0, buttonHeights.length - 1) * gap;

const getVisibleStickyElements = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('.chat-process-sticky[data-visible="true"]'));

const getProcessOwnerId = (element: HTMLElement | null) =>
  element?.closest<HTMLElement>("[data-process-message-id]")?.dataset.processMessageId || null;

const pendingStickyScrollCancels = new WeakMap<HTMLElement, () => void>();

/** Keep every active locator in document order instead of letting sticky bars overlap. */
const updateStickyStackLayout = (container: HTMLElement) => {
  let offset = 0;
  for (const sticky of Array.from(container.querySelectorAll<HTMLElement>(".chat-process-sticky"))) {
    if (sticky.dataset.visible !== "true") {
      sticky.style.removeProperty("--chat-process-sticky-top");
      continue;
    }
    sticky.style.setProperty("--chat-process-sticky-top", `${offset}px`);
    const inner = sticky.querySelector<HTMLElement>(".chat-process-sticky-inner");
    const height = Math.ceil(inner?.getBoundingClientRect().height || 0);
    if (height > 0) offset += height + STICKY_CONTROL_GAP;
  }
  container.style.setProperty("--chat-process-sticky-stack-height", `${offset}px`);
};

const getStickyOcclusionHeight = (container: HTMLElement, target: HTMLElement) => {
  const targetProcessId = getProcessOwnerId(target);
  let height = 0;
  for (const sticky of getVisibleStickyElements(container)) {
    const stickyProcessId = getProcessOwnerId(sticky);
    if (stickyProcessId === targetProcessId) {
      // Jumping to this process header makes its locator disappear. A target
      // inside the process still needs room for the process-level locator, but
      // not for its thinking locator because that disappears at the target.
      if (target.classList.contains("chat-process-toggle")) continue;
      const processControl = sticky.querySelector<HTMLElement>(".chat-process-sticky-toggle");
      const controlHeight = Math.ceil(processControl?.getBoundingClientRect().height || 0);
      if (controlHeight > 0) height += controlHeight;

      const targetThinkingId = target.dataset.thinkingId;
      if (!targetThinkingId) continue;
      const thinkingControls = Array.from(
        sticky.querySelectorAll<HTMLElement>(".chat-process-sticky-thinking"),
      );
      const targetIndex = thinkingControls.findIndex(
        (control) => control.dataset.thinkingId === targetThinkingId,
      );
      // Thoughts before the target remain sticky after the jump. Include only
      // those controls; the target and later controls will disappear once
      // their rows move below the sticky boundary.
      const remainingControls = targetIndex >= 0
        ? thinkingControls.slice(0, targetIndex)
        : thinkingControls;
      if (remainingControls.length > 0) {
        const remainingHeight = getStickyButtonStackHeight(remainingControls.map((control) => (
          Math.ceil(control.getBoundingClientRect().height || 0)
        )));
        height += STICKY_CONTROL_GAP + remainingHeight;
      }
      continue;
    }
    const inner = sticky.querySelector<HTMLElement>(".chat-process-sticky-inner");
    const innerHeight = Math.ceil(inner?.getBoundingClientRect().height || 0);
    if (innerHeight > 0) height += innerHeight + STICKY_CONTROL_GAP;
  }
  return height;
};

/**
 * Read the actual bottom edge of the visible sticky controls. This is used for
 * the post-jump correction because React may still be committing the latest
 * sticky-button set immediately after `scrollTop` changes.
 */
const getStickyVisualBottom = (container: HTMLElement, target: HTMLElement) => {
  const containerTop = container.getBoundingClientRect().top;
  const targetProcessId = getProcessOwnerId(target);
  let bottom = containerTop;

  for (const sticky of getVisibleStickyElements(container)) {
    const stickyProcessId = getProcessOwnerId(sticky);
    if (stickyProcessId !== targetProcessId || target.classList.contains("chat-process-toggle")) {
      const innerBottom = sticky.querySelector<HTMLElement>(".chat-process-sticky-inner")
        ?.getBoundingClientRect().bottom || 0;
      bottom = Math.max(bottom, innerBottom);
      continue;
    }

    const processBottom = sticky.querySelector<HTMLElement>(".chat-process-sticky-toggle")
      ?.getBoundingClientRect().bottom || 0;
    bottom = Math.max(bottom, processBottom);

    const targetThinkingId = target.dataset.thinkingId;
    if (!targetThinkingId) continue;
    const thinkingControls = Array.from(
      sticky.querySelectorAll<HTMLElement>(".chat-process-sticky-thinking"),
    );
    const targetIndex = thinkingControls.findIndex(
      (control) => control.dataset.thinkingId === targetThinkingId,
    );
    for (const control of targetIndex >= 0 ? thinkingControls.slice(0, targetIndex) : thinkingControls) {
      bottom = Math.max(bottom, control.getBoundingClientRect().bottom);
    }
  }

  return bottom;
};

export const getStickyAdjustedScrollTop = (
  containerScrollTop: number,
  targetTop: number,
  containerTop: number,
  stickyHeight: number,
  gap = STICKY_TARGET_GAP,
) => Math.max(0, containerScrollTop + targetTop - containerTop - stickyHeight - gap);

export const getStickyVisualCorrectionScrollTop = (
  containerScrollTop: number,
  targetTop: number,
  stickyBottom: number,
  gap = STICKY_TARGET_GAP,
) => Math.max(0, containerScrollTop + targetTop - stickyBottom - gap);

const scrollTargetBelowSticky = (
  container: HTMLElement,
  target: HTMLElement,
  onSettled?: () => void,
) => {
  pendingStickyScrollCancels.get(container)?.();

  const getTargetScrollTop = () => {
    updateStickyStackLayout(container);
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return getStickyAdjustedScrollTop(
      container.scrollTop,
      targetRect.top,
      containerRect.top,
      getStickyOcclusionHeight(container, target),
    );
  };

  const correctTargetAgainstVisibleSticky = () => {
    if (!target.isConnected) return;
    const targetTop = target.getBoundingClientRect().top;
    container.scrollTo({
      top: getStickyVisualCorrectionScrollTop(
        container.scrollTop,
        targetTop,
        getStickyVisualBottom(container, target),
      ),
      behavior: "auto",
    });
  };

  let settled = false;
  let correctionFrame: number | null = null;
  const cancel = () => {
    if (settled) return;
    settled = true;
    if (correctionFrame !== null) cancelAnimationFrame(correctionFrame);
    if (pendingStickyScrollCancels.get(container) === cancel) {
      pendingStickyScrollCancels.delete(container);
    }
  };

  pendingStickyScrollCancels.set(container, cancel);
  container.scrollTo({
    top: getTargetScrollTop(),
    behavior: "auto",
  });
  correctTargetAgainstVisibleSticky();

  // The direct jump changes which locators are sticky. Re-read the actual
  // visible bottom after React has committed that state, without relying on a
  // guessed distance threshold or browser-specific smooth-scroll timing.
  correctionFrame = requestAnimationFrame(() => {
    if (settled) return;
    if (!target.isConnected) {
      cancel();
      return;
    }
    correctTargetAgainstVisibleSticky();
    cancel();
    onSettled?.();
  });
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
  commentary = [],
  running = true,
  terminalState = "completed",
  fallbackEndedAt,
  expandThinkingWhileRunning = false,
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
  expandThinkingWhileRunning?: boolean;
  onToggle: (messageId: string, anchor?: HTMLElement | null) => void;
  onToggleEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null, expanded?: boolean) => void;
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
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
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

  // --- 吸顶定位条：复用聊天滚动容器的 scroll 事件，避免 IntersectionObserver
  // 以 viewport 为 root 导致聊天区域较矮时判断不准确。 ---
  const [processStuck, setProcessStuck] = useState(false);
  const [stuckThinkingIds, setStuckThinkingIds] = useState<ReadonlySet<string>>(() => new Set());
  const processToggleElementRef = useRef<HTMLElement | null>(null);
  const stickyElementRef = useRef<HTMLDivElement | null>(null);
  const thinkingRowsRef = useRef(new Map<string, HTMLElement>());
  const stickyScrollContainerRef = useRef<HTMLElement | null>(null);
  const highlightedThinkingRowRef = useRef<HTMLElement | null>(null);
  const thinkingHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sortedStuckThinkingIds = useMemo(() => {
    const entryOrder = new Map(mergedEntries.map((entry, index) => [entry.id, index]));
    return [...stuckThinkingIds].sort((left, right) => (
      (entryOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (entryOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
    ));
  }, [mergedEntries, stuckThinkingIds]);

  const refreshStickyState = useCallback(() => {
    const container = stickyScrollContainerRef.current;
    if (!container) {
      setProcessStuck(false);
      setStuckThinkingIds((prev) => prev.size === 0 ? prev : new Set());
      return;
    }

    const containerTop = container.getBoundingClientRect().top;
    const stickyTopOffset = Number.parseFloat(
      stickyElementRef.current?.style.getPropertyValue("--chat-process-sticky-top") || "0",
    ) || 0;
    const processBoundary = containerTop + stickyTopOffset;
    const toggle = processToggleElementRef.current;
    const processWrap = toggle?.closest<HTMLElement>(".chat-process-wrap");
    const messageWrap = processWrap?.closest<HTMLElement>(".chat-msg-wrapper") || null;
    const processContent = processWrap?.querySelector<HTMLElement>(
      ".chat-process-content, .chat-turn-timeline",
    ) || null;
    const processContentMetrics = getRenderedContentMetrics(processContent);
    const assistantBodyMetrics = getRenderedContentMetrics(
      messageWrap?.querySelector<HTMLElement>(".chat-bubble-content") || null,
    );
    const renderedProcessLines = processContentMetrics.lineHeight > 0
      ? processContentMetrics.contentHeight / processContentMetrics.lineHeight
      : 0;
    const renderedAssistantBodyLines = assistantBodyMetrics.lineHeight > 0
      ? assistantBodyMetrics.contentHeight / assistantBodyMetrics.lineHeight
      : 0;
    const totalContentLines = (expandedRef.current ? renderedProcessLines : 0) +
      renderedAssistantBodyLines;
    const messageContentOverTenLines = totalContentLines > STICKY_CONTENT_MIN_LINES;
    const processStuckNow = messageContentOverTenLines && !!toggle &&
      toggle.getBoundingClientRect().bottom <= processBoundary &&
      (!messageWrap || messageWrap.getBoundingClientRect().bottom > processBoundary);
    setProcessStuck(processStuckNow);

    const stickyProcessControl = stickyElementRef.current
      ?.querySelector<HTMLElement>(".chat-process-sticky-toggle");
    const processControlHeight = processStuckNow
      ? Math.ceil(stickyProcessControl?.getBoundingClientRect().height || 0) + STICKY_CONTROL_GAP
      : 0;
    const thinkingBoundary = processBoundary + processControlHeight;

    const nextStuckThinkingIds = new Set<string>();
    for (const [entryId, row] of thinkingRowsRef.current) {
      const rect = row.getBoundingClientRect();
      const output = row.querySelector<HTMLElement>(".chat-process-thinking-output");
      const outputMetrics = getRenderedContentMetrics(output);
      const contentOverTenLines = isRenderedContentOverLineLimit(
        outputMetrics.contentHeight,
        outputMetrics.lineHeight,
      );
      // Only keep the expanded thinking entry currently crossing the sticky
      // boundary: its heading has left the viewport, while its body is still
      // being read. Short entries never get a locator; once a long row scrolls
      // past completely, remove it as well.
      if (contentOverTenLines && isThinkingPastStickyBoundary(
        rect.top,
        rect.bottom,
        thinkingBoundary,
        row.classList.contains("expanded"),
      )) {
        nextStuckThinkingIds.add(entryId);
      }
    }

    setStuckThinkingIds((prev) => {
      if (prev.size === nextStuckThinkingIds.size && [...prev].every((id) => nextStuckThinkingIds.has(id))) {
        return prev;
      }
      return nextStuckThinkingIds;
    });
  }, []);

  const connectStickyScrollContainer = useCallback((element: HTMLElement | null) => {
    const nextContainer = element ? findScrollContainer(element) : null;
    const previousContainer = stickyScrollContainerRef.current;
    if (previousContainer === nextContainer) return;

    if (previousContainer) previousContainer.removeEventListener("scroll", refreshStickyState);
    window.removeEventListener("resize", refreshStickyState);
    stickyScrollContainerRef.current = nextContainer;

    if (nextContainer) {
      nextContainer.addEventListener("scroll", refreshStickyState, { passive: true });
      window.addEventListener("resize", refreshStickyState);
      refreshStickyState();
    }
  }, [refreshStickyState]);

  const processToggleRef = useCallback((el: HTMLElement | null) => {
    processToggleElementRef.current = el;
    connectStickyScrollContainer(el);
    refreshStickyState();
  }, [connectStickyScrollContainer, refreshStickyState]);

  const registerThinkingRow = useCallback((entryId: string, el: HTMLElement | null) => {
    const rows = thinkingRowsRef.current;
    if (!el) {
      rows.delete(entryId);
      refreshStickyState();
      return;
    }
    el.dataset.thinkingId = entryId;
    rows.set(entryId, el);
    connectStickyScrollContainer(el);
    refreshStickyState();
  }, [connectStickyScrollContainer, refreshStickyState]);

  useEffect(() => {
    refreshStickyState();
  }, [expandThinkingWhileRunning, mergedEntries, processRunning, refreshStickyState]);

  useEffect(() => {
    const container = stickyScrollContainerRef.current;
    if (container) updateStickyStackLayout(container);
  }, [processStuck, stuckThinkingIds]);

  useEffect(() => () => {
    const container = stickyScrollContainerRef.current;
    if (container) container.removeEventListener("scroll", refreshStickyState);
    window.removeEventListener("resize", refreshStickyState);
  }, [refreshStickyState]);

  useEffect(() => () => {
    if (thinkingHighlightTimerRef.current) clearTimeout(thinkingHighlightTimerRef.current);
    highlightedThinkingRowRef.current?.classList.remove("jump-highlight");
  }, []);

  const scrollToProcess = useCallback(() => {
    const target = processToggleElementRef.current;
    const container = stickyScrollContainerRef.current;
    if (target && container) scrollTargetBelowSticky(container, target);
  }, []);

  const scrollToStuckThinking = useCallback((entryId: string) => {
    const container = stickyScrollContainerRef.current;
    if (!container) return;
    const row = thinkingRowsRef.current.get(entryId);
    if (!row) return;

    scrollTargetBelowSticky(container, row, () => {
      if (thinkingHighlightTimerRef.current) clearTimeout(thinkingHighlightTimerRef.current);
      highlightedThinkingRowRef.current?.classList.remove("jump-highlight");
      // Force a style flush so clicking the same locator repeatedly restarts the
      // animation instead of leaving the previous animation at its final frame.
      row.classList.remove("jump-highlight");
      void row.offsetWidth;
      row.classList.add("jump-highlight");
      highlightedThinkingRowRef.current = row;
      thinkingHighlightTimerRef.current = setTimeout(() => {
        row.classList.remove("jump-highlight");
        if (highlightedThinkingRowRef.current === row) highlightedThinkingRowRef.current = null;
        thinkingHighlightTimerRef.current = null;
      }, 2_300);
    });
  }, []);

  return (
    <>
      <div
        ref={stickyElementRef}
        className="chat-process-sticky"
        data-process-message-id={messageId}
        data-visible={processStuck ? "true" : "false"}
      >
        <div className="chat-process-sticky-inner">
          <button
            type="button"
            className="chat-process-sticky-toggle"
            onClick={scrollToProcess}
            title={`${interrupted ? uiText.process.interrupted : uiText.process.elapsed} ${elapsed}`}
            aria-label={`${interrupted ? uiText.process.interrupted : uiText.process.elapsed} ${elapsed}，返回处理过程开头`}
          >
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 15 6-6 6 6" />
            </svg>
          </button>
          {sortedStuckThinkingIds.length > 0 && (
            <div className="chat-process-sticky-thinking-list" aria-label="当前吸顶思考">
              {sortedStuckThinkingIds.map((entryId, index) => (
                <button
                  key={entryId}
                  type="button"
                  className="chat-process-sticky-thinking"
                  data-thinking-id={entryId}
                  title={`定位到第 ${index + 1} 条思考`}
                  aria-label={`定位到第 ${index + 1} 条思考`}
                  onClick={() => scrollToStuckThinking(entryId)}
                >
                  <ProcessEntryIcon type="thinking" />
                  {sortedStuckThinkingIds.length > 1 && (
                    <span className="chat-process-sticky-thinking-index">{index + 1}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="chat-process-wrap" data-process-message-id={messageId}>
      <div className={`chat-process ${interrupted ? "interrupted" : ""}`}>
        <button ref={processToggleRef} className="chat-process-toggle" onClick={(event) => onToggle(messageId, event.currentTarget)}>
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
                running={running}
                expandThinkingWhileRunning={expandThinkingWhileRunning}
                onToggleEntry={onToggleEntry}
                onOpenFile={onOpenFile}
                onOpenImage={onOpenImage}
                onPreserveScroll={onPreserveScroll}
                onThinkingRowRef={registerThinkingRow}
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
              running={running}
              expandThinkingWhileRunning={expandThinkingWhileRunning}
              onToggleEntry={onToggleEntry}
              onOpenFile={onOpenFile}
              onOpenImage={onOpenImage}
              onPreserveScroll={onPreserveScroll}
              onThinkingRowRef={registerThinkingRow}
              receivedMessageDocument={receivedMessageDocument}
            />
          ) : null)}
        </div>
      )}
      </div>
    </>
  );
}
