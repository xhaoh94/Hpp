import type {
  ChangeEvent,
  DragEvent,
  KeyboardEvent,
  ClipboardEvent,
  RefObject,
} from "react";
import type { PendingFile } from "@/stores/chat-store";

export type PendingImage = {
  id: string;
  src: string;
  name: string;
  file: File;
};

type ChatComposerProps = {
  activeQuestionnaire: boolean;
  currentSessionRunning: boolean;
  isAwaitingUIResponse: boolean;
  inputHasText: boolean;
  pendingFiles: PendingFile[];
  pendingImages: PendingImage[];
  sendKey: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onAddPendingImage: (file: File) => void;
  onRemovePendingFile: (id: string) => void;
  onRemovePendingImage: (id: string) => void;
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

export function ChatComposer({
  activeQuestionnaire,
  currentSessionRunning,
  isAwaitingUIResponse,
  inputHasText,
  pendingFiles,
  pendingImages,
  sendKey,
  fileInputRef,
  textareaRef,
  onAddPendingImage,
  onRemovePendingFile,
  onRemovePendingImage,
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
  const isAbortMode = currentSessionRunning && !isAwaitingUIResponse;
  const hasPendingContent = inputHasText || pendingImages.length > 0 || pendingFiles.length > 0;
  const sendDisabled = activeQuestionnaire
    ? true
    : isAwaitingUIResponse
      ? !inputHasText
      : !currentSessionRunning && !hasPendingContent;
  const placeholder = activeQuestionnaire
    ? "请在上方提交问卷"
    : sendKey === "Ctrl+Enter"
      ? "输入消息... (Ctrl+Enter 发送, Enter 换行, 粘贴图片)"
      : "输入消息... (Enter 发送, Ctrl+Enter 换行, 粘贴图片)";
  const sendTitle = activeQuestionnaire
    ? "请在上方提交问卷"
    : isAbortMode
      ? "停止"
      : isAwaitingUIResponse
        ? "发送回答"
        : "发送";

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    Array.from(event.target.files || []).forEach(onAddPendingImage);
    event.target.value = "";
  };

  return (
    <>
      {(pendingFiles.length > 0 || pendingImages.length > 0) && (
        <div className="chat-preview-bar">
          {pendingFiles.map((file) => (
            <div key={file.id} className="chat-file-card">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="chat-file-icon">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className="chat-file-name">{file.fileName}:{file.startLine}-{file.endLine}</span>
              <button className="chat-file-remove" onClick={() => onRemovePendingFile(file.id)}>×</button>
            </div>
          ))}
          {pendingImages.map((image) => (
            <div key={image.id} className="chat-image-card-inline">
              {image.file.type.startsWith("image/") ? (
                <img src={image.src} alt={image.name} className="chat-image-thumb-inline" onClick={() => onOpenImage(image.src)} />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="2" className="chat-file-icon">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              )}
              <span className="chat-file-name">{image.name}</span>
              <button className="chat-file-remove" onClick={() => onRemovePendingImage(image.id)}>×</button>
            </div>
          ))}
        </div>
      )}

      <div className="chat-input-container" onDrop={onDrop} onDragOver={onDragOver}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleFileInputChange}
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
          disabled={activeQuestionnaire}
        />
        <button
          onClick={isAbortMode ? onAbort : onSend}
          disabled={sendDisabled}
          className={`chat-send-btn ${isAbortMode ? "abort" : ""}`}
          title={sendTitle}
        >
          {isAbortMode ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          )}
        </button>
      </div>
    </>
  );
}
