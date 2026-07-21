import {
  memo,
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  type RefObject,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent as ReactUIEvent,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { Check, ChevronLeft, Copy, CornerDownRight, FileText, Folder, GitBranch, GripVertical, ImagePlus, Link2, ListCollapse, MessageCircle, Pencil, Plus, RefreshCw, Trash2, WandSparkles, X } from "lucide-react";
import {
  useChatStore,
  type AgentProcess,
  type AgentProcessStep,
  type ChatDraft,
  type ChatMessage,
  type ModelInfo,
  type QueuedMessage,
  type PendingFile,
  type PendingImage,
  type PendingPathAttachment,
  type QueuedMessageEditableDraft,
  EMPTY_CHAT_DRAFT,
  cloneChatDraft,
} from "@/stores/chat-store";
import { useProjectStore, type Project, type ProjectSession, type SessionReference } from "@/stores/project-store";
import { useAppStore } from "@/stores/app-store";
import { getAgentName, getAgentPlanModeTooltip, supportsAgentActions, supportsGuidance } from "@/lib/agents";
import { getModelSwitchToastText, showFloatingToastMessage } from "@/lib/floating-toast";
import {
  createSessionReferenceSnapshot,
  getSessionReferenceTitle,
} from "@/lib/session-references";
import { PATH_ATTACHMENT_DRAG_MIME, type PathAttachmentDragData } from "@/lib/path-attachments";
import { getSessionModel, SESSION_DATA_PURGED_EVENT } from "@/hooks/useDataPersistence";
import { SessionCommandCoordinator, type PreparedSessionMessage } from "@/lib/session-command-coordinator";
import { buildSessionMessagePayload } from "@/lib/session-message-payload";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import { FilePreview } from "@/components/shared/FilePreview";
import { AgentConfigModal } from "@/components/sidebar/AgentConfigModal";
import { ChatComposer } from "./ChatComposer";
import { ChatToolbar } from "./ChatToolbar";
import { DiffBlock } from "./DiffBlock";
import { ProcessBlock } from "./ProcessBlock";
import { QuestionnairePanel } from "./QuestionnairePanel";
import { useChatScroll } from "./useChatScroll";
import { useAgentEvents } from "./useAgentEvents";
import { isSupportedImageAttachment, usePendingImages } from "./usePendingImages";
import { usePendingUIResponse, usePendingUIResponseActions } from "./usePendingUIResponse";
import { useRemoteBridge } from "@/hooks/useRemoteBridge";
import { useQuestionnaireResize } from "./useQuestionnaireResize";
import { useSessionModels } from "./useSessionModels";
import {
  asRecord,
  getBooleanField,
  resetSessionRuntimeAfterTurn,
  type SessionRuntime,
} from "./agentEventUtils";
import { getModelThinkingLevels, getOrderedModelProviders, includeCurrentModel } from "@shared/models";
import { collectProcessDiffs } from "@shared/diff-summary";
import { areAssistantMessageActionsVisible, formatHistoryMessageTime } from "@shared/message-display";
import type { AgentActionInvocation } from "@shared/agent-actions";
import {
  ComposerHistoryController,
  draftFromMessage,
  type LegacyReferenceResolver,
} from "@/lib/composer-history";
import { matchShortcut } from "@/lib/shortcuts";
import "./ChatPanel.css";

const AGENT_SETTINGS_UPDATED_EVENT = "agent-settings-updated";
type MessageSessionReferencePayload = { sourceSessionId: string; sourceTitle: string };
type MessagePayload = PreparedSessionMessage;

const EMPTY_QUEUED_MESSAGES: QueuedMessage[] = [];

const copyMessageText = async (content: string) => {
  try {
    await navigator.clipboard.writeText(content);
    showFloatingToastMessage("已复制");
  } catch {
    showFloatingToastMessage("复制失败");
  }
};

type SendPayloadNow = (
  targetSessionId: string,
  payload: MessagePayload,
  options?: {
    onSendFailure?: (error: string) => void;
    planModeEnabled?: boolean;
    queueIfRunning?: boolean;
    clientMessageId?: string;
  }
) => Promise<void>;

type MessageQueueDispatcherProps = {
  sessionRuntimeRef: { current: Record<string, SessionRuntime> };
  sendPayloadNow: SendPayloadNow;
};

type QueuePanelProps = {
  items: QueuedMessage[];
  canGuide: boolean;
  currentSessionRunning: boolean;
  onGuide: (item: QueuedMessage) => void;
  onEdit: (item: QueuedMessage) => void;
  onReorder: (itemId: string, toIndex: number) => void;
  onRemove: (itemId: string) => void;
};

const getQueuePreview = (item: QueuedMessage) => {
  const content = item.displayContent.trim();
  if (content) return content.length > 120 ? `${content.slice(0, 120)}...` : content;
  if (item.sessionReferences?.length) return `[引用会话: ${item.sessionReferences.map((reference) => reference.sourceTitle).join(", ")}]`;
  if (item.messageImages?.length) return `[${item.messageImages.length} 张图片]`;
  if (item.action) return `${item.action.kind === "skill" ? "技能" : "命令"} · ${item.action.name}`;
  return "空消息";
};

function MessageQueuePanel({
  items,
  canGuide,
  currentSessionRunning,
  onGuide,
  onEdit,
  onReorder,
  onRemove,
}: QueuePanelProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  if (items.length === 0) return null;

  const finishDragging = () => {
    draggingIdRef.current = null;
    dropIndexRef.current = null;
    setDraggingId(null);
    setDropIndex(null);
  };

  const startDragging = (event: ReactPointerEvent<HTMLButtonElement>, item: QueuedMessage, index: number) => {
    if (item.status === "sending") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingIdRef.current = item.id;
    dropIndexRef.current = index;
    setDraggingId(item.id);
    setDropIndex(index);
  };

  const moveDragging = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!draggingIdRef.current) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-queue-id]");
    if (!target) return;
    const index = items.findIndex((item) => item.id === target.dataset.queueId);
    if (index < 0 || dropIndexRef.current === index) return;
    dropIndexRef.current = index;
    setDropIndex(index);
  };

  const stopDragging = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) => {
    const itemId = draggingIdRef.current;
    const targetIndex = dropIndexRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishDragging();
    if (commit && itemId && targetIndex !== null) onReorder(itemId, targetIndex);
  };

  return (
    <div className="chat-queue-panel">
      <div className="chat-queue-header">
        <span>发送队列</span>
        <span>{items.length}</span>
      </div>
      <div className="chat-queue-list">
        {items.map((item, index) => (
          <div
            key={item.id}
            data-queue-id={item.id}
            className={`chat-queue-item ${item.status} ${draggingId === item.id ? "dragging" : ""} ${dropIndex === index && draggingId !== item.id ? "drop-target" : ""}`}
          >
            <button
              type="button"
              className="chat-queue-drag"
              disabled={item.status === "sending"}
              title="拖动调整顺序"
              aria-label={`拖动第 ${index + 1} 条队列消息`}
              onPointerDown={(event) => startDragging(event, item, index)}
              onPointerMove={moveDragging}
              onPointerUp={(event) => stopDragging(event, true)}
              onPointerCancel={(event) => stopDragging(event, false)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                onReorder(item.id, index + (event.key === "ArrowUp" ? -1 : 1));
              }}
            >
              <GripVertical size={14} />
              <span>{index + 1}</span>
            </button>
            <div className="chat-queue-main">
              {item.action && (
                <div className="chat-action-badge">
                  {item.action.kind === "skill" ? "技能" : "命令"} · {item.action.name}
                </div>
              )}
              <div className="chat-queue-preview">{getQueuePreview(item)}</div>
              {item.error && <div className="chat-queue-error">{item.error}</div>}
            </div>
            <div className="chat-queue-controls">
              <button type="button" className="chat-queue-icon-btn" onClick={() => onEdit(item)} disabled={item.status === "sending"} title="编辑">
                <Pencil size={14} />
              </button>
              {canGuide && !item.action && (
                <button
                  type="button"
                  className="chat-queue-action"
                  onClick={() => onGuide(item)}
                  disabled={!currentSessionRunning || item.status === "sending"}
                  title={currentSessionRunning ? "作为引导发送到当前运行的对话" : "Agent 运行中才能引导"}
                >
                  <CornerDownRight size={14} />
                  <span>引导</span>
                </button>
              )}
              <button type="button" className="chat-queue-icon-btn" onClick={() => onRemove(item.id)} disabled={item.status === "sending"} title="移除">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

type QueueEditDialogProps = {
  item: QueuedMessage;
  project: Project;
  session: ProjectSession;
  onClose: () => void;
  onSave: (draft: QueuedMessageEditableDraft) => Promise<boolean>;
};

const getQueuedImageMimeType = (src: string) =>
  /^data:([^;,]+)[;,]/.exec(src)?.[1] || "image/png";

function QueueEditDialog({ item, project, session, onClose, onSave }: QueueEditDialogProps) {
  const sessionMessages = useChatStore((state) => state.sessionMessages);
  const fallbackReferences = (item.sessionReferences || []).map((reference): SessionReference => {
    const source = project.sessions.find((candidate) => candidate.id === reference.sourceSessionId);
    return source
      ? createSessionReferenceSnapshot(source, sessionMessages[source.id] || [])
      : {
          sourceSessionId: reference.sourceSessionId,
          sourceAgentId: "",
          sourceTitle: reference.sourceTitle,
          sourceUpdatedAt: "",
          addedAt: new Date().toISOString(),
          summary: "",
        };
  });
  const initialDraft = item.editableDraft || {
    text: item.editableContent ?? item.displayContent,
    images: (item.messageImages || []).map((image) => ({ ...image, mimeType: getQueuedImageMimeType(image.src) })),
    pendingFiles: [],
    pendingPathAttachments: [],
    sessionReferences: fallbackReferences,
    action: item.action,
  };
  const [draft, setDraft] = useState<QueuedMessageEditableDraft>(initialDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [addMenuPosition, setAddMenuPosition] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const referenceCandidates = project.sessions.filter((candidate) => candidate.id !== session.id);

  useEffect(() => {
    if (!addMenuOpen) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setAddMenuOpen(false);
      setReferencePickerOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [addMenuOpen]);

  useLayoutEffect(() => {
    if (!addMenuOpen) {
      setAddMenuPosition(null);
      return;
    }
    const updatePosition = () => {
      const anchor = addMenuRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = referencePickerOpen ? Math.min(420, window.innerWidth - 32) : 170;
      const estimatedHeight = referencePickerOpen ? 266 : 150;
      const opensUpward = anchor.top >= estimatedHeight + 16;
      setAddMenuPosition({
        left: Math.max(16, Math.min(anchor.left, window.innerWidth - width - 16)),
        width,
        ...(opensUpward
          ? { bottom: Math.max(16, window.innerHeight - anchor.top + 7) }
          : { top: Math.max(16, Math.min(window.innerHeight - estimatedHeight - 16, anchor.bottom + 7)) }),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [addMenuOpen, referencePickerOpen]);

  const addImages = useCallback((files: File[]) => {
    files.filter(isSupportedImageAttachment).forEach((file) => {
      if (file.size > 10 * 1024 * 1024) {
        setError(`图片不能超过 10MB：${file.name}`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setDraft((current) => ({
          ...current,
          images: [...current.images, {
            id: crypto.randomUUID(),
            src: String(reader.result || ""),
            name: file.name,
            mimeType: file.type || "image/png",
          }],
        }));
        setError("");
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const addLocalFiles = useCallback((files: File[]) => {
    void (async () => {
      for (const file of files) {
        if (isSupportedImageAttachment(file)) {
          addImages([file]);
          continue;
        }
        const path = window.electronAPI.getPathForFile(file);
        const result = await window.electronAPI.statPath(path);
        if (!result.success || !result.attachment) {
          setError(result.error || `无法添加文件：${file.name}`);
          continue;
        }
        setDraft((current) => ({
          ...current,
          pendingPathAttachments: current.pendingPathAttachments.some((entry) => entry.path === result.attachment?.path)
            ? current.pendingPathAttachments
            : [...current.pendingPathAttachments, { id: crypto.randomUUID(), ...result.attachment! }],
        }));
      }
    })();
  }, [addImages]);

  const addFolder = useCallback(() => {
    void (async () => {
      const result = await window.electronAPI.openAttachmentFolder();
      if (result.canceled) return;
      if (!result.attachment) {
        setError(result.error || "无法添加文件夹");
        return;
      }
      setDraft((current) => ({
        ...current,
        pendingPathAttachments: current.pendingPathAttachments.some((entry) => entry.path === result.attachment?.path)
          ? current.pendingPathAttachments
          : [...current.pendingPathAttachments, { id: crypto.randomUUID(), ...result.attachment! }],
      }));
    })();
  }, []);

  const toggleReference = useCallback((source: ProjectSession) => {
    setDraft((current) => {
      const exists = current.sessionReferences.some((reference) => reference.sourceSessionId === source.id);
      return {
        ...current,
        sessionReferences: exists
          ? current.sessionReferences.filter((reference) => reference.sourceSessionId !== source.id)
          : [...current.sessionReferences, createSessionReferenceSnapshot(source, sessionMessages[source.id] || [])],
      };
    });
  }, [sessionMessages]);

  const hasContent = !!draft.text.trim() || draft.images.length > 0 || draft.pendingFiles.length > 0
    || draft.pendingPathAttachments.length > 0 || draft.sessionReferences.length > 0 || !!draft.action;
  const submit = async () => {
    if (!hasContent || saving) return;
    setSaving(true);
    setError("");
    try {
      if (await onSave(draft)) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="chat-queue-edit-overlay" onMouseDown={onClose}>
      <section
        className="chat-queue-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-queue-edit-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="chat-queue-edit-header">
          <div><h3 id="chat-queue-edit-title">编辑队列消息</h3><span>保存后会按当前附件重新生成发送内容</span></div>
          <button type="button" onClick={onClose} disabled={saving} title="关闭"><X size={16} /></button>
        </header>
        <div className="chat-queue-edit-body">
          {(draft.action || draft.images.length > 0 || draft.pendingFiles.length > 0 || draft.pendingPathAttachments.length > 0 || draft.sessionReferences.length > 0) && (
            <div className="chat-queue-edit-contexts">
                {draft.action && (
                  <div className="chat-queue-edit-chip action"><WandSparkles size={13} /><span>{draft.action.kind === "skill" ? "技能" : "命令"} · {draft.action.name}</span><button type="button" onClick={() => setDraft((current) => ({ ...current, action: undefined }))}><X size={12} /></button></div>
                )}
                {draft.images.map((image) => (
                  <div className="chat-queue-edit-chip image" key={image.id}><img src={image.src} alt="" /><span>{image.name}</span><button type="button" onClick={() => setDraft((current) => ({ ...current, images: current.images.filter((entry) => entry.id !== image.id) }))}><X size={12} /></button></div>
                ))}
                {draft.pendingFiles.map((file) => (
                  <div className="chat-queue-edit-chip" key={file.id}><FileText size={13} /><span>{file.fileName}:{file.startLine}-{file.endLine}</span><button type="button" onClick={() => setDraft((current) => ({ ...current, pendingFiles: current.pendingFiles.filter((entry) => entry.id !== file.id) }))}><X size={12} /></button></div>
                ))}
                {draft.pendingPathAttachments.map((attachment) => (
                  <div className="chat-queue-edit-chip" key={attachment.id}>{attachment.kind === "folder" ? <Folder size={13} /> : <FileText size={13} />}<span>{attachment.name}</span><button type="button" onClick={() => setDraft((current) => ({ ...current, pendingPathAttachments: current.pendingPathAttachments.filter((entry) => entry.id !== attachment.id) }))}><X size={12} /></button></div>
                ))}
                {draft.sessionReferences.map((reference) => (
                  <div className="chat-queue-edit-chip reference" key={reference.sourceSessionId}><Link2 size={13} /><span>{reference.sourceTitle}</span><button type="button" onClick={() => setDraft((current) => ({ ...current, sessionReferences: current.sessionReferences.filter((entry) => entry.sourceSessionId !== reference.sourceSessionId) }))}><X size={12} /></button></div>
                ))}
            </div>
          )}

          <div className="chat-queue-edit-composer">
            <textarea
              value={draft.text}
              autoFocus
              rows={5}
              placeholder={draft.action ? "添加技能参数或说明" : "编辑消息内容"}
              onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))}
              onKeyDown={(event) => {
                if (event.key === "Escape") onClose();
                if (event.key === "Enter" && event.ctrlKey) { event.preventDefault(); void submit(); }
              }}
            />
            <div className="chat-queue-edit-add-control" ref={addMenuRef}>
              <button
                type="button"
                className={`chat-queue-edit-add-button${addMenuOpen ? " active" : ""}`}
                aria-label="添加附件或引用"
                aria-expanded={addMenuOpen}
                title="添加附件或引用"
                onClick={() => {
                  setAddMenuOpen((open) => {
                    if (open) setReferencePickerOpen(false);
                    return !open;
                  });
                }}
              >
                <Plus size={16} />
              </button>
              {addMenuOpen && addMenuPosition && createPortal(
                <>
                  <div
                    className="chat-queue-edit-add-backdrop"
                    aria-hidden="true"
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      setAddMenuOpen(false);
                      setReferencePickerOpen(false);
                    }}
                  />
                  <div
                    className={`chat-queue-edit-add-menu${referencePickerOpen ? " references" : ""}`}
                    role="menu"
                    style={addMenuPosition}
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                  {referencePickerOpen ? (
                    <>
                      <div className="chat-queue-edit-add-menu-header">
                        <button type="button" onClick={() => setReferencePickerOpen(false)} title="返回"><ChevronLeft size={15} /></button>
                        <span>引用会话</span>
                        <small>{draft.sessionReferences.length > 0 ? `已选 ${draft.sessionReferences.length}` : ""}</small>
                      </div>
                      <div className="chat-queue-edit-reference-list">
                        {referenceCandidates.length === 0 ? (
                          <div className="chat-queue-edit-reference-empty">暂无可引用的会话</div>
                        ) : referenceCandidates.map((candidate) => {
                          const selected = draft.sessionReferences.some((reference) => reference.sourceSessionId === candidate.id);
                          return (
                            <button type="button" className={selected ? "selected" : ""} key={candidate.id} onClick={() => toggleReference(candidate)}>
                              <Link2 size={14} />
                              <span>{candidate.title}</span>
                              {selected && <Check size={14} />}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <>
                      <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); imageInputRef.current?.click(); }}><ImagePlus size={15} /><span>图片</span></button>
                      <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); fileInputRef.current?.click(); }}><FileText size={15} /><span>文件</span></button>
                      <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); addFolder(); }}><Folder size={15} /><span>文件夹</span></button>
                      <button type="button" role="menuitem" onClick={() => setReferencePickerOpen(true)}><Link2 size={15} /><span>引用会话</span></button>
                    </>
                  )}
                  </div>
                </>,
                document.body,
              )}
              <input ref={imageInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { addImages(Array.from(event.target.files || [])); event.target.value = ""; }} />
              <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { addLocalFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
            </div>
          </div>
          {error && <div className="chat-queue-edit-error">{error}</div>}
        </div>
        <footer className="chat-queue-edit-actions">
          <button type="button" className="btn-action" onClick={onClose} disabled={saving}>取消</button>
          <button type="button" className="filter-add-btn" onClick={() => void submit()} disabled={!hasContent || saving}>{saving ? "保存中..." : "保存修改"}</button>
        </footer>
      </section>
    </div>
  );
}

type SessionReferenceControlProps = {
  project: Project;
  activeSession: ProjectSession;
  references: SessionReference[];
  open: boolean;
  showTrigger?: boolean;
  onOpenChange: (open: boolean) => void;
  onAddOrRefresh: (session: ProjectSession) => void;
  onRemove: (sourceSessionId: string) => void;
};

function SessionReferenceControl({
  project,
  activeSession,
  references,
  open,
  showTrigger = true,
  onOpenChange,
  onAddOrRefresh,
  onRemove,
}: SessionReferenceControlProps) {
  const sessionMessages = useChatStore((state) => state.sessionMessages);
  const referencedSessionIds = new Set(references.map((reference) => reference.sourceSessionId));
  const availableSessions = project.sessions.filter((session) => session.id !== activeSession.id);
  const unreferencedSessions = availableSessions.filter((session) => !referencedSessionIds.has(session.id));

  if (!showTrigger && !open) return null;

  return (
    <div className="chat-reference-control">
      {showTrigger && (
        <button
          type="button"
          className={`chat-header-reference-btn ${references.length > 0 ? "active" : ""}`}
          onClick={() => onOpenChange(!open)}
          title="引用其他会话上下文"
        >
          <Link2 size={14} />
          {references.length > 0 && <span>{references.length}</span>}
        </button>
      )}

      {open && (
        <div className="chat-reference-popup">
          <div className="chat-reference-header">
            <span>引用会话</span>
            <button type="button" onClick={() => onOpenChange(false)} title="关闭">
              <X size={13} />
            </button>
          </div>

          <div className="chat-reference-section">
            <div className="chat-reference-section-title">已引用</div>
            {references.length === 0 ? (
              <div className="chat-reference-empty">暂无引用</div>
            ) : (
              references.map((reference) => {
                const sourceSession = project.sessions.find((session) => session.id === reference.sourceSessionId);
                return (
                  <div className="chat-reference-item" key={reference.sourceSessionId}>
                    <div className="chat-reference-item-main">
                      <div className="chat-reference-item-title">{reference.sourceTitle}</div>
                      <div className="chat-reference-item-meta">
                        {getAgentName(reference.sourceAgentId)}
                        {sourceSession?.closed ? " · 已关闭" : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="chat-reference-icon-btn"
                      onClick={() => sourceSession && onAddOrRefresh(sourceSession)}
                      disabled={!sourceSession}
                      title="刷新快照"
                    >
                      <RefreshCw size={13} />
                    </button>
                    <button
                      type="button"
                      className="chat-reference-icon-btn"
                      onClick={() => onRemove(reference.sourceSessionId)}
                      title="移除引用"
                    >
                      <X size={13} />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="chat-reference-section">
            <div className="chat-reference-section-title">可添加</div>
            {unreferencedSessions.length === 0 ? (
              <div className="chat-reference-empty">没有其他可引用会话</div>
            ) : (
              unreferencedSessions.map((session) => {
                const messages = sessionMessages[session.id] || [];
                return (
                  <button
                    type="button"
                    className="chat-reference-add-item"
                    key={session.id}
                    onClick={() => onAddOrRefresh(session)}
                  >
                    <Plus size={13} />
                    <span className="chat-reference-add-main">
                      <span className="chat-reference-item-title">
                        {getSessionReferenceTitle(session, messages)}
                      </span>
                      <span className="chat-reference-item-meta">
                        {getAgentName(session.agentId)} · {messages.length} 条消息{session.closed ? " · 已关闭" : ""}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type UserMessageHistoryControlProps = {
  open: boolean;
  anchorRef: RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
  onScrollToMessage: (messageId: string) => void;
};

const UserMessageHistoryControl = memo(function UserMessageHistoryControl({
  open,
  anchorRef,
  onOpenChange,
  onScrollToMessage,
}: UserMessageHistoryControlProps) {
  const userMessagesReversed = useChatStore(useShallow((state) =>
    state.messages.filter((message) => message.role === "user").slice().reverse()
  ));

  return (
    <div ref={anchorRef} className="relative chat-header-history-anchor">
      <button
        className="chat-header-history-btn"
        onClick={() => onOpenChange(!open)}
        title="发言记录"
      >
        <MessageCircle size={14} strokeWidth={1.8} />
      </button>
      {open && (
        <div className="chat-user-history-popup">
          <div className="chat-user-history-header">发言记录</div>
          {userMessagesReversed.length === 0 ? (
            <div className="chat-user-history-empty">暂无发言</div>
          ) : (
            <div className="chat-user-history-list">
              {userMessagesReversed.map((msg) => (
                <div
                  key={msg.id}
                  className="chat-user-history-item"
                  onClick={() => onScrollToMessage(msg.id)}
                >
                  <span className="chat-user-history-text">{msg.content}</span>
                  <span className="chat-user-history-time">
                    {formatHistoryMessageTime(msg.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

type SessionStarterListProps = {
  activeProject: Project;
  openSessions: ProjectSession[];
  onSwitchSession: (project: Project, session: ProjectSession) => void;
};

const SessionStarterList = memo(function SessionStarterList({
  activeProject,
  openSessions,
  onSwitchSession,
}: SessionStarterListProps) {
  const sessionMessages = useChatStore((state) => state.sessionMessages);

  if (openSessions.length === 0) return null;

  return (
    <div className="chat-session-list">
      {openSessions.map((session) => {
        const messages = sessionMessages[session.id];
        const firstUserMsg = messages?.find((message) => message.role === "user");
        return (
          <button
            key={session.id}
            className="chat-session-item"
            onClick={() => onSwitchSession(activeProject, session)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="3" width="20" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M7 8L10 11L7 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12 14H17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span>{firstUserMsg ? (firstUserMsg.content.length > 30 ? `${firstUserMsg.content.substring(0, 30)}...` : firstUserMsg.content) : session.title}</span>
          </button>
        );
      })}
    </div>
  );
});

type ChatMessagesViewProps = {
  activeSessionId: string | null;
  activeSessionInitialized: boolean;
  currentSessionRunning: boolean;
  projectPath?: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  showScrollBottom: boolean;
  onMessagesScroll: (event: ReactUIEvent<HTMLDivElement>) => void;
  onScrollToBottom: () => void;
  onContentChange: () => void;
  onEditMessage: (message: ChatMessage) => void;
  onImageContextMenu: (event: React.MouseEvent, imageSrc: string) => void;
  onOpenImage: (src: string) => void;
  onOpenFile: (path: string) => void;
  onToggleAssistantProcess: (messageId: string, anchor?: HTMLElement | null) => void;
  onToggleAssistantProcessEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null) => void;
  onPreserveScroll: (action: () => void, anchor?: HTMLElement | null) => void;
  onForkMessage: (message: ChatMessage) => void;
  forkingMessageId: string | null;
};

type ChatMessageItemProps = {
  msg: ChatMessage;
  projectPath?: string;
  onEditMessage: (message: ChatMessage) => void;
  onImageContextMenu: (event: React.MouseEvent, imageSrc: string) => void;
  onOpenImage: (src: string) => void;
  onOpenFile: (path: string) => void;
  onToggleAssistantProcess: (messageId: string, anchor?: HTMLElement | null) => void;
  onToggleAssistantProcessEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null) => void;
  onPreserveScroll: (action: () => void, anchor?: HTMLElement | null) => void;
  onForkMessage: (message: ChatMessage) => void;
  forkingMessageId: string | null;
};

const ChatMessageItem = memo(function ChatMessageItem({
  msg,
  projectPath,
  onEditMessage,
  onImageContextMenu,
  onOpenImage,
  onOpenFile,
  onToggleAssistantProcess,
  onToggleAssistantProcessEntry,
  onPreserveScroll,
  onForkMessage,
  forkingMessageId,
}: ChatMessageItemProps) {
  if (msg.role === "system" && msg.systemType === "context_compaction") {
    return (
      <div data-msg-id={msg.id} className="chat-context-divider">
        <span className="chat-context-divider-line" />
        <span className="chat-context-divider-label">
          <ListCollapse size={15} strokeWidth={1.8} />
          <span>{msg.content || "上下文已自动压缩"}</span>
        </span>
        <span className="chat-context-divider-line" />
      </div>
    );
  }

  const processRunning = msg.role === "assistant" && !!msg.process && !msg.process.endedAt;
  const hasImages = !!msg.images?.length;
  const hasSessionReferences = !!msg.sessionReferences?.length;
  const hasAction = !!msg.action;
  const processDiffs = collectProcessDiffs(msg.process);
  const visibleDiffs = !processRunning ? [...(msg.diffs || []), ...processDiffs] : [];
  const hasDiffs = visibleDiffs.length > 0;
  const hasContent = msg.content.trim().length > 0;
  const hasVisibleBubble =
    msg.role === "assistant"
      ? !processRunning && (hasContent || hasImages || hasDiffs || hasSessionReferences || hasAction)
      : hasContent || hasImages || hasDiffs || hasSessionReferences || hasAction;
  const showAssistantActions = hasVisibleBubble && areAssistantMessageActionsVisible(msg);
  const isForkingThisMessage = forkingMessageId === msg.id;
  const renderSessionReferences = () => (
    hasSessionReferences && msg.sessionReferences ? (
      <div className="chat-message-references" aria-label="引用会话">
        {msg.sessionReferences.map((reference) => (
          <div key={reference.sourceSessionId} className="chat-message-reference-chip">
            <Link2 size={12} strokeWidth={2} />
            <span>引用会话: {reference.sourceTitle}</span>
          </div>
        ))}
      </div>
    ) : null
  );

  return (
    <div data-msg-id={msg.id} className="chat-msg-wrapper">
      {msg.role === "assistant" && msg.process && (
        <ProcessBlock
          messageId={msg.id}
          process={msg.process}
          onToggle={onToggleAssistantProcess}
          onToggleEntry={onToggleAssistantProcessEntry}
          onOpenFile={onOpenFile}
          onPreserveScroll={onPreserveScroll}
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
                  onClick={() => onOpenImage(img.src)}
                  onContextMenu={msg.role === "user" ? (event) => onImageContextMenu(event, img.src) : undefined}
                />
              ))}
            </div>
          )}
          {(hasContent || hasAction || msg.role === "user") && (
            <div className="chat-bubble-row">
              <div className="chat-bubble-stack">
                {(hasContent || hasAction) && (
                  <div className={`chat-bubble ${msg.role} ${msg.action ? "has-action" : ""}`}>
                    {msg.action && (
                      <div className={`chat-action-label ${hasContent ? "with-content" : ""}`}>
                        <WandSparkles size={14} strokeWidth={1.9} />
                        <span>{msg.action.kind === "skill" ? "技能" : "命令"}</span>
                        <strong>{msg.action.name}</strong>
                      </div>
                    )}
                    {hasContent && (
                      <div className="chat-bubble-content">
                      {msg.role === "assistant" ? (
                          <MarkdownRenderer content={msg.content} />
                        ) : (
                          msg.content
                        )}
                      </div>
                    )}
                  </div>
                )}
                {msg.role === "user" && renderSessionReferences()}
              </div>
              {msg.role === "user" && hasVisibleBubble && (
                <div className="chat-msg-actions">
                  <button
                    className="chat-copy-btn"
                    onClick={() => onEditMessage(msg)}
                    title="编辑"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    className="chat-copy-btn"
                    onClick={() => void copyMessageText(msg.content)}
                    title="复制"
                    disabled={!hasContent}
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
          {msg.role !== "user" && renderSessionReferences()}
          {hasDiffs && (
            <DiffBlock diffs={visibleDiffs} projectPath={projectPath} />
          )}
          {showAssistantActions && (
            <div className="chat-assistant-actions">
              <button
                type="button"
                className="chat-assistant-action-btn"
                onClick={() => void copyMessageText(msg.content)}
                title="复制回复"
                aria-label="复制回复"
                disabled={!hasContent}
              >
                <Copy size={15} strokeWidth={1.9} />
              </button>
              <button
                type="button"
                className="chat-assistant-action-btn"
                onClick={() => onForkMessage(msg)}
                title={isForkingThisMessage ? "正在创建分叉会话" : "从这里新建会话"}
                aria-label={isForkingThisMessage ? "正在创建分叉会话" : "从这里新建会话"}
                disabled={isForkingThisMessage}
              >
                <GitBranch size={15} strokeWidth={1.9} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const getCompletedTodoCount = (steps: AgentProcessStep[]) =>
  steps.filter((step) => step.status === "completed").length;

const hasNativeTodoSteps = (process?: AgentProcess) =>
  !!process && process.planStepsSource === "native" && !!process.planSteps?.length;

const getTodoStatusText = (status: AgentProcessStep["status"]) => {
  switch (status) {
    case "running": return "进行中";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "cancelled": return "已取消";
    default: return "待处理";
  }
};

function TodoSummaryPill({ process }: { process: AgentProcess }) {
  const steps = process.planSteps || [];
  if (!hasNativeTodoSteps(process)) return null;
  const completedCount = getCompletedTodoCount(steps);

  const changeSummary = process.changeSummary;
  const changeText = changeSummary && changeSummary.filesChanged > 0
    ? `${changeSummary.filesChanged} 个文件已更改${changeSummary.additions > 0 ? ` +${changeSummary.additions}` : ""}${changeSummary.deletions > 0 ? ` -${changeSummary.deletions}` : ""}`
    : "";

  return (
    <div className="chat-todo-summary">
      <span className="chat-todo-summary-dot" />
      <span className="chat-todo-summary-text">进度 {completedCount}/{steps.length}</span>
      {changeText && <span className="chat-todo-summary-change">· {changeText}</span>}
      <div className="chat-todo-summary-popover">
        {steps.map((step) => (
          <div className="chat-todo-summary-row" key={step.id}>
            <span className={`chat-todo-summary-status ${step.status}`} />
            <span className="chat-todo-summary-title" title={step.title}>{step.title}</span>
            <span className="chat-todo-summary-label">{getTodoStatusText(step.status)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const ChatMessagesView = memo(function ChatMessagesView({
  activeSessionId,
  activeSessionInitialized,
  currentSessionRunning,
  projectPath,
  scrollRef,
  showScrollBottom,
  onMessagesScroll,
  onScrollToBottom,
  onContentChange,
  onEditMessage,
  onImageContextMenu,
  onOpenImage,
  onOpenFile,
  onToggleAssistantProcess,
  onToggleAssistantProcessEntry,
  onPreserveScroll,
  onForkMessage,
  forkingMessageId,
}: ChatMessagesViewProps) {
  const messages = useChatStore((state) => state.messages);
  const activeProcessWithTodos = [...messages]
    .reverse()
    .find((msg) => msg.role === "assistant" && !!msg.process && !msg.process.endedAt && hasNativeTodoSteps(msg.process))
    ?.process;

  useLayoutEffect(() => {
    onContentChange();
  }, [messages, onContentChange]);

  return (
    <div className={`chat-messages-area ${activeProcessWithTodos ? "has-todo-summary" : ""}`}>
      <div ref={scrollRef} className="chat-messages" onScroll={onMessagesScroll}>
        {activeSessionId && !activeSessionInitialized ? (
          <div className="chat-loading-agent">
            <div className="chat-working-spinner" />
            <span>正在初始化 Agent 会话...</span>
          </div>
        ) : (
          <>
            {messages.length === 0 && (
              <div className="chat-empty">发送消息开始对话</div>
            )}
            {messages.map((msg) => (
              <ChatMessageItem
                key={msg.id}
                msg={msg}
                projectPath={projectPath}
                onEditMessage={onEditMessage}
                onImageContextMenu={onImageContextMenu}
                onOpenImage={onOpenImage}
                onOpenFile={onOpenFile}
                onToggleAssistantProcess={onToggleAssistantProcess}
                onToggleAssistantProcessEntry={onToggleAssistantProcessEntry}
                onPreserveScroll={onPreserveScroll}
                onForkMessage={onForkMessage}
                forkingMessageId={forkingMessageId}
              />
            ))}

            {currentSessionRunning && messages.length > 0 && messages[messages.length - 1].role === "user" && (
              <div className="chat-working">
                <div className="chat-working-spinner" />
                <span>正在处理您的请求...</span>
              </div>
            )}
          </>
        )}
      </div>

      {(showScrollBottom || activeProcessWithTodos) && (
        <div className="chat-floating-status">
          {showScrollBottom && (
        <button className="chat-scroll-bottom" onClick={onScrollToBottom} title="返回底部">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" />
            <path d="M19 12l-7 7-7-7" />
          </svg>
        </button>
          )}
          {activeProcessWithTodos && <TodoSummaryPill process={activeProcessWithTodos} />}
        </div>
      )}
    </div>
  );
});

const MessageQueueDispatcher = memo(function MessageQueueDispatcher({
  sessionRuntimeRef,
  sendPayloadNow,
}: MessageQueueDispatcherProps) {
  const messageQueues = useChatStore((state) => state.messageQueues);
  const {
    clearQueuedMessageError,
    markQueuedMessageSending,
    removeQueuedMessage,
    upsertQueuedMessage,
  } = useChatStore(useShallow((state) => ({
    clearQueuedMessageError: state.clearQueuedMessageError,
    markQueuedMessageSending: state.markQueuedMessageSending,
    removeQueuedMessage: state.removeQueuedMessage,
    upsertQueuedMessage: state.upsertQueuedMessage,
  })));
  const agentStatuses = useProjectStore((state) => state.agentStatuses);
  const initializedSessionIds = useProjectStore((state) => state.initializedSessionIds);
  const queueDispatchingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const [sessionId, queue] of Object.entries(messageQueues)) {
      if (queueDispatchingRef.current.has(sessionId)) continue;
      if (!initializedSessionIds.has(sessionId)) continue;
      const nextItem = queue.find((item) => item.status === "queued");
      if (!nextItem) continue;
      const runtime = sessionRuntimeRef.current[sessionId];
      if (runtime?.processActive || agentStatuses[sessionId] === "running") continue;

      queueDispatchingRef.current.add(sessionId);
      clearQueuedMessageError(sessionId, nextItem.id);
      markQueuedMessageSending(sessionId, nextItem.id);
      removeQueuedMessage(sessionId, nextItem.id);
      void sendPayloadNow(sessionId, nextItem, {
        planModeEnabled: !!nextItem.planModeEnabled,
        onSendFailure: (error) => {
          upsertQueuedMessage({
          ...nextItem,
          status: "failed",
          error,
        });
        },
      }).finally(() => {
        queueDispatchingRef.current.delete(sessionId);
      });
    }
  }, [
    agentStatuses,
    clearQueuedMessageError,
    initializedSessionIds,
    markQueuedMessageSending,
    messageQueues,
    removeQueuedMessage,
    sendPayloadNow,
    sessionRuntimeRef,
    upsertQueuedMessage,
  ]);

  return null;
});

type ChatPanelProps = {
  sendKey?: string;
  previousMessageKey?: string;
  nextMessageKey?: string;
};

export function ChatPanel({
  sendKey = "Enter",
  previousMessageKey = "Ctrl+Up",
  nextMessageKey = "Ctrl+Down",
}: ChatPanelProps) {
  const isStreaming = useChatStore((state) => state.isStreaming);
  const activeAgentId = useChatStore((state) => state.activeAgentId);
  const currentModel = useChatStore((state) => state.currentModel);
  const availableModels = useChatStore((state) => state.availableModels);
  const favoriteModels = useChatStore((state) => state.favoriteModels);
  const thinkingLevel = useChatStore((state) => state.thinkingLevel);
  const {
    addMessage,
    setStreaming,
    setCurrentModel,
    setAvailableModels,
    toggleFavorite,
    setThinkingLevel,
    setDraftText,
    replaceSessionDraft,
    addPendingImage: addPendingImageToDraft,
    removePendingImage,
    removePendingFile,
    addPendingPathAttachment,
    removePendingPathAttachment,
    upsertSessionReference: upsertDraftSessionReference,
    removeSessionReference: removeDraftSessionReference,
    clearSessionDraft,
    removeQueuedMessage,
    toggleAssistantProcess,
    toggleAssistantProcessEntry,
  } = useChatStore(useShallow((state) => ({
    addMessage: state.addMessage,
    setStreaming: state.setStreaming,
    setCurrentModel: state.setCurrentModel,
    setAvailableModels: state.setAvailableModels,
    toggleFavorite: state.toggleFavorite,
    setThinkingLevel: state.setThinkingLevel,
    setDraftText: state.setDraftText,
    replaceSessionDraft: state.replaceSessionDraft,
    addPendingImage: state.addPendingImage,
    removePendingImage: state.removePendingImage,
    removePendingFile: state.removePendingFile,
    addPendingPathAttachment: state.addPendingPathAttachment,
    removePendingPathAttachment: state.removePendingPathAttachment,
    upsertSessionReference: state.upsertSessionReference,
    removeSessionReference: state.removeSessionReference,
    clearSessionDraft: state.clearSessionDraft,
    removeQueuedMessage: state.removeQueuedMessage,
    toggleAssistantProcess: state.toggleAssistantProcess,
    toggleAssistantProcessEntry: state.toggleAssistantProcessEntry,
  })));

  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const projects = useProjectStore((state) => state.projects);
  const activeSessionId = useProjectStore((state) => state.activeSessionId);
  const activeSessionAgentStatus = useProjectStore((state) =>
    activeSessionId ? state.agentStatuses[activeSessionId] : undefined
  );
  const activeSessionInitialized = useProjectStore((state) =>
    activeSessionId ? state.initializedSessionIds.has(activeSessionId) : false
  );
  const {
    removeSessionReference: removePersistedSessionReference,
  } = useProjectStore(useShallow((state) => ({
    removeSessionReference: state.removeSessionReference,
  })));
  const triggerAddProject = useAppStore((state) => state.triggerAddProject);
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const activeSession = activeProject?.sessions.find((s) => s.id === activeSessionId);
  const currentAgentId = activeSession?.agentId || activeAgentId;
  const activeDraft: ChatDraft = useChatStore(useShallow((state) =>
    activeSessionId ? state.sessionDrafts[activeSessionId] || EMPTY_CHAT_DRAFT : EMPTY_CHAT_DRAFT
  ));
  const pendingImages = activeDraft.pendingImages;
  const pendingFiles = activeDraft.pendingFiles;
  const pendingPathAttachments = activeDraft.pendingPathAttachments;
  const legacySessionReferences = activeSession?.references || [];
  const activeSessionReferences = useMemo(
    () => activeDraft.sessionReferences.length > 0 ? activeDraft.sessionReferences : legacySessionReferences,
    [activeDraft.sessionReferences, legacySessionReferences]
  );
  const activeSessionForkContext = activeSession?.forkContext;
  const activeQueuedMessages = useChatStore(useShallow((state) =>
    activeSessionId ? state.messageQueues[activeSessionId] || EMPTY_QUEUED_MESSAGES : EMPTY_QUEUED_MESSAGES
  ));
  const activeSessionSupportsGuidance = supportsGuidance(activeSession?.agentId || activeAgentId);
  const activeSessionSupportsActions = supportsAgentActions(activeSession?.agentId || activeAgentId);
  const openSessions = useMemo(
    () => activeProject?.sessions.filter((session) => !session.closed) || [],
    [activeProject?.sessions]
  );
  const [modelProviderOrder, setModelProviderOrder] = useState<string[]>([]);
  const modelProviders = useMemo(
    () => getOrderedModelProviders(includeCurrentModel(availableModels, currentModel), modelProviderOrder),
    [availableModels, currentModel, modelProviderOrder]
  );

  const refreshModelProviderOrder = useCallback(async (agentId: string) => {
    try {
      const result = await window.electronAPI.agentConfigList(agentId);
      if (!result.success || !result.config) {
        setModelProviderOrder([]);
        return;
      }
      setModelProviderOrder(result.config.providers.map((provider) => provider.providerId));
    } catch {
      setModelProviderOrder([]);
    }
  }, []);

  useEffect(() => {
    void refreshModelProviderOrder(currentAgentId);
  }, [currentAgentId, refreshModelProviderOrder]);

  const inputValueRef = useRef("");
  const composerHistoryRef = useRef(new ComposerHistoryController());
  const inputHasTextRef = useRef(false);
  const [inputHasText, setInputHasText] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const [imageContextMenu, setImageContextMenu] = useState<{ x: number; y: number; src: string } | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [userMsgHistoryOpen, setUserMsgHistoryOpen] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [planModeEnabled, setPlanModeEnabled] = useState(false);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const [modelConfigAgentId, setModelConfigAgentId] = useState<string | null>(null);
  const [agentReloadConfirmOpen, setAgentReloadConfirmOpen] = useState(false);
  const [agentReloading, setAgentReloading] = useState(false);
  const [agentReloadError, setAgentReloadError] = useState("");
  const [queueEditingId, setQueueEditingId] = useState<string | null>(null);
  const userMsgHistoryRef = useRef<HTMLDivElement>(null);
  const referenceRef = useRef<HTMLDivElement>(null);
  const chatPanelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const sessionRuntimeRef = useRef<Record<string, SessionRuntime>>({});
  const forkingMessageIdRef = useRef<string | null>(null);
  const {
    attachmentError,
    addPendingImage: addPendingImageFile,
    clearAttachmentError,
    showAttachmentError,
    handlePaste,
  } = usePendingImages(addPendingImageToDraft);

  useEffect(() => {
    const handleSessionDataPurged = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionIds?: string[] }>).detail;
      for (const sessionId of detail?.sessionIds || []) composerHistoryRef.current.reset(sessionId);
    };
    window.addEventListener(SESSION_DATA_PURGED_EVENT, handleSessionDataPurged);
    return () => window.removeEventListener(SESSION_DATA_PURGED_EVENT, handleSessionDataPurged);
  }, []);

  useEffect(() => {
    const openSessionIds = new Set<string>();
    for (const project of projects) {
      for (const session of project.sessions) {
        if (!session.closed) openSessionIds.add(session.id);
      }
    }

    for (const [sessionId, runtime] of Object.entries(sessionRuntimeRef.current)) {
      if (openSessionIds.has(sessionId)) continue;
      if (runtime.streamWatchdog) {
        clearTimeout(runtime.streamWatchdog);
        runtime.streamWatchdog = null;
      }
      resetSessionRuntimeAfterTurn(runtime);
      delete sessionRuntimeRef.current[sessionId];
    }
  }, [projects]);

  useEffect(() => {
    if (!activeProject || !activeSessionId || legacySessionReferences.length === 0) return;
    const currentDraft = useChatStore.getState().sessionDrafts[activeSessionId];
    if (currentDraft?.sessionReferences.length) return;

    legacySessionReferences.forEach((reference) => {
      upsertDraftSessionReference(reference, activeSessionId);
      removePersistedSessionReference(activeProject.id, activeSessionId, reference.sourceSessionId);
    });
  }, [
    activeProject,
    activeSessionId,
    legacySessionReferences,
    removePersistedSessionReference,
    upsertDraftSessionReference,
  ]);

  const {
    pendingUIResponse,
    pendingUIResponseRef,
    setPendingUIResponseState,
    isAwaitingUIResponse,
    activeQuestionnaire,
  } = usePendingUIResponse(activeSessionId);
  const currentSessionRunning = activeSessionId ? activeSessionAgentStatus === "running" : isStreaming;
  const isForkingSession = forkingMessageId !== null;
  const questionnaireResetKey = activeQuestionnaire
    ? `${activeQuestionnaire.sessionId}:${activeQuestionnaire.requestId || ""}:${activeQuestionnaire.entryId || ""}`
    : null;
  const {
    questionnairePaneHeight,
    handleQuestionnaireResizeStart,
  } = useQuestionnaireResize({
    panelRef: chatPanelRef,
    enabled: !!activeQuestionnaire,
    resetKey: questionnaireResetKey,
  });
  const {
    scrollRef,
    showScrollBottom,
    handleMessagesScroll,
    scrollToBottom,
    scrollToBottomNow,
    scrollToMessage: scrollToMessageElement,
    preserveScrollDuringLayoutChange,
    enableAutoFollow,
    handleContentChange,
  } = useChatScroll({
    activeSessionId,
    activeSessionInitialized,
    questionnairePaneHeight,
  });

  const resizeTextarea = useCallback((textarea = textareaRef.current) => {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
  }, []);

  const syncInputValue = useCallback((value: string) => {
    inputValueRef.current = value;
    const hasText = value.trim().length > 0;
    if (inputHasTextRef.current !== hasText) {
      inputHasTextRef.current = hasText;
      setInputHasText(hasText);
    }
    const sessionId = useProjectStore.getState().activeSessionId;
    if (sessionId) setDraftText(sessionId, value);
  }, [setDraftText]);

  const setComposerInput = useCallback((value: string) => {
    syncInputValue(value);
    const textarea = textareaRef.current;
    if (textarea && textarea.value !== value) {
      textarea.value = value;
    }
    resizeTextarea(textarea);
  }, [resizeTextarea, syncInputValue]);

  const resolveLegacyReference = useCallback<LegacyReferenceResolver>((reference) => {
    const projectState = useProjectStore.getState();
    const source = projectState.projects
      .flatMap((project) => project.sessions)
      .find((session) => session.id === reference.sourceSessionId);
    if (!source) return undefined;
    const chatState = useChatStore.getState();
    return createSessionReferenceSnapshot(source, chatState.sessionMessages[source.id] || []);
  }, []);

  const getCurrentSessionDraft = useCallback((sessionId: string) => {
    const chatState = useChatStore.getState();
    const draft = cloneChatDraft(chatState.sessionDrafts[sessionId] || EMPTY_CHAT_DRAFT);
    if (draft.sessionReferences.length > 0) return draft;
    const projectState = useProjectStore.getState();
    const session = projectState.projects
      .flatMap((project) => project.sessions)
      .find((candidate) => candidate.id === sessionId);
    if (session?.references?.length) {
      draft.sessionReferences = session.references.map((reference) => ({ ...reference }));
    }
    return draft;
  }, []);

  const restoreComposerDraft = useCallback((sessionId: string, draft: ChatDraft) => {
    if (useProjectStore.getState().activeSessionId !== sessionId) return;
    replaceSessionDraft(sessionId, draft);
    setComposerInput(draft.text);
    clearAttachmentError();
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      resizeTextarea(textarea);
    });
  }, [clearAttachmentError, replaceSessionDraft, resizeTextarea, setComposerInput]);

  const handleEditMessage = useCallback((message: ChatMessage) => {
    const sessionId = useProjectStore.getState().activeSessionId;
    if (!sessionId) return;
    composerHistoryRef.current.reset(sessionId);
    const draft = draftFromMessage(message, resolveLegacyReference);
    if (
      !message.composerDraft &&
      (message.sessionReferences?.length || 0) > draft.sessionReferences.length
    ) {
      showFloatingToastMessage("部分旧引用会话已不存在，未能恢复");
    }
    restoreComposerDraft(sessionId, draft);
  }, [resolveLegacyReference, restoreComposerDraft]);

  useEffect(() => {
    setComposerInput(activeDraft.text);
    clearAttachmentError();
  }, [activeSessionId, setComposerInput, clearAttachmentError]);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.loadData("settings").then((data) => {
      const settings = asRecord(data);
      const general = asRecord(settings.general);
      if (!cancelled) setPlanModeEnabled(!!getBooleanField(general, "planModeEnabled"));
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

  const savePlanModeEnabled = useCallback(async (nextPlanModeEnabled: boolean) => {
    setPlanModeEnabled(nextPlanModeEnabled);
    setModelOpen(false);
    setThinkingOpen(false);
    setExpandedProvider(null);
    const data = await window.electronAPI.loadData("settings");
    const currentSettings = asRecord(data);
    const currentGeneral = asRecord(currentSettings.general);
    const nextSettings = {
      ...currentSettings,
      general: {
        ...currentGeneral,
        planModeEnabled: nextPlanModeEnabled,
      },
    };
    await window.electronAPI.saveData("settings", nextSettings);
    window.dispatchEvent(new CustomEvent(AGENT_SETTINGS_UPDATED_EVENT, {
      detail: { planModeEnabled: nextPlanModeEnabled },
    }));
  }, []);

  // Auto-resize textarea after layout changes; typing resizes directly in onChange.
  useEffect(() => {
    resizeTextarea();
  }, [resizeTextarea, activeQuestionnaire]);

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

  useEffect(() => {
    if (!referenceOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (referenceRef.current && !referenceRef.current.contains(e.target as Node)) {
        setReferenceOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [referenceOpen]);

  useEffect(() => {
    setReferenceOpen(false);
    setModelOpen(false);
    setThinkingOpen(false);
    setExpandedProvider(null);
    setUserMsgHistoryOpen(false);
    setQueueEditingId(null);
  }, [activeSessionId]);

  useEffect(() => {
    if (!imageContextMenu) return;
    const close = () => setImageContextMenu(null);
    document.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [imageContextMenu]);

  useEffect(() => {
    setImageContextMenu(null);
  }, [activeSessionId]);

  const handleImageContextMenu = useCallback((event: React.MouseEvent, imageSrc: string) => {
    event.preventDefault();
    event.stopPropagation();
    setImageContextMenu({ x: event.clientX, y: event.clientY, src: imageSrc });
  }, []);

  const handleCopyImage = useCallback(async () => {
    const imageSrc = imageContextMenu?.src;
    setImageContextMenu(null);
    if (!imageSrc) return;
    const result = await window.electronAPI.writeImageToClipboard(imageSrc);
    if (!result.success) {
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: `复制图片失败: ${result.error || "未知错误"}`,
        timestamp: Date.now(),
      }, activeSessionId);
    }
  }, [activeSessionId, addMessage, imageContextMenu]);

  const handleOpenImage = useCallback((src: string) => {
    setZoomImage(src);
  }, []);

  const handleOpenFile = useCallback((path: string) => {
    setPreviewFile(path);
  }, []);

  const scrollToMessage = useCallback((msgId: string) => {
    scrollToMessageElement(msgId);
    setUserMsgHistoryOpen(false);
  }, [scrollToMessageElement]);

  const handleAddOrRefreshReference = useCallback((sourceSession: ProjectSession) => {
    if (!activeProject || !activeSessionId || sourceSession.id === activeSessionId) return;
    const sessionMessages = useChatStore.getState().sessionMessages;
    const reference = createSessionReferenceSnapshot(sourceSession, sessionMessages[sourceSession.id] || []);
    upsertDraftSessionReference(reference, activeSessionId);
  }, [activeProject, activeSessionId, upsertDraftSessionReference]);

  const handleRemoveReference = useCallback((sourceSessionId: string) => {
    if (!activeProject || !activeSessionId) return;
    removeDraftSessionReference(sourceSessionId, activeSessionId);
    removePersistedSessionReference(activeProject.id, activeSessionId, sourceSessionId);
  }, [activeProject, activeSessionId, removeDraftSessionReference, removePersistedSessionReference]);

  const clearLegacySessionReferences = useCallback((sessionId: string, references: MessageSessionReferencePayload[]) => {
    if (!activeProject || references.length === 0) return;
    references.forEach((reference) => {
      removePersistedSessionReference(activeProject.id, sessionId, reference.sourceSessionId);
    });
  }, [activeProject, removePersistedSessionReference]);

  const addPathAttachmentFromPath = useCallback(async (path: string) => {
    if (!path) {
      showAttachmentError("无法获取文件路径");
      return;
    }

    const result = await window.electronAPI.statPath(path);
    if (!result.success || !result.attachment) {
      showAttachmentError(result.error ? `无法添加路径：${result.error}` : "无法添加路径");
      return;
    }

    addPendingPathAttachment({
      id: crypto.randomUUID(),
      ...result.attachment,
    });
    clearAttachmentError();
  }, [addPendingPathAttachment, clearAttachmentError, showAttachmentError]);

  const getDroppedFilePath = useCallback((file: File) => {
    try {
      return window.electronAPI.getPathForFile(file);
    } catch {
      return "";
    }
  }, []);

  const getPathAttachmentDragData = useCallback((dataTransfer: DataTransfer): PathAttachmentDragData | null => {
    const raw = dataTransfer.getData(PATH_ATTACHMENT_DRAG_MIME);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as Partial<PathAttachmentDragData>;
      if (
        typeof parsed.name === "string" &&
        typeof parsed.path === "string" &&
        (parsed.kind === "file" || parsed.kind === "folder")
      ) {
        return parsed as PathAttachmentDragData;
      }
    } catch {
      return null;
    }

    return null;
  }, []);

  const handleAddInputFiles = useCallback((files: File[]) => {
    void (async () => {
      for (const file of files) {
        if (isSupportedImageAttachment(file)) {
          addPendingImageFile(file);
          continue;
        }

        await addPathAttachmentFromPath(getDroppedFilePath(file));
      }
    })();
  }, [addPathAttachmentFromPath, addPendingImageFile, getDroppedFilePath]);

  const handleOpenAttachmentFolder = useCallback(() => {
    void (async () => {
      const result = await window.electronAPI.openAttachmentFolder();
      if (result.canceled) return;
      if (!result.attachment) {
        showAttachmentError(result.error ? `无法添加文件夹：${result.error}` : "无法添加文件夹");
        return;
      }

      addPendingPathAttachment({
        id: crypto.randomUUID(),
        ...result.attachment,
      });
      clearAttachmentError();
    })();
  }, [addPendingPathAttachment, clearAttachmentError, showAttachmentError]);

  const handleDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (forkingMessageIdRef.current) return;

    const pathAttachment = getPathAttachmentDragData(event.dataTransfer);
    if (pathAttachment) {
      void addPathAttachmentFromPath(pathAttachment.path);
      return;
    }

    const files = Array.from(event.dataTransfer.files);
    handleAddInputFiles(files);
  }, [addPathAttachmentFromPath, getPathAttachmentDragData, handleAddInputFiles]);

  const handleDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (forkingMessageIdRef.current) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleToggleAssistantProcess = useCallback((messageId: string, anchor?: HTMLElement | null) => {
    preserveScrollDuringLayoutChange(() => toggleAssistantProcess(messageId), anchor);
  }, [preserveScrollDuringLayoutChange, toggleAssistantProcess]);

  const handleToggleAssistantProcessEntry = useCallback((messageId: string, entryId: string, anchor?: HTMLElement | null) => {
    preserveScrollDuringLayoutChange(() => toggleAssistantProcessEntry(messageId, entryId), anchor);
  }, [preserveScrollDuringLayoutChange, toggleAssistantProcessEntry]);

  const { switchToSession } = useSessionModels({
    activeSessionId,
    activeSessionAgentId: activeSession?.agentId,
    activeSessionInitialized,
    setAvailableModels,
    setCurrentModel,
    setThinkingLevel,
  });

  const handleForkFromMessage = useCallback(async (msg: ChatMessage) => {
    if (!activeProject || !activeSession || forkingMessageIdRef.current) return;
    forkingMessageIdRef.current = msg.id;
    setForkingMessageId(msg.id);
    try {
      await SessionCommandCoordinator.forkSession({
        sourceSessionId: activeSession.id,
        throughMessageId: msg.id,
        activate: true,
      });
      setUserMsgHistoryOpen(false);
      window.setTimeout(() => scrollToBottomNow(), 0);
    } finally {
      forkingMessageIdRef.current = null;
      setForkingMessageId(null);
    }
  }, [
    activeProject,
    activeSession,
    scrollToBottomNow,
  ]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
      if (thinkingRef.current && !thinkingRef.current.contains(e.target as Node)) setThinkingOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!isForkingSession) return;
    setModelOpen(false);
    setThinkingOpen(false);
    setExpandedProvider(null);
    setReferenceOpen(false);
    setUserMsgHistoryOpen(false);
    setImageContextMenu(null);
  }, [isForkingSession]);

  // Persist active messages to sessionMessages without subscribing this component to every stream update.
  useEffect(() => {
    let lastMessages = useChatStore.getState().messages;
    const unsubscribe = useChatStore.subscribe((state) => {
      if (state.messages === lastMessages) return;
      lastMessages = state.messages;
      const sessionId = state.activeSessionId;
      if (
        sessionId &&
        state.messages.length > 0 &&
        state.sessionMessages[sessionId] !== state.messages
      ) {
        state.loadSessionMessages(sessionId, state.messages);
      }
    });
    return unsubscribe;
  }, []);

  const { requestManualAbort } = useAgentEvents({
    activeAgentId,
    sessionRuntimeRef,
    pendingUIResponseRef,
    setPendingUIResponseState,
    setStreaming,
  });

  useRemoteBridge({
    pendingInteraction: pendingUIResponse,
    setPendingInteraction: setPendingUIResponseState,
    abortSession: requestManualAbort,
  });

  const {
    handleSendUIResponse,
    handleSubmitQuestionnaire,
    handleCancelQuestionnaire,
  } = usePendingUIResponseActions({
    activeQuestionnaire,
    addMessage,
    enableAutoFollow,
    inputValueRef,
    pendingUIResponse,
    sessionRuntimeRef,
    setComposerInput,
    setPendingUIResponseState,
  });

  const buildMessagePayload = useCallback(async (
    text: string,
    files: PendingFile[],
    images: PendingImage[],
    pathAttachments: PendingPathAttachment[],
    sessionReferences: SessionReference[] = activeSessionReferences,
    action: AgentActionInvocation | undefined = activeDraft.action,
    forkContext: string | undefined = activeSessionForkContext?.context,
  ): Promise<MessagePayload> => {
    return buildSessionMessagePayload({
      text,
      images: images.map((image) => ({
        id: image.id,
        src: image.src,
        name: image.name,
        mimeType: image.file.type || "image/png",
      })),
      pendingFiles: files,
      pendingPathAttachments: pathAttachments,
      sessionReferences,
      forkContext,
      action,
      readFile: (path) => window.electronAPI.readFile(path),
    });
  }, [activeDraft.action, activeSessionForkContext?.context, activeSessionReferences]);

  const sendPayloadNow = useCallback(async (
    targetSessionId: string,
    payload: MessagePayload,
    options?: {
      onSendFailure?: (error: string) => void;
      planModeEnabled?: boolean;
      queueIfRunning?: boolean;
      clientMessageId?: string;
    }
  ) => {
    const cleanupRuntime = (sessionId: string) => {
      const runtime = sessionRuntimeRef.current[sessionId];
      if (runtime?.streamWatchdog) {
        clearTimeout(runtime.streamWatchdog);
        runtime.streamWatchdog = null;
      }
      if (runtime) resetSessionRuntimeAfterTurn(runtime);
      if (!useProjectStore.getState().projects.some((project) =>
        project.sessions.some((session) => session.id === sessionId))) {
        delete sessionRuntimeRef.current[sessionId];
      }
    };
    const result = await SessionCommandCoordinator.sendMessage({
      sessionId: targetSessionId,
      clientMessageId: options?.clientMessageId || crypto.randomUUID(),
      queueIfRunning: options?.queueIfRunning === true,
      message: {
        ...payload,
        planModeEnabled: !!options?.planModeEnabled,
      },
      hooks: {
        isProcessActive: (sessionId) => sessionRuntimeRef.current[sessionId]?.processActive === true,
        commit: (action) => flushSync(action),
        onSendStarted: (sessionId) => {
          const runtime = sessionRuntimeRef.current[sessionId];
          if (!runtime) return;
          if (runtime.streamWatchdog) {
            clearTimeout(runtime.streamWatchdog);
            runtime.streamWatchdog = null;
          }
          runtime.streamBuffer = "";
          runtime.thinkingBuffer = "";
          runtime.thinkingEntryId = null;
          runtime.streamIdleNoticeEntryId = null;
          runtime.autoAbortReason = null;
        },
        onOptimisticMessage: () => {
          enableAutoFollow();
          scrollToBottomNow();
        },
        onSendFailureCleanup: cleanupRuntime,
      },
    });
    if ("error" in result && result.error && options?.onSendFailure) options.onSendFailure(result.error);
  }, [
    enableAutoFollow,
    scrollToBottomNow,
    sessionRuntimeRef,
  ]);

  const handleSend = useCallback(async () => {
    if (forkingMessageIdRef.current) return;
    if (activeQuestionnaire) return;

    if (isAwaitingUIResponse) {
      await handleSendUIResponse();
      return;
    }

    const rawText = inputValueRef.current;
    const text = rawText.trim();
    const targetSessionId = useProjectStore.getState().activeSessionId;
    if (
      !targetSessionId ||
      (!text &&
        pendingImages.length === 0 &&
        pendingFiles.length === 0 &&
        pendingPathAttachments.length === 0 &&
        activeSessionReferences.length === 0 &&
        !activeDraft.action)
    ) {
      return;
    }
    const modelForSend = getSessionModel(targetSessionId) || useChatStore.getState().currentModel;
    if (pendingImages.length > 0 && modelForSend?.supportsImages === false) {
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: "当前模型未标记支持图片输入，请切换支持图片的模型，或在 Agent 配置中启用该模型的图片能力。",
        timestamp: Date.now(),
      }, targetSessionId);
      return;
    }

    const payload = await buildMessagePayload(rawText, pendingFiles, pendingImages, pendingPathAttachments);
    composerHistoryRef.current.reset(targetSessionId);
    if (useProjectStore.getState().activeSessionId === targetSessionId) setComposerInput("");
    clearSessionDraft(targetSessionId);
    clearLegacySessionReferences(targetSessionId, payload.sessionReferences || []);
    await sendPayloadNow(targetSessionId, payload, {
      planModeEnabled,
      queueIfRunning: true,
    });
  }, [
    activeQuestionnaire,
    activeDraft.action,
    activeSessionReferences.length,
    addMessage,
    buildMessagePayload,
    clearLegacySessionReferences,
    clearSessionDraft,
    handleSendUIResponse,
    isAwaitingUIResponse,
    pendingFiles,
    pendingImages,
    pendingPathAttachments,
    planModeEnabled,
    sendPayloadNow,
    sessionRuntimeRef,
    setComposerInput,
  ]);

  const handleGuideQueuedMessage = useCallback(async (item: QueuedMessage) => {
    if (!activeSessionSupportsGuidance) return;
    await SessionCommandCoordinator.guideQueuedMessage(item.sessionId, item.id).catch(() => undefined);
  }, [
    activeSessionSupportsGuidance,
  ]);

  const handleEditQueuedMessage = useCallback(async (item: QueuedMessage, draft: QueuedMessageEditableDraft) => {
    try {
      const payload = await buildSessionMessagePayload({
        text: draft.text,
        images: draft.images,
        pendingFiles: draft.pendingFiles,
        pendingPathAttachments: draft.pendingPathAttachments,
        sessionReferences: draft.sessionReferences,
        forkContext: draft.forkContext,
        action: draft.action,
        readFile: (path) => window.electronAPI.readFile(path),
      });
      SessionCommandCoordinator.editQueuedMessage(item.sessionId, item.id, payload);
      return true;
    } catch (error) {
      showFloatingToastMessage(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, []);

  const handleReorderQueuedMessage = useCallback((itemId: string, toIndex: number) => {
    if (!activeSessionId) return;
    const queue = useChatStore.getState().messageQueues[activeSessionId] || [];
    if (queue.length < 2) return;
    const boundedIndex = Math.max(0, Math.min(toIndex, queue.length - 1));
    try {
      SessionCommandCoordinator.reorderQueuedMessage(activeSessionId, itemId, boundedIndex);
    } catch (error) {
      showFloatingToastMessage(error instanceof Error ? error.message : String(error));
    }
  }, [activeSessionId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;

    const historyDirection = matchShortcut(e, previousMessageKey)
      ? "previous"
      : matchShortcut(e, nextMessageKey)
        ? "next"
        : null;
    if (historyDirection) {
      if (activeQuestionnaire || isForkingSession || e.currentTarget.disabled) return;
      const sessionId = useProjectStore.getState().activeSessionId;
      if (!sessionId) return;
      e.preventDefault();
      const currentDraft = getCurrentSessionDraft(sessionId);
      const chatState = useChatStore.getState();
      const messages = chatState.activeSessionId === sessionId
        ? chatState.messages
        : chatState.sessionMessages[sessionId] || [];
      const nextDraft = historyDirection === "previous"
        ? composerHistoryRef.current.previous(sessionId, currentDraft, messages, resolveLegacyReference)
        : composerHistoryRef.current.next(sessionId, currentDraft);
      if (nextDraft) restoreComposerDraft(sessionId, nextDraft);
      return;
    }

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
        const currentValue = inputValueRef.current;
        const newValue = currentValue.substring(0, start) + "\n" + currentValue.substring(end);
        setComposerInput(newValue);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 1;
        });
      }
    }
  }, [
    activeQuestionnaire,
    getCurrentSessionDraft,
    handleSend,
    isForkingSession,
    nextMessageKey,
    previousMessageKey,
    resolveLegacyReference,
    restoreComposerDraft,
    sendKey,
    setComposerInput,
  ]);

  const handleAbort = useCallback(() => {
    const currentSessionId = useProjectStore.getState().activeSessionId;
    if (!currentSessionId) return;
    void SessionCommandCoordinator.abortSession(currentSessionId, {
      abortSession: requestManualAbort,
    }).catch(() => undefined);
  }, [requestManualAbort]);

  const handleSelectModel = async (model: ModelInfo) => {
    const previousModel = useChatStore.getState().currentModel;
    setModelOpen(false);
    const sessionId = useProjectStore.getState().activeSessionId;
    const agentId = activeSession?.agentId || activeAgentId;
    if (!sessionId) return;
    try {
      await SessionCommandCoordinator.setModel(sessionId, model, {
        models: availableModels,
        isProcessActive: (targetSessionId) => sessionRuntimeRef.current[targetSessionId]?.processActive === true,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "SESSION_BUSY") {
        window.alert("切换 Agent 渠道或模型需要等当前 Agent 运行结束后再操作。");
        return;
      }
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: `Model switch failed: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: Date.now(),
      }, sessionId);
      return;
    }
    const modelChanged =
      !previousModel ||
      previousModel.id !== model.id ||
      previousModel.provider !== model.provider;
    if (modelChanged) {
      showFloatingToastMessage(getModelSwitchToastText(agentId, model.provider, model.name || model.id));
    }
  };

  const handleModelConfigModelsUpdated = useCallback((agentId: string, models?: ModelInfo[], selectedProviderId?: string) => {
    if (!models) return;
    if (currentAgentId !== agentId) return;

    void refreshModelProviderOrder(agentId);
    const chatState = useChatStore.getState();
    chatState.setAvailableModels(models);
    if (models.length === 0) {
      useChatStore.setState({ currentModel: null });
      return;
    }
    const current = chatState.currentModel;
    const selectedProviderModel = selectedProviderId
      ? models.find((model) => model.provider === selectedProviderId)
      : undefined;
    const nextModel = selectedProviderModel || (current
      ? models.find((model) => model.id === current.id && model.provider === current.provider) || models[0]
      : models[0]);
    const sessionId = useProjectStore.getState().activeSessionId;
    if (sessionId) {
      void SessionCommandCoordinator.setModel(sessionId, nextModel, { models }).catch(() => undefined);
    }
    if (!sessionId) chatState.setCurrentModel(nextModel);
  }, [currentAgentId, refreshModelProviderOrder]);

  const openAgentReloadConfirm = useCallback(() => {
    setAgentReloadError("");
    setAgentReloadConfirmOpen(true);
  }, []);

  const closeAgentReloadConfirm = useCallback(() => {
    if (agentReloading) return;
    setAgentReloadConfirmOpen(false);
    setAgentReloadError("");
  }, [agentReloading]);

  const handleReloadCurrentAgent = useCallback(async () => {
    if (agentReloading || currentSessionRunning || !activeSessionId) return;
    setAgentReloading(true);
    setAgentReloadError("");
    try {
      const result = await SessionCommandCoordinator.reloadSession(activeSessionId);
      void refreshModelProviderOrder(currentAgentId);
      setAgentReloadConfirmOpen(false);
      showFloatingToastMessage(
        result.reloadedSessionIds?.includes(activeSessionId)
          ? `${getAgentName(currentAgentId)} 当前会话已重新打开`
          : `${getAgentName(currentAgentId)} 当前会话无需重载`
      );
    } catch (error) {
      setAgentReloadError(error instanceof Error ? error.message : String(error));
    } finally {
      setAgentReloading(false);
    }
  }, [activeSessionId, agentReloading, currentAgentId, currentSessionRunning, refreshModelProviderOrder]);

  useEffect(() => {
    if (!agentReloadConfirmOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !agentReloading) closeAgentReloadConfirm();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [agentReloadConfirmOpen, agentReloading, closeAgentReloadConfirm]);

  const handleSelectThinking = async (levelId: string) => {
    const sessionId = useProjectStore.getState().activeSessionId;
    setThinkingOpen(false);
    if (!sessionId) return;
    try {
      await SessionCommandCoordinator.setThinking(sessionId, levelId, {
        isProcessActive: (targetSessionId) => sessionRuntimeRef.current[targetSessionId]?.processActive === true,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "SESSION_BUSY") {
        window.alert("调整思考级别需要等当前 Agent 运行结束后再操作。");
      }
    }
  };

  const thinkingLevels = getModelThinkingLevels(currentModel);
  const currentThinking = thinkingLevels.find((l) => l.id === thinkingLevel)
    || thinkingLevels.find((level) => level.id === "medium")
    || thinkingLevels[0];

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
          <SessionStarterList
            activeProject={activeProject}
            openSessions={openSessions}
            onSwitchSession={switchToSession}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <MessageQueueDispatcher
        sessionRuntimeRef={sessionRuntimeRef}
        sendPayloadNow={sendPayloadNow}
      />
      <div
        ref={chatPanelRef}
        className={`chat-panel${isForkingSession ? " chat-panel-forking" : ""}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        aria-busy={isForkingSession}
      >
      {/* Header */}
      <div className="chat-header">
        <div className="chat-agent-dot" />
        <span className="chat-agent-name">{activeProject.name}</span>
        <button
          type="button"
          className="chat-agent-tag chat-agent-reload-trigger"
          onClick={openAgentReloadConfirm}
          title={`重载 ${getAgentName(currentAgentId)}`}
          aria-label={`重载 ${getAgentName(currentAgentId)}`}
        >
          <span>{getAgentName(currentAgentId)}</span>
          <RefreshCw size={10} strokeWidth={2} />
        </button>
        <UserMessageHistoryControl
          open={userMsgHistoryOpen}
          anchorRef={userMsgHistoryRef}
          onOpenChange={setUserMsgHistoryOpen}
          onScrollToMessage={scrollToMessage}
        />
        <div style={{ flex: 1 }} />
      </div>

      {/* Messages */}
      <ChatMessagesView
        activeSessionId={activeSessionId}
        activeSessionInitialized={activeSessionInitialized}
        currentSessionRunning={currentSessionRunning}
        projectPath={activeProject.path}
        scrollRef={scrollRef}
        showScrollBottom={showScrollBottom}
        onMessagesScroll={handleMessagesScroll}
        onScrollToBottom={scrollToBottom}
        onContentChange={handleContentChange}
        onEditMessage={handleEditMessage}
        onImageContextMenu={handleImageContextMenu}
        onOpenImage={handleOpenImage}
        onOpenFile={handleOpenFile}
        onToggleAssistantProcess={handleToggleAssistantProcess}
        onToggleAssistantProcessEntry={handleToggleAssistantProcessEntry}
        onPreserveScroll={preserveScrollDuringLayoutChange}
        onForkMessage={handleForkFromMessage}
        forkingMessageId={forkingMessageId}
      />

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

        <MessageQueuePanel
          items={activeQueuedMessages}
          canGuide={activeSessionSupportsGuidance}
          currentSessionRunning={currentSessionRunning}
          onGuide={handleGuideQueuedMessage}
          onEdit={(item) => setQueueEditingId(item.id)}
          onReorder={handleReorderQueuedMessage}
          onRemove={(itemId) => {
            if (activeSessionId) SessionCommandCoordinator.removeQueuedMessage(activeSessionId, itemId);
          }}
        />

        <ChatComposer
          activeQuestionnaire={!!activeQuestionnaire}
          currentSessionRunning={currentSessionRunning}
          interactionDisabled={isForkingSession}
          attachmentError={attachmentError}
          isAwaitingUIResponse={isAwaitingUIResponse}
          inputHasText={inputHasText}
          pendingFiles={pendingFiles}
          pendingImages={pendingImages}
          pendingPathAttachments={pendingPathAttachments}
          sessionReferences={activeSessionReferences}
          selectedAction={activeDraft.action}
          agentId={activeSession?.agentId || activeAgentId}
          actionSupported={activeSessionSupportsActions}
          actionContextKey={activeSessionId || ""}
          sendKey={sendKey}
          fileInputRef={fileInputRef}
          textareaRef={textareaRef}
          onAddInputFiles={handleAddInputFiles}
          onOpenAttachmentFolder={handleOpenAttachmentFolder}
          onOpenSessionReferences={() => {
            setModelOpen(false);
            setThinkingOpen(false);
            setReferenceOpen(true);
          }}
          onLoadActions={(reload) => activeSessionId
            ? SessionCommandCoordinator.getActions(activeSessionId, reload)
            : Promise.resolve([])}
          onSelectAction={(action) => {
            const sessionId = useProjectStore.getState().activeSessionId;
            if (sessionId) useChatStore.getState().setDraftAction(sessionId, action);
          }}
          onSelectedActionInvalid={() => {
            const sessionId = useProjectStore.getState().activeSessionId;
            if (sessionId) useChatStore.getState().setDraftAction(sessionId, undefined);
            showFloatingToastMessage("所选技能或命令已失效，已从草稿中移除");
          }}
          onClearAttachmentError={clearAttachmentError}
          onRemovePendingFile={removePendingFile}
          onRemovePendingImage={removePendingImage}
          onRemovePathAttachment={removePendingPathAttachment}
          onRemoveSessionReference={handleRemoveReference}
          onOpenImage={handleOpenImage}
          onSyncInputValue={syncInputValue}
          onResizeTextarea={resizeTextarea}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onSend={handleSend}
          onAbort={handleAbort}
        />

        <ChatToolbar
          activeAgentId={activeAgentId}
          activeSessionAgentId={activeSession?.agentId}
          availableModels={availableModels}
          currentModel={currentModel}
          currentThinking={currentThinking}
          expandedProvider={expandedProvider}
          favoriteModels={favoriteModels}
          modelOpen={modelOpen}
          modelProviders={modelProviders}
          planModeEnabled={planModeEnabled}
          thinkingLevel={currentThinking.id}
          thinkingLevels={thinkingLevels}
          thinkingOpen={thinkingOpen}
          modelRef={modelRef}
          thinkingRef={thinkingRef}
          leadingContent={
            activeProject && activeSession && (activeSessionReferences.length > 0 || referenceOpen) ? (
              <div ref={referenceRef} className="relative">
                <SessionReferenceControl
                  project={activeProject}
                  activeSession={activeSession}
                  references={activeSessionReferences}
                  open={referenceOpen}
                  showTrigger={activeSessionReferences.length > 0}
                  onOpenChange={setReferenceOpen}
                  onAddOrRefresh={handleAddOrRefreshReference}
                  onRemove={handleRemoveReference}
                />
              </div>
            ) : null
          }
          getPlanModeTooltip={getAgentPlanModeTooltip}
          onExpandedProviderChange={setExpandedProvider}
          onModelOpenChange={(open) => {
            setModelOpen(open);
            if (open) void refreshModelProviderOrder(currentAgentId);
          }}
          onThinkingOpenChange={setThinkingOpen}
          onPlanModeChange={savePlanModeEnabled}
          onOpenModelConfig={() => {
            const agentId = activeSession?.agentId || activeAgentId;
            setModelOpen(false);
            setThinkingOpen(false);
            setModelConfigAgentId(agentId);
          }}
          onSelectModel={handleSelectModel}
          onSelectThinking={handleSelectThinking}
          onToggleFavorite={toggleFavorite}
        />
      </div>

      {isForkingSession && (
        <div
          className="chat-forking-overlay"
          role="status"
          aria-live="polite"
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "none";
          }}
        >
          <div className="chat-forking-card">
            <div className="chat-working-spinner" />
            <span>正在创建分叉会话...</span>
          </div>
        </div>
      )}

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
      {imageContextMenu && (
        <div
          className="chat-image-context-menu"
          style={{ left: imageContextMenu.x, top: imageContextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button className="chat-image-context-menu-btn" onClick={handleCopyImage}>
            复制图片
          </button>
        </div>
      )}
      <FilePreview filePath={previewFile} onClose={() => setPreviewFile(null)} />
      {queueEditingId && activeProject && activeSession && (() => {
        const item = activeQueuedMessages.find((queued) => queued.id === queueEditingId);
        return item ? (
          <QueueEditDialog
            key={item.id}
            item={item}
            project={activeProject}
            session={activeSession}
            onClose={() => setQueueEditingId(null)}
            onSave={(draft) => handleEditQueuedMessage(item, draft)}
          />
        ) : null;
      })()}
      {modelConfigAgentId && (
        <AgentConfigModal
          agentId={modelConfigAgentId}
          agentName={getAgentName(modelConfigAgentId)}
          onClose={() => setModelConfigAgentId(null)}
          onModelsUpdated={handleModelConfigModelsUpdated}
        />
      )}
      {agentReloadConfirmOpen && (
        <div className="chat-agent-reload-overlay" onMouseDown={closeAgentReloadConfirm}>
          <div
            className="chat-agent-reload-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-agent-reload-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="chat-agent-reload-header">
              <div>
                <h3 id="chat-agent-reload-title">重载 {getAgentName(currentAgentId)}</h3>
                <span>{currentAgentId}</span>
              </div>
              <button
                type="button"
                className="chat-agent-reload-close"
                onClick={closeAgentReloadConfirm}
                disabled={agentReloading}
                title="关闭"
                aria-label="关闭"
              >
                <X size={17} />
              </button>
            </div>
            <div className="chat-agent-reload-content">
              <p>是否重载当前会话？</p>
              {currentSessionRunning && (
                <div className="chat-agent-reload-warning">当前会话正在运行，请等待任务结束后再重载。</div>
              )}
              {agentReloadError && <div className="chat-agent-reload-error">{agentReloadError}</div>}
            </div>
            <div className="chat-agent-reload-actions">
              <button type="button" className="btn-action" onClick={closeAgentReloadConfirm} disabled={agentReloading}>
                取消
              </button>
              <button
                type="button"
                className="filter-add-btn chat-agent-reload-confirm"
                onClick={() => void handleReloadCurrentAgent()}
                disabled={agentReloading || currentSessionRunning}
              >
                <RefreshCw size={13} className={agentReloading ? "chat-agent-reload-spin" : undefined} />
                {agentReloading ? "重载中..." : "确认重载"}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </>
  );
}
