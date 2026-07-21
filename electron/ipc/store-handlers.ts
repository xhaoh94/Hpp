import { ipcMain } from "electron";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { join } from "path";
import { app } from "electron";
import type { SessionDataPurgeRequest } from "../../src/types/ipc";

const dataDir = join(app.getPath("userData"), "hpp-data");
const COMPACT_JSON_KEYS = new Set(["sessionMessages"]);
const ALLOWED_STORE_KEYS = new Set(["settings", "projects", "sessionMessages", "currentModel"]);
const storeWriteQueues = new Map<string, Promise<void>>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const normalizeIds = (value: unknown) => new Set(
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim())
    : [],
);

function getStoreFilePath(key: unknown): string {
  if (typeof key !== "string" || !ALLOWED_STORE_KEYS.has(key)) {
    throw new Error("Invalid data store key.");
  }
  return join(dataDir, `${key}.json`);
}

async function ensureDataDir() {
  try {
    await mkdir(dataDir, { recursive: true });
  } catch {
    // Already exists
  }
}

async function readStoreFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return JSON.parse(await readFile(`${filePath}.bak`, "utf-8"));
  }
}

async function writeStoreFile(filePath: string, json: string): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  const backupPath = `${filePath}.bak`;
  await writeFile(tempPath, json, "utf-8");
  try {
    try {
      await copyFile(filePath, backupPath);
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function pruneRecord(
  value: unknown,
  removedSessionIds: Set<string>,
  validSessionIds?: Set<string>,
) {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([sessionId]) =>
    !removedSessionIds.has(sessionId) && (!validSessionIds || validSessionIds.has(sessionId))
  ));
}

export function pruneSessionStoreData(key: string, value: unknown, request: SessionDataPurgeRequest): unknown {
  if (!isRecord(value)) return value;
  const removedSessionIds = normalizeIds(request.sessionIds);
  const removedProjectIds = normalizeIds(request.projectIds);
  const validSessionIds = Array.isArray(request.validSessionIds)
    ? normalizeIds(request.validSessionIds)
    : undefined;
  const validProjectIds = Array.isArray(request.validProjectIds)
    ? normalizeIds(request.validProjectIds)
    : undefined;

  if (key === "sessionMessages") {
    return {
      ...value,
      sessionMessages: pruneRecord(value.sessionMessages, removedSessionIds, validSessionIds),
    };
  }
  if (key === "currentModel") {
    return {
      ...value,
      models: pruneRecord(value.models, removedSessionIds, validSessionIds),
      thinkingLevels: pruneRecord(value.thinkingLevels, removedSessionIds, validSessionIds),
    };
  }
  if (key === "projects" && Array.isArray(value.projects)) {
    const projects = value.projects.flatMap((item): unknown[] => {
      if (
        !isRecord(item) ||
        typeof item.id !== "string" ||
        removedProjectIds.has(item.id) ||
        (validProjectIds && !validProjectIds.has(item.id))
      ) return [];
      const sessions = Array.isArray(item.sessions)
        ? item.sessions.filter((session) =>
            !isRecord(session) || typeof session.id !== "string" || (
              !removedSessionIds.has(session.id) && (!validSessionIds || validSessionIds.has(session.id))
            )
          )
        : item.sessions;
      return [{ ...item, sessions }];
    });
    return {
      ...value,
      projects,
      activeProjectId: typeof value.activeProjectId === "string" && (
        removedProjectIds.has(value.activeProjectId) || (validProjectIds && !validProjectIds.has(value.activeProjectId))
      )
        ? null
        : value.activeProjectId,
      activeSessionId: typeof value.activeSessionId === "string" && (
        removedSessionIds.has(value.activeSessionId) || (validSessionIds && !validSessionIds.has(value.activeSessionId))
      )
        ? null
        : value.activeSessionId,
    };
  }
  return value;
}

async function replaceStoreCopy(filePath: string, key: string, request: SessionDataPurgeRequest) {
  let current: unknown;
  try {
    current = JSON.parse(await readFile(filePath, "utf-8"));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    await rm(filePath, { force: true });
    return;
  }
  const json = COMPACT_JSON_KEYS.has(key)
    ? JSON.stringify(pruneSessionStoreData(key, current, request))
    : JSON.stringify(pruneSessionStoreData(key, current, request), null, 2);
  const tempPath = `${filePath}.purge.tmp`;
  await writeFile(tempPath, json, "utf-8");
  try {
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function purgeSessionStore(request: SessionDataPurgeRequest) {
  const sessionIds = normalizeIds(request.sessionIds);
  const projectIds = normalizeIds(request.projectIds);
  const hasValidSessionIds = Array.isArray(request.validSessionIds);
  const hasValidProjectIds = Array.isArray(request.validProjectIds);
  if (sessionIds.size === 0 && projectIds.size === 0 && !hasValidSessionIds && !hasValidProjectIds) {
    throw new Error("No session data cleanup criteria provided.");
  }
  const normalizedRequest: SessionDataPurgeRequest = {
    sessionIds: [...sessionIds],
    projectIds: [...projectIds],
    ...(hasValidSessionIds ? { validSessionIds: [...normalizeIds(request.validSessionIds)] } : {}),
    ...(hasValidProjectIds ? { validProjectIds: [...normalizeIds(request.validProjectIds)] } : {}),
  };
  await ensureDataDir();
  await Promise.all(["projects", "sessionMessages", "currentModel"].map((key) =>
    queueStoreWrite(key, async () => {
      const filePath = getStoreFilePath(key);
      await replaceStoreCopy(filePath, key, normalizedRequest);
      await replaceStoreCopy(`${filePath}.bak`, key, normalizedRequest);
    })
  ));
}

async function queueStoreWrite(key: string, write: () => Promise<void>): Promise<void> {
  const previous = storeWriteQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(write);
  storeWriteQueues.set(key, current);
  try {
    await current;
  } finally {
    if (storeWriteQueues.get(key) === current) storeWriteQueues.delete(key);
  }
}

export function registerStoreHandlers() {
  ipcMain.handle("store:load", async (_event, key: string) => {
    try {
      await ensureDataDir();
      const filePath = getStoreFilePath(key);
      return await readStoreFile(filePath);
    } catch {
      return null;
    }
  });

  ipcMain.handle(
    "store:save",
    async (_event, key: string, data: unknown) => {
      try {
        await ensureDataDir();
        const filePath = getStoreFilePath(key);
        const json = COMPACT_JSON_KEYS.has(key)
          ? JSON.stringify(data)
          : JSON.stringify(data, null, 2);
        await queueStoreWrite(key, () => writeStoreFile(filePath, json));
        return { success: true };
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  ipcMain.handle("store:purgeSessions", async (_event, request: SessionDataPurgeRequest) => {
    try {
      await purgeSessionStore(request || {});
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
