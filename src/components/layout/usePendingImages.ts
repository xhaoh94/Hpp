import { useCallback, useState, type ClipboardEvent, type DragEvent } from "react";
import type { PendingImage } from "./ChatComposer";

const MAX_PENDING_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/svg+xml",
]);
const SUPPORTED_IMAGE_NAME_PATTERN = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;

const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${Math.round(bytes / 1024 / 1024)}MB`;
};

const getImageAttachmentRejection = (file: File) => {
  const isImage = SUPPORTED_IMAGE_TYPES.has(file.type) || SUPPORTED_IMAGE_NAME_PATTERN.test(file.name);
  if (!isImage) {
    return `仅支持图片附件，已忽略 ${file.name || "该文件"}`;
  }
  if (file.size > MAX_PENDING_IMAGE_BYTES) {
    return `图片不能超过 ${formatBytes(MAX_PENDING_IMAGE_BYTES)}，已忽略 ${file.name || "该文件"}`;
  }
  return null;
};

export function usePendingImages() {
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const addPendingImage = useCallback((file: File) => {
    const rejection = getImageAttachmentRejection(file);
    if (rejection) {
      console.warn("[chat] ignored attachment:", file.name || file.type || "unknown file");
      setAttachmentError(rejection);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setPendingImages((prev) => [...prev, {
        id: crypto.randomUUID(),
        src: reader.result as string,
        name: file.name,
        file,
      }]);
      setAttachmentError(null);
    };
    reader.readAsDataURL(file);
  }, []);

  const removePendingImage = useCallback((id: string) => {
    setPendingImages((prev) => prev.filter((image) => image.id !== id));
  }, []);

  const clearPendingImages = useCallback(() => {
    setPendingImages([]);
  }, []);

  const clearAttachmentError = useCallback(() => {
    setAttachmentError(null);
  }, []);

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData.items);
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) addPendingImage(file);
        return;
      }
    }
  }, [addPendingImage]);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    for (const file of files) {
      addPendingImage(file);
    }
  }, [addPendingImage]);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  }, []);

  return {
    pendingImages,
    attachmentError,
    addPendingImage,
    removePendingImage,
    clearPendingImages,
    clearAttachmentError,
    handlePaste,
    handleDrop,
    handleDragOver,
  };
}
