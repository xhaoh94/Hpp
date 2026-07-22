export function normalizeFileTreePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "");
}

function normalizePathPair(path: string, directory: string): [string, string] {
  const normalizedPath = normalizeFileTreePath(path);
  const normalizedDirectory = normalizeFileTreePath(directory);
  const windowsPath = /^[a-z]:(?:\/|$)/i.test(normalizedPath)
    || /^[a-z]:(?:\/|$)/i.test(normalizedDirectory)
    || path.includes("\\")
    || directory.includes("\\");
  return windowsPath
    ? [normalizedPath.toLowerCase(), normalizedDirectory.toLowerCase()]
    : [normalizedPath, normalizedDirectory];
}

export function isSameFileTreePath(left: string, right: string): boolean {
  const [normalizedLeft, normalizedRight] = normalizePathPair(left, right);
  return normalizedLeft === normalizedRight;
}

export function isFileTreePathWithin(path: string, directory: string): boolean {
  const [normalizedPath, normalizedDirectory] = normalizePathPair(path, directory);
  if (!normalizedPath || !normalizedDirectory) return false;
  if (normalizedPath === normalizedDirectory) return true;
  const prefix = normalizedDirectory === "/" ? "/" : `${normalizedDirectory}/`;
  return normalizedPath.startsWith(prefix);
}
