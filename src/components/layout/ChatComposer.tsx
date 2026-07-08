import type {
  ChangeEvent,
  DragEvent,
  KeyboardEvent,
  ClipboardEvent,
  RefObject,
} from "react";
import { memo, useEffect, useRef, useState } from "react";
import { FileText, Folder, Image as ImageIcon, Link2, Square, X } from "lucide-react";
import type { PendingFile, PendingImage, PendingPathAttachment } from "@/stores/chat-store";
import type { SessionReference } from "@/stores/project-store";
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
  sendKey: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onAddInputFiles: (files: File[]) => void;
  onOpenAttachmentFolder: () => void;
  onOpenSessionReferences: () => void;
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
  sendKey,
  fileInputRef,
  textareaRef,
  onAddInputFiles,
  onOpenAttachmentFolder,
  onOpenSessionReferences,
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
    sessionReferences.length > 0;
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
  const uploadMenuRef = useRef<HTMLDivElement>(null);

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (interactionDisabled) {
      event.target.value = "";
      return;
    }
    onAddInputFiles(Array.from(event.target.files || []));
    event.target.value = "";
  };

  useEffect(() => {
    if (!uploadMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (uploadMenuRef.current && !uploadMenuRef.current.contains(event.target as Node)) {
        setUploadMenuOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setUploadMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [uploadMenuOpen]);

  useEffect(() => {
    if (interactionDisabled) setUploadMenuOpen(false);
  }, [interactionDisabled]);

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

  return (
    <>
      {(sessionReferences.length > 0 || pendingFiles.length > 0 || pendingImages.length > 0 || pendingPathAttachments.length > 0) && (
        <div className="chat-preview-bar">
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
        {showAbortButton && (
          <button
            type="button"
            onClick={onAbort}
            className="chat-send-btn abort"
            title={uiText.chatComposer.stop}
          >
            <Square size={14} fill="currentColor" strokeWidth={0} />
          </button>
        )}
        {!showAbortButton && (
          <button
            onClick={onSend}
            disabled={sendDisabled}
            className={`chat-send-btn ${queueSend ? "queue" : ""}`}
            title={sendTitle}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </>
  );
});
