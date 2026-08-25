import { watch, type FSWatcher } from "node:fs";
import { dirname, resolve } from "node:path";
import type { WebContents } from "electron";

export interface FileWatchResult {
  success: boolean;
  error?: string;
}

interface ActiveFileWatch {
  key: string;
  targetPath: string;
  recursive: boolean;
  watcher: FSWatcher;
}

const watchesBySender = new Map<number, Map<string, ActiveFileWatch>>();
const cleanupAttachedSenders = new Set<number>();

function normalizePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getWatchKey(targetPath: string, recursive: boolean): string {
  return `${recursive ? "recursive" : "file"}:${normalizePath(targetPath)}`;
}

function removeWatch(sender: WebContents, key: string, watch?: ActiveFileWatch): void {
  const senderWatches = watchesBySender.get(sender.id);
  const current = senderWatches?.get(key);
  if (!current || (watch && current !== watch)) return;
  current.watcher.close();
  senderWatches?.delete(key);
  if (senderWatches && senderWatches.size === 0) watchesBySender.delete(sender.id);
}

function removeAllWatches(sender: WebContents): void {
  const senderWatches = watchesBySender.get(sender.id);
  if (!senderWatches) return;
  for (const activeWatch of senderWatches.values()) activeWatch.watcher.close();
  watchesBySender.delete(sender.id);
  cleanupAttachedSenders.delete(sender.id);
}

function attachSenderCleanup(sender: WebContents): void {
  if (cleanupAttachedSenders.has(sender.id)) return;
  cleanupAttachedSenders.add(sender.id);
  sender.once("destroyed", () => removeAllWatches(sender));
}

export function startFileWatch(
  sender: WebContents,
  rawTargetPath: string,
  recursive = false,
): FileWatchResult {
  if (typeof rawTargetPath !== "string" || !rawTargetPath.trim()) {
    return { success: false, error: "Invalid watch path" };
  }

  const targetPath = resolve(rawTargetPath);
  const key = getWatchKey(targetPath, recursive);
  const senderWatches = watchesBySender.get(sender.id) || new Map<string, ActiveFileWatch>();
  if (senderWatches.has(key)) return { success: true };

  // For a single file, watch its parent directory so atomic saves (rename temp
  // file into place) are observed as well. Recursive directory watches use the
  // project root directly.
  const watchRoot = recursive ? targetPath : dirname(targetPath);
  let watcher: FSWatcher;
  try {
    watcher = watch(watchRoot, { recursive }, (eventType, filename) => {
      if (sender.isDestroyed()) {
        removeAllWatches(sender);
        return;
      }

      const filenameText = filename == null ? "" : filename.toString();
      const changedPath = filenameText ? resolve(watchRoot, filenameText) : targetPath;
      if (!recursive && normalizePath(changedPath) !== normalizePath(targetPath)) return;

      try {
        sender.send("fs:change", {
          path: changedPath,
          eventType,
        });
      } catch {
        // The renderer can disappear between isDestroyed() and send().
      }
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  const activeWatch: ActiveFileWatch = { key, targetPath, recursive, watcher };
  senderWatches.set(key, activeWatch);
  watchesBySender.set(sender.id, senderWatches);
  attachSenderCleanup(sender);

  watcher.on("error", () => {
    // Do not leave a dead watcher in the registry. The renderer can retry when
    // its visibility/project lifecycle changes.
    removeWatch(sender, key, activeWatch);
  });

  return { success: true };
}

export function stopFileWatch(
  sender: WebContents,
  rawTargetPath: string,
  recursive = false,
): FileWatchResult {
  if (typeof rawTargetPath !== "string" || !rawTargetPath.trim()) {
    return { success: false, error: "Invalid watch path" };
  }
  removeWatch(sender, getWatchKey(rawTargetPath, recursive));
  return { success: true };
}
