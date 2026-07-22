import { rankFileSearchItemsAsync } from "@/lib/file-search-ranking";
import type { FileEntry } from "@/types";
import { getFileFilterKey, normalizeFileFilters, type FileFilterConfig } from "@shared/file-filters";

export const PROJECT_FILE_INDEX_TTL_MS = 60_000;
export const PROJECT_FILE_INDEX_CACHE_LIMIT = 4;
export const PROJECT_FILE_QUERY_CACHE_LIMIT = 100;
export const PROJECT_FILE_QUERY_LIMIT = 50;

const LEGACY_INDEX_MAX_DEPTH = 16;
const LEGACY_INDEX_READ_CONCURRENCY = 8;

export interface ProjectFileIndexItem {
  name: string;
  path: string;
  isDirectory: boolean;
  normalizedName?: string;
  normalizedPath?: string;
}

export interface ProjectFileIndexQuery {
  projectPath: string;
  filters: FileFilterConfig;
  query?: string;
  limit?: number;
  includeDirectories?: boolean;
  signal?: AbortSignal;
}

interface ProjectFileIndexCacheEntry {
  filterKey: string;
  filters: FileFilterConfig;
  pending: Promise<readonly ProjectFileIndexItem[]> | null;
  projectPath: string;
  settledAt: number;
  value: readonly ProjectFileIndexItem[] | null;
}

const indexCache = new Map<string, ProjectFileIndexCacheEntry>();
const queryCache = new WeakMap<
  readonly ProjectFileIndexItem[],
  Map<string, ProjectFileIndexItem[]>
>();

function getComparableProjectPath(projectPath: string): string {
  return window.electronAPI.platform === "win32"
    ? projectPath.toLowerCase()
    : projectPath;
}

function createCacheKey(projectPath: string, filterKey: string): string {
  return JSON.stringify([getComparableProjectPath(projectPath), filterKey]);
}

function touchCacheEntry(cacheKey: string, entry: ProjectFileIndexCacheEntry) {
  indexCache.delete(cacheKey);
  indexCache.set(cacheKey, entry);
}

function trimIndexCache() {
  while (indexCache.size > PROJECT_FILE_INDEX_CACHE_LIMIT) {
    const oldestKey = indexCache.keys().next().value;
    if (oldestKey === undefined) return;
    indexCache.delete(oldestKey);
  }
}

function isMissingIndexHandlerError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("No handler registered for 'fs:indexProjectFiles'");
}

async function collectLegacyProjectFileIndex(
  projectPath: string,
  filters: FileFilterConfig,
): Promise<FileEntry[]> {
  interface DirectoryTask {
    depth: number;
    path: string;
  }

  const indexedEntries: FileEntry[] = [];
  let directories: DirectoryTask[] = [{ depth: 0, path: projectPath }];
  while (directories.length > 0) {
    const nextDirectories: DirectoryTask[] = [];
    for (let offset = 0; offset < directories.length; offset += LEGACY_INDEX_READ_CONCURRENCY) {
      const batch = directories.slice(offset, offset + LEGACY_INDEX_READ_CONCURRENCY);
      const listings = await Promise.all(batch.map(async (directory) => {
        try {
          return {
            directory,
            entries: await window.electronAPI.readDirectory(directory.path, filters),
          };
        } catch {
          return { directory, entries: [] as FileEntry[] };
        }
      }));

      for (const { directory, entries } of listings) {
        for (const fileEntry of entries) {
          indexedEntries.push(fileEntry);
          if (fileEntry.type === "folder" && directory.depth < LEGACY_INDEX_MAX_DEPTH) {
            nextDirectories.push({ depth: directory.depth + 1, path: fileEntry.path });
          }
        }
      }
    }
    directories = nextDirectories;
  }
  return indexedEntries;
}

async function requestProjectFileIndex(
  projectPath: string,
  filters: FileFilterConfig,
) {
  const indexProjectFiles = window.electronAPI.indexProjectFiles;
  if (typeof indexProjectFiles === "function") {
    try {
      return await indexProjectFiles(projectPath, filters);
    } catch (error) {
      if (!isMissingIndexHandlerError(error)) throw error;
    }
  }
  return collectLegacyProjectFileIndex(projectPath, filters);
}

