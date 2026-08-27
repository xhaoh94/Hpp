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
import { Check, ChevronDown, ChevronLeft, Copy, CornerDownRight, FileText, Folder, GitBranch, GripVertical, ImagePlus, Link2, ListCollapse, MessageCircle, Pencil, Plus, RefreshCw, RotateCcw, Trash2, WandSparkles, X } from "lucide-react";
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
  isUserSpeechMessage,
} from "@/stores/chat-store";
import { useProjectStore, type AgentStatus, type Project, type ProjectSession, type SessionReference } from "@/stores/project-store";
import { BrailleSpinner } from "@/components/shared/BrailleSpinner";
import { useAppStore } from "@/stores/app-store";
import { useEditorStore } from "@/stores/editor-store";
import { getAgentName, getAgentPlanModeTooltip, supportsAgentActions, supportsGuidance, supportsPermissionModes } from "@/lib/agents";
import { getModelSwitchToastText, showFloatingToastMessage } from "@/lib/floating-toast";
import { showAppAlert } from "@/lib/app-dialog";
import {
  createSessionReferenceSnapshot,
  getSessionHeaderTitle,
  getSessionReferenceTitle,
} from "@/lib/session-references";
import { PATH_ATTACHMENT_DRAG_MIME, type PathAttachmentDragData } from "@/lib/path-attachments";
import { getLocalMarkdownCodePath, getLocalMarkdownFilePath, resolveProjectFilePath } from "@/lib/project-file-path";
import { extractUserMessageAttachments } from "@shared/user-message-attachments";
import { getSessionModel, SESSION_DATA_PURGED_EVENT } from "@/hooks/useDataPersistence";
import {
  SessionCommandCoordinator,
  type PreparedSessionMessage,
  type SendMessageResult,
} from "@/lib/session-command-coordinator";
import { useDragAutoScroll } from "@/hooks/useDragAutoScroll";
import { buildSessionMessagePayload } from "@/lib/session-message-payload";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import { AttachmentPreviewText } from "@/components/shared/AttachmentPreviewText";
import { getChatMessagePreviewText } from "@/lib/chat-message-preview";
import { ComposerMessageFlow } from "@/components/shared/ComposerMessageFlow";
import { FilePreview } from "@/components/shared/FilePreview";
import { AgentConfigModal } from "@/components/sidebar/AgentConfigModal";
import { ChatComposer } from "./ChatComposer";
import { InlineComposerEditor, type InlineComposerEditorHandle } from "@/components/shared/InlineComposerEditor";
import { ChatToolbar } from "./ChatToolbar";
import { ConfirmationPanel } from "./ConfirmationPanel";
import { DiffBlock } from "./DiffBlock";
import { PermissionChoicePanel } from "./PermissionChoicePanel";
import { ProcessBlock } from "./ProcessBlock";
import { QuestionnairePanel } from "./QuestionnairePanel";
import { useChatScroll } from "./useChatScroll";
import { resolvePreviousUserTargetIndex } from "./previousUserTarget";
import { useAgentEvents } from "./useAgentEvents";
import { isSupportedImageAttachment, usePendingImages } from "./usePendingImages";
import {
  preparePendingQuestionContinuation,
  settleFailedPendingQuestionTurn,
  usePendingUIResponse,
  usePendingUIResponseActions,
  type PendingUIResponseValue,
} from "./usePendingUIResponse";
import { useRemoteBridge } from "@/hooks/useRemoteBridge";
import { useQuestionnaireResize } from "./useQuestionnaireResize";
import { useSessionModels } from "./useSessionModels";
import {
  useChatVirtualizer,
  useExposeChatVirtualizer,
  type ChatVirtualizerHandle,
  type ChatVirtualizerRef,
} from "./useChatVirtualizer";
import {
  activateSessionRuntimeTurn,
  asRecord,
  createSessionRuntime,
  getBooleanField,
  markSessionRuntimeTurnSettled,
  rememberSettledCompactionEvent,
  resetSessionRuntimeAfterTurn,
  type SessionRuntime,
} from "./agentEventUtils";
import {
  getModelThinkingLevels,
  getOrderedModelProviders,
  includeCurrentModel,
  normalizeModelThinkingLevel,
} from "@shared/models";
import { collectProcessDiffs } from "@shared/diff-summary";
import { areAssistantMessageActionsVisible, formatHistoryMessageTime, formatMessageActionTime } from "@shared/message-display";
import {
  getActiveAssistantTurnId,
  hasNativeMultiStepProcessPlan,
  isProcessViewRunning,
  type ProcessTerminalViewState,
} from "@shared/process-view";
import type { AgentActionInvocation } from "@shared/agent-actions";
import {
  normalizeAgentPermissionMode,
  type AgentPermissionMode,
} from "@shared/agent-permissions";
import {
  ComposerHistoryController,
  draftFromMessage,
  type LegacyReferenceResolver,
} from "@/lib/composer-history";
import { matchShortcut } from "@/lib/shortcuts";
import { COMPOSER_INSERT_EVENT, type ComposerInsertEventDetail } from "@/lib/composer-insert-event";
import {
  composerDocumentHasContent,
  createComposerDocument,
  getComposerImageNodes,
  getComposerPlainText,
  withoutComposerImages,
  type ComposerDocument,
  type ComposerNode,
} from "@shared/composer-document";
import "./ChatPanel.css";

const AGENT_SETTINGS_UPDATED_EVENT = "agent-settings-updated";
const GENERAL_SETTINGS_UPDATED_EVENT = "general-settings-updated";
type MessageSessionReferencePayload = { sourceSessionId: string; sourceTitle: string };
type MessagePayload = PreparedSessionMessage;

const EMPTY_QUEUED_MESSAGES: QueuedMessage[] = [];

const documentFromDraftParts = (draft: {
  text: string;
  pendingImages: PendingImage[];
  pendingFiles: PendingFile[];
  pendingPathAttachments: PendingPathAttachment[];
  sessionReferences: SessionReference[];
}): ComposerDocument => {
  const nodes: ComposerNode[] = [];
  const append = (node: ComposerNode) => {
    if (nodes.length > 0) nodes.push({ id: crypto.randomUUID(), type: "text", text: "\n" });
    nodes.push(node);
  };
  if (draft.text) nodes.push({ id: crypto.randomUUID(), type: "text", text: draft.text });
  draft.pendingFiles.forEach((file) => append({ ...file, type: "snippet" }));
  draft.pendingPathAttachments.forEach((attachment) => append({ ...attachment, type: "path" }));
  draft.sessionReferences.forEach((reference) => append({ id: crypto.randomUUID(), type: "session", reference: { ...reference } }));
  return createComposerDocument(nodes);
};

const isOpenQueueSession = (sessionId: string) => useProjectStore.getState().projects.some((project) =>
  project.sessions.some((session) => session.id === sessionId && !session.closed));

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
    permissionMode?: AgentPermissionMode;
    queueIfRunning?: boolean;
    clientMessageId?: string;
  }
) => Promise<SendMessageResult>;

type MessageQueueDispatcherProps = {
  sessionRuntimeRef: { current: Record<string, SessionRuntime> };
  sendPayloadNow: SendPayloadNow;
};

type QueuePanelProps = {
  items: QueuedMessage[];
  canGuide: boolean;
  currentSessionRunning: boolean;
  compactionInProgress: boolean;
  onGuide: (item: QueuedMessage) => void;
  onEdit: (item: QueuedMessage) => void;
  onReorder: (itemId: string, toIndex: number) => void;
  onRemove: (itemId: string) => void;
};

const getQueuePreview = (item: QueuedMessage) => {
  const content = item.displayContent.trim();
  if (content) return <AttachmentPreviewText content={content} maxLength={120} />;
  if (item.sessionReferences?.length) return `[引用会话: ${item.sessionReferences.map((reference) => reference.sourceTitle).join(", ")}]`;
  if (item.messageImages?.length) return `[${item.messageImages.length} 张图片]`;
  if (item.action) return `${item.action.kind === "skill" ? "技能" : "命令"} · ${item.action.name}`;
  return "空消息";
};

