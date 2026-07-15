import { ipcMain } from "electron";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { join } from "path";
import { app } from "electron";

const dataDir = join(app.getPath("userData"), "hpp-data");
const COMPACT_JSON_KEYS = new Set(["sessionMessages"]);
const ALLOWED_STORE_KEYS = new Set(["settings", "projects", "sessionMessages", "currentModel"]);
const storeWriteQueues = new Map<string, Promise<void>>();

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
}
