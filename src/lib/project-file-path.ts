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

export function getLocalMarkdownFilePath(href: string): string | null {
  const path = decodeMarkdownHrefPath(href);
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
export function getLocalMarkdownCodePath(value: string): string | null {
  const path = value.trim();
  if (!path || path.length > 2048 || /[\r\n]/.test(path)) return null;
  if (path.startsWith("//") || (!WINDOWS_ABSOLUTE_PATH.test(path) && URI_SCHEME.test(path))) return null;

  const hasPathSeparator = /[\\/]/.test(path);
  const hasFileExtension = /(?:^|[\\/])[^\\/]+\.[a-z\d][a-z\d._-]*$/i.test(path);
  if (!hasPathSeparator && !hasFileExtension) return null;
  if (/[<>|]/.test(path)) return null;
  return path;
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
