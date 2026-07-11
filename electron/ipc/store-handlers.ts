import { ipcMain } from "electron";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { app } from "electron";

const dataDir = join(app.getPath("userData"), "hpp-data");
const COMPACT_JSON_KEYS = new Set(["sessionMessages"]);
const ALLOWED_STORE_KEYS = new Set(["settings", "projects", "sessionMessages", "currentModel"]);

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

export function registerStoreHandlers() {
  ipcMain.handle("store:load", async (_event, key: string) => {
    try {
      await ensureDataDir();
      const filePath = getStoreFilePath(key);
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content);
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
        await writeFile(filePath, json, "utf-8");
        return { success: true };
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}
