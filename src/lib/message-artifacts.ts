import type { ChatMessage } from "@/stores/chat-store";

/** 一轮对话里 Agent 真正“产出”的文件（写/改），不含只读的查看记录。 */
export type MessageArtifactKind = "image" | "document" | "file";

export interface MessageArtifact {
  /** Agent 给出的原始路径（通常是绝对路径，也可能是项目相对路径）。 */
  path: string;
  name: string;
  kind: MessageArtifactKind;
}

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;
const DOCUMENT_EXTENSION = /\.(?:html?|xhtml|pdf|mdx?|csv)$/i;

/**
 * 产物只收「做出来的成品」：安装包、压缩包、网页、图片、音视频、文档。
 *
 * 代码文件（.ts/.py/.cs/.json…）即使是被新建的，也属于“改了什么”，
 * 由 diff 面板负责，不进产物清单。
 */
const ARTIFACT_EXTENSIONS = new Set([
  // 图片
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico",
  // 网页
  "html", "htm", "xhtml",
  // 安装包 / 压缩包
  "apk", "aab", "ipa", "exe", "msi", "dmg", "appimage", "deb", "rpm", "zip", "7z", "rar", "tar", "gz", "tgz",
  // 音视频
  "mp4", "mov", "webm", "mp3", "wav", "m4a", "flac",
  // 文档 / 报告
  "pdf", "docx", "xlsx", "pptx", "csv", "md", "txt",
]);

const getExtension = (path: string) => {
  const match = /\.([a-z\d]+)$/i.exec(path);
  return match ? match[1].toLowerCase() : "";
};

const isArtifactPath = (path: string) => ARTIFACT_EXTENSIONS.has(getExtension(path));

// 只有这些动作算“产出”；read/listed 属于查看，不是产物。
const PRODUCING_ACTIONS = new Set(["written", "edited", "modified"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getFileName = (path: string) => path.split(/[/\\]/).pop() || path;

const classify = (path: string): MessageArtifactKind => {
  if (IMAGE_EXTENSION.test(path)) return "image";
  if (DOCUMENT_EXTENSION.test(path)) return "document";
  return "file";
};

type CollectEntry = {
  type?: string;
  files?: unknown[];
};

const getEntryArtifactPaths = (entry: CollectEntry): string[] => {
  // diff 条目本身就是“改了这些文件”，没有 action 字段也全部计入。
  const isDiff = entry.type === "diff";
  const paths: string[] = [];
  // 运行期拿到的 files 不一定是数组（旧数据 / 第三方后端），不能直接 for...of。
  if (!Array.isArray(entry.files)) return paths;
  for (const file of entry.files) {
    if (typeof file === "string") {
      if (isDiff && file.trim()) paths.push(file.trim());
      continue;
    }
    if (!isRecord(file) || typeof file.file !== "string") continue;
    const path = file.file.trim();
    if (!path) continue;
    const action = typeof file.action === "string" ? file.action : "";
    if (isDiff || PRODUCING_ACTIONS.has(action)) paths.push(path);
  }
  return paths;
};

/**
 * 收集一条 assistant 消息里的产物。
 *
 * 数据来自工具调用记录（process.entries）：只取写入类动作与 diff 条目，按路径
 * 去重，保持出现顺序。这样“Agent 这次产出了哪些文件”不再需要用户自己去翻
 * 处理过程或磁盘。
 */
const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

const isSamePath = (left: string, right: string) => {
  if (left === right) return true;
  // 一处可能是项目相对路径、另一处是绝对路径，用结尾匹配兜住。
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
};

/**
 * @param options.excludePaths 已经由别的 UI（如消息底部的 diff 面板）展示过的
 *   文件，这里跳过，避免同一个文件在两处各出现一次。
 */
export function collectMessageArtifacts(
  message: ChatMessage,
  options: { excludePaths?: string[] } = {},
): MessageArtifact[] {
  const entries = message.process?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const excluded = (options.excludePaths || []).map(normalizePath).filter(Boolean);
  const seen = new Set<string>();
  const artifacts: MessageArtifact[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    for (const path of getEntryArtifactPaths(entry as CollectEntry)) {
      // 代码文件不算产物：它们属于“改动”，交给 diff 面板。
      if (!isArtifactPath(path)) continue;
      const key = normalizePath(path);
      if (seen.has(key)) continue;
      if (excluded.some((candidate) => isSamePath(key, candidate))) continue;
      seen.add(key);
      artifacts.push({ path, name: getFileName(path), kind: classify(path) });
    }
  }
  return artifacts;
}
