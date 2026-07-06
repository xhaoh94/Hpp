import { ipcMain, dialog, BrowserWindow } from "electron";
import { readdir, readFile, access, stat } from "fs/promises";
import { basename, join } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";

const SEARCH_RESULT_LIMIT = 50;
const SEARCH_EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  ".next",
  ".nuxt",
  "out",
  "release",
  "coverage",
  "target",
  "vendor",
]);

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: FileEntry[];
}

interface PathAttachmentInfo {
  name: string;
  path: string;
  kind: "file" | "folder";
}

const getPathAttachmentInfo = async (targetPath: string): Promise<PathAttachmentInfo> => {
  const info = await stat(targetPath);
  if (!info.isFile() && !info.isDirectory()) {
    throw new Error("Path is not a file or folder");
  }
  return {
    name: basename(targetPath) || targetPath,
    path: targetPath,
    kind: info.isDirectory() ? "folder" : "file",
  };
};

export function registerFileHandlers() {
  ipcMain.handle("fs:readDirectory", async (_event, dirPath: string) => {
    if (typeof dirPath !== "string" || !dirPath.trim()) return [];
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
    if (typeof filePath !== "string" || !filePath.trim()) {
      return { success: false, error: "Invalid file path" };
    }
    try {
      const content = await readFile(filePath, "utf-8");
      return { success: true, content };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("fs:statPath", async (_event, filePath: string) => {
    if (typeof filePath !== "string" || !filePath.trim()) {
      return { success: false, error: "Invalid file path" };
    }
    try {
      return { success: true, attachment: await getPathAttachmentInfo(filePath) };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("fs:fileExists", async (_event, filePath: string) => {
    if (typeof filePath !== "string" || !filePath.trim()) return false;
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("fs:reverseApplyPatch", async (_event, projectPath: string, patches: string[]) => {
    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return { success: false, error: "Invalid project path" };
    }
    if (!Array.isArray(patches) || patches.length === 0) {
      return { success: false, error: "No patch content to revert" };
    }

    try {
      const projectInfo = await stat(projectPath);
      if (!projectInfo.isDirectory()) {
        return { success: false, error: "Project path is not a directory" };
      }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const patchInput = patches
      .filter((patch): patch is string => typeof patch === "string" && patch.trim().length > 0)
      .map((patch) => patch.trimEnd())
      .join("\n");

    if (!patchInput.trim()) {
      return { success: false, error: "No patch content to revert" };
    }

    try {
      const result = spawnSync("git", ["apply", "--reverse", "--whitespace=nowarn", "-"], {
        cwd: projectPath,
        input: `${patchInput}\n`,
        encoding: "utf-8",
        shell: false,
        maxBuffer: 10 * 1024 * 1024,
      });

      if (result.error) {
        return { success: false, error: result.error.message };
      }
      if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || "").trim();
        return { success: false, error: detail || `git apply exited with code ${result.status}` };
      }
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    "fs:searchFiles",
    async (_event, dirPath: string, query: string) => {
      const results: FileEntry[] = [];
      const maxDepth = 5;
      if (typeof dirPath !== "string" || !dirPath.trim()) return results;
      const normalizedQuery = typeof query === "string" ? query.trim().toLowerCase() : "";
      if (!normalizedQuery) return results;

      async function walk(dir: string, depth: number) {
        if (results.length >= SEARCH_RESULT_LIMIT) return;
        if (depth > maxDepth) return;
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= SEARCH_RESULT_LIMIT) return;
            if (entry.name.startsWith(".")) continue;
            if (entry.isDirectory() && SEARCH_EXCLUDED_DIRS.has(entry.name)) continue;

            const fullPath = join(dir, entry.name);

            if (entry.name.toLowerCase().includes(normalizedQuery)) {
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
      return results;
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

  ipcMain.handle("fs:openAttachmentFolder", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    try {
      return { canceled: false, attachment: await getPathAttachmentInfo(result.filePaths[0]) };
    } catch (err: unknown) {
      return { canceled: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("fs:getHomeDir", () => {
    return homedir();
  });

  ipcMain.handle("fs:isCommandAvailable", (_event, command: string) => {
    if (typeof command !== "string" || !/^[\w@./:-]+$/.test(command)) return false;
    try {
      const executable = process.platform === "win32" ? "where" : "which";
      const args = process.platform === "win32" ? [command] : ["-a", command];
      const result = spawnSync(executable, args, { encoding: "utf-8", shell: false });
      if (result.status !== 0 || result.error) return false;
      const output = result.stdout.trim();
      if (!output) return false;
      const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
      return lines.some((p) => !p.includes("node_modules"));
    } catch {
      return false;
    }
  });
}
