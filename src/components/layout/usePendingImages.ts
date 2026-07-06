import { useCallback, useState, type ClipboardEvent } from "react";
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

export const isSupportedImageAttachment = (file: File) =>
  SUPPORTED_IMAGE_TYPES.has(file.type) || SUPPORTED_IMAGE_NAME_PATTERN.test(file.name);

const getImageAttachmentRejection = (file: File) => {
  if (file.size > MAX_PENDING_IMAGE_BYTES) {
    return `图片不能超过 ${formatBytes(MAX_PENDING_IMAGE_BYTES)}，已忽略 ${file.name || "该文件"}`;
  }
  return null;
};

export function usePendingImages() {
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const addPendingImage = useCallback((file: File) => {
    if (!isSupportedImageAttachment(file)) {
      setAttachmentError(`不支持的图片附件：${file.name || "该文件"}`);
      return;
    }

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

  const showAttachmentError = useCallback((message: string) => {
    setAttachmentError(message);
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

  return {
    pendingImages,
    attachmentError,
    addPendingImage,
    removePendingImage,
    clearPendingImages,
    clearAttachmentError,
    showAttachmentError,
    handlePaste,
  };
}
