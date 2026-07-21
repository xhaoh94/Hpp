import type {
  ChangeEvent,
  DragEvent,
  KeyboardEvent,
  ClipboardEvent,
  RefObject,
} from "react";
import { memo, useEffect, useRef, useState } from "react";
import { FileText, Folder, Image as ImageIcon, Link2, RefreshCw, Search, Square, WandSparkles, X } from "lucide-react";
import type { PendingFile, PendingImage, PendingPathAttachment } from "@/stores/chat-store";
import type { SessionReference } from "@/stores/project-store";
import {
  getAgentActionDisplayDescription,
  type AgentActionCatalogEntry,
  type AgentActionInvocation,
} from "@shared/agent-actions";
import { getComposerAction, type ComposerAction } from "@shared/composer-action";
import {
  getChatComposerPlaceholder,
  getChatComposerSendTitle,
  getRemovePathAttachmentLabel,
  uiText,
} from "@/i18n/text";

type ChatComposerProps = {
  activeQuestionnaire: boolean;
  attachmentError: string | null;
  currentSessionRunning: boolean;
  interactionDisabled?: boolean;
  isAwaitingUIResponse: boolean;
  inputHasText: boolean;
  pendingFiles: PendingFile[];
  pendingImages: PendingImage[];
  pendingPathAttachments: PendingPathAttachment[];
  sessionReferences: SessionReference[];
  selectedAction?: AgentActionInvocation;
  agentId?: string;
  actionSupported: boolean;
  actionContextKey: string;
  sendKey: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onAddInputFiles: (files: File[]) => void;
  onOpenAttachmentFolder: () => void;
  onOpenSessionReferences: () => void;
  onLoadActions: (reload: boolean) => Promise<AgentActionCatalogEntry[]>;
  onSelectAction: (action?: AgentActionInvocation) => void;
  onSelectedActionInvalid: () => void;
  onClearAttachmentError: () => void;
  onRemovePendingFile: (id: string) => void;
  onRemovePendingImage: (id: string) => void;
  onRemovePathAttachment: (id: string) => void;
  onRemoveSessionReference: (sourceSessionId: string) => void;
  onOpenImage: (src: string) => void;
  onSyncInputValue: (value: string) => void;
  onResizeTextarea: (textarea?: HTMLTextAreaElement | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onSend: () => void;
  onAbort: () => void;
};

export const ChatComposer = memo(function ChatComposer({
  activeQuestionnaire,
  attachmentError,
  currentSessionRunning,
  interactionDisabled = false,
  isAwaitingUIResponse,
  inputHasText,
  pendingFiles,
  pendingImages,
  pendingPathAttachments,
  sessionReferences,
  selectedAction,
  agentId,
  actionSupported,
  actionContextKey,
  sendKey,
  fileInputRef,
  textareaRef,
  onAddInputFiles,
  onOpenAttachmentFolder,
  onOpenSessionReferences,
  onLoadActions,
  onSelectAction,
  onSelectedActionInvalid,
  onClearAttachmentError,
  onRemovePendingFile,
  onRemovePendingImage,
  onRemovePathAttachment,
  onRemoveSessionReference,
  onOpenImage,
  onSyncInputValue,
  onResizeTextarea,
  onKeyDown,
  onPaste,
  onDrop,
  onDragOver,
  onSend,
  onAbort,
}: ChatComposerProps) {
  const hasPendingContent =
    inputHasText ||
    pendingImages.length > 0 ||
    pendingFiles.length > 0 ||
    pendingPathAttachments.length > 0 ||
    sessionReferences.length > 0 ||
    !!selectedAction;
  const inputDisabled = activeQuestionnaire || interactionDisabled;
  const showAbortButton = !interactionDisabled && currentSessionRunning && !isAwaitingUIResponse && !hasPendingContent;
  const queueSend = !interactionDisabled && currentSessionRunning && !isAwaitingUIResponse && hasPendingContent;
  const sendDisabled = interactionDisabled
    ? true
    : activeQuestionnaire
      ? true
      : isAwaitingUIResponse
        ? !inputHasText
        : !hasPendingContent;
  const placeholder = getChatComposerPlaceholder(interactionDisabled, activeQuestionnaire, sendKey);
  const sendTitle = getChatComposerSendTitle(
    interactionDisabled,
    activeQuestionnaire,
    isAwaitingUIResponse,
    currentSessionRunning
  );
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [actionPickerOpen, setActionPickerOpen] = useState(false);
  const [actionSearch, setActionSearch] = useState("");
  const [actionCatalog, setActionCatalog] = useState<AgentActionCatalogEntry[]>([]);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const uploadMenuRef = useRef<HTMLDivElement>(null);
  const primaryActionIntentRef = useRef<ComposerAction | null>(null);

  const resolvePrimaryAction = () => {
    if (interactionDisabled || activeQuestionnaire) return "none" as const;
    const text = textareaRef.current?.value || "";
    if (isAwaitingUIResponse) return text.trim() ? "send" as const : "none" as const;
    return getComposerAction({
      text,
      imageCount: pendingImages.length,
      fileCount: pendingFiles.length,
      pathAttachmentCount: pendingPathAttachments.length,
      referenceCount: sessionReferences.length,
      actionCount: selectedAction ? 1 : 0,
      running: currentSessionRunning,
    });
  };

  const handlePrimaryAction = () => {
    const action = primaryActionIntentRef.current || resolvePrimaryAction();
    primaryActionIntentRef.current = null;
    if (action === "send") onSend();
    if (action === "abort" && currentSessionRunning) onAbort();
  };

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (interactionDisabled) {
      event.target.value = "";
      return;
    }
    onAddInputFiles(Array.from(event.target.files || []));
    event.target.value = "";
  };

  useEffect(() => {
    if (!uploadMenuOpen && !actionPickerOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (uploadMenuRef.current && !uploadMenuRef.current.contains(event.target as Node)) {
        setUploadMenuOpen(false);
        setActionPickerOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setUploadMenuOpen(false);
        setActionPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionPickerOpen, uploadMenuOpen]);

  useEffect(() => {
    if (interactionDisabled) {
      setUploadMenuOpen(false);
      setActionPickerOpen(false);
    }
  }, [interactionDisabled]);

  useEffect(() => {
    primaryActionIntentRef.current = null;
    setUploadMenuOpen(false);
    setActionPickerOpen(false);
    setActionSearch("");
    setActionCatalog([]);
    setActionError("");
  }, [actionContextKey]);

  const handleChooseFiles = () => {
    if (interactionDisabled) return;
    setUploadMenuOpen(false);
    fileInputRef.current?.click();
  };

  const handleChooseFolder = () => {
    if (interactionDisabled) return;
    setUploadMenuOpen(false);
    onOpenAttachmentFolder();
  };

  const handleChooseSession = () => {
    if (interactionDisabled) return;
    setUploadMenuOpen(false);
    onOpenSessionReferences();
  };

  const loadActions = async (reload: boolean) => {
    setActionLoading(true);
    setActionError("");
    try {
      const actions = await onLoadActions(reload);
      setActionCatalog(actions);
      if (selectedAction && !actions.some((entry) => entry.kind === selectedAction.kind && entry.name === selectedAction.name)) {
        onSelectedActionInvalid();
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionLoading(false);
    }
  };

  const handleChooseAction = () => {
    if (interactionDisabled || !actionSupported) return;
    setUploadMenuOpen(false);
    setActionPickerOpen(true);
    void loadActions(false);
  };

  const handleSelectAction = (entry: AgentActionCatalogEntry) => {
    onSelectAction({ kind: entry.kind, name: entry.name });
    setActionPickerOpen(false);
    setUploadMenuOpen(false);
    setActionSearch("");
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const normalizedSearch = actionSearch.trim().toLowerCase();
  const visibleActions = actionCatalog.filter((entry) => {
    const description = getAgentActionDisplayDescription(agentId, entry);
    return !normalizedSearch || `${entry.name} ${description} ${entry.description || ""}`.toLowerCase().includes(normalizedSearch);
  });
  const skillActions = visibleActions.filter((entry) => entry.kind === "skill");
  const commandActions = visibleActions.filter((entry) => entry.kind === "command");

  return (
    <>
      {(selectedAction || sessionReferences.length > 0 || pendingFiles.length > 0 || pendingImages.length > 0 || pendingPathAttachments.length > 0) && (
        <div className="chat-preview-bar">
          {selectedAction && (
            <div className="chat-preview-chip chat-preview-chip-action">
              <WandSparkles size={12} strokeWidth={2} className="chat-preview-icon" />
              <span className="chat-preview-label">
                {selectedAction.kind === "skill" ? "技能" : "命令"} · {selectedAction.name}
              </span>
              <button
                type="button"
                className="chat-preview-remove"
                onClick={() => onSelectAction(undefined)}
                disabled={interactionDisabled}
                title="移除"
                aria-label="移除技能或命令"
              >
                <X size={12} />
              </button>
            </div>
          )}
          {sessionReferences.map((reference) => (
            <div key={reference.sourceSessionId} className="chat-preview-chip chat-preview-chip-reference">
              <Link2 size={12} strokeWidth={2} className="chat-preview-icon" />
              <span className="chat-preview-label">{reference.sourceTitle} {uiText.chatComposer.session}</span>
              <button
                type="button"
                className="chat-preview-remove"
                onClick={() => onRemoveSessionReference(reference.sourceSessionId)}
                disabled={interactionDisabled}
                title={uiText.chatComposer.remove}
                aria-label={uiText.chatComposer.removeReferenceSession}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {pendingFiles.map((file) => (
            <div key={file.id} className="chat-preview-chip">
              <FileText size={12} strokeWidth={2} className="chat-preview-icon" />
              <span className="chat-preview-label">{file.fileName}:{file.startLine}-{file.endLine}</span>
              <button
                type="button"
                className="chat-preview-remove"
                onClick={() => onRemovePendingFile(file.id)}
                disabled={interactionDisabled}
                title={uiText.chatComposer.remove}
                aria-label={uiText.chatComposer.removeFileSnippet}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {pendingPathAttachments.map((attachment) => (
            <div key={attachment.id} className="chat-preview-chip" title={attachment.path}>
              {attachment.kind === "folder" ? (
                <Folder size={12} strokeWidth={2} className="chat-preview-icon" />
              ) : (
                <FileText size={12} strokeWidth={2} className="chat-preview-icon" />
              )}
              <span className="chat-preview-label">{attachment.name}</span>
              <button
                type="button"
                className="chat-preview-remove"
                onClick={() => onRemovePathAttachment(attachment.id)}
                disabled={interactionDisabled}
                title={uiText.chatComposer.remove}
                aria-label={getRemovePathAttachmentLabel(attachment.kind)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {pendingImages.map((image) => (
            <div key={image.id} className="chat-preview-chip">
              {image.src.startsWith("data:image/") || image.file.type.startsWith("image/") ? (
                <img src={image.src} alt={image.name} className="chat-preview-thumb" onClick={() => onOpenImage(image.src)} />
              ) : (
                <ImageIcon size={12} strokeWidth={2} className="chat-preview-icon" />
              )}
              <span className="chat-preview-label">{image.name}</span>
              <button
                type="button"
                className="chat-preview-remove"
                onClick={() => onRemovePendingImage(image.id)}
                disabled={interactionDisabled}
                title={uiText.chatComposer.remove}
                aria-label={uiText.chatComposer.removeImage}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {attachmentError && (
        <div className="chat-attachment-alert" role="status">
          <span>{attachmentError}</span>
          <button type="button" onClick={onClearAttachmentError} aria-label={uiText.chatComposer.closeAttachmentNotice}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <div
        className="chat-input-container"
        onDrop={(event) => {
          event.stopPropagation();
          onDrop(event);
        }}
        onDragOver={(event) => {
          event.stopPropagation();
          onDragOver(event);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleFileInputChange}
          disabled={interactionDisabled}
        />
        <div className="chat-input-actions-left">
          <div ref={uploadMenuRef} className="chat-upload-control">
            <button
              type="button"
              className="chat-input-btn"
              title={uiText.chatComposer.addAttachment}
              aria-haspopup="menu"
              aria-expanded={uploadMenuOpen}
              onClick={() => setUploadMenuOpen((open) => !open)}
              disabled={interactionDisabled}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
            </button>
            {uploadMenuOpen && (
              <div className="chat-upload-menu" role="menu">
                <button type="button" role="menuitem" onClick={handleChooseFiles}>
                  <FileText size={13} />
                  <span>{uiText.chatComposer.file}</span>
                </button>
                <button type="button" role="menuitem" onClick={handleChooseFolder}>
                  <Folder size={13} />
                  <span>{uiText.chatComposer.folder}</span>
                </button>
                <button type="button" role="menuitem" onClick={handleChooseSession}>
                  <Link2 size={13} />
                  <span>{uiText.chatComposer.session}</span>
                </button>
                {actionSupported && (
                  <button type="button" role="menuitem" onClick={handleChooseAction}>
                    <WandSparkles size={13} />
                    <span>技能</span>
                  </button>
                )}
              </div>
            )}
            {actionPickerOpen && (
              <div className="chat-action-picker" role="dialog" aria-label="选择技能或命令">
                <div className="chat-action-picker-header">
                  <strong>技能与命令</strong>
                  <div>
                    <button type="button" onClick={() => void loadActions(true)} disabled={actionLoading} title="刷新">
                      <RefreshCw size={13} className={actionLoading ? "spin" : undefined} />
                    </button>
                    <button type="button" onClick={() => setActionPickerOpen(false)} title="关闭"><X size={13} /></button>
                  </div>
                </div>
                <label className="chat-action-search">
                  <Search size={13} />
                  <input
                    value={actionSearch}
                    onChange={(event) => setActionSearch(event.target.value)}
                    placeholder="搜索技能或命令"
                    autoFocus
                  />
                </label>
                <div className="chat-action-list">
                  {actionLoading && actionCatalog.length === 0 ? (
                    <div className="chat-action-state">正在加载...</div>
                  ) : actionError ? (
                    <div className="chat-action-state error">加载失败：{actionError}</div>
                  ) : visibleActions.length === 0 ? (
                    <div className="chat-action-state">{normalizedSearch ? "没有匹配项" : "当前 Agent 没有可用技能或命令"}</div>
                  ) : (
                    <>
                      {skillActions.length > 0 && <div className="chat-action-group-title">技能</div>}
                      {skillActions.map((entry) => {
                        const description = getAgentActionDisplayDescription(agentId, entry);
                        return (
                          <button
                            type="button"
                            className="chat-action-item"
                            key={`skill:${entry.name}`}
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={() => handleSelectAction(entry)}
                          >
                            <span>{entry.name}</span>
                            {description && <small>{description}</small>}
                          </button>
                        );
                      })}
                      {commandActions.length > 0 && <div className="chat-action-group-title">命令</div>}
                      {commandActions.map((entry) => {
                        const description = getAgentActionDisplayDescription(agentId, entry);
                        return (
                          <button
                            type="button"
                            className="chat-action-item"
                            key={`command:${entry.name}`}
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={() => handleSelectAction(entry)}
                          >
                            <span>/{entry.name}</span>
                            {description && <small>{description}</small>}
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        <textarea
          ref={textareaRef}
          defaultValue=""
          onChange={(event) => {
            onSyncInputValue(event.currentTarget.value);
            onResizeTextarea(event.currentTarget);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          rows={1}
          className="chat-textarea"
          disabled={inputDisabled}
        />
        <button
          type="button"
          onPointerDown={() => { primaryActionIntentRef.current = resolvePrimaryAction(); }}
          onPointerCancel={() => { primaryActionIntentRef.current = null; }}
          onPointerLeave={(event) => { if (event.buttons !== 0) primaryActionIntentRef.current = null; }}
          onClick={handlePrimaryAction}
          disabled={showAbortButton ? false : sendDisabled}
          className={`chat-send-btn ${showAbortButton ? "abort" : queueSend ? "queue" : ""}`}
          title={showAbortButton ? uiText.chatComposer.stop : sendTitle}
        >
          {showAbortButton
            ? <Square size={14} fill="currentColor" strokeWidth={0} />
            : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
              )}
        </button>
      </div>
    </>
  );
});