function loadProjectFileIndex(
  cacheKey: string,
  entry: ProjectFileIndexCacheEntry,
): Promise<readonly ProjectFileIndexItem[]> {
  if (entry.pending) return entry.pending;

  const pending = requestProjectFileIndex(entry.projectPath, entry.filters)
    .then((entries) => entries.map((fileEntry) => ({
      name: fileEntry.name,
      path: fileEntry.path,
      isDirectory: fileEntry.type === "folder",
    })))
    .then((index) => {
      if (indexCache.get(cacheKey) === entry) {
        entry.value = index;
        entry.settledAt = Date.now();
      }
      return index;
    })
    .catch((error) => {
      if (indexCache.get(cacheKey) === entry) {
        if (entry.value) {
          entry.settledAt = Date.now();
          return entry.value;
        }
        indexCache.delete(cacheKey);
      }
      throw error;
    })
    .finally(() => {
      if (entry.pending === pending) entry.pending = null;
    });

  entry.pending = pending;
  return pending;
}

export function getProjectFileIndex(
  projectPath: string,
  filters: FileFilterConfig,
): Promise<readonly ProjectFileIndexItem[]> {
  const normalizedProjectPath = projectPath.trim();
  if (!normalizedProjectPath) return Promise.resolve([]);

  const normalizedFilters = normalizeFileFilters(filters);
  const filterKey = getFileFilterKey(normalizedFilters);
  const cacheKey = createCacheKey(normalizedProjectPath, filterKey);
  const cached = indexCache.get(cacheKey);
  if (cached) {
    touchCacheEntry(cacheKey, cached);
    if (cached.value) {
      if (Date.now() - cached.settledAt >= PROJECT_FILE_INDEX_TTL_MS && !cached.pending) {
        void loadProjectFileIndex(cacheKey, cached).catch(() => undefined);
      }
      return Promise.resolve(cached.value);
    }
    return loadProjectFileIndex(cacheKey, cached);
  }

  const entry: ProjectFileIndexCacheEntry = {
    filterKey,
    filters: normalizedFilters,
    pending: null,
    projectPath: normalizedProjectPath,
    settledAt: 0,
    value: null,
  };
  indexCache.set(cacheKey, entry);
  trimIndexCache();
  return loadProjectFileIndex(cacheKey, entry);
}

function getCachedQueryResults(
  index: readonly ProjectFileIndexItem[],
  queryKey: string,
): ProjectFileIndexItem[] | undefined {
  const cachedQueries = queryCache.get(index);
  const cached = cachedQueries?.get(queryKey);
  if (!cached || !cachedQueries) return undefined;
  cachedQueries.delete(queryKey);
  cachedQueries.set(queryKey, cached);
  return cached;
}

function cacheQueryResults(
  index: readonly ProjectFileIndexItem[],
  queryKey: string,
  results: ProjectFileIndexItem[],
) {
  let cachedQueries = queryCache.get(index);
  if (!cachedQueries) {
    cachedQueries = new Map();
    queryCache.set(index, cachedQueries);
  }
  cachedQueries.set(queryKey, results);
  while (cachedQueries.size > PROJECT_FILE_QUERY_CACHE_LIMIT) {
    const oldestKey = cachedQueries.keys().next().value;
    if (oldestKey === undefined) break;
    cachedQueries.delete(oldestKey);
  }
}

export async function queryProjectFileIndex({
  projectPath,
  filters,
  query = "",
  limit = PROJECT_FILE_QUERY_LIMIT,
  includeDirectories = true,
  signal,
}: ProjectFileIndexQuery): Promise<ProjectFileIndexItem[]> {
  if (signal?.aborted) return [];
  const index = await getProjectFileIndex(projectPath, filters);
  if (signal?.aborted) return [];

  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];
  const normalizedQuery = query.trim().toLowerCase();
  const queryKey = JSON.stringify([normalizedQuery, boundedLimit, includeDirectories]);
  const cached = getCachedQueryResults(index, queryKey);
  if (cached) return cached;

  const candidates = includeDirectories
    ? index
    : index.filter((item) => !item.isDirectory);
  const results = normalizedQuery
    ? await rankFileSearchItemsAsync(candidates, normalizedQuery, boundedLimit, { signal })
    : candidates.slice(0, boundedLimit);
  if (signal?.aborted) return [];
  cacheQueryResults(index, queryKey, results);
  return results;
}

export function invalidateProjectFileIndex(
  projectPath?: string,
  filters?: FileFilterConfig,
): void {
  if (projectPath === undefined) {
    indexCache.clear();
    return;
  }

  const normalizedProjectPath = projectPath.trim();
  const comparableProjectPath = getComparableProjectPath(normalizedProjectPath);
  const filterKey = filters ? getFileFilterKey(normalizeFileFilters(filters)) : null;
  for (const [cacheKey, entry] of indexCache) {
    if (getComparableProjectPath(entry.projectPath) !== comparableProjectPath) continue;
    if (filterKey !== null && entry.filterKey !== filterKey) continue;
    indexCache.delete(cacheKey);
  }
}
