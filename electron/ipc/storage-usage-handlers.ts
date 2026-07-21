import { ipcMain, app, session as electronSession } from "electron";
import { readdir, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import type { DiskCleanupResult, DiskUsageCategory, DiskUsageCategoryId, DiskUsageStats } from "../../src/types/ipc";

const CATEGORY_ORDER: DiskUsageCategoryId[] = [
  "conversations",
  "configuration",
  "agentPlugins",
  "agentRuntimes",
  "browserCache",
  "browserStorage",
  "other",
];

const BROWSER_CACHE_DIRS = new Set([
  "cache",
  "code cache",
  "gpucache",
  "dawncache",
  "dawngraphitecache",
  "dawnwebgpucache",
  "grshadercache",
  "shadercache",
]);

const BROWSER_STORAGE_DIRS = new Set([
  "blob_storage",
  "databases",
  "indexeddb",
  "local storage",
  "network",
  "session storage",
  "shared dictionary",
  "webstorage",
]);

const CLEARABLE_BROWSER_CACHE_DIRS = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
];

const HPP_TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;
const CODEX_IMAGE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const classifyFile = (root: string, filePath: string): DiskUsageCategoryId => {
  const parts = relative(root, filePath).split(sep).map((part) => part.toLowerCase());
  const top = parts[0] || "";
  if (top === "hpp-data") {
    const name = parts[1] || "";
    if (
      name.startsWith("sessionmessages.json") ||
      name.startsWith("projects.json") ||
      name.startsWith("currentmodel.json")
    ) {
      return "conversations";
    }
    if (name === "agent-plugins") return "agentPlugins";
    if (
      name === "agent-runtimes" ||
      name === "pi-sdk-runtime" ||
      name === "claude-agent-sdk-runtime" ||
      name.endsWith("-runtime")
    ) {
      return "agentRuntimes";
    }
    return "configuration";
  }
  if (BROWSER_CACHE_DIRS.has(top)) return "browserCache";
  if (BROWSER_STORAGE_DIRS.has(top) || top === "cookies" || top === "preferences") return "browserStorage";
  return "other";
};

export async function collectDiskUsage(dataPath: string): Promise<DiskUsageStats> {
  const buckets = new Map<DiskUsageCategoryId, DiskUsageCategory>(
    CATEGORY_ORDER.map((id) => [id, { id, sizeBytes: 0, fileCount: 0 }]),
  );
  const directories = [dataPath];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(target);
        const bucket = buckets.get(classifyFile(dataPath, target))!;
        bucket.sizeBytes += info.size;
        bucket.fileCount += 1;
      } catch {
        // Files may disappear while caches are being refreshed.
      }
    }
  }
  const categories = CATEGORY_ORDER.map((id) => buckets.get(id)!).filter((category) => category.fileCount > 0);
  return {
    totalSizeBytes: categories.reduce((total, category) => total + category.sizeBytes, 0),
    totalFileCount: categories.reduce((total, category) => total + category.fileCount, 0),
    dataPath,
    categories,
    measuredAt: Date.now(),
  };
}

async function measureTree(targetPath: string) {
  let sizeBytes = 0;
  let fileCount = 0;
  const directories = [targetPath];
  while (directories.length > 0) {
    let entries: Dirent[];
    const directory = directories.pop()!;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
      } else if (entry.isFile()) {
        try {
          sizeBytes += (await stat(path)).size;
          fileCount += 1;
        } catch {
          // Ignore files removed during measurement.
        }
      }
    }
  }
  return { sizeBytes, fileCount };
}

const inferRuntimeOwnerId = (directoryName: string) => {
  const name = directoryName.toLowerCase();
  for (const suffix of ["-agent-sdk-runtime", "-sdk-runtime", "-runtime"]) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return "";
};

