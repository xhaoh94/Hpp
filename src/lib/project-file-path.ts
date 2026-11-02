const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i;
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;

function decodeMarkdownHrefPath(href: string): string {
  const pathWithoutHash = href.split("#", 1)[0] || "";
  const pathWithoutQuery = pathWithoutHash.split("?", 1)[0] || "";
  try {
    return decodeURIComponent(pathWithoutQuery).trim();
  } catch {
    return pathWithoutQuery.trim();
  }
}

const EXTERNAL_HREF = /^https?:\/\//i;

/** `file:///C:/a/b.ts`、`file://C:/a/b.ts` 去掉 scheme 后就是普通本地路径。 */
const FILE_URI_PREFIX = /^file:\/\//i;
const DRIVE_AFTER_SLASH = /^\/[a-z]:/i;

/**
 * http(s) 是唯一有「系统浏览器」这条出路的链接。
 * 其余 href（本地路径、#锚点、mailto:、vscode: 等自定义 scheme）在 Electron 里都没有
 * 可用的默认行为：放行 target="_blank" 只会让 Electron 新开一个没有 preload 的空窗口。
 */
export function isExternalMarkdownHref(href: string | null | undefined): boolean {
  return EXTERNAL_HREF.test((href || "").trim());
}

export function getLocalMarkdownFilePath(href: string): string | null {
  const withoutScheme = decodeMarkdownHrefPath(href).replace(FILE_URI_PREFIX, "");
  // file:///C:/a 去掉 scheme 后是 /C:/a，盘符前多一个斜杠，补一刀；
  // file:///home/a 的斜杠是 POSIX 绝对路径的一部分，必须保留。
  const path = DRIVE_AFTER_SLASH.test(withoutScheme) ? withoutScheme.slice(1) : withoutScheme;
  if (!path || href.trim().startsWith("#") || path.startsWith("//")) return null;
  if (WINDOWS_ABSOLUTE_PATH.test(path) || path.startsWith("/") || path.startsWith("\\")) {
    return path;
  }
  if (URI_SCHEME.test(path)) return null;
  return path;
}

/**
 * Extract a project path rendered as inline code or a single-line code block.
 * Keep this deliberately conservative so normal source snippets do not look
 * interactive merely because they are rendered with Markdown code styling.
 */
// 以「文件名.扩展名」结尾，允许尾随 1~2 级行号/列号（`foo.ts:42:7`）。
const FILE_PATH_ENDING = /(?:^|[\\/])[^\\/]+\.[a-z\d][a-z\d._-]*(?::\d+){0,2}$/i;
const LINE_SUFFIX = /(?::\d+){1,2}$/;

export function getLocalMarkdownCodePath(value: string): string | null {
  const path = value.trim();
  if (!path || path.length > 2048 || /[\r\n]/.test(path)) return null;
  if (path.startsWith("//") || (!WINDOWS_ABSOLUTE_PATH.test(path) && URI_SCHEME.test(path))) return null;
  if (/[<>|]/.test(path)) return null;

  // 连续空白说明这段不只是路径。单行代码块会被渲染成行内代码，模型在里面写
  // `release/app.exe   18:38 更新` 时，整段当路径去点会变成「找不到文件」。
  if (/\s{2,}/.test(path)) return null;
  // 以分隔符结尾 = 目录引用；否则必须「名字.扩展名[:行号]」结尾，
  // 这样 `npm run build`、`路径后面跟了解释文字` 都不会被判成可点击路径。
  if (!/[\\/]$/.test(path) && !FILE_PATH_ENDING.test(path)) return null;

  // 行号不是文件系统的一部分，去掉了才能真正打开。
  return path.replace(LINE_SUFFIX, "");
}

export function isAbsoluteProjectFilePath(filePath: string): boolean {
  const path = filePath.trim();
  return WINDOWS_ABSOLUTE_PATH.test(path)
    || path.startsWith("/")
    || path.startsWith("\\");
}

/**
 * Convert an absolute file path to a project-relative path for display
 * purposes (e.g. remote / process file lists). Paths inside the project root
 * are relativized; absolute paths outside the project fall back to their
 * basename; already-relative paths are returned unchanged. This is the same
 * logic used when publishing process/diff data to the mobile client.
 */
export function relativeRemotePath(value: string, projectPath: string): string {
  const path = value.replace(/\\/g, "/");
  const root = projectPath.replace(/\\/g, "/").replace(/\/$/, "");
  if (path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return path.slice(root.length + 1);
  if (/^(?:[a-z]:\/|\/)/i.test(path)) return path.split("/").filter(Boolean).pop() || "file";
  return path;
}

export function resolveProjectFilePath(filePath: string, projectPath: string): string {
  const path = filePath.trim();
  if (!path || isAbsoluteProjectFilePath(path)) return path;

  const projectRoot = projectPath.trim().replace(/[\\/]+$/, "");
  if (!projectRoot) return path;

  const separator = projectRoot.includes("\\") ? "\\" : "/";
  return `${projectRoot}${separator}${path.replace(/^[.][\\/]/, "")}`;
}
