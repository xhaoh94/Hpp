export const ANDROID_UPDATE_METADATA_URL =
  "https://github.com/xhaoh94/Hpp/releases/latest/download/android-latest.json";
export const ANDROID_UPDATE_METADATA_MIRROR_URL =
  "https://cdn.jsdelivr.net/gh/xhaoh94/Hpp@main/updates/android-latest.json";
export const ANDROID_UPDATE_RELEASE_API_URL =
  "https://api.github.com/repos/xhaoh94/Hpp/releases/latest";

export type AndroidUpdateMetadata = {
  version: string;
  versionCode: number;
  url: string;
  sha256: string;
  publishedAt: string;
};

const HTTPS_URL_PATTERN = /^https:\/\//i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const VERSION_CODE_LABEL_PATTERN = /^hpp-version-code:(\d+)$/;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export function parseAndroidUpdateMetadata(value: unknown): AndroidUpdateMetadata {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("UPDATE_METADATA_INVALID");
    }
  }
  const raw = asRecord(parsed);
  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  const versionCode = typeof raw.versionCode === "number" ? raw.versionCode : Number(raw.versionCode);
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const sha256 = typeof raw.sha256 === "string" ? raw.sha256.trim().toLowerCase() : "";
  const publishedAt = typeof raw.publishedAt === "string" ? raw.publishedAt : "";
  if (
    !version || !Number.isSafeInteger(versionCode) || versionCode <= 0 ||
    !HTTPS_URL_PATTERN.test(url) || !SHA256_PATTERN.test(sha256)
  ) {
    throw new Error("UPDATE_METADATA_INVALID");
  }
  return { version, versionCode, url, sha256, publishedAt };
}

export function parseGitHubReleaseUpdateMetadata(value: unknown): AndroidUpdateMetadata {
  const release = asRecord(value);
  const tag = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const apk = assets
    .map(asRecord)
    .find((asset) => asset.name === "Hpp-Android.apk");
  const label = typeof apk?.label === "string" ? apk.label.trim() : "";
  const labelMatch = VERSION_CODE_LABEL_PATTERN.exec(label);
  const digest = typeof apk?.digest === "string" ? apk.digest.trim().toLowerCase() : "";
  const url = typeof apk?.browser_download_url === "string" ? apk.browser_download_url.trim() : "";
  return parseAndroidUpdateMetadata({
    version: tag.replace(/^v/i, ""),
    versionCode: labelMatch ? Number(labelMatch[1]) : 0,
    url,
    sha256: digest.replace(/^sha256:/, ""),
    publishedAt: typeof release.published_at === "string" ? release.published_at : "",
  });
}

export const isAndroidUpdateAvailable = (currentBuild: string | number, metadata: AndroidUpdateMetadata) => {
  const build = typeof currentBuild === "number" ? currentBuild : Number(currentBuild);
  return Number.isFinite(build) && metadata.versionCode > build;
};

export function getAndroidUpdateErrorMessage(error: unknown) {
  const raw = asRecord(error);
  const code = typeof raw.code === "string" ? raw.code : "";
  const message = error instanceof Error ? error.message : typeof raw.message === "string" ? raw.message : String(error);
  const marker = `${code} ${message}`;
  const normalizedMarker = marker.toLowerCase();
  if (marker.includes("CHECKSUM_MISMATCH")) return "安装包校验失败，请重新下载";
  if (marker.includes("DOWNLOAD_TOO_LARGE")) return "安装包大小异常，已停止下载";
  if (marker.includes("DOWNLOAD_FAILED")) return "安装包下载失败，请检查网络后重试";
  if (marker.includes("UPDATE_CHECK_HTTP")) return "无法获取更新信息，请检查网络后重试";
  if (marker.includes("UPDATE_METADATA_INVALID")) return "更新信息格式异常，请稍后重试";
  if (marker.includes("INSTALL_FILE_MISSING")) return "安装包已失效，请重新下载";
  if (marker.includes("INSTALL_PERMISSION_REQUIRED")) return "请先允许 Hpp 安装未知应用";
  if (
    normalizedMarker.includes("connection closed") ||
    normalizedMarker.includes("connection reset") ||
    normalizedMarker.includes("failed to fetch") ||
    normalizedMarker.includes("network error") ||
    normalizedMarker.includes("timeout") ||
    normalizedMarker.includes("timed out") ||
    normalizedMarker.includes("unable to resolve host") ||
    normalizedMarker.includes("name not resolved")
  ) return "无法连接 GitHub，请检查网络或稍后重试";
  return message && message !== "[object Object]" ? message : "检查更新失败，请稍后重试";
}
