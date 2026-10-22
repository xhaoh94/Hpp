/**
 * 本地媒体（视频）预览。
 *
 * 视频不能像图片一样转成 data URL：大文件会直接把渲染进程内存打满；
 * Chromium 的媒体加载安全检查又拒绝自定义协议（即使 standard+secure），
 * 所以主进程起了一个只监听 127.0.0.1 的临时 HTTP 流服务（支持 Range）。
 * 这里只负责拼 URL，前缀由 `media:getBaseUrl` 提供。
 */
let cachedMediaBaseUrl = "";

/** 主进程的本地媒体流前缀（启动后由 ChatPanel 填充，供缩略图/预览共用）。 */
export const setLocalMediaBaseUrl = (baseUrl: string) => {
  cachedMediaBaseUrl = String(baseUrl || "");
};

export const getLocalMediaBaseUrl = () => cachedMediaBaseUrl;

export const ensureLocalMediaBaseUrl = async () => {
  if (cachedMediaBaseUrl) return cachedMediaBaseUrl;
  if (typeof window === "undefined" || typeof window.electronAPI?.getLocalMediaBaseUrl !== "function") {
    return "";
  }
  const baseUrl = await window.electronAPI.getLocalMediaBaseUrl().catch(() => "");
  if (typeof baseUrl === "string") cachedMediaBaseUrl = baseUrl;
  return cachedMediaBaseUrl;
};

export const toLocalMediaUrl = (filePath: string, baseUrl: string) => {
  const path = String(filePath || "").trim();
  const prefix = String(baseUrl || "").trim();
  if (!path || !prefix) return "";
  return `${prefix}${encodeURIComponent(path)}`;
};

/**
 * 视频预览走自定义事件，避免把回调从 ChatPanel 一路穿过消息列表/流程块/输入框的 props。
 * 和图片预览的 `onOpenImage` 不同，视频只可能来自本地路径。
 */
/**
 * 把 hpp-file:// URL 还原成磁盘路径（主进程协议 handler 使用）。
 * Windows 盘符在编码后是 `C%3A`，解码后还要去掉 URL 的根斜杠。
 */
export const parseLocalMediaUrlPath = (url: string) => {
  const parsed = new URL(url);
  return decodeURIComponent(parsed.pathname).replace(/^\/([A-Za-z]:)/, "$1");
};

export const OPEN_VIDEO_PREVIEW_EVENT = "hpp:open-video-preview";

export const openVideoPreview = (path: string) => {
  if (typeof window === "undefined" || !path) return;
  window.dispatchEvent(new CustomEvent(OPEN_VIDEO_PREVIEW_EVENT, { detail: { path } }));
};

/** 是否是常见视频扩展名（剪贴板里有时只给空 MIME）。 */
export const VIDEO_FILE_EXTENSION_PATTERN = /\.(?:mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpg|mpeg|ts|3gp)$/i;

export const isVideoAttachment = (file: { type?: string; name?: string }) =>
  !!file?.type?.startsWith("video/") || VIDEO_FILE_EXTENSION_PATTERN.test(file?.name || "");
