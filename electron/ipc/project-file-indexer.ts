import { readdir } from "fs/promises";
import { join } from "path";
import {
  normalizeFileFilters,
  type FileFilterConfig,
} from "../../shared/file-filters";

export const PROJECT_FILE_INDEX_MAX_DEPTH = 16;
export const PROJECT_FILE_INDEX_READ_CONCURRENCY = 16;

export interface IndexedProjectFileEntry {
  name: string;
  path: string;
  type: "file" | "folder";
}

interface DirectoryEntryLike {
  name: string;
  isDirectory: () => boolean;
}

type DirectoryReader = (dirPath: string) => Promise<DirectoryEntryLike[]>;

interface ProjectFileIndexerOptions {
  concurrency?: number;
  maxDepth?: number;
  readDirectory?: DirectoryReader;
}

interface DirectoryTask {
  depth: number;
  path: string;
}

const defaultDirectoryReader: DirectoryReader = async (dirPath) => (
  readdir(dirPath, { withFileTypes: true })
);

function createEntryExcluder(filters: FileFilterConfig) {
  const excludedFolders = new Set(filters.excludeFolders.map((rule) => rule.toLowerCase()));
  const excludedFiles = new Set(filters.excludeFiles.map((rule) => rule.toLowerCase()));
  const excludedExtensions = filters.excludeExtensions.map((rule) => rule.toLowerCase());

  return (name: string, isDirectory: boolean) => {
    const normalizedName = name.toLowerCase();
    if (isDirectory) return excludedFolders.has(normalizedName);
    if (excludedFiles.has(normalizedName)) return true;
    return excludedExtensions.some((extension) => normalizedName.endsWith(extension));
  };
}

function sortDirectoryEntries(left: DirectoryEntryLike, right: DirectoryEntryLike) {
  const leftDirectory = left.isDirectory();
  const rightDirectory = right.isDirectory();
  if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
  return left.name.localeCompare(right.name);
}

export async function collectProjectFileIndex(
  projectPath: string,
  rawFilters: unknown,
  options: ProjectFileIndexerOptions = {},
): Promise<IndexedProjectFileEntry[]> {
  const normalizedProjectPath = projectPath.trim();
  if (!normalizedProjectPath) return [];

  const requestedConcurrency = options.concurrency ?? PROJECT_FILE_INDEX_READ_CONCURRENCY;
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.floor(requestedConcurrency))
    : PROJECT_FILE_INDEX_READ_CONCURRENCY;
  const requestedMaxDepth = options.maxDepth ?? PROJECT_FILE_INDEX_MAX_DEPTH;
  const maxDepth = Number.isFinite(requestedMaxDepth)
    ? Math.max(0, Math.floor(requestedMaxDepth))
    : PROJECT_FILE_INDEX_MAX_DEPTH;
  const readDirectory = options.readDirectory ?? defaultDirectoryReader;
  const isExcluded = createEntryExcluder(normalizeFileFilters(rawFilters));
  const indexedEntries: IndexedProjectFileEntry[] = [];
  let directories: DirectoryTask[] = [{ depth: 0, path: normalizedProjectPath }];

  while (directories.length > 0) {
    const nextDirectories: DirectoryTask[] = [];

    for (let offset = 0; offset < directories.length; offset += concurrency) {
      const batch = directories.slice(offset, offset + concurrency);
      const listings = await Promise.all(batch.map(async (directory) => {
        try {
          const entries = await readDirectory(directory.path);
          return { directory, entries: entries.sort(sortDirectoryEntries) };
        } catch (error) {
          if (directory.depth === 0) throw error;
          return { directory, entries: [] as DirectoryEntryLike[] };
        }
      }));

      for (const { directory, entries } of listings) {
        for (const entry of entries) {
          const isDirectory = entry.isDirectory();
          if (isExcluded(entry.name, isDirectory)) continue;

          const entryPath = join(directory.path, entry.name);
          indexedEntries.push({
            name: entry.name,
            path: entryPath,
            type: isDirectory ? "folder" : "file",
          });
          if (isDirectory && directory.depth < maxDepth) {
            nextDirectories.push({ depth: directory.depth + 1, path: entryPath });
          }
        }
      }
    }

    directories = nextDirectories;
  }

  return indexedEntries;
}
