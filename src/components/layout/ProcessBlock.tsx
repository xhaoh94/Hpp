import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  uiText,
} from "@/i18n/text";
import {
  canMergeAdjacentSubagentEntries,
  createProcessEntryMerger,
  mergeAdjacentSubagentEntries,
} from "./processEntryMerge";
import { getThinkingPreview, getThinkingPreviewMarkdown, isThinkingSingleLine } from "./agentEventUtils";
import { relativeRemotePath, resolveProjectFilePath } from "@/lib/project-file-path";
import { SUBAGENT_MONITOR_OPEN_EVENT } from "@/lib/app-events";
import { FileContextMenu, type FileContextMenuState } from "@/components/shared/FileContextMenu";
import {
  buildConciseCommentaryEntry,
  collapseStandardProcessEntries,
  formatProcessDuration,
  getSubagentProgressLabel,
  getEffectiveProcessSubagents,
  getVisibleProcessEntries,
  getConciseProcessEntries,
  getUserGuidanceText,
  isAssistantNarrationProcessEntry,
  isProcessInterrupted,
  isProcessViewRunning,
  isUserGuidanceProcessEntry,
  mergeThinkingEntries,
  normalizeProcessForView,
  OPERATION_SUMMARY_TOOL_KIND,
  splitCommandDetail,
  type ProcessEntryView,
  type ProcessTerminalViewState,
} from "@shared/process-view";
import {
  DEFAULT_OUTPUT_DETAIL_LEVEL,
  shouldListChangedFiles,
  type OutputDetailLevel,
} from "@shared/output-detail";

