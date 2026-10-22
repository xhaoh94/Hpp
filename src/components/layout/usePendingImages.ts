import { useCallback, useState, type ClipboardEvent } from "react";
import type { PendingImage } from "@/stores/chat-store";
import { detectImageMimeType, PROVIDER_IMAGE_MIME_TYPES } from "@shared/image-data";

const MAX_PENDING_IMAGE_BYTES = 10 * 1024 * 1024;
/**
 * 渠道真正能解码的图片格式。
 *
 * BMP / SVG 可以在本地预览，但 OpenAI 兼容渠道会直接报
 * `failed to decode image config: unsupported format` 让整次请求失败，
 * 所以不能把它们原样 base64 发给模型，必须在附件阶段转成 PNG。
 */
const SUPPORTED_IMAGE_TYPES = new Set([
  ...PROVIDER_IMAGE_MIME_TYPES,
  "image/bmp",
  "image/x-ms-bmp",
  "image/svg+xml",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);
const SUPPORTED_IMAGE_NAME_PATTERN = /\.(png|jpe?g|webp|gif|bmp|svg|avif|ico)$/i;

/** 把渠道不支持的图片格式光栅化成 PNG（data URL）。 */
const rasterizeToPngDataUrl = (dataUrl: string) => new Promise<string>((resolve, reject) => {
  const image = new Image();
  image.onload = () => {
    try {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) {
        reject(new Error("图片缺少可解析的尺寸"));
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("无法创建画布"));
        return;
      }
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL("image/png"));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  image.onerror = () => reject(new Error("无法解析该图片格式"));
  image.src = dataUrl;
});

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

export function usePendingImages(onAddImage: (image: PendingImage) => void) {
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

    const fileType = (file.type || "").toLowerCase();
    const reader = new FileReader();
    reader.onerror = () => {
      setAttachmentError(`无法读取图片附件：${file.name || "该文件"}`);
    };
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const addImage = (src: string, normalizedFile: File) => {
        onAddImage({
          id: crypto.randomUUID(),
          src,
          name: file.name,
          file: normalizedFile,
        });
        setAttachmentError(null);
      };
      // 按真实字节判断，而不是 file.type：`icon.svg` 改名成 `icon.png` 时
      // type/扩展名都会说自己是 PNG，但发给渠道就报 unsupported image。
      const detected = detectImageMimeType(dataUrl);
      if (detected && PROVIDER_IMAGE_MIME_TYPES.has(detected)) {
        addImage(dataUrl, detected === fileType ? file : new File([file], file.name, { type: detected }));
        return;
      }
      // BMP / SVG / 改名后的 SVG / ICO / AVIF 等：光栅化成真 PNG 再入队。
      void rasterizeToPngDataUrl(dataUrl).then(
        (pngDataUrl) => {
          const pngFile = new File([pngDataUrl], file.name.replace(/\.[^.]+$/, "") + ".png", {
            type: "image/png",
          });
          const rejection = getImageAttachmentRejection(pngFile);
          if (rejection) {
            setAttachmentError(rejection);
            return;
          }
          addImage(pngDataUrl, pngFile);
        },
        () => {
          setAttachmentError(`无法转换图片格式（${file.name || fileType || "未知"}），请改用 PNG/JPG/WebP。`);
        },
      );
    };
    reader.readAsDataURL(file);
  }, [onAddImage]);

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
    attachmentError,
    addPendingImage,
    clearAttachmentError,
    showAttachmentError,
    handlePaste,
  };
}
