import { ipcMain } from "electron";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { app } from "electron";

const dataDir = join(app.getPath("userData"), "hpp-data");
const COMPACT_JSON_KEYS = new Set(["sessionMessages"]);

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
      const filePath = join(dataDir, `${key}.json`);
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
        const filePath = join(dataDir, `${key}.json`);
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