function MessageQueuePanel({
  items,
  canGuide,
  currentSessionRunning,
  compactionInProgress,
  onGuide,
  onEdit,
  onReorder,
  onRemove,
}: QueuePanelProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [dropPosition, setDropPosition] = useState<"before" | "after">("before");
  const draggingIdRef = useRef<string | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const queueScrollRef = useRef<HTMLDivElement>(null);
  const { update: updateQueueAutoScroll, stop: stopQueueAutoScroll } = useDragAutoScroll(queueScrollRef);
  if (items.length === 0) return null;

  const finishDragging = () => {
    stopQueueAutoScroll();
    draggingIdRef.current = null;
    dropIndexRef.current = null;
    setDraggingId(null);
    setDropTargetIndex(null);
    setDropPosition("before");
  };

  const startDragging = (event: ReactPointerEvent<HTMLButtonElement>, item: QueuedMessage) => {
    if (item.status === "sending") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingIdRef.current = item.id;
    dropIndexRef.current = null;
    setDraggingId(item.id);
    setDropTargetIndex(null);
    setDropPosition("before");
  };

  const moveDragging = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!draggingIdRef.current) return;
    event.preventDefault();
    updateQueueAutoScroll(event.clientY);
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-queue-id]");
    if (!target) return;
    const index = items.findIndex((item) => item.id === target.dataset.queueId);
    const sourceIndex = items.findIndex((item) => item.id === draggingIdRef.current);
    if (index < 0 || sourceIndex < 0) return;
    const rect = target.getBoundingClientRect();
    const insertAfter = event.clientY >= rect.top + rect.height / 2;
    const rawInsertIndex = index + (insertAfter ? 1 : 0);
    const nextIndex = sourceIndex < rawInsertIndex ? rawInsertIndex - 1 : rawInsertIndex;
    if (nextIndex === sourceIndex) {
      dropIndexRef.current = null;
      setDropTargetIndex(null);
      return;
    }
    dropIndexRef.current = nextIndex;
    setDropTargetIndex(index);
    setDropPosition(insertAfter ? "after" : "before");
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
      <div ref={queueScrollRef} className="chat-queue-list">
        {items.map((item, index) => (
          <div
            key={item.id}
            data-queue-id={item.id}
            className={`chat-queue-item ${item.status} ${draggingId === item.id ? "dragging" : ""} ${dropTargetIndex === index && draggingId !== item.id ? `drop-target ${dropPosition}` : ""}`}
          >
            <button
              type="button"
              className="chat-queue-drag"
              disabled={item.status === "sending"}
              title="拖动调整顺序"
              aria-label={`拖动第 ${index + 1} 条队列消息`}
              onPointerDown={(event) => startDragging(event, item)}
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
              {canGuide && !compactionInProgress && !item.action && (
                <button
                  type="button"
                  className="chat-queue-action"
                  onClick={() => onGuide(item)}
                  disabled={!currentSessionRunning || item.status === "sending"}
                  title={item.status === "sending"
                    ? "等待调度"
                    : currentSessionRunning ? "作为引导发送到当前运行的对话" : "Agent 运行中才能引导"}
                >
                  <CornerDownRight size={14} />
                  <span>{item.status === "sending" ? "等待调度" : "引导"}</span>
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
  onOpenImage: (src: string) => void;
};

const getQueuedImageMimeType = (src: string) =>
  /^data:([^;,]+)[;,]/.exec(src)?.[1] || "image/png";

const documentFromQueuedDraft = (draft: QueuedMessageEditableDraft): ComposerDocument => withoutComposerImages(draft.document || createComposerDocument([
  ...(draft.text ? [{ id: crypto.randomUUID(), type: "text" as const, text: draft.text }] : []),
  ...draft.pendingFiles.map((file) => ({ ...file, type: "snippet" as const })),
  ...draft.pendingPathAttachments.map((attachment) => ({ ...attachment, type: "path" as const })),
  ...draft.sessionReferences.map((reference) => ({ id: crypto.randomUUID(), type: "session" as const, reference: { ...reference } })),
 ]));

const queuedDraftWithDocument = (draft: QueuedMessageEditableDraft, document: ComposerDocument): QueuedMessageEditableDraft => {
  const images = [...draft.images];
  for (const image of getComposerImageNodes(document)) {
    if (!images.some((current) => current.id === image.id)) images.push(image);
  }
  const orderedDocument = withoutComposerImages(document);
  return ({
  ...draft,
  document: orderedDocument,
  text: getComposerPlainText(orderedDocument),
  images,
  pendingFiles: document.nodes.flatMap((node) => node.type === "snippet" ? [{
    id: node.id, fileName: node.fileName, filePath: node.filePath, startLine: node.startLine, endLine: node.endLine,
  }] : []),
  pendingPathAttachments: document.nodes.flatMap((node) => node.type === "path" ? [{ id: node.id, name: node.name, path: node.path, kind: node.kind }] : []),
  sessionReferences: document.nodes.flatMap((node): SessionReference[] => {
    if (node.type !== "session") return [];
    const reference = node.reference;
    if (!reference.sourceAgentId || !reference.sourceUpdatedAt || !reference.addedAt || reference.summary === undefined) return [];
    return [{ ...reference } as SessionReference];
  }),
  });
};

function QueueEditDialog({ item, project, session, onClose, onSave, onOpenImage }: QueueEditDialogProps) {
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
  const [draft, setDraft] = useState<QueuedMessageEditableDraft>(() => queuedDraftWithDocument(
    initialDraft,
    item.composerDocument || documentFromQueuedDraft(initialDraft),
  ));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [addMenuPosition, setAddMenuPosition] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const queueEditorRef = useRef<InlineComposerEditorHandle>(null);
  const referenceCandidates = project.sessions.filter((candidate) => candidate.id !== session.id);

  useEffect(() => {
    if (!addMenuOpen) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
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
        const image = {
          id: crypto.randomUUID(),
          src: String(reader.result || ""),
          name: file.name,
          mimeType: file.type || "image/png",
        };
        setDraft((current) => ({ ...current, images: [...current.images, image] }));
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
        if (!draft.pendingPathAttachments.some((entry) => entry.path === result.attachment?.path)) {
          queueEditorRef.current?.insertNode({ id: crypto.randomUUID(), type: "path", ...result.attachment });
        }
      }
    })();
  }, [addImages, draft.pendingPathAttachments]);

  const addFolder = useCallback(() => {
    void (async () => {
      const result = await window.electronAPI.openAttachmentFolder();
      if (result.canceled) return;
      if (!result.attachment) {
        setError(result.error || "无法添加文件夹");
        return;
      }
      if (!draft.pendingPathAttachments.some((entry) => entry.path === result.attachment?.path)) {
        queueEditorRef.current?.insertNode({ id: crypto.randomUUID(), type: "path", ...result.attachment });
      }
    })();
  }, [draft.pendingPathAttachments]);

  const toggleReference = useCallback((source: ProjectSession) => {
    const exists = draft.sessionReferences.some((reference) => reference.sourceSessionId === source.id);
    if (exists) {
      const document = createComposerDocument((draft.document || documentFromQueuedDraft(draft)).nodes.filter((node) =>
        node.type !== "session" || node.reference.sourceSessionId !== source.id
      ));
      setDraft((current) => queuedDraftWithDocument(current, document));
      return;
    }
    queueEditorRef.current?.insertNode({
      id: crypto.randomUUID(),
      type: "session",
      reference: createSessionReferenceSnapshot(source, sessionMessages[source.id] || []),
    });
  }, [draft, sessionMessages]);

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
          {draft.action && (
            <div className="chat-queue-edit-contexts">
                {draft.action && (
                  <div className="chat-queue-edit-chip action"><WandSparkles size={13} /><span>{draft.action.kind === "skill" ? "技能" : "命令"} · {draft.action.name}</span><button type="button" onClick={() => setDraft((current) => ({ ...current, action: undefined }))}><X size={12} /></button></div>
                )}
            </div>
          )}

          {draft.images.length > 0 && (
            <div className="chat-queue-edit-contexts">
              {draft.images.map((image) => (
                <div className="chat-queue-edit-chip" key={image.id}>
                  <img src={image.src} alt={image.name} onClick={() => onOpenImage(image.src)} />
                  <span>Image</span>
                  <button type="button" onClick={() => setDraft((current) => ({ ...current, images: current.images.filter((item) => item.id !== image.id) }))} title="移除图片"><X size={12} /></button>
                </div>
              ))}
            </div>
          )}
          <div className="chat-queue-edit-composer">
            <InlineComposerEditor
              ref={queueEditorRef}
              value={draft.document || documentFromQueuedDraft(draft)}
              onChange={(document) => setDraft((current) => queuedDraftWithDocument(current, document))}
              onOpenImage={onOpenImage}
              placeholder={draft.action ? "添加技能参数或说明" : "编辑消息内容"}
              onKeyDown={(event) => {
                if (event.key === "Escape") onClose();
                if (event.key === "Enter" && event.ctrlKey) { event.preventDefault(); void submit(); }
              }}
            />
          </div>
          {error && <div className="chat-queue-edit-error">{error}</div>}
        </div>
        <footer className="chat-queue-edit-actions">
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
                            <AttachmentPreviewText content={candidate.title} />
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
          <div className="chat-queue-edit-action-buttons">
            <button type="button" className="btn-action" onClick={onClose} disabled={saving}>取消</button>
            <button type="button" className="filter-add-btn" onClick={() => void submit()} disabled={!hasContent || saving}>{saving ? "保存中..." : "保存修改"}</button>
          </div>
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

          <div className="chat-reference-section chat-reference-selected-section">
            <div className="chat-reference-section-title">已引用</div>
            {references.length === 0 ? (
              <div className="chat-reference-empty">暂无引用</div>
            ) : (
              references.map((reference) => {
                const sourceSession = project.sessions.find((session) => session.id === reference.sourceSessionId);
                return (
                  <div className="chat-reference-item" key={reference.sourceSessionId}>
                    <div className="chat-reference-item-main">
                      <div className="chat-reference-item-title"><AttachmentPreviewText content={reference.sourceTitle} /></div>
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
            {availableSessions.length === 0 ? (
              <div className="chat-reference-empty">没有其他可引用会话</div>
            ) : (
              availableSessions.map((session) => {
                const messages = sessionMessages[session.id] || [];
                const selected = referencedSessionIds.has(session.id);
                const selectedReference = references.find((reference) => reference.sourceSessionId === session.id);
                return (
                  <button
                    type="button"
                    className={`chat-reference-add-item ${selected ? "selected" : ""}`}
                    key={session.id}
                    onClick={() => {
                      if (selected) {
                        onRemove(session.id);
                        return;
                      }
                      onAddOrRefresh(session);
                    }}
                  >
                    {selected ? <Check size={13} /> : <Plus size={13} />}
                    <span className="chat-reference-add-main">
                      <span className="chat-reference-item-title">
                        <AttachmentPreviewText content={selectedReference?.sourceTitle || getSessionReferenceTitle(session, messages)} />
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

// 消息底部的 token 数量用紧凑格式（1.2k / 3.4M），悬停 title 里保留完整数字。
const formatTokenCount = (count: number) => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(count);
};

// 发言记录弹窗的虚拟行高度估算：12px 文本行高（约 16.8px）+ 上下 8px padding
// + 1px 底部边框。真实高度由 ResizeObserver 测量后自动校正。
const USER_HISTORY_ITEM_ESTIMATED_HEIGHT = 34;

const UserMessageHistoryControl = memo(function UserMessageHistoryControl({
  open,
  anchorRef,
  onOpenChange,
  onScrollToMessage,
}: UserMessageHistoryControlProps) {
  const userMessages = useChatStore(useShallow((state) =>
    state.messages.filter((message) => isUserSpeechMessage(message)).slice()
  ));
  const historyListRef = useRef<HTMLDivElement | null>(null);
  const historyItemKeys = useMemo(
    () => userMessages.map((message) => message.id),
    [userMessages],
  );
  const { virtualizer: historyVirtualizer, handle: historyVirtualHandle } = useChatVirtualizer({
    count: open ? userMessages.length : 0,
    itemKeys: historyItemKeys,
    scrollRef: historyListRef,
    estimateSize: () => USER_HISTORY_ITEM_ESTIMATED_HEIGHT,
    gap: 0,
    anchorTo: "start",
    overscan: 8,
  });
  useLayoutEffect(() => {
    // 弹窗是条件挂载，滚动容器 ref 在打开后才可用，需触发一次测量，
    // 并默认滚动到最新一行（正序后最新在底部）。
    if (open) {
      historyVirtualHandle.measure();
      historyVirtualHandle.scrollToEnd();
    }
  }, [open, historyVirtualHandle]);

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
        <div
          className="chat-user-history-popup"
          onWheel={(event) => event.stopPropagation()}
        >
          {userMessages.length === 0 ? (
            <div className="chat-user-history-empty">暂无发言</div>
          ) : (
            <div ref={historyListRef} className="chat-user-history-list persistent-scroll">
              <div className="chat-virtual-content" style={{ height: historyVirtualizer.getTotalSize() }}>
                {historyVirtualizer.getVirtualItems().map((virtualRow) => {
                  const msg = userMessages[virtualRow.index];
                  return (
                    <div
                      key={virtualRow.key}
                      ref={historyVirtualizer.measureElement}
                      data-index={virtualRow.index}
                      className="chat-virtual-row chat-user-history-item"
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                      onClick={() => onScrollToMessage(msg.id)}
                    >
                      <AttachmentPreviewText content={getChatMessagePreviewText(msg)} className="chat-user-history-text" />
                      <span className="chat-user-history-time">
                        {formatHistoryMessageTime(msg.timestamp)}
                      </span>
                    </div>
                  );
                })}
              </div>
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
        const firstUserMsg = messages?.find((message) => isUserSpeechMessage(message));
        const firstUserPreview = firstUserMsg ? getChatMessagePreviewText(firstUserMsg) : "";
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
            {firstUserPreview
              ? <AttachmentPreviewText content={firstUserPreview} maxLength={30} />
              : <span>{session.title}</span>}
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
  currentSessionStatus: AgentStatus;
  currentSessionCompacting: boolean;
  expandThinkingWhileRunning: boolean;
  projectPath?: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  showScrollBottom: boolean;
  userMsgHistoryOpen: boolean;
  userMsgHistoryRef: RefObject<HTMLDivElement | null>;
  onMessagesScroll: (event: ReactUIEvent<HTMLDivElement>) => void;
  onScrollToBottom: () => void;
  onContentChange: () => void;
  onEditMessage: (message: ChatMessage) => void;
  onImageContextMenu: (event: React.MouseEvent, imageSrc: string) => void;
  onOpenImage: (src: string) => void;
  onOpenFile: (path: string, options?: { preview?: boolean }) => void;
  onToggleAssistantProcess: (messageId: string, anchor?: HTMLElement | null) => void;
  onToggleAssistantProcessEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null, expanded?: boolean) => void;
  onPreserveScroll: (action: () => void, anchor?: HTMLElement | null) => void;
  onForkMessage: (message: ChatMessage) => void;
  forkingMessageId: string | null;
  onResendMessage: (message: ChatMessage) => void;
  onUserMsgHistoryOpenChange: (open: boolean) => void;
  onScrollToMessage: (messageId: string) => void;
  virtualizerRef?: ChatVirtualizerRef;
};

type ChatMessageItemProps = {
  msg: ChatMessage;
  receivedUserMessage?: ChatMessage;
  turnRunning: boolean;
  compactionRunning: boolean;
  processTerminalState: ProcessTerminalViewState;
  expandThinkingWhileRunning: boolean;
  projectPath?: string;
  onEditMessage: (message: ChatMessage) => void;
  onImageContextMenu: (event: React.MouseEvent, imageSrc: string) => void;
  onOpenImage: (src: string) => void;
  onOpenFile: (path: string, options?: { preview?: boolean }) => void;
  onToggleAssistantProcess: (messageId: string, anchor?: HTMLElement | null) => void;
  onToggleAssistantProcessEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null, expanded?: boolean) => void;
  onPreserveScroll: (action: () => void, anchor?: HTMLElement | null) => void;
  onForkMessage: (message: ChatMessage) => void;
  forkingMessageId: string | null;
  onResendMessage: (message: ChatMessage) => void;
  stickyPortalTarget?: HTMLElement | null;
  messageIndex?: number;
  userMessageExpanded?: boolean;
  onUserMessageExpandedChange?: (messageId: string, expanded: boolean) => void;
  onDiffOpenChange?: (messageId: string, open: boolean) => void;
};

const ChatMessageItem = memo(function ChatMessageItem({
  messageIndex,
  msg,
  receivedUserMessage,
  turnRunning,
  compactionRunning,
  processTerminalState,
  expandThinkingWhileRunning,
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
  onResendMessage,
  stickyPortalTarget,
  userMessageExpanded = false,
  onUserMessageExpandedChange,
  onDiffOpenChange,
}: ChatMessageItemProps) {
  const openMessageProjectPath = useCallback(async (path: string) => {
    const resolvedPath = resolveProjectFilePath(path, projectPath || "");
    const result = await window.electronAPI.statPath(resolvedPath);
    if (!result.success || !result.attachment) return;
    onOpenFile(resolvedPath, { preview: result.attachment.kind === "file" });
  }, [onOpenFile, projectPath]);

  const handleMessageMarkdownLinkClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const link = target.closest<HTMLAnchorElement>("a.md-link");
    const inlineCode = target.closest<HTMLElement>("code.md-inline-code.md-path-reference");
    if (link && event.currentTarget.contains(link)) {
      const filePath = getLocalMarkdownFilePath(link.getAttribute("href") || "");
      if (!filePath) return;
      event.preventDefault();
      event.stopPropagation();
      void openMessageProjectPath(filePath);
      return;
    }
    if (!inlineCode || !event.currentTarget.contains(inlineCode)) return;
    const codePath = getLocalMarkdownCodePath(inlineCode.textContent || "");
    if (!codePath) return;
    event.preventDefault();
    event.stopPropagation();
    void openMessageProjectPath(codePath);
  }, [openMessageProjectPath]);

  if (msg.role === "system" && msg.systemType === "context_compaction") {
    const compactionText = !compactionRunning && msg.compactionState === "running"
      ? "上下文压缩已结束"
      : msg.content || "上下文已自动压缩";
    return (
      <div data-msg-id={msg.id} className={`chat-context-divider${compactionRunning ? " running" : ""}`}>
        <span className="chat-context-divider-line" />
        <span className="chat-context-divider-label">
          {compactionRunning
            ? <span className="chat-context-divider-spinner" />
            : <ListCollapse size={15} strokeWidth={1.8} />}
          <span>{compactionText}</span>
        </span>
        <span className="chat-context-divider-line" />
      </div>
    );
  }

  const processRunning = msg.role === "assistant" && !!msg.process && isProcessViewRunning(msg.process, turnRunning);
  const fallbackProcessEndedAt = Math.max(
    msg.timestamp,
    ...(msg.commentary || []).map((item) => item.timestamp),
  );
  const sourceComposerDocument = msg.role === "user"
    ? msg.composerDocument || msg.composerDraft?.document
    : undefined;
  const orderedComposerDocument = sourceComposerDocument
    ? withoutComposerImages(sourceComposerDocument)
    : undefined;
  const displayedImages = msg.images?.length
    ? msg.images
    : sourceComposerDocument
      ? getComposerImageNodes(sourceComposerDocument).map(({ id, src, name }) => ({ id, src, name }))
      : [];
  const hasImages = displayedImages.length > 0;
  const hasSessionReferences = !!msg.sessionReferences?.length;
  const hasAction = !!msg.action;
  const commentary = msg.role === "assistant"
    ? (msg.commentary || []).filter((item) => item.content.trim().length > 0)
    : [];
  const processDiffs = collectProcessDiffs(msg.process);
  const visibleDiffs = !processRunning ? [...(msg.diffs || []), ...processDiffs] : [];
  const hasDiffs = visibleDiffs.length > 0;
  const userMessagePresentation = msg.role === "user"
    ? extractUserMessageAttachments(msg.content)
    : { text: msg.content, attachments: [] };
  const hasContent = orderedComposerDocument
    ? getComposerPlainText(orderedComposerDocument).trim().length > 0
    : userMessagePresentation.text.trim().length > 0;
  const hasOrderedContent = !!orderedComposerDocument && composerDocumentHasContent(orderedComposerDocument);
  const hasRawContent = msg.content.trim().length > 0;
  const hasTextAttachments = userMessagePresentation.attachments.length > 0;
  const userMessageLines = msg.role === "user" ? userMessagePresentation.text.split(/\r?\n/) : [];
  const userMessageIsLong = userMessageLines.length > 10;
  const displayedUserContent = userMessageIsLong && !userMessageExpanded
    ? userMessageLines.slice(0, 10).join("\n")
    : userMessagePresentation.text;
  const hasVisibleBubble =
    msg.role === "assistant"
      ? !processRunning && (hasContent || hasImages || hasDiffs || hasSessionReferences || hasAction)
      : hasContent || hasOrderedContent || hasTextAttachments || hasImages || hasDiffs || hasSessionReferences || hasAction;
  const showAssistantActions = hasVisibleBubble && areAssistantMessageActionsVisible({
    ...msg,
    isStreaming: turnRunning && msg.isStreaming,
    process: msg.process ? {
      ...msg.process,
      endedAt: processRunning ? msg.process.endedAt : msg.process.endedAt ?? fallbackProcessEndedAt,
    } : undefined,
  });
  const isForkingThisMessage = forkingMessageId === msg.id;
  const renderSessionReferences = () => (
    hasSessionReferences && msg.sessionReferences ? (
      <div className="chat-message-references" aria-label="引用会话">
        {msg.sessionReferences.map((reference) => (
          <div key={reference.sourceSessionId} className="chat-message-reference-chip">
            <Link2 size={12} strokeWidth={2} />
            <span>引用会话: <AttachmentPreviewText content={reference.sourceTitle} /></span>
          </div>
        ))}
      </div>
    ) : null
  );

  return (
    <div data-msg-id={msg.id} data-msg-index={messageIndex} className="chat-msg-wrapper" onClick={handleMessageMarkdownLinkClick}>
      {msg.role === "assistant" && msg.process && (
        <ProcessBlock
          messageId={msg.id}
          process={msg.process}
          commentary={commentary}
          running={processRunning}
          terminalState={processTerminalState}
          fallbackEndedAt={fallbackProcessEndedAt}
          expandThinkingWhileRunning={expandThinkingWhileRunning}
          onToggle={onToggleAssistantProcess}
          onToggleEntry={onToggleAssistantProcessEntry}
          onOpenFile={onOpenFile}
          onOpenImage={onOpenImage}
          onPreserveScroll={onPreserveScroll}
          receivedMessageDocument={receivedUserMessage?.composerDocument || receivedUserMessage?.composerDraft?.document}
          projectPath={projectPath}
          stickyPortalTarget={stickyPortalTarget}
          messageIndex={messageIndex}
        />
      )}
      {!msg.process && commentary.length > 0 && (
        <div className="chat-commentary" aria-label="处理说明">
          {commentary.map((item) => (
            <div
              key={item.id}
              className={`chat-commentary-item ${turnRunning && item.isStreaming ? "streaming" : ""}`}
            >
              <MarkdownRenderer content={item.content} />
            </div>
          ))}
        </div>
      )}
      {hasVisibleBubble && (
        <div className={`chat-msg ${msg.role}`}>
          {hasImages && (
            <div className="chat-images">
              {displayedImages.map((img) => (
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
                {(hasContent || hasAction || (msg.role === "user" && (hasOrderedContent || hasTextAttachments || hasSessionReferences))) && (
                  <div className={`chat-bubble ${msg.role} ${msg.action ? "has-action" : ""}`}>
                    {msg.action && (
                      <div className={`chat-action-label ${hasContent ? "with-content" : ""}`}>
                        <WandSparkles size={14} strokeWidth={1.9} />
                        <span>{msg.action.kind === "skill" ? "技能" : "命令"}</span>
                        <strong>{msg.action.name}</strong>
                      </div>
                    )}
                    {msg.role === "user" && (hasOrderedContent || hasTextAttachments || hasSessionReferences || hasContent) && (
                      <div className="chat-user-message-flow">
                        {orderedComposerDocument ? (
                          <ComposerMessageFlow document={orderedComposerDocument} onOpenImage={onOpenImage} />
                        ) : (
                          <>
                        {userMessagePresentation.attachments.map((attachment, index) => (
                          <span className={`chat-attached-path-chip ${attachment.kind}`} key={`${attachment.kind}:${attachment.label}:${index}`}>
                            {attachment.kind === "folder" ? <Folder size={13} /> : <FileText size={13} />}
                            <span>{attachment.label}</span>
                          </span>
                        ))}
                        {msg.sessionReferences?.map((reference) => (
                          <span key={reference.sourceSessionId} className="chat-message-reference-chip">
                            <Link2 size={12} strokeWidth={2} />
                            <span>引用会话: <AttachmentPreviewText content={reference.sourceTitle} /></span>
                          </span>
                        ))}
                        {hasContent && (
                          <span className={`chat-user-content ${userMessageIsLong && !userMessageExpanded ? "collapsed" : ""}`}>
                            {displayedUserContent}
                          </span>
                        )}
                          </>
                        )}
                        {userMessageIsLong && (
                          <button
                            type="button"
                            className="chat-user-expand-btn"
                            onClick={() => onUserMessageExpandedChange?.(msg.id, !userMessageExpanded)}
                          >
                            {userMessageExpanded ? "收起" : "显示更多"}
                            <ChevronDown
                              className={`chat-user-expand-chevron ${userMessageExpanded ? "expanded" : ""}`}
                              size={14}
                              strokeWidth={2}
                            />
                          </button>
                        )}
                      </div>
                    )}
                    {msg.role !== "user" && hasContent && (
                      <div className="chat-bubble-content">
                        <MarkdownRenderer content={msg.content} />
                      </div>
                    )}
                  </div>
                )}
              </div>
              {msg.role === "user" && hasVisibleBubble && (
                <div className="chat-msg-actions">
                  <time className="chat-message-time">{formatMessageActionTime(msg.timestamp)}</time>
                  <button
                    className="chat-copy-btn"
                    onClick={() => void onResendMessage(msg)}
                    title="重新发送"
                    aria-label="重新发送"
                  >
                    <RotateCcw size={12} strokeWidth={2} />
                  </button>
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
                    disabled={!hasRawContent}
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
            <DiffBlock
              diffs={visibleDiffs}
              projectPath={projectPath}
              onOpenChange={(open) => onDiffOpenChange?.(msg.id, open)}
            />
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
              <time className="chat-message-time">{formatMessageActionTime(msg.timestamp)}</time>
              {(msg.modelLabel || msg.tokenUsage) && (
                <span
                  className="chat-assistant-model-info"
                  title={[
                    msg.modelLabel || "",
                    msg.thinkingLevel || "",
                    msg.tokenUsage
                      ? `输入${msg.tokenUsage.input.toLocaleString()} (未命中${(msg.tokenUsage.input - (msg.tokenUsage.cacheInput ?? 0)).toLocaleString()} 缓存${(msg.tokenUsage.cacheInput ?? 0).toLocaleString()} · ${Math.round(((msg.tokenUsage.cacheInput ?? 0) / Math.max(1, msg.tokenUsage.input)) * 1000) / 10}%) / 输出${msg.tokenUsage.output.toLocaleString()}`
                      : "",
                  ].filter(Boolean).join(" · ")}
                >
                  {msg.modelLabel}
                  {msg.modelLabel && msg.tokenUsage ? " · " : ""}
                  {msg.tokenUsage && (
                    <>
                      <span className="token-arrow">↑</span>
                      <span className="token-value">
                        {formatTokenCount(Math.max(0, msg.tokenUsage.input - (msg.tokenUsage.cacheInput ?? 0)))}
                        {(msg.tokenUsage.cacheInput ?? 0) > 0 ? `(${formatTokenCount(msg.tokenUsage.cacheInput ?? 0)})` : ""}
                      </span>
                      {" "}
                      <span className="token-arrow">↓</span>
                      <span className="token-value">{formatTokenCount(msg.tokenUsage.output)}</span>
                    </>
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const getCurrentTodoStep = (steps: AgentProcessStep[]) =>
  steps.find((step) => step.status === "running")
  || steps.find((step) => step.status !== "completed")
  || steps[steps.length - 1];

const hasNativeTodoSteps = (process?: AgentProcess) => hasNativeMultiStepProcessPlan(process);

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
  const currentStep = getCurrentTodoStep(steps);

  const changeSummary = process.changeSummary;

  return (
    <div className="chat-todo-summary">
      <span className={`chat-todo-summary-dot ${currentStep?.status || ""}`} />
      <span className="chat-todo-summary-text" title={currentStep?.title || "任务处理中"}>
        {currentStep?.title || "任务处理中"}
      </span>
      {changeSummary && changeSummary.filesChanged > 0 && (
        <span className="chat-todo-summary-change">
          · {changeSummary.filesChanged} 个文件已更改
          {changeSummary.additions > 0 && <span className="chat-diff-add"> +{changeSummary.additions}</span>}
          {changeSummary.deletions > 0 && <span className="chat-diff-del"> -{changeSummary.deletions}</span>}
        </span>
      )}
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

/**
 * Estimate a row before Markdown, images and process timelines have been
 * measured. The virtualizer replaces this estimate with the real row height.
 */
const estimateChatMessageHeight = (message: ChatMessage): number => {
  if (message.role === "system") return 44;

  if (message.role === "user") {
    const lines = Math.max(1, (message.content || "").split(/\r?\n/).length);
    const attachmentCount = (message.images?.length || 0) + (message.sessionReferences?.length || 0);
    return Math.min(520, 64 + Math.min(lines, 10) * 20 + attachmentCount * 28);
  }

  const entryCount = message.process?.entries.length || 0;
  const commentaryCount = message.commentary?.length || 0;
  const textLines = Math.max(1, Math.ceil((message.content || "").length / 180));
  return Math.min(1_200, 84 + Math.min(entryCount, 18) * 28 + Math.min(commentaryCount, 6) * 54 + textLines * 22);
};

type ChatMessagesViewportProps = {
  messages: ChatMessage[];
  receivedUserMessages: Record<string, ChatMessage>;
  activeTurnId: string | null;
  activeCompactionMessageId: string | null;
  processTerminalState: ProcessTerminalViewState;
  expandThinkingWhileRunning: boolean;
  showWorking: boolean;
  expandedUserMessageIds: ReadonlySet<string>;
  onUserMessageExpandedChange: (messageId: string, expanded: boolean) => void;
  pinnedMessageIndex?: number;
  onDiffOpenChange: (messageId: string, open: boolean) => void;
  projectPath?: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  virtualizerRef?: ChatVirtualizerRef;
  onContentChange: () => void;
  onEditMessage: (message: ChatMessage) => void;
  onImageContextMenu: (event: React.MouseEvent, imageSrc: string) => void;
  onOpenImage: (src: string) => void;
  onOpenFile: (path: string, options?: { preview?: boolean }) => void;
  onToggleAssistantProcess: (messageId: string, anchor?: HTMLElement | null) => void;
  onToggleAssistantProcessEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null, expanded?: boolean) => void;
  onPreserveScroll: (action: () => void, anchor?: HTMLElement | null) => void;
  onForkMessage: (message: ChatMessage) => void;
  forkingMessageId: string | null;
  onResendMessage: (message: ChatMessage) => void;
  stickyPortalTarget?: HTMLElement | null;
};

const VirtualMessagesViewport = memo(function ChatMessagesViewport({
  messages,
  receivedUserMessages,
  activeTurnId,
  activeCompactionMessageId,
  processTerminalState,
  expandThinkingWhileRunning,
  showWorking,
  expandedUserMessageIds,
  onUserMessageExpandedChange,
  pinnedMessageIndex,
  onDiffOpenChange,
  projectPath,
  scrollRef,
  virtualizerRef,
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
  onResendMessage,
  stickyPortalTarget,
}: ChatMessagesViewportProps) {
  const itemKeys = useMemo(
    () => [
      ...messages.map((message) => message.id),
      ...(showWorking ? ["__chat-working__"] : []),
    ],
    [messages, showWorking],
  );
  const pinnedIndexes = useMemo(() => {
    const next = new Set<number>();
    messages.forEach((message, index) => {
      if (message.role === "assistant" && message.process?.expanded) next.add(index);
    });
    if (pinnedMessageIndex !== undefined) next.add(pinnedMessageIndex);
    return next.size > 0 ? next : undefined;
  }, [messages, pinnedMessageIndex]);
  const { virtualizer, handle } = useChatVirtualizer({
    count: itemKeys.length,
    itemKeys,
    scrollRef,
    pinnedIndexes,
    estimateSize: (index) => index < messages.length
      ? estimateChatMessageHeight(messages[index])
      : 40,
    // useChatScroll exclusively owns bottom-following. Start anchoring keeps
    // virtual row measurement from independently pulling a paused reader down.
    anchorTo: "start",
  });
  useExposeChatVirtualizer(virtualizerRef, handle);

  useLayoutEffect(() => {
    // Row ResizeObserver measures Markdown, images and process output changes.
    // Do not clear the whole measurement cache on every streaming update.
    onContentChange();
  }, [messages, onContentChange, showWorking]);

  return (
    <div
      className="chat-virtual-content chat-message-virtual-content"
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const message = messages[virtualRow.index];
        const isWorking = !message && showWorking && virtualRow.index === messages.length;
        return (
          <div
            key={virtualRow.key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            data-msg-id={message?.id}
            className="chat-virtual-row"
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            {message ? (
              <ChatMessageItem
                messageIndex={virtualRow.index}
                msg={message}
                receivedUserMessage={receivedUserMessages[message.id]}
                turnRunning={message.id === activeTurnId}
                compactionRunning={message.id === activeCompactionMessageId}
                processTerminalState={processTerminalState}
                expandThinkingWhileRunning={expandThinkingWhileRunning}
                userMessageExpanded={expandedUserMessageIds.has(message.id)}
                onUserMessageExpandedChange={onUserMessageExpandedChange}
                onDiffOpenChange={onDiffOpenChange}
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
                onResendMessage={onResendMessage}
                stickyPortalTarget={stickyPortalTarget}
              />
            ) : isWorking ? (
              <div className="chat-working">
                <div className="chat-working-spinner" />
                <span>正在处理您的请求...</span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
});

const ChatMessagesView = memo(function ChatMessagesView({
  activeSessionId,
  activeSessionInitialized,
  currentSessionRunning,
  currentSessionStatus,
  currentSessionCompacting,
  projectPath,
  scrollRef,
  showScrollBottom,
  userMsgHistoryOpen,
  userMsgHistoryRef,
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
  onResendMessage,
  expandThinkingWhileRunning,
  onUserMsgHistoryOpenChange,
  onScrollToMessage,
  virtualizerRef,
}: ChatMessagesViewProps) {
  const messages = useChatStore((state) => state.messages);
  const activeTurnId = getActiveAssistantTurnId(messages, currentSessionRunning);
  const activeCompactionMessageId = currentSessionRunning && currentSessionCompacting
    ? [...messages].reverse().find((message) => (
        message.systemType === "context_compaction" && message.compactionState === "running"
      ))?.id || null
    : null;
  const processTerminalState: ProcessTerminalViewState = currentSessionStatus === "error"
    ? "error"
    : "completed";
  const activeProcessWithTodos = messages.find((msg) => (
    msg.id === activeTurnId && !!msg.process && hasNativeTodoSteps(msg.process)
  ))?.process;
  const [stickyPortalTarget, setStickyPortalTarget] = useState<HTMLDivElement | null>(null);
  const [expandedUserMessageIds, setExpandedUserMessageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [activeDiffMessageId, setActiveDiffMessageId] = useState<string | null>(null);
  const [previousUserTargetId, setPreviousUserTargetId] = useState<string | null>(null);
  const setStickyPortalTargetRef = useCallback((element: HTMLDivElement | null) => {
    setStickyPortalTarget(element);
  }, []);
  useEffect(() => {
    setExpandedUserMessageIds(new Set());
    setActiveDiffMessageId(null);
    setPreviousUserTargetId(null);
  }, [activeSessionId]);
  const handleUserMessageExpandedChange = useCallback((messageId: string, expanded: boolean) => {
    setExpandedUserMessageIds((current) => {
      const next = new Set(current);
      if (expanded) next.add(messageId);
      else next.delete(messageId);
      return next;
    });
  }, []);
  const handleDiffOpenChange = useCallback((messageId: string, open: boolean) => {
    setActiveDiffMessageId(open ? messageId : null);
  }, []);
  // 全局「返回上一条发言」按钮：若视口中已有用户气泡，就定位到它的上一条；
  // 否则定位到视口上方最近的用户发言。这样在对话底部可以返回最后一条发言，
  // 跳转后即使气泡只剩一部分可见，也会继续正确指向更早的一条。
  const refreshPreviousUserTarget = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      setPreviousUserTargetId(null);
      return;
    }

    const speechIndexes = messages.reduce<number[]>((indexes, message, index) => {
      if (isUserSpeechMessage(message)) indexes.push(index);
      return indexes;
    }, []);
    if (speechIndexes.length === 0) {
      setPreviousUserTargetId(null);
      return;
    }

    const speechIndexSet = new Set(speechIndexes);
    const containerRect = el.getBoundingClientRect();
    const viewportTop = containerRect.top + 1;
    const viewportBottom = containerRect.bottom - 1;
    const mountedRows = Array.from(el.querySelectorAll<HTMLElement>(
      ".chat-message-virtual-content > .chat-virtual-row",
    )).flatMap((row) => {
      const index = Number(row.dataset.index);
      if (!Number.isInteger(index) || index > messages.length) return [];
      return [{ row, index, rect: row.getBoundingClientRect() }];
    });

    // 部分露在视口顶部的用户气泡也算当前气泡，避免轻微滚动后又把目标
    // 错误切回这条发言。若同时有多条可见，使用位置最靠上的一条。
    const visibleSpeechIndex = mountedRows
      .filter(({ index }) => speechIndexSet.has(index))
      .flatMap(({ row, index }) => {
        const bubble = row.querySelector<HTMLElement>(".chat-bubble.user");
        if (!bubble) return [];
        const rect = bubble.getBoundingClientRect();
        if (rect.bottom <= viewportTop || rect.top >= viewportBottom) return [];
        return [{ index, top: rect.top }];
      })
      .sort((left, right) => left.top - right.top)[0]?.index ?? null;

    // 没有用户气泡可见时，按真实 DOM 几何位置确定视口顶部所在的行。
    // 不直接比较 virtualItem.start 与 scrollTop：前者相对虚拟内容，后者相对
    // 滚动容器，两者坐标原点不同，会导致目标随滚动位置随机漂移。
    const rowAtOrAboveViewport = mountedRows
      .filter(({ rect }) => rect.top <= viewportTop)
      .sort((left, right) => right.rect.top - left.rect.top)[0];
    const firstRowBelowViewport = mountedRows
      .filter(({ rect }) => rect.top > viewportTop)
      .sort((left, right) => left.rect.top - right.rect.top)[0];
    const viewportMessageIndex = rowAtOrAboveViewport?.index
      ?? firstRowBelowViewport?.index
      ?? null;
    const targetIndex = resolvePreviousUserTargetIndex(
      speechIndexes,
      visibleSpeechIndex,
      viewportMessageIndex,
    );
    setPreviousUserTargetId(targetIndex === null ? null : messages[targetIndex].id);
  }, [messages, scrollRef]);
  const previousUserTarget = previousUserTargetId
    ? messages.find((message) => message.id === previousUserTargetId)
    : undefined;
  const previousUserTargetPreview = previousUserTarget ? getChatMessagePreviewText(previousUserTarget) : "";
  const previousUserTargetTip = previousUserTargetPreview && previousUserTargetPreview.trim()
    ? (previousUserTargetPreview.length > 120
        ? `${previousUserTargetPreview.slice(0, 120)}…`
        : previousUserTargetPreview)
    : "返回我的上一条发言";
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(refreshPreviousUserTarget);
    };
    el.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [refreshPreviousUserTarget, scrollRef]);
  useLayoutEffect(() => {
    refreshPreviousUserTarget();
  }, [refreshPreviousUserTarget]);
  const activeDiffMessageIndex = activeDiffMessageId
    ? messages.findIndex((message) => message.id === activeDiffMessageId)
    : -1;
  const receivedUserMessages = useMemo(() => {
    const byAssistantId: Record<string, ChatMessage> = {};
    let latestUserMessage: ChatMessage | undefined;
    for (const message of messages) {
      if (isUserSpeechMessage(message)) {
        latestUserMessage = message;
      } else if (message.role === "assistant" && message.process && latestUserMessage) {
        byAssistantId[message.id] = latestUserMessage;
      }
    }
    return byAssistantId;
  }, [messages]);

  return (
    <div className={`chat-messages-area ${activeProcessWithTodos ? "has-todo-summary" : ""}`}>
      <div ref={scrollRef} className="chat-messages" onScroll={onMessagesScroll}>
        <div ref={setStickyPortalTargetRef} className="chat-process-sticky-layer">
          {previousUserTarget && (
            <div className="chat-sticky-previous-message" data-visible="true">
              <button
                type="button"
                className="chat-process-sticky-toggle"
                onClick={() => onScrollToMessage(previousUserTarget.id)}
                title={previousUserTargetTip}
                aria-label={`返回我的上一条发言${previousUserTargetPreview ? `：${previousUserTargetPreview}` : ""}`}
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
            </div>
          )}
        </div>
        <UserMessageHistoryControl
          open={userMsgHistoryOpen}
          anchorRef={userMsgHistoryRef}
          onOpenChange={onUserMsgHistoryOpenChange}
          onScrollToMessage={onScrollToMessage}
        />
        {activeSessionId && !activeSessionInitialized ? (
          <div className="chat-loading-agent">
            <div className="chat-working-spinner" />
            <span>正在初始化会话...</span>
          </div>
        ) : (
          <>
            {messages.length === 0 && (
              <div className="chat-empty">发送消息开始对话</div>
            )}
            <ChatMessagesViewport
              messages={messages}
              receivedUserMessages={receivedUserMessages}
              activeTurnId={activeTurnId}
              activeCompactionMessageId={activeCompactionMessageId}
              processTerminalState={processTerminalState}
              expandThinkingWhileRunning={expandThinkingWhileRunning}
              showWorking={currentSessionRunning && messages.length > 0 && messages[messages.length - 1].role === "user"}
              expandedUserMessageIds={expandedUserMessageIds}
              onUserMessageExpandedChange={handleUserMessageExpandedChange}
              pinnedMessageIndex={activeDiffMessageIndex >= 0 ? activeDiffMessageIndex : undefined}
              onDiffOpenChange={handleDiffOpenChange}
              projectPath={projectPath}
              scrollRef={scrollRef}
              virtualizerRef={virtualizerRef}
              stickyPortalTarget={stickyPortalTarget}
              onContentChange={onContentChange}
              onEditMessage={onEditMessage}
              onImageContextMenu={onImageContextMenu}
              onOpenImage={onOpenImage}
              onOpenFile={onOpenFile}
              onToggleAssistantProcess={onToggleAssistantProcess}
              onToggleAssistantProcessEntry={onToggleAssistantProcessEntry}
              onPreserveScroll={onPreserveScroll}
              onForkMessage={onForkMessage}
              forkingMessageId={forkingMessageId}
              onResendMessage={onResendMessage}
            />
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
  const compactingSessions = useChatStore((state) => state.compactingSessions);
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
  const queueRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const queueRetryAttemptsRef = useRef<Map<string, number>>(new Map());
  const queueRetryReadyRef = useRef<Set<string>>(new Set());
  const [queueRetryVersion, setQueueRetryVersion] = useState(0);

  const clearQueueRetry = useCallback((sessionId: string) => {
    const timer = queueRetryTimersRef.current.get(sessionId);
    if (timer) clearTimeout(timer);
    queueRetryTimersRef.current.delete(sessionId);
    queueRetryAttemptsRef.current.delete(sessionId);
    queueRetryReadyRef.current.delete(sessionId);
  }, []);

  const scheduleQueueRetry = useCallback((sessionId: string) => {
    if (queueRetryTimersRef.current.has(sessionId)) return;
    const attempt = (queueRetryAttemptsRef.current.get(sessionId) || 0) + 1;
    queueRetryAttemptsRef.current.set(sessionId, attempt);
    const delay = Math.min(2_000, 100 * (2 ** Math.min(attempt - 1, 5)));
    const timer = setTimeout(() => {
      queueRetryTimersRef.current.delete(sessionId);
      queueRetryReadyRef.current.add(sessionId);
      setQueueRetryVersion((version) => version + 1);
    }, delay);
    queueRetryTimersRef.current.set(sessionId, timer);
  }, []);

  useEffect(() => () => {
    for (const timer of queueRetryTimersRef.current.values()) clearTimeout(timer);
    queueRetryTimersRef.current.clear();
    queueRetryAttemptsRef.current.clear();
    queueRetryReadyRef.current.clear();
  }, []);

  useEffect(() => {
    for (const sessionId of queueRetryTimersRef.current.keys()) {
      if (!(messageQueues[sessionId] || []).some((item) => item.status === "queued")) {
        clearQueueRetry(sessionId);
      }
    }
    for (const [sessionId, queue] of Object.entries(messageQueues)) {
      if (queue.length === 0) {
        clearQueueRetry(sessionId);
        continue;
      }
      if (queueDispatchingRef.current.has(sessionId)) continue;
      if (!initializedSessionIds.has(sessionId)) continue;
      const nextItem = queue.find((item) => item.status === "queued");
      if (!nextItem) continue;
      const runtime = sessionRuntimeRef.current[sessionId];
      const forceBackendRecheck = queueRetryReadyRef.current.has(sessionId);
      if (
        !forceBackendRecheck &&
        (runtime?.processActive || agentStatuses[sessionId] === "running" || compactingSessions[sessionId])
      ) {
        // Renderer lifecycle events can be delayed or lost even after the
        // backend has become idle. Keep a bounded backend probe alive for an
        // existing queue instead of waiting indefinitely for another render
        // state transition. sendPayloadNow rechecks authoritative backend
        // activity and requeues the same item in place while it is still busy.
        scheduleQueueRetry(sessionId);
        continue;
      }

      queueRetryReadyRef.current.delete(sessionId);
      queueDispatchingRef.current.add(sessionId);
      clearQueuedMessageError(sessionId, nextItem.id);
      markQueuedMessageSending(sessionId, nextItem.id);
      void sendPayloadNow(sessionId, nextItem, {
        planModeEnabled: !!nextItem.planModeEnabled,
        permissionMode: nextItem.permissionMode,
        queueIfRunning: true,
        clientMessageId: nextItem.id,
      }).then((result) => {
        if (!isOpenQueueSession(sessionId)) {
          clearQueueRetry(sessionId);
          return;
        }
        if (result.queued) {
          scheduleQueueRetry(sessionId);
          return;
        }
        clearQueueRetry(sessionId);
        if (result.abandoned) {
          removeQueuedMessage(sessionId, nextItem.id);
          return;
        }
        if (result.error) {
          upsertQueuedMessage({
            ...nextItem,
            status: "failed",
            error: result.error,
          });
          return;
        }
        removeQueuedMessage(sessionId, nextItem.id);
      }).catch((error) => {
        clearQueueRetry(sessionId);
        if (!isOpenQueueSession(sessionId)) return;
        upsertQueuedMessage({
          ...nextItem,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }).finally(() => {
        queueDispatchingRef.current.delete(sessionId);
        if ((useChatStore.getState().messageQueues[sessionId] || []).some((item) => item.status === "queued")) {
          setQueueRetryVersion((version) => version + 1);
        }
      });
    }
  }, [
    agentStatuses,
    clearQueueRetry,
    clearQueuedMessageError,
    compactingSessions,
    initializedSessionIds,
    markQueuedMessageSending,
    messageQueues,
    queueRetryVersion,
    removeQueuedMessage,
    scheduleQueueRetry,
    sendPayloadNow,
    sessionRuntimeRef,
    upsertQueuedMessage,
  ]);

  return null;
});

const ChatMessagesViewport = VirtualMessagesViewport;

const IMAGE_UNSUPPORTED_HINT = "当前模型未标记支持图片输入，请切换支持图片的模型，或在 Agent 配置中启用该模型的图片能力。";

/**
 * Show one red hint bubble when the active model does not accept images.
 * Each send attempt appends one hint; several images in a single send still
 * count as one because they share a single send action. The unsent message is
 * left untouched in the composer.
 */
function addImageUnsupportedHint(sessionId: string) {
  useChatStore.getState().addMessage({
    id: crypto.randomUUID(),
    role: "system",
    content: IMAGE_UNSUPPORTED_HINT,
    timestamp: Date.now(),
  }, sessionId);
}

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
    setDraftDocument,
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
    setDraftDocument: state.setDraftDocument,
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
  const sessionMessages = useChatStore((state) => state.sessionMessages);
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
  const activeSessionTitle = activeSession
    ? getSessionHeaderTitle(activeSession, activeSessionId ? sessionMessages[activeSessionId] || [] : [])
    : "";
  const currentAgentId = activeSession?.agentId || activeAgentId;
  const activeDraft = useChatStore(useShallow((state) => {
    const draft = activeSessionId
      ? state.sessionDrafts[activeSessionId] || EMPTY_CHAT_DRAFT
      : EMPTY_CHAT_DRAFT;
    return {
      text: draft.text,
      document: draft.document,
      action: draft.action,
      pendingFiles: draft.pendingFiles,
      pendingImages: draft.pendingImages,
      pendingPathAttachments: draft.pendingPathAttachments,
      sessionReferences: draft.sessionReferences,
    };
  }));
  const pendingImages = activeDraft.pendingImages;
  const pendingFiles = activeDraft.pendingFiles;
  const pendingPathAttachments = activeDraft.pendingPathAttachments;
  const activeComposerDocument = useMemo(
    () => withoutComposerImages(activeDraft.document || documentFromDraftParts(activeDraft)),
    [activeDraft]
  );
  const legacySessionReferences = activeSession?.references || [];
  const activeSessionReferences = useMemo(
    () => activeDraft.sessionReferences.length > 0 ? activeDraft.sessionReferences : legacySessionReferences,
    [activeDraft.sessionReferences, legacySessionReferences]
  );
  const activeSessionForkContext = activeSession?.forkContext;
  const activeQueuedMessages = useChatStore(useShallow((state) =>
    activeSessionId ? state.messageQueues[activeSessionId] || EMPTY_QUEUED_MESSAGES : EMPTY_QUEUED_MESSAGES
  ));
  const activeSessionCompacting = useChatStore((state) =>
    activeSessionId ? state.compactingSessions[activeSessionId] === true : false
  );
  const activeSessionSupportsGuidance = supportsGuidance(activeSession?.agentId || activeAgentId);
  const activeSessionSupportsActions = supportsAgentActions(activeSession?.agentId || activeAgentId);
  const openSessions = useMemo(
    () => activeProject?.sessions.filter((session) => !session.closed) || [],
    [activeProject?.sessions]
  );
  const openSessionIds = useMemo(() => {
    const sessionIds = new Set<string>();
    for (const project of projects) {
      for (const session of project.sessions) {
        if (!session.closed) sessionIds.add(session.id);
      }
    }
    return sessionIds;
  }, [projects]);
  const [modelProviderOrder, setModelProviderOrder] = useState<string[]>([]);
  const modelProviders = useMemo(
    () => getOrderedModelProviders(
      availableModels.length > 0 ? includeCurrentModel(availableModels, currentModel) : [],
      modelProviderOrder,
    ),
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
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const [imageContextMenu, setImageContextMenu] = useState<{ x: number; y: number; src: string } | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [userMsgHistoryOpen, setUserMsgHistoryOpen] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [planModeEnabled, setPlanModeEnabled] = useState(false);
  const [expandThinkingWhileRunning, setExpandThinkingWhileRunning] = useState(false);
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>("auto");
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const [modelConfigAgentId, setModelConfigAgentId] = useState<string | null>(null);
  const [agentReloadConfirmOpen, setAgentReloadConfirmOpen] = useState(false);
  const [agentReloading, setAgentReloading] = useState(false);
  const [agentReloadError, setAgentReloadError] = useState("");
  const [queueEditingId, setQueueEditingId] = useState<string | null>(null);
  const userMsgHistoryRef = useRef<HTMLDivElement>(null);
  const referenceRef = useRef<HTMLDivElement>(null);
  const chatPanelRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<InlineComposerEditorHandle>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const permissionRef = useRef<HTMLDivElement>(null);
  const sessionRuntimeRef = useRef<Record<string, SessionRuntime>>({});
  const forkingMessageIdRef = useRef<string | null>(null);
  const {
    attachmentError,
    addPendingImage: addPendingImageFile,
    clearAttachmentError,
    showAttachmentError,
    handlePaste,
  } = usePendingImages((image) => {
    addPendingImageToDraft(image);
  });

  useEffect(() => {
    const handleComposerInsert = (event: Event) => {
      const composerEvent = event as CustomEvent<ComposerInsertEventDetail>;
      const targetSessionId = composerEvent.detail?.sessionId || useProjectStore.getState().activeSessionId;
      if (!targetSessionId || targetSessionId !== useProjectStore.getState().activeSessionId) return;
      composerEvent.preventDefault();
      editorRef.current?.insertNode(composerEvent.detail.node);
      requestAnimationFrame(() => editorRef.current?.focus());
    };
    window.addEventListener(COMPOSER_INSERT_EVENT, handleComposerInsert);
    return () => window.removeEventListener(COMPOSER_INSERT_EVENT, handleComposerInsert);
  }, []);

  useEffect(() => {
    const handleSessionDataPurged = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionIds?: string[] }>).detail;
      for (const sessionId of detail?.sessionIds || []) composerHistoryRef.current.reset(sessionId);
    };
    window.addEventListener(SESSION_DATA_PURGED_EVENT, handleSessionDataPurged);
    return () => window.removeEventListener(SESSION_DATA_PURGED_EVENT, handleSessionDataPurged);
  }, []);

  useEffect(() => {
    for (const [sessionId, runtime] of Object.entries(sessionRuntimeRef.current)) {
      if (openSessionIds.has(sessionId)) continue;
      if (runtime.streamWatchdog) {
        clearTimeout(runtime.streamWatchdog);
        runtime.streamWatchdog = null;
      }
      if (runtime.activeCompactionId) {
        rememberSettledCompactionEvent(runtime, runtime.activeCompactionId);
        runtime.activeCompactionId = null;
        runtime.activeCompactionPresentation = null;
      }
      resetSessionRuntimeAfterTurn(runtime);
      const chatState = useChatStore.getState();
      const sessionMessages = chatState.sessionMessages[sessionId] || (
        chatState.activeSessionId === sessionId ? chatState.messages : []
      );
      const latestUserMessage = [...sessionMessages].reverse().find((message) => message.role === "user");
      markSessionRuntimeTurnSettled(runtime, "aborted", {
        userMessageId: latestUserMessage?.id,
      });
      const sessionStillExists = useProjectStore.getState().projects.some((project) =>
        project.sessions.some((session) => session.id === sessionId)
      );
      // Keep only a lightweight terminal tombstone for closed sessions so a
      // queued old event cannot revive them after reopen. Permanently deleted
      // sessions can release the runtime immediately.
      if (!sessionStillExists) delete sessionRuntimeRef.current[sessionId];
    }
  }, [openSessionIds]);

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
    pendingUIResponses,
    pendingUIResponse,
    getPendingUIResponse,
    clearPendingUIResponse,
    setPendingUIResponseState,
    isAwaitingUIResponse,
    activeConfirmation,
    activePermissionChoice,
    activeQuestionnaire,
  } = usePendingUIResponse(activeSessionId, openSessionIds);
  const activeInteraction = activeConfirmation || activePermissionChoice || activeQuestionnaire;
  const currentSessionRunning = activeSessionId ? activeSessionAgentStatus === "running" : isStreaming;
  const permissionModeSupported = supportsPermissionModes(activeSession?.agentId || activeAgentId);
  useEffect(() => {
    if (!permissionModeSupported) setPermissionOpen(false);
  }, [permissionModeSupported]);
  const isForkingSession = forkingMessageId !== null;
  const questionnaireResetKey = activeQuestionnaire
    ? `${activeQuestionnaire.sessionId}:${activeQuestionnaire.requestId || ""}:${activeQuestionnaire.entryId || ""}`
    : null;
  // 问卷弹出时，若窗口不在前台则发系统通知提醒（与任务完成通知一致，避免前台打扰）。
  const notifiedQuestionnaireKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeQuestionnaire || !questionnaireResetKey) return;
    if (notifiedQuestionnaireKeysRef.current.has(questionnaireResetKey)) return;
    if (
      typeof document === "undefined" ||
      (document.visibilityState === "visible" && document.hasFocus())
    ) {
      return;
    }
    notifiedQuestionnaireKeysRef.current.add(questionnaireResetKey);
    void window.electronAPI.showNotification({
      title: "有新的问题需要你回答",
      body: "Agent 正在等待你的选择，点击查看 Hpp",
    }).catch((error) => {
      console.error("[notification] questionnaire show failed:", error);
    });
  }, [activeQuestionnaire, questionnaireResetKey]);
  const {
    questionnairePaneHeight,
    handleQuestionnaireResizeStart,
  } = useQuestionnaireResize({
    panelRef: chatPanelRef,
    enabled: !!activeQuestionnaire,
    resetKey: questionnaireResetKey,
  });
  const chatVirtualizerRef = useRef<ChatVirtualizerHandle | null>(null);
  const getMessageIndex = useCallback(
    (messageId: string) => useChatStore.getState().messages.findIndex((message) => message.id === messageId),
    [],
  );
  const {
    scrollRef,
    showScrollBottom,
    handleMessagesScroll,
    scrollToBottom,
    scrollToBottomNow,
    scrollToMessage: scrollToMessageElement,
    preserveScrollDuringLayoutChange,
    preserveScrollDuringAutoLayoutChange,
    enableAutoFollow,
    handleContentChange,
  } = useChatScroll({
    activeSessionId,
    activeSessionInitialized,
    questionnairePaneHeight,
    virtualizerRef: chatVirtualizerRef,
    getMessageIndex,
  });

  const syncInputState = useCallback((value: string) => {
    inputValueRef.current = value;
    const hasText = value.trim().length > 0;
    if (inputHasTextRef.current !== hasText) {
      inputHasTextRef.current = hasText;
      setInputHasText(hasText);
    }
  }, []);

  const syncInputValue = useCallback((value: string) => {
    syncInputState(value);
    const sessionId = useProjectStore.getState().activeSessionId;
    if (sessionId) setDraftText(sessionId, value);
  }, [setDraftText, syncInputState]);

  const syncComposerDocument = useCallback((document: ComposerDocument) => {
    const sessionId = useProjectStore.getState().activeSessionId;
    const text = getComposerPlainText(document);
    syncInputState(text);
    if (sessionId) setDraftDocument(sessionId, document);
  }, [setDraftDocument, syncInputState]);

  const setComposerInput = useCallback((value: string) => {
    const document = createComposerDocument(value
      ? [{ id: crypto.randomUUID(), type: "text", text: value }]
      : []);
    syncComposerDocument(document);
  }, [syncComposerDocument]);

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
    syncInputState(draft.text);
    clearAttachmentError();
    requestAnimationFrame(() => {
      editorRef.current?.focus();
    });
  }, [clearAttachmentError, replaceSessionDraft, syncInputState]);

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
    const draftText = activeSessionId ? useChatStore.getState().sessionDrafts[activeSessionId]?.text || "" : "";
    syncInputState(draftText);
    clearAttachmentError();
  }, [activeSessionId, syncInputState, clearAttachmentError]);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.loadData("settings").then((data) => {
      const settings = asRecord(data);
      const general = asRecord(settings.general);
      if (!cancelled) {
        setPlanModeEnabled(!!getBooleanField(general, "planModeEnabled"));
        setExpandThinkingWhileRunning(getBooleanField(general, "expandThinkingWhileRunning") === true);
        setPermissionMode(normalizeAgentPermissionMode(general.permissionMode));
      }
    });

    const handleGeneralSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ expandThinkingWhileRunning?: boolean }>).detail;
      if (typeof detail?.expandThinkingWhileRunning === "boolean") {
        setExpandThinkingWhileRunning(detail.expandThinkingWhileRunning);
      }
    };
    window.addEventListener(GENERAL_SETTINGS_UPDATED_EVENT, handleGeneralSettingsUpdated);

    const handleAgentSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{
        planModeEnabled?: boolean;
        permissionMode?: AgentPermissionMode;
      }>).detail;
      if (typeof detail?.planModeEnabled === "boolean") {
        setPlanModeEnabled(detail.planModeEnabled);
      }
      if (detail?.permissionMode) setPermissionMode(normalizeAgentPermissionMode(detail.permissionMode));
    };
    window.addEventListener(AGENT_SETTINGS_UPDATED_EVENT, handleAgentSettingsUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(AGENT_SETTINGS_UPDATED_EVENT, handleAgentSettingsUpdated);
      window.removeEventListener(GENERAL_SETTINGS_UPDATED_EVENT, handleGeneralSettingsUpdated);
    };
  }, []);

  const savePlanModeEnabled = useCallback(async (nextPlanModeEnabled: boolean) => {
    setPlanModeEnabled(nextPlanModeEnabled);
    setModelOpen(false);
    setThinkingOpen(false);
    setPermissionOpen(false);
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

  const savePermissionMode = useCallback(async (nextPermissionMode: AgentPermissionMode) => {
    const normalizedMode = normalizeAgentPermissionMode(nextPermissionMode);
    setPermissionMode(normalizedMode);
    setPermissionOpen(false);
    setModelOpen(false);
    setThinkingOpen(false);
    setExpandedProvider(null);
    const data = await window.electronAPI.loadData("settings");
    const currentSettings = asRecord(data);
    const currentGeneral = asRecord(currentSettings.general);
    await window.electronAPI.saveData("settings", {
      ...currentSettings,
      general: {
        ...currentGeneral,
        permissionMode: normalizedMode,
      },
    });
    window.dispatchEvent(new CustomEvent(AGENT_SETTINGS_UPDATED_EVENT, {
      detail: { permissionMode: normalizedMode },
    }));
  }, []);

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
    setPermissionOpen(false);
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

  const handleOpenFile = useCallback((path: string, options: { preview?: boolean } = {}) => {
    const resolvedPath = resolveProjectFilePath(path, activeProject?.path || "");
    if (options.preview === false) {
      useAppStore.getState().revealFile(resolvedPath, { preview: false });
      return;
    }
    if (useEditorStore.getState().mode) {
      useEditorStore.getState().openFile(resolvedPath);
      return;
    }
    setPreviewFile(resolvedPath);
  }, [activeProject?.path]);

  const scrollToMessage = useCallback((msgId: string) => {
    scrollToMessageElement(msgId);
    setUserMsgHistoryOpen(false);
  }, [scrollToMessageElement]);

  const handleAddOrRefreshReference = useCallback((sourceSession: ProjectSession) => {
    if (!activeProject || !activeSessionId || sourceSession.id === activeSessionId) return;
    const sessionMessages = useChatStore.getState().sessionMessages;
    const reference = createSessionReferenceSnapshot(sourceSession, sessionMessages[sourceSession.id] || []);
    const existing = activeComposerDocument.nodes.find((node) =>
      node.type === "session" && node.reference.sourceSessionId === sourceSession.id
    );
    if (existing) {
      syncComposerDocument(createComposerDocument(activeComposerDocument.nodes.map((node) =>
        node.type === "session" && node.reference.sourceSessionId === sourceSession.id
          ? { ...node, reference: { ...reference } }
          : node
      )));
    } else {
      const node = { id: crypto.randomUUID(), type: "session" as const, reference: { ...reference } };
      const inserted = editorRef.current?.insertNode(node) === true;
      if (!inserted) {
        syncComposerDocument(createComposerDocument([...activeComposerDocument.nodes, node]));
      }
    }
  }, [activeComposerDocument, activeProject, activeSessionId, syncComposerDocument]);

  const handleRemoveReference = useCallback((sourceSessionId: string) => {
    if (!activeProject || !activeSessionId) return;
    const remainingNodes = activeComposerDocument.nodes.filter((node) =>
      node.type !== "session" || node.reference.sourceSessionId !== sourceSessionId
    );
    const hasVisibleContent = remainingNodes.some((node) => node.type !== "text" || node.text.trim().length > 0);
    syncComposerDocument(createComposerDocument(hasVisibleContent ? remainingNodes : []));
    removePersistedSessionReference(activeProject.id, activeSessionId, sourceSessionId);
  }, [activeComposerDocument, activeProject, activeSessionId, removePersistedSessionReference, syncComposerDocument]);

  const clearLegacySessionReferences = useCallback((sessionId: string, references: MessageSessionReferencePayload[]) => {
    if (!activeProject || references.length === 0) return;
    references.forEach((reference) => {
      removePersistedSessionReference(activeProject.id, sessionId, reference.sourceSessionId);
    });
  }, [activeProject, removePersistedSessionReference]);

  const addPathAttachmentFromPath = useCallback(async (path: string) => {
    const targetSessionId = useProjectStore.getState().activeSessionId;
    if (!targetSessionId) {
      showAttachmentError("当前没有可添加附件的会话");
      return false;
    }
    if (!path) {
      showAttachmentError("无法获取文件路径");
      return false;
    }

    const result = await window.electronAPI.statPath(path);
    if (!result.success || !result.attachment) {
      showAttachmentError(result.error ? `无法添加路径：${result.error}` : "无法添加路径");
      return false;
    }

    if (!activeComposerDocument.nodes.some((node) => node.type === "path" && node.path === result.attachment!.path)) {
      editorRef.current?.insertNode({ id: crypto.randomUUID(), type: "path", ...result.attachment });
    }
    clearAttachmentError();
    return true;
  }, [activeComposerDocument.nodes, clearAttachmentError, showAttachmentError]);

  const addIndexedFileAttachment = useCallback((attachment: Omit<PendingPathAttachment, "id">) => {
    const targetSessionId = useProjectStore.getState().activeSessionId;
    if (!targetSessionId) {
      showAttachmentError("当前没有可添加附件的会话");
      return;
    }
    if (!activeComposerDocument.nodes.some((node) => node.type === "path" && node.path === attachment.path)) {
      editorRef.current?.insertNode({ id: crypto.randomUUID(), type: "path", ...attachment });
    }
    clearAttachmentError();
  }, [activeComposerDocument.nodes, clearAttachmentError, showAttachmentError]);

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

      if (!activeComposerDocument.nodes.some((node) => node.type === "path" && node.path === result.attachment!.path)) {
        editorRef.current?.insertNode({ id: crypto.randomUUID(), type: "path", ...result.attachment });
      }
      clearAttachmentError();
    })();
  }, [activeComposerDocument.nodes, clearAttachmentError, showAttachmentError]);

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

  const handleToggleAssistantProcessEntry = useCallback((messageId: string, entryId: string, anchor?: HTMLElement | null, expanded?: boolean) => {
    preserveScrollDuringLayoutChange(() => toggleAssistantProcessEntry(messageId, entryId, expanded), anchor);
  }, [preserveScrollDuringLayoutChange, toggleAssistantProcessEntry]);

  const { switchToSession, refreshModels } = useSessionModels({
    activeSessionId,
    activeSessionAgentId: activeSession?.agentId,
    activeSessionInitialized,
    setAvailableModels,
    setCurrentModel,
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
      if ((e.target as Element | null)?.closest?.("[data-chat-toolbar-overlay]")) return;
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
      if (thinkingRef.current && !thinkingRef.current.contains(e.target as Node)) setThinkingOpen(false);
      if (permissionRef.current && !permissionRef.current.contains(e.target as Node)) setPermissionOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!isForkingSession) return;
    setModelOpen(false);
    setThinkingOpen(false);
    setPermissionOpen(false);
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

  const { refreshSessionWatchdog, requestManualAbort } = useAgentEvents({
    activeAgentId,
    sessionRuntimeRef,
    getPendingUIResponse,
    setPendingUIResponseState,
    setStreaming,
    preserveAssistantProcessCollapse: (sessionId, action) => {
      if (useProjectStore.getState().activeSessionId === sessionId) {
        preserveScrollDuringAutoLayoutChange(() => flushSync(action));
      } else {
        action();
      }
    },
    onContextCompactionSettled: (sessionId) => {
      // A compaction can keep the backend worker too busy for the initial
      // model fetch, leaving the picker empty after it settles. Re-fetch
      // models for the active session only when nothing is shown yet.
      if (useProjectStore.getState().activeSessionId !== sessionId) return;
      const chat = useChatStore.getState();
      if (chat.availableModels.length > 0 || chat.currentModel) return;
      refreshModels(sessionId);
    },
  });

  const prepareRemoteInteractionResponse = useCallback((sessionId: string) => {
    preparePendingQuestionContinuation(sessionId, sessionRuntimeRef);
  }, [sessionRuntimeRef]);

  const settleRemoteInteractionResponseFailure = useCallback(async (
    sessionId: string,
    pendingResponse: PendingUIResponseValue,
  ) => {
    await settleFailedPendingQuestionTurn(
      sessionId,
      pendingResponse,
      sessionRuntimeRef,
      setStreaming,
      (targetSessionId) => window.electronAPI.agentAbort(targetSessionId),
    );
  }, [sessionRuntimeRef, setStreaming]);

  useRemoteBridge({
    pendingInteractions: pendingUIResponses,
    getPendingInteraction: getPendingUIResponse,
    clearPendingInteraction: clearPendingUIResponse,
    abortSession: requestManualAbort,
    onInteractionResponsePrepared: prepareRemoteInteractionResponse,
    onInteractionResponseAccepted: refreshSessionWatchdog,
    onInteractionResponseFailed: settleRemoteInteractionResponseFailure,
  });

  const {
    handleConfirmUIResponse,
    handlePermissionChoiceUIResponse,
    handleSendUIResponse,
    handleSubmitQuestionnaire,
    handleCancelQuestionnaire,
  } = usePendingUIResponseActions({
    activeConfirmation,
    activePermissionChoice,
    activeQuestionnaire,
    addMessage,
    enableAutoFollow,
    inputValueRef,
    pendingUIResponse,
    refreshSessionWatchdog,
    sessionRuntimeRef,
    setComposerInput,
    setPendingUIResponseState,
    setStreaming,
  });

  const buildMessagePayload = useCallback(async (
    text: string,
    files: PendingFile[],
    images: PendingImage[],
    pathAttachments: PendingPathAttachment[],
    sessionReferences: SessionReference[] = activeSessionReferences,
    action: AgentActionInvocation | undefined = activeDraft.action,
    forkContext: string | undefined = activeSessionForkContext?.context,
    document: ComposerDocument | undefined = activeComposerDocument,
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
      document,
      forkContext,
      action,
      readFile: (path) => window.electronAPI.readFile(path),
    });
  }, [activeComposerDocument, activeDraft.action, activeSessionForkContext?.context, activeSessionReferences]);

  const sendPayloadNow = useCallback(async (
    targetSessionId: string,
    payload: MessagePayload,
    options?: {
      onSendFailure?: (error: string) => void;
      planModeEnabled?: boolean;
      permissionMode?: AgentPermissionMode;
      queueIfRunning?: boolean;
      clientMessageId?: string;
    }
  ) => {
    const cleanupRuntime = (sessionId: string) => {
      const runtime = sessionRuntimeRef.current[sessionId] || createSessionRuntime();
      sessionRuntimeRef.current[sessionId] = runtime;
      if (runtime?.streamWatchdog) {
        clearTimeout(runtime.streamWatchdog);
        runtime.streamWatchdog = null;
      }
      resetSessionRuntimeAfterTurn(runtime);
      const chatState = useChatStore.getState();
      const sessionMessages = chatState.sessionMessages[sessionId] || (
        chatState.activeSessionId === sessionId ? chatState.messages : []
      );
      const latestUserMessage = [...sessionMessages].reverse().find((message) => message.role === "user");
      markSessionRuntimeTurnSettled(runtime, "error", {
        userMessageId: latestUserMessage?.id,
      });
      if (!useProjectStore.getState().projects.some((project) =>
        project.sessions.some((session) => session.id === sessionId))) {
        delete sessionRuntimeRef.current[sessionId];
      }
    };
    const clientMessageId = options?.clientMessageId || crypto.randomUUID();
    const result = await SessionCommandCoordinator.sendMessage({
      sessionId: targetSessionId,
      clientMessageId,
      queueIfRunning: options?.queueIfRunning === true,
      message: {
        ...payload,
        planModeEnabled: !!options?.planModeEnabled,
        permissionMode: normalizeAgentPermissionMode(options?.permissionMode),
      },
      hooks: {
        isProcessActive: (sessionId) => sessionRuntimeRef.current[sessionId]?.processActive === true,
        commit: (action) => flushSync(action),
        onSendStarted: (sessionId) => {
          const runtime = sessionRuntimeRef.current[sessionId] || createSessionRuntime();
          sessionRuntimeRef.current[sessionId] = runtime;
          activateSessionRuntimeTurn(runtime, { userMessageId: clientMessageId });
          if (runtime.streamWatchdog) {
            clearTimeout(runtime.streamWatchdog);
            runtime.streamWatchdog = null;
          }
          runtime.streamBuffer = "";
          runtime.thinkingBuffer = "";
          runtime.thinkingEntryId = null;
          runtime.streamIdleNoticeEntryId = null;
          runtime.autoAbortReason = null;
          // The backend may accept the prompt but then emit nothing (stalled
          // worker, dropped first event). Arm the backend-state watchdog right
          // away so a silent turn cannot leave the session spinning as
          // "running" forever; it will settle against the authoritative state.
          refreshSessionWatchdog(sessionId);
        },
        onOptimisticMessage: () => {
          enableAutoFollow();
          scrollToBottomNow();
        },
        onReconcileCleanup: cleanupRuntime,
        onSendFailureCleanup: cleanupRuntime,
      },
    });
    if ("error" in result && result.error && options?.onSendFailure) options.onSendFailure(result.error);
    return result;
  }, [
    enableAutoFollow,
    refreshSessionWatchdog,
    scrollToBottomNow,
    sessionRuntimeRef,
  ]);

  const handleSend = useCallback(async () => {
    if (forkingMessageIdRef.current) return;
    if (activeInteraction) return;
    const targetSessionId = useProjectStore.getState().activeSessionId;

    if (isAwaitingUIResponse) {
      await handleSendUIResponse();
      return;
    }

    const rawText = inputValueRef.current;
    const text = rawText.trim();
    if (
      !targetSessionId ||
      (!composerDocumentHasContent(activeComposerDocument) &&
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
      // This message would otherwise go straight to a queue while the agent is
      // running. Instead of queueing or silently dropping it, show a toast and
      // keep the (unsent) message in the composer.
      if (currentSessionRunning) {
        showFloatingToastMessage("当前模型不支持图片输入，无法发送该消息。");
        return;
      }
      // Each send attempt shows one red hint bubble; multiple images in a
      // single send still count as one. The message stays in the composer.
      addImageUnsupportedHint(targetSessionId);
      return;
    }

    const payload = await buildMessagePayload(rawText, pendingFiles, pendingImages, pendingPathAttachments);
    composerHistoryRef.current.reset(targetSessionId);
    if (useProjectStore.getState().activeSessionId === targetSessionId) setComposerInput("");
    clearSessionDraft(targetSessionId);
    clearLegacySessionReferences(targetSessionId, payload.sessionReferences || []);
    await sendPayloadNow(targetSessionId, payload, {
      planModeEnabled,
      permissionMode,
      queueIfRunning: true,
    });
  }, [
    activeInteraction,
    activeDraft.action,
    activeComposerDocument,
    activeSessionReferences.length,
    addMessage,
    buildMessagePayload,
    clearLegacySessionReferences,
    clearSessionDraft,
    currentSessionRunning,
    handleSendUIResponse,
    isAwaitingUIResponse,
    pendingFiles,
    pendingImages,
    pendingPathAttachments,
    planModeEnabled,
    permissionMode,
    sendPayloadNow,
    sessionRuntimeRef,
    setComposerInput,
  ]);

  // 重发某条发言：以新消息的形式重新提交原内容（含图片/引用/技能），
  // 用于发送失败后的一键重试；若原消息其实已送达会产生重复。
  const handleResendMessage = useCallback(async (msg: ChatMessage) => {
    if (msg.role !== "user" || forkingMessageIdRef.current) return;
    const targetSessionId = useProjectStore.getState().activeSessionId;
    if (!targetSessionId) return;
    // 图片仅还原 base64 data URL 的，其它来源静默跳过。
    const images = (msg.images || []).flatMap((image) => {
      const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,.+$/.exec(image.src || "");
      return match ? [{ id: image.id, name: image.name, mimeType: match[1], src: image.src }] : [];
    });
    try {
      const payload = await buildSessionMessagePayload({
        text: msg.content,
        images,
        pendingFiles: [],
        pendingPathAttachments: [],
        sessionReferences: (msg.sessionReferences || []).map((reference) => ({
          sourceSessionId: reference.sourceSessionId,
          sourceTitle: reference.sourceTitle,
          sourceAgentId: "",
          sourceUpdatedAt: "",
          addedAt: new Date(msg.timestamp).toISOString(),
          summary: "",
        })),
        document: msg.composerDocument,
        action: msg.action,
        readFile: (path) => window.electronAPI.readFile(path),
      });
      await sendPayloadNow(targetSessionId, payload, {
        planModeEnabled,
        permissionMode,
        queueIfRunning: true,
      });
    } catch (error) {
      showFloatingToastMessage(error instanceof Error ? error.message : String(error));
    }
  }, [permissionMode, planModeEnabled, sendPayloadNow]);

  const handleGuideQueuedMessage = useCallback(async (item: QueuedMessage) => {
    if (!activeSessionSupportsGuidance) return;
    try {
      await SessionCommandCoordinator.guideQueuedMessage(item.sessionId, item.id);
    } catch (error) {
      showFloatingToastMessage(error instanceof Error ? error.message : String(error));
    }
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
        document: draft.document,
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

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;

    const historyDirection = matchShortcut(e, previousMessageKey)
      ? "previous"
      : matchShortcut(e, nextMessageKey)
        ? "next"
        : null;
    if (historyDirection) {
      if (activeInteraction || isForkingSession) return;
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
      editorRef.current?.insertLineBreak();
    }
  }, [
    activeInteraction,
    getCurrentSessionDraft,
    handleSend,
    isForkingSession,
    nextMessageKey,
    previousMessageKey,
    resolveLegacyReference,
    restoreComposerDraft,
    sendKey,
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
        showAppAlert("切换渠道或模型需要等当前运行结束后再操作。");
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
        showAppAlert("调整思考级别需要等当前运行结束后再操作。");
      }
    }
  };

  const thinkingLevels = getModelThinkingLevels(currentModel);
  const normalizedThinkingLevel = normalizeModelThinkingLevel(thinkingLevel, currentModel);
  const currentThinking = thinkingLevels.find((level) => level.id === normalizedThinkingLevel)
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
        <div className={`chat-agent-dot${currentSessionRunning ? " chat-agent-dot-running" : ""}`} />
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
        <span className="chat-header-session-title" title={activeSessionTitle}>
          {activeSessionTitle}
        </span>
        {currentSessionRunning && <BrailleSpinner />}
        <div style={{ flex: 1 }} />
      </div>

      {/* Messages */}
      <ChatMessagesView
        activeSessionId={activeSessionId}
        activeSessionInitialized={activeSessionInitialized}
        currentSessionRunning={currentSessionRunning}
        currentSessionStatus={activeSessionAgentStatus || (currentSessionRunning ? "running" : "idle")}
        currentSessionCompacting={activeSessionCompacting}
        expandThinkingWhileRunning={expandThinkingWhileRunning}
        projectPath={activeProject.path}
        scrollRef={scrollRef}
        showScrollBottom={showScrollBottom}
        userMsgHistoryOpen={userMsgHistoryOpen}
        userMsgHistoryRef={userMsgHistoryRef}
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
        onResendMessage={handleResendMessage}
        onUserMsgHistoryOpenChange={setUserMsgHistoryOpen}
        onScrollToMessage={scrollToMessage}
        virtualizerRef={chatVirtualizerRef}
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

      {/* 发送队列：移到输入框上方、聊天输入框之外，避免挤在输入框内显得杂乱 */}
      <MessageQueuePanel
        items={activeQueuedMessages}
        canGuide={activeSessionSupportsGuidance}
        currentSessionRunning={currentSessionRunning}
        compactionInProgress={activeSessionCompacting}
        onGuide={handleGuideQueuedMessage}
        onEdit={(item) => setQueueEditingId(item.id)}
        onReorder={handleReorderQueuedMessage}
        onRemove={(itemId) => {
          if (activeSessionId) SessionCommandCoordinator.removeQueuedMessage(activeSessionId, itemId);
        }}
      />

      {/* Input area */}
      <div
        className={`chat-input-area${activeInteraction ? " questionnaire-active" : ""}${activeQuestionnaire && questionnairePaneHeight !== null ? " questionnaire-resized" : ""}`}
        style={activeQuestionnaire && questionnairePaneHeight !== null ? { height: questionnairePaneHeight } : undefined}
      >
        <div className="chat-input-content">
        {activeConfirmation && (
          <ConfirmationPanel
            title={activeConfirmation.title}
            description={activeConfirmation.description}
            onConfirm={() => void handleConfirmUIResponse(true)}
            onReject={() => void handleConfirmUIResponse(false)}
          />
        )}

        {activePermissionChoice && (
          <PermissionChoicePanel
            title={activePermissionChoice.title}
            description={activePermissionChoice.description}
            question={activePermissionChoice.questions?.[0]}
            onSelect={(option) => void handlePermissionChoiceUIResponse(option)}
          />
        )}

        {activeQuestionnaire && (
          <QuestionnairePanel
            questions={activeQuestionnaire.questions || []}
            onSubmit={handleSubmitQuestionnaire}
            onCancel={handleCancelQuestionnaire}
          />
        )}

        <ChatComposer
          activeQuestionnaire={!!activeInteraction}
          currentSessionRunning={currentSessionRunning}
          compactionInProgress={activeSessionCompacting}
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
          editorRef={editorRef}
          composerDocument={activeComposerDocument}
          onDocumentChange={syncComposerDocument}
          onAddInputFiles={handleAddInputFiles}
          onAddPathAttachment={addIndexedFileAttachment}
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
          onKeyDown={handleKeyDown}
          onPaste={(event) => handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>)}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onSend={handleSend}
          onAbort={handleAbort}
        />

        {activeProject && activeSession && referenceOpen && (
          <div ref={referenceRef} className="chat-reference-floating-anchor">
            <SessionReferenceControl
              project={activeProject}
              activeSession={activeSession}
              references={activeSessionReferences}
              open={referenceOpen}
              showTrigger={false}
              onOpenChange={setReferenceOpen}
              onAddOrRefresh={handleAddOrRefreshReference}
              onRemove={handleRemoveReference}
            />
          </div>
        )}

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
          permissionMode={permissionMode}
          permissionModeSupported={permissionModeSupported}
          permissionOpen={permissionOpen}
          thinkingLevel={currentThinking?.id || thinkingLevel}
          thinkingLevels={thinkingLevels}
          thinkingOpen={thinkingOpen}
          modelRef={modelRef}
          thinkingRef={thinkingRef}
          permissionRef={permissionRef}
          leadingContent={null}
          getPlanModeTooltip={getAgentPlanModeTooltip}
          onExpandedProviderChange={setExpandedProvider}
          onModelOpenChange={(open) => {
            setModelOpen(open);
            if (open) void refreshModelProviderOrder(currentAgentId);
          }}
          onThinkingOpenChange={setThinkingOpen}
          onPermissionOpenChange={setPermissionOpen}
          onPlanModeChange={savePlanModeEnabled}
          onPermissionModeChange={savePermissionMode}
          onOpenModelConfig={() => {
            const agentId = activeSession?.agentId || activeAgentId;
            setModelOpen(false);
            setThinkingOpen(false);
            setPermissionOpen(false);
            setModelConfigAgentId(agentId);
          }}
          onSelectModel={handleSelectModel}
          onSelectThinking={handleSelectThinking}
          onToggleFavorite={toggleFavorite}
        />
        </div>
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
            onOpenImage={handleOpenImage}
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
