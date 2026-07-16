import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Capacitor } from "@capacitor/core";
import { MAX_REMOTE_IMAGE_BYTES } from "@shared/remote-protocol";
import { createClientId } from "./web-platform";

export interface PendingRemoteImage {
  id: string;
  name: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  data: string;
  preview: string;
}

const estimateBase64Bytes = (value: string) => Math.floor(value.length * 0.75);

const IMAGE_SELECTION_CANCELLED_CODES = new Set([
  "OS-PLUG-CAMR-0006",
  "OS-PLUG-CAMR-0013",
  "OS-PLUG-CAMR-0020",
]);

function getImageErrorDetails(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
  return { code, message };
}

export function isImageSelectionCancelled(error: unknown) {
  const { code, message } = getImageErrorDetails(error);
  return IMAGE_SELECTION_CANCELLED_CODES.has(code)
    || /\b(?:user\s+)?cancel(?:led|ed)?\b/i.test(message)
    || /no (?:image|file)s? (?:was )?selected/i.test(message);
}

export function getImageErrorMessage(error: unknown) {
  const { code, message } = getImageErrorDetails(error);
  if (isImageSelectionCancelled(error)) return "";
  if (["OS-PLUG-CAMR-0003", "OS-PLUG-CAMR-0005"].includes(code) || /permission|denied/i.test(message)) {
    return "没有相机或相册访问权限，请在系统设置中允许 Hpp 访问。";
  }
  if (code === "OS-PLUG-CAMR-0007" || /no camera/i.test(message)) {
    return "当前设备没有可用的相机。";
  }
  if (/larger than 2 MB|超过 2 MB/i.test(message)) {
    return "图片压缩后仍超过 2 MB，请选择尺寸更小的图片。";
  }
  if (/read|decode|prepare|process|image data/i.test(message)) {
    return "无法读取或处理所选图片，请换一张图片重试。";
  }
  return "选择图片失败，请重试。";
}

async function resizeDataUrl(dataUrl: string): Promise<{ dataUrl: string; mimeType: PendingRemoteImage["mimeType"] }> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法处理所选图片。");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  let quality = 0.86;
  let resized = canvas.toDataURL("image/jpeg", quality);
  while (estimateBase64Bytes(resized.split(",")[1] || "") > MAX_REMOTE_IMAGE_BYTES && quality > 0.45) {
    quality -= 0.1;
    resized = canvas.toDataURL("image/jpeg", quality);
  }
  if (estimateBase64Bytes(resized.split(",")[1] || "") > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error("图片压缩后仍超过 2 MB。");
  }
  return { dataUrl: resized, mimeType: "image/jpeg" };
}

export async function chooseRemoteImage(): Promise<PendingRemoteImage> {
  let dataUrl: string;
  if (Capacitor.isNativePlatform()) {
    const photo = await Camera.getPhoto({
      quality: 88,
      width: 2048,
      height: 2048,
      allowEditing: false,
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Prompt,
      saveToGallery: false,
      promptLabelHeader: "选择图片",
      promptLabelCancel: "取消",
      promptLabelPhoto: "从相册选择",
      promptLabelPicture: "拍照",
    });
    if (!photo.dataUrl) throw new Error("未选择图片。");
    dataUrl = photo.dataUrl;
  } else {
    dataUrl = await new Promise<string>((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/jpeg,image/png,image/webp,image/gif";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          reject(new Error("未选择图片。"));
          return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("无法读取所选图片。"));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(file);
      };
      input.click();
    });
  }
  const resized = await resizeDataUrl(dataUrl);
  return {
    id: createClientId(),
    name: `mobile-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`,
    mimeType: resized.mimeType,
    data: resized.dataUrl.split(",")[1] || "",
    preview: resized.dataUrl,
  };
}
