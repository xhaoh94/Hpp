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

const canAttachImage = (file: File) => {
  const isImage = SUPPORTED_IMAGE_TYPES.has(file.type) || SUPPORTED_IMAGE_NAME_PATTERN.test(file.name);
  if (!isImage) {
    console.warn("[chat] ignored non-image attachment:", file.name || file.type || "unknown file");
    return false;
  }
  if (file.size > MAX_PENDING_IMAGE_BYTES) {
    console.warn("[chat] ignored oversized image attachment:", file.name || "unknown file");
    return false;
  }
  return true;
};

export function usePendingImages() {
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);

  const addPendingImage = useCallback((file: File) => {
    if (!canAttachImage(file)) return;

    const reader = new FileReader();
    reader.onload = () => {
      setPendingImages((prev) => [...prev, {
        id: crypto.randomUUID(),
        src: reader.result as string,
        name: file.name,
        file,
      }]);
    };
    reader.readAsDataURL(file);
  }, []);

  const removePendingImage = useCallback((id: string) => {
    setPendingImages((prev) => prev.filter((image) => image.id !== id));
  }, []);

  const clearPendingImages = useCallback(() => {
    setPendingImages([]);
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
    addPendingImage,
    removePendingImage,
    clearPendingImages,
    handlePaste,
    handleDrop,
    handleDragOver,
  };
}
