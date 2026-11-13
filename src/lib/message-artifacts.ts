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
const DOCUMENT_EXTENSION = /\.(?:html?|xhtml|pdf|mdx?|csv|docx?|xlsx?|pptx?)$/i;

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
  // 文档 / 报告（含 doc/xls/ppt 老格式）
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "md", "txt",
]);

/**
 * 系统临时目录：写在这里的都是中间脚本 / 调试截图，不是交付物。
 * 归一化后按小写匹配，Windows 的 %TEMP% 与 POSIX 的 /tmp 都要盖住。
 */
const TEMP_PATH_PATTERNS = [
  /^\/tmp\//,
  /^\/var\/tmp\//,
  /^\/private\/tmp\//,
  /^\/private\/var\/folders\//,
  /^\/run\/user\//,
  /\/appdata\/local\/temp\//,
];

/** 依赖与缓存目录：写进去的是工具产出，不该冒充用户交付物。 */
const JUNK_DIRECTORIES = new Set([
  "node_modules", ".git", ".cache", "__pycache__", ".venv", "venv",
  ".next", ".nuxt", ".turbo", "coverage", ".parcel-cache", ".vite",
]);

const getExtension = (path: string) => {
  const match = /\.([a-z\d]+)$/i.exec(path);
  return match ? match[1].toLowerCase() : "";
};

/** 与 normalizePath 分开：这里要保留真实大小写语义，只统一分隔符与重复斜杠。 */
const normalizeLocation = (value: string) =>
  value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "").toLowerCase();

const isScratchLocation = (path: string, workspacePath?: string) => {
  const normalized = normalizeLocation(path);
  if (!normalized) return true;
  if (TEMP_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => JUNK_DIRECTORIES.has(segment))) return true;
  // 工作区根下的 tmp/.tmp 是仓库自己的草稿区（.gitignore 里也这么写），
  // 同名目录在别处不管——那是工作区外的成品，用户可能就是要存那儿。
  const root = workspacePath ? normalizeLocation(workspacePath) : "";
  if (!root || !normalized.startsWith(`${root}/`)) return false;
  const firstSegment = normalized.slice(root.length + 1).split("/")[0];
  return firstSegment === "tmp" || firstSegment === ".tmp";
};

const isArtifactPath = (path: string, workspacePath?: string) =>
  ARTIFACT_EXTENSIONS.has(getExtension(path)) && !isScratchLocation(path, workspacePath);

// 只有这些动作算“产出”；read/listed 属于查看，不是产物。
const PRODUCING_ACTIONS = new Set(["written", "edited", "modified"]);
const DELETING_ACTIONS = new Set(["deleted", "removed"]);

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

const getEntryFileAction = (file: Record<string, unknown>) => {
  const action = typeof file.action === "string" ? file.action : "";
  const status = typeof file.status === "string" ? file.status : "";
  return DELETING_ACTIONS.has(action) || status === "deleted" ? "deleted" : action;
};

/** 本次会话里被删掉的文件：写过后又删的不能算产物。 */
const getEntryDeletedPaths = (entry: CollectEntry): string[] => {
  if (!Array.isArray(entry.files)) return [];
  const paths: string[] = [];
  for (const file of entry.files) {
    if (!isRecord(file) || typeof file.file !== "string") continue;
    const path = file.file.trim();
    if (path && getEntryFileAction(file) === "deleted") paths.push(path);
  }
  return paths;
};

/** 产物候选：presented 来自模型的显式声明，不过扩展名/位置过滤。 */
type CollectPath = {
  path: string;
  presented: boolean;
};

const getEntryArtifactPaths = (entry: CollectEntry): CollectPath[] => {
  // diff 条目本身就是“改了这些文件”，没有 action 字段也全部计入。
  const isDiff = entry.type === "diff";
  const paths: CollectPath[] = [];
  // 运行期拿到的 files 不一定是数组（旧数据 / 第三方后端），不能直接 for...of。
  if (!Array.isArray(entry.files)) return paths;
  for (const file of entry.files) {
    if (typeof file === "string") {
      if (isDiff && file.trim()) paths.push({ path: file.trim(), presented: false });
      continue;
    }
    if (!isRecord(file) || typeof file.file !== "string") continue;
    const path = file.file.trim();
    if (!path) continue;
    const action = getEntryFileAction(file);
    if (action === "deleted") continue;
    if (action === "presented") {
      paths.push({ path, presented: true });
      continue;
    }
    if (isDiff || PRODUCING_ACTIONS.has(action)) paths.push({ path, presented: false });
  }
  return paths;
};

const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

const isSamePath = (left: string, right: string) => {
  if (left === right) return true;
  // 一处可能是项目相对路径、另一处是绝对路径，用结尾匹配兜住。
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
};

/**
 * 收集一条 assistant 消息里的产物。
 *
 * 数据来自工具调用记录（process.entries）：只取写入类动作与 diff 条目，按路径
 * 去重，保持出现顺序。除扩展名外还要过一遍位置——系统临时目录、依赖/缓存目录、
 * 工作区自带的 tmp/.tmp 都是中间产物，不是交付物。
 *
 * @param options.excludePaths 已经由别的 UI（如消息底部的 diff 面板）展示过的
 *   文件，这里跳过，避免同一个文件在两处各出现一次。
 * @param options.workspacePath 当前项目根目录，用来识别工作区内的草稿目录；
 *   缺省时只按系统临时目录与依赖目录过滤。
 */
export function collectMessageArtifacts(
  message: ChatMessage,
  options: { excludePaths?: string[]; workspacePath?: string } = {},
): MessageArtifact[] {
  const entries = message.process?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const excluded = (options.excludePaths || []).map(normalizePath).filter(Boolean);
  const deleted = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    for (const path of getEntryDeletedPaths(entry as CollectEntry)) {
      deleted.add(normalizePath(path));
    }
  }

  const seen = new Set<string>();
  const artifacts: MessageArtifact[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    for (const item of getEntryArtifactPaths(entry as CollectEntry)) {
      // 代码文件不算产物：它们属于“改动”，交给 diff 面板。
      // 模型显式声明的不受这条限制——它说了这是交付物就按交付物算。
      if (!item.presented && !isArtifactPath(item.path, options.workspacePath)) continue;
      const key = normalizePath(item.path);
      if (seen.has(key) || deleted.has(key)) continue;
      if (excluded.some((candidate) => isSamePath(key, candidate))) continue;
      seen.add(key);
      artifacts.push({ path: item.path, name: getFileName(item.path), kind: classify(item.path) });
    }
  }
  return artifacts;
}
