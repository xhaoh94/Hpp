import { ipcMain, dialog, BrowserWindow } from "electron";
import { readdir, readFile, stat, access } from "fs/promises";
import { join, extname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: FileEntry[];
}

export function registerFileHandlers() {
  ipcMain.handle("fs:readDirectory", async (_event, dirPath: string) => {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const result: FileEntry[] = [];

      for (const entry of entries) {
        // Skip hidden files and common large directories
        if (entry.name.startsWith(".")) continue;

        const fullPath = join(dirPath, entry.name);
        const entryData: FileEntry = {
          name: entry.name,
          path: fullPath,
          type: entry.isDirectory() ? "folder" : "file",
        };

        if (entry.isDirectory()) {
          entryData.children = []; // Lazy load on expand
        }

        result.push(entryData);
      }

      // Sort: folders first, then files
      result.sort((a, b) => {
        if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return result;
    } catch (err) {
      return [];
    }
  });

  ipcMain.handle("fs:readFile", async (_event, filePath: string) => {
    try {
      const content = await readFile(filePath, "utf-8");
      return { success: true, content };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("fs:fileExists", async (_event, filePath: string) => {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(
    "fs:searchFiles",
    async (_event, dirPath: string, query: string) => {
      const results: FileEntry[] = [];
      const maxDepth = 5;

      async function walk(dir: string, depth: number) {
        if (depth > maxDepth) return;
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;
            if (
              ["node_modules", ".git", "dist", "build", "__pycache__"].includes(
                entry.name
              )
            )
              continue;

            const fullPath = join(dir, entry.name);

            if (
              entry.name.toLowerCase().includes(query.toLowerCase())
            ) {
              results.push({
                name: entry.name,
                path: fullPath,
                type: entry.isDirectory() ? "folder" : "file",
              });
            }

            if (entry.isDirectory()) {
              await walk(fullPath, depth + 1);
            }
          }
        } catch {
          // Skip inaccessible directories
        }
      }

      await walk(dirPath, 0);
      return results.slice(0, 50); // Limit results
    }
  );

  ipcMain.handle("fs:openDirectory", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: "" };
    }
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle("fs:getHomeDir", () => {
    return homedir();
  });

  ipcMain.handle("fs:isCommandAvailable", (_event, command: string) => {
    try {
      const cmd = process.platform === "win32" ? `where ${command}` : `which ${command}`;
      execSync(cmd, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
}