type PreserveScroll = (action: () => void, anchor?: HTMLElement | null) => void;

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
  onPreserveScroll,
  projectPath,
}: {
  files: AgentProcessFile[];
  onOpenFile: (filePath: string, options?: { preview?: boolean }) => void;
  onPreserveScroll?: PreserveScroll;
  projectPath?: string;
}) {
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);
  return (
    <div className="chat-process-files">
      {files.map((file, index) => {
        const preview = file.action !== "listed";
        const displayPath = relativeRemotePath(file.file, projectPath || "");
        return (
          <div className="chat-process-file" key={`${file.file}-${index}`}>
            <button
              className="chat-process-file-name openable"
              title={displayPath}
              onClick={(event) => {
                // 预览面板会挤窄聊天区触发重排：按锚点保持视口，避免阅读位置被顶走。
                const action = () => onOpenFile(file.file, { preview });
                if (onPreserveScroll) onPreserveScroll(action, event.currentTarget);
                else action();
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  path: resolveProjectFilePath(file.file, projectPath || ""),
                });
              }}
            >
              {displayPath}
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
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          path={contextMenu.path}
          projectPath={projectPath}
          onClose={() => setContextMenu(null)}
        />
      )}
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

/**
 * 命令条目展开后的内容：原始命令一行 + 输出块。
 * 标题行（图标 + 意图 + 折叠箭头）统一由 ProcessEntryRow 渲染，这里不再重复。
 */
function CommandDetail({
  entry,
}: {
  entry: AgentProcessEntry;
}) {
  const { command, output } = useMemo(
    () => splitCommandDetail(entry),
    [entry.detail, entry.command]
  );
  const outputLines = useMemo(() => output ? output.split("\n") : [], [output]);
  if (!command && outputLines.length === 0) return null;

  return (
    <div className={`chat-command-detail ${entry.state || ""} expanded`}>
      {command && <div className="chat-command-inline">$ {command}</div>}
      {outputLines.length > 0 && (
        <div className="chat-command-output">
          <div className="chat-command-lang">BASH</div>
          <pre>{outputLines.join("\n")}</pre>
        </div>
      )}
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

/** 监视窗挂在 ChatPanel 上，用事件解耦，免得把回调从聊天区一路透传下来。 */
const openSubagentMonitor = (subagentId: string) => {
  window.dispatchEvent(new CustomEvent(SUBAGENT_MONITOR_OPEN_EVENT, { detail: { subagentId } }));
};

const getSubagentTooltip = (subagent: AgentSubagent) => [
  getSubagentStatusLabel(subagent.status),
  subagent.model,
  subagent.path,
  subagent.message,
].filter(Boolean).join(" · ");

/**
 * 运行中的子任务由底部悬浮胶囊统一展示，聊天区等它全部结束再出现，避免两处重复。
 * 判据与胶囊同源（getEffectiveProcessSubagents），两边不会一显一隐。
 */
const isActiveSubagentEntry = (entry: ProcessEntryView) =>
  entry.type === "subagent" &&
  getEffectiveProcessSubagents(entry.subagents, entry.state)
    .some((subagent) => subagent.status === "running" || subagent.status === "pending");

function SubagentEntryRow({
  messageId,
  entry,
  now,
  onToggleEntry,
  projectPath,
}: {
  messageId: string;
  entry: AgentProcessEntry;
  now: number;
  onToggleEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null) => void;
  projectPath?: string;
}) {
  const subagents = getEffectiveProcessSubagents(entry.subagents, entry.state);
  const progress = getSubagentProgressLabel(subagents);
  const elapsed = typeof entry.startedAt === "number"
    ? `已运行 ${formatProcessDuration((entry.completedAt ?? now) - entry.startedAt)}`
    : "";
  const messages = subagents
    .map((subagent) => subagent.message?.trim())
    .filter((message): message is string => !!message && message !== entry.detail?.trim());
  const detail = [entry.detail?.trim(), ...new Set(messages)].filter(Boolean).join("\n\n");
  const canExpand = detail.length > 0;
  const toggle = (element?: HTMLElement | null) => onToggleEntry(messageId, entry.id, element);

  return (
    <div className={`chat-subagent-entry ${entry.state || ""}`}>
      <div className="chat-subagent-event">
        <span className="chat-subagent-chips">
          {subagents.map((subagent) => {
            const monitorable = subagent.status === "running" || subagent.status === "pending";
            return (
              <button
                type="button"
                className={`chat-subagent-chip ${subagent.status || ""}`}
                key={subagent.id}
                title={getSubagentTooltip(subagent) || subagent.label}
                // 运行中的子任务有实时输出，点开监视窗；已结束的没有可监视内容，退化成展开详情。
                onClick={
                  monitorable
                    ? () => openSubagentMonitor(subagent.id)
                    : canExpand ? () => toggle() : undefined
                }
                disabled={!monitorable && !canExpand}
              >
                <span className={`chat-subagent-avatar tone-${getSubagentTone(subagent.id)}`}>
                  <SubagentGlyph />
                </span>
                <span className="chat-subagent-label">{subagent.label}</span>
              </button>
            );
          })}
        </span>
        <button
          type="button"
          className={`chat-subagent-event-toggle ${canExpand ? "expandable" : ""}`}
          onClick={canExpand ? (event) => toggle(event.currentTarget) : undefined}
          disabled={!canExpand}
          aria-expanded={canExpand ? !!entry.expanded : undefined}
        >
          {progress && <span className="chat-subagent-event-meta">{progress}</span>}
          {elapsed && <span className="chat-subagent-event-meta">{elapsed}</span>}
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
      </div>
      {canExpand && entry.expanded && (
        <div className="chat-subagent-detail">
          <MarkdownRenderer content={detail} projectPath={projectPath} />
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
  outputDetailLevel = DEFAULT_OUTPUT_DETAIL_LEVEL,
  onToggleEntry,
  onOpenFile,
  onOpenImage,
  onPreserveScroll,
  onThinkingRowRef,
  receivedMessageDocument,
  projectPath,
  operationSummaryExpanded = false,
  onToggleOperationSummary,
}: {
  messageId: string;
  entry: AgentProcessEntry;
  now: number;
  running?: boolean;
  expandThinkingWhileRunning?: boolean;
  outputDetailLevel?: OutputDetailLevel;
  onToggleEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null, expanded?: boolean) => void;
  onOpenFile: (filePath: string, options?: { preview?: boolean }) => void;
  onOpenImage: (src: string) => void;
  onPreserveScroll: PreserveScroll;
  onThinkingRowRef?: (entryId: string, el: HTMLElement | null) => void;
  receivedMessageDocument?: ComposerDocument;
  projectPath?: string;
  operationSummaryExpanded?: boolean;
  onToggleOperationSummary?: (entryId: string) => void;
}) {
  const isReceivedMessage = entry.toolKind === "message_received" || entry.title.startsWith("收到消息:");
  const showReceivedMessage = isReceivedMessage && !!receivedMessageDocument;
  const hasDetail = !!entry.detail && !showReceivedMessage;
  const files = entry.files || [];
  const isCommandEntry = entry.toolKind === "run_command";
  const canExpand = hasDetail;
  const detailVisible = hasDetail && !isCommandEntry && (!canExpand || entry.expanded);
  const commandVisible = isCommandEntry && hasDetail && (!canExpand || entry.expanded);
  const errorDetailMarkdown =
    detailVisible && (entry.type === "error" || entry.state === "error")
      ? formatErrorDetailAsMarkdown(entry.detail)
      : null;
  const thinkingRowRef = useCallback((element: HTMLElement | null) => {
    onThinkingRowRef?.(entry.id, element);
  }, [entry.id, onThinkingRowRef]);

  // Thinking 正文不再截断显示：展开时完整渲染（设置“处理中是否展开”
  // 只控制处理过程中的默认展开状态，见 thinkingExpanded）。

  // 「标准」档把命令 / 查看文件 / 修改文件合并成的一条摘要：
  // 标题行常驻，点击展开后在下面按「已运行 / 已修改 / 已查看」列明细，
  // 文件名与详细档一样是可点击的蓝色链接。
  if (entry.toolKind === OPERATION_SUMMARY_TOOL_KIND) {
    const summary = entry.operationSummary;
    const showDetails = operationSummaryExpanded && !!summary;
    const renderFileLink = (file: string) => {
      const displayPath = relativeRemotePath(file, projectPath || "");
      return (
        <button
          key={file}
          type="button"
          className="chat-process-file-name openable"
          title={displayPath}
          onClick={(event) => {
            // 预览面板会挤窄聊天区触发重排，同样按锚点保持视口位置。
            const action = () => onOpenFile(file, { preview: true });
            if (onPreserveScroll) onPreserveScroll(action, event.currentTarget);
            else action();
          }}
        >
          {displayPath}
        </button>
      );
    };
    return (
      <div className="chat-process-operation-summary-block">
        <button
          type="button"
          className={`chat-process-operation-summary${entry.state === "running" ? " running" : ""}`}
          onClick={(event) => {
            // 展开会改变高度，必须走滚动保持：否则贴底时内容一长高就会被拽回底部。
            const action = () => onToggleOperationSummary?.(entry.id);
            if (onPreserveScroll) onPreserveScroll(action, event.currentTarget);
            else action();
          }}
          aria-expanded={showDetails}
          disabled={!onToggleOperationSummary}
          title={showDetails ? "收起操作详情" : "展开操作详情"}
        >
          {/* 中性图标：三条横线 = 一批操作的汇总，与条目标题同一行对齐。 */}
          <span className="chat-process-entry-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
            </svg>
          </span>
          <span>{entry.title}</span>
          {onToggleOperationSummary && (
            <svg
              className={`chat-process-operation-summary-chevron${showDetails ? " expanded" : ""}`}
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              aria-hidden="true"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          )}
        </button>
        {showDetails && summary && (
          <div className="chat-process-operation-details">
            {/* 每条命令单独一行：图标 + 模型写的意图，完整命令放 title。
                老数据没有 commandItems，退回原来的总数行。 */}
            {summary.commandItems && summary.commandItems.length > 0
              ? summary.commandItems.map((item) => (
                <div className="chat-process-operation-detail-line chat-process-operation-command" key={item.id}>
                  <span className="chat-process-operation-command-icon" aria-hidden="true">
                    <ProcessEntryIcon type="tool" />
                  </span>
                  <span
                    className="chat-process-operation-command-title"
                    title={item.command || item.description || ""}
                  >
                    {item.description || item.command || "命令"}
                  </span>
                </div>
              ))
              : summary.commandCount > 0 && (
                <div className="chat-process-operation-detail-line">
                  已运行 {summary.commandCount} 条命令
                </div>
              )}
            {/* 每个文件占一行：路径长时不会几个文件挤在同一行。 */}
            {summary.changedFiles.map((file) => (
              <div className="chat-process-operation-detail-line" key={`changed-${file}`}>
                <span>已修改</span>
                {renderFileLink(file)}
              </div>
            ))}
            {summary.viewedFiles.map((file) => (
              <div className="chat-process-operation-detail-line" key={`viewed-${file}`}>
                <span>已查看</span>
                {renderFileLink(file)}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (entry.type === "subagent") {
    return (
      <SubagentEntryRow
        messageId={messageId}
        entry={entry}
        now={now}
        onToggleEntry={onToggleEntry}
        projectPath={projectPath}
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
                <ComposerMessageFlow
                  document={guidanceDocument}
                  onOpenImage={onOpenImage}
                  projectPath={projectPath}
                  onOpenFile={onOpenFile}
                  compactCode
                />
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
            <MarkdownRenderer content={entry.detail} deferHighlight={thinkingRunning} />
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
              <MarkdownRenderer content={entry.detail} deferHighlight={thinkingRunning} />
            </div>
          </div>
        ) : (
          <div className={`chat-process-thinking-preview${thinkingPreviewHasCodeBlock ? " has-code-block" : ""}`}>
            <MarkdownRenderer content={thinkingPreviewMarkdown} deferHighlight={thinkingRunning} />
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
        <MarkdownRenderer content={entry.detail || entry.title} deferHighlight={running} />
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
            <ComposerMessageFlow
              document={receivedMessageDocument}
              onOpenImage={onOpenImage}
              projectPath={projectPath}
              onOpenFile={onOpenFile}
              compactCode
            />
          </div>
        ) : (
          <button
            className={`chat-process-entry-header ${canExpand ? "expandable" : ""}`}
            onClick={canExpand ? (event) => onToggleEntry(messageId, entry.id, event.currentTarget) : undefined}
            disabled={!canExpand}
          >
            <span className="chat-process-entry-title">
              {entry.title}
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
        {files.length > 0 && shouldListChangedFiles(outputDetailLevel) && (
          <ProcessEntryFiles files={files} onOpenFile={onOpenFile} onPreserveScroll={onPreserveScroll} projectPath={projectPath} />
        )}
        {commandVisible && (
          <CommandDetail entry={entry} />
        )}
        {detailVisible && errorDetailMarkdown && (
          <div className={`chat-process-entry-detail chat-process-error-markdown ${canExpand ? "panel" : ""}`}>
            <MarkdownRenderer content={errorDetailMarkdown} deferHighlight={running} projectPath={projectPath} />
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
  outputDetailLevel = DEFAULT_OUTPUT_DETAIL_LEVEL,
  onToggleEntry,
  onOpenFile,
  onOpenImage,
  onPreserveScroll,
  onThinkingRowRef,
  receivedMessageDocument,
  projectPath,
  expandedSummaryIds,
  onToggleOperationSummary,
}: {
  entries: AgentProcessEntry[];
  messageId: string;
  now: number;
  running?: boolean;
  expandThinkingWhileRunning?: boolean;
  outputDetailLevel?: OutputDetailLevel;
  onToggleEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null, expanded?: boolean) => void;
  onOpenFile: (filePath: string, options?: { preview?: boolean }) => void;
  onOpenImage: (src: string) => void;
  onPreserveScroll: PreserveScroll;
  onThinkingRowRef?: (entryId: string, el: HTMLElement | null) => void;
  receivedMessageDocument?: ComposerDocument;
  projectPath?: string;
  /** 「标准」档里已展开的合并摘要 id（一段回合可能有多段）。 */
  expandedSummaryIds?: Set<string>;
  onToggleOperationSummary?: (entryId: string) => void;
}) {
  // 每条命令独立成行（标题用模型写的 description），不再合并成「已运行 N 条命令」。
  return <>{entries.map((entry) => (
    <ProcessEntryRow
      key={entry.id}
      messageId={messageId}
      entry={entry}
      now={now}
      running={running}
      expandThinkingWhileRunning={expandThinkingWhileRunning}
      outputDetailLevel={outputDetailLevel}
      onToggleEntry={onToggleEntry}
      onOpenFile={onOpenFile}
      onOpenImage={onOpenImage}
      onPreserveScroll={onPreserveScroll}
      onThinkingRowRef={onThinkingRowRef}
      receivedMessageDocument={receivedMessageDocument}
      projectPath={projectPath}
      operationSummaryExpanded={expandedSummaryIds?.has(entry.id) === true}
      onToggleOperationSummary={onToggleOperationSummary}
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

const getStickyMessageIndex = (element: HTMLElement) => {
  const value = Number.parseInt(element.dataset.messageIndex || "", 10);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
};

const getStickyElements = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(".chat-process-sticky"))
    .sort((left, right) => getStickyMessageIndex(left) - getStickyMessageIndex(right));

const getVisibleStickyElements = (container: HTMLElement) =>
  getStickyElements(container).filter((element) => element.dataset.visible === "true");

const getProcessOwnerId = (element: HTMLElement | null) =>
  element?.closest<HTMLElement>("[data-process-message-id]")?.dataset.processMessageId || null;

const pendingStickyScrollCancels = new WeakMap<HTMLElement, () => void>();

/** Keep every active locator in document order instead of letting sticky bars overlap. */
const updateStickyStackLayout = (container: HTMLElement) => {
  let offset = 0;
  for (const sticky of getStickyElements(container)) {
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
  outputDetailLevel = DEFAULT_OUTPUT_DETAIL_LEVEL,
  onToggle,
  onToggleEntry,
  onOpenFile,
  onOpenImage,
  onPreserveScroll,
  receivedMessageDocument,
  projectPath,
  stickyPortalTarget,
  messageIndex,
}: {
  messageId: string;
  process: AgentProcess;
  commentary?: AgentCommentary[];
  running?: boolean;
  terminalState?: ProcessTerminalViewState;
  fallbackEndedAt?: number;
  expandThinkingWhileRunning?: boolean;
  /** 输出内容详细等级：详细=全部，标准=操作合并成摘要，简洁=思考与正文各自合并。 */
  outputDetailLevel?: OutputDetailLevel;
  onToggle: (messageId: string, anchor?: HTMLElement | null) => void;
  onToggleEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null, expanded?: boolean) => void;
  onOpenFile: (filePath: string, options?: { preview?: boolean }) => void;
  onOpenImage: (src: string) => void;
  onPreserveScroll: PreserveScroll;
  receivedMessageDocument?: ComposerDocument;
  projectPath?: string;
  /** 吸顶定位条挂载到聊天滚动容器的公共顶层，避免受消息块边界限制。 */
  stickyPortalTarget?: HTMLElement | null;
  messageIndex?: number;
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
  // 简洁档把独立的 commentary 正文折成一个 narration 条目，和 process 里的
  // 正文一起参与两段合并；时间线分支因此不再单独渲染 commentary，正文才不会散开。
  const conciseCommentaryEntry = useMemo(
    () => outputDetailLevel === "concise" ? buildConciseCommentaryEntry<AgentProcessEntry>(commentary) : null,
    [commentary, outputDetailLevel]
  );
  const visibleEntries = useMemo(
    () => {
      const base = getVisibleProcessEntries(viewProcess.entries).filter((entry) => !isActiveSubagentEntry(entry));
      return conciseCommentaryEntry ? [...base, conciseCommentaryEntry] : base;
    },
    [viewProcess.entries, conciseCommentaryEntry]
  );
  // 「标准」档合并摘要的展开状态：默认收起，点开就列出原始的命令/文件条目。
  // 一段回合里可能有多段合并（被思考/正文打断），所以按条目 id 记。
  const [expandedSummaryIds, setExpandedSummaryIds] = useState<Set<string>>(() => new Set());
  const toggleOperationSummary = useCallback((entryId: string) => {
    setExpandedSummaryIds((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }, []);
  // 切换等级或换消息后回到默认（收起）。
  useEffect(() => {
    setExpandedSummaryIds(new Set());
  }, [outputDetailLevel]);

  // 「简洁」把思考与正文各自合并成一段，交互条目作为分界点保留；
  // 「标准」把操作类条目合并成一条摘要。
  const renderedEntries = useMemo(
    () => {
      if (outputDetailLevel === "concise") return getConciseProcessEntries(visibleEntries);
      // 「标准」按段合并：一段里所有思考合成一块、所有命令/查看/修改合成另一块。
      if (outputDetailLevel === "standard") return collapseStandardProcessEntries(visibleEntries);
      return visibleEntries;
    },
    [outputDetailLevel, visibleEntries]
  );
  // 有条目但全被等级过滤掉时，不能当成“还没事件”去显示「等待 agent 事件…」。
  const hasEntriesHiddenByLevel = viewProcess.entries.length > 0 && renderedEntries.length === 0;
  const mergeProcessEntriesRef = useRef(createProcessEntryMerger());
  const mergedEntries = useMemo(() => {
    if (!expanded) return [];
    const entries = mergeProcessEntriesRef.current(renderedEntries);
    // 所有等级都把连续思考合并成一条；中间夹着其他条目（正文、查看文件等）时自然断开。
    return mergeThinkingEntries(entries);
  }, [expanded, renderedEntries]);
  // 简洁档正文已折进 renderedEntries，时间线里不能再出现一份。
  const visibleCommentary = useMemo(
    () => outputDetailLevel === "concise"
      ? []
      : commentary.filter((item) => item.content.trim().length > 0),
    [commentary, outputDetailLevel]
  );
  const timelineItems = useMemo(() => {
    const items: ProcessTimelineItem[] = [
      ...renderedEntries.map((entry, index) => ({
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
      order: renderedEntries.length + index,
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
    // 所有等级都把连续思考合并成一条；正文与其他条目（如查看文件）在时间线里
    // 自然成为分界点，不会跨过它们合并。
    return merged.reduce<ProcessTimelineItem[]>((result, item) => {
      const previous = result[result.length - 1];
      if (
        item.kind === "entry" &&
        item.entry.type === "thinking" &&
        previous?.kind === "entry" &&
        previous.entry.type === "thinking"
      ) {
        const [entry] = mergeThinkingEntries([previous.entry, item.entry]);
        result[result.length - 1] = { ...previous, entry };
        return result;
      }
      result.push(item);
      return result;
    }, []);
  }, [renderedEntries, visibleCommentary]);
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
      stickyElementRef.current ? window.getComputedStyle(stickyElementRef.current).top : "0",
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

  const stickyLocator = (
      <div
        ref={stickyElementRef}
        className="chat-process-sticky"
        data-process-message-id={messageId}
        data-message-index={messageIndex ?? ""}
        data-visible={processStuck ? "true" : "false"}
      >
        <div className="chat-process-sticky-inner">
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
  );

  return (
    <>
      {stickyPortalTarget
        ? createPortal(stickyLocator, stickyPortalTarget)
        : stickyLocator}
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
        {expanded && !hasCommentaryTimeline && (renderedEntries.length > 0 || (processRunning && !hasEntriesHiddenByLevel)) && (
          <div className="chat-process-content">
            {renderedEntries.length === 0 ? (
              <div className="chat-process-empty">{uiText.process.emptyEvents}</div>
            ) : (
              <ProcessEntries
                entries={mergedEntries}
                messageId={messageId}
                now={nowTick}
                running={running}
                expandThinkingWhileRunning={expandThinkingWhileRunning}
                outputDetailLevel={outputDetailLevel}
                onToggleEntry={onToggleEntry}
                onOpenFile={onOpenFile}
                onOpenImage={onOpenImage}
                onPreserveScroll={onPreserveScroll}
                onThinkingRowRef={registerThinkingRow}
                receivedMessageDocument={receivedMessageDocument}
                projectPath={projectPath}
                expandedSummaryIds={expandedSummaryIds}
                onToggleOperationSummary={toggleOperationSummary}
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
              <MarkdownRenderer
                content={item.commentary.content}
                deferHighlight={processRunning && item.commentary.isStreaming === true}
              />
            </div>
          ) : expanded ? (
            <ProcessEntryRow
              key={`process-${item.id}`}
              entry={item.entry}
              messageId={messageId}
              now={nowTick}
              running={running}
              expandThinkingWhileRunning={expandThinkingWhileRunning}
              outputDetailLevel={outputDetailLevel}
              onToggleEntry={onToggleEntry}
              onOpenFile={onOpenFile}
              onOpenImage={onOpenImage}
              onPreserveScroll={onPreserveScroll}
              onThinkingRowRef={registerThinkingRow}
              receivedMessageDocument={receivedMessageDocument}
              projectPath={projectPath}
              operationSummaryExpanded={expandedSummaryIds.has(item.entry.id)}
              onToggleOperationSummary={toggleOperationSummary}
            />
          ) : null)}
        </div>
      )}
      </div>
    </>
  );
}