async function removeOrphanedAgentRuntimes(dataPath: string) {
  const hppDataPath = join(dataPath, "hpp-data");
  const pluginPath = join(hppDataPath, "agent-plugins");
  let installedPluginEntries: Dirent[] = [];
  let dataEntries: Dirent[] = [];
  try {
    installedPluginEntries = await readdir(pluginPath, { withFileTypes: true });
  } catch {
    // No installed plugins means every managed runtime is orphaned.
  }
  try {
    dataEntries = await readdir(hppDataPath, { withFileTypes: true });
  } catch {
    return { sizeBytes: 0, fileCount: 0 };
  }

  const installedPluginIds = new Set(
    installedPluginEntries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name.toLowerCase()),
  );
  let sizeBytes = 0;
  let fileCount = 0;
  for (const entry of dataEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const lowerName = entry.name.toLowerCase();
    const isLegacyRuntime = lowerName === "agent-runtimes";
    const ownerId = inferRuntimeOwnerId(lowerName);
    if (!isLegacyRuntime && (!ownerId || installedPluginIds.has(ownerId))) continue;

    const runtimePath = join(hppDataPath, entry.name);
    const measured = await measureTree(runtimePath);
    try {
      await rm(runtimePath, { recursive: true, force: true });
      sizeBytes += measured.sizeBytes;
      fileCount += measured.fileCount;
    } catch {
      // A still-running process may keep individual runtime files locked.
    }
  }
  return { sizeBytes, fileCount };
}

async function removeStaleTempFiles(root: string, cutoff: number) {
  let sizeBytes = 0;
  let fileCount = 0;
  const directories = [root];
  while (directories.length > 0) {
    let entries: Dirent[];
    const directory = directories.pop()!;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".tmp")) continue;
      try {
        const info = await stat(path);
        if (info.mtimeMs > cutoff) continue;
        await rm(path, { force: true });
        sizeBytes += info.size;
        fileCount += 1;
      } catch {
        // Locked or concurrently replaced files are still active.
      }
    }
  }
  return { sizeBytes, fileCount };
}

async function removeStaleCodexImageDirs(temporaryRoot: string, cutoff: number) {
  let sizeBytes = 0;
  let fileCount = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(temporaryRoot, { withFileTypes: true });
  } catch {
    return { sizeBytes, fileCount };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("hpp-codex-images-")) continue;
    const path = join(temporaryRoot, entry.name);
    try {
      if ((await stat(path)).mtimeMs > cutoff) continue;
      const measured = await measureTree(path);
      await rm(path, { recursive: true, force: true });
      sizeBytes += measured.sizeBytes;
      fileCount += measured.fileCount;
    } catch {
      // Active image directories may still be locked by Codex.
    }
  }
  return { sizeBytes, fileCount };
}

export async function cleanupDiskData(
  dataPath: string,
  options: {
    clearBrowserCache?: () => Promise<void>;
    temporaryRoot?: string;
    now?: number;
  } = {},
): Promise<DiskCleanupResult> {
  const now = options.now ?? Date.now();
  const before = await collectDiskUsage(dataPath);
  await options.clearBrowserCache?.().catch(() => undefined);
  let removedFileCount = 0;
  let extraReclaimedBytes = 0;

  for (const directory of CLEARABLE_BROWSER_CACHE_DIRS) {
    const path = join(dataPath, directory);
    const measured = await measureTree(path);
    try {
      await rm(path, { recursive: true, force: true });
      removedFileCount += measured.fileCount;
    } catch {
      // Chromium can keep individual cache files locked until restart.
    }
  }

  const orphanedRuntimes = await removeOrphanedAgentRuntimes(dataPath);
  removedFileCount += orphanedRuntimes.fileCount;

  const staleFiles = await removeStaleTempFiles(
    join(dataPath, "hpp-data"),
    now - HPP_TEMP_FILE_MAX_AGE_MS,
  );
  removedFileCount += staleFiles.fileCount;

  const staleImages = await removeStaleCodexImageDirs(
    options.temporaryRoot || tmpdir(),
    now - CODEX_IMAGE_TEMP_MAX_AGE_MS,
  );
  removedFileCount += staleImages.fileCount;
  extraReclaimedBytes += staleImages.sizeBytes;

  const stats = await collectDiskUsage(dataPath);
  return {
    reclaimedBytes: Math.max(0, before.totalSizeBytes - stats.totalSizeBytes) + extraReclaimedBytes,
    removedFileCount,
    stats,
  };
}

export function registerStorageUsageHandlers() {
  ipcMain.handle("storage:getUsage", async () => collectDiskUsage(app.getPath("userData")));
  ipcMain.handle("storage:cleanup", async () => cleanupDiskData(app.getPath("userData"), {
    clearBrowserCache: () => electronSession.defaultSession.clearCache(),
  }));
}
