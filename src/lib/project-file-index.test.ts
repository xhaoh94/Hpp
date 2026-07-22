import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "@/types";
import type { FileFilterConfig } from "@shared/file-filters";
import {
  getProjectFileIndex,
  invalidateProjectFileIndex,
  PROJECT_FILE_INDEX_TTL_MS,
  queryProjectFileIndex,
} from "./project-file-index";

const filters: FileFilterConfig = {
  excludeFolders: ["node_modules"],
  excludeExtensions: [".log"],
  excludeFiles: [".env"],
};

function entry(name: string, path: string, type: FileEntry["type"] = "file"): FileEntry {
  return { name, path, type };
}

function stubProjectIndex(
  implementation: (dirPath: string, receivedFilters?: FileFilterConfig) => Promise<FileEntry[]>,
) {
  const indexProjectFiles = vi.fn(implementation);
  vi.stubGlobal("window", {
    electronAPI: {
      indexProjectFiles,
      platform: "win32",
    },
  });
  return indexProjectFiles;
}

describe("project file index", () => {
  beforeEach(() => invalidateProjectFileIndex());

  afterEach(() => {
    invalidateProjectFileIndex();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shares one in-flight scan and cached index for the same project and filters", async () => {
    let release: ((entries: FileEntry[]) => void) | undefined;
    const pendingEntries = new Promise<FileEntry[]>((resolve) => { release = resolve; });
    const indexProjectFiles = stubProjectIndex(async () => pendingEntries);

    const exactResults = queryProjectFileIndex({ projectPath: "C:\\repo", filters, query: "chat" });
    const fuzzyResults = queryProjectFileIndex({ projectPath: "c:\\REPO", filters, query: "read" });

    expect(indexProjectFiles).toHaveBeenCalledTimes(1);
    release?.([
      entry("chat", "C:\\repo\\chat", "folder"),
      entry("README.md", "C:\\repo\\README.md"),
    ]);

    await expect(exactResults).resolves.toEqual([
      expect.objectContaining({ name: "chat", isDirectory: true }),
    ]);
    await expect(fuzzyResults).resolves.toEqual([
      expect.objectContaining({ name: "README.md" }),
    ]);
    await getProjectFileIndex("C:\\repo", filters);
    expect(indexProjectFiles).toHaveBeenCalledTimes(1);
  });

  it("keeps project and filter cache keys independent", async () => {
    const indexProjectFiles = stubProjectIndex(async (dirPath) => [
      entry("file.ts", `${dirPath}\\file.ts`),
    ]);
    const otherFilters = { ...filters, excludeFiles: ["secret.txt"] };

    await getProjectFileIndex("C:\\repo", filters);
    await getProjectFileIndex("C:\\repo", otherFilters);
    await getProjectFileIndex("C:\\other", filters);
    await getProjectFileIndex("c:\\REPO", filters);

    expect(indexProjectFiles).toHaveBeenCalledTimes(3);
  });

  it("falls back to bounded directory reads when a hot-reloaded preload lacks the index API", async () => {
    const root = "C:\\repo";
    const readDirectory = vi.fn(async (dirPath: string) => {
      if (dirPath === root) {
        return [
          entry("src", `${root}\\src`, "folder"),
          entry("README.md", `${root}\\README.md`),
        ];
      }
      return [entry("chat.ts", `${root}\\src\\chat.ts`)];
    });
    vi.stubGlobal("window", {
      electronAPI: {
        platform: "win32",
        readDirectory,
      },
    });

    const index = await getProjectFileIndex(root, filters);

    expect(index.map((item) => item.name)).toEqual(["src", "README.md", "chat.ts"]);
    expect(readDirectory).toHaveBeenCalledTimes(2);
    expect(readDirectory).toHaveBeenCalledWith(root, filters);
  });

  it("falls back when preload exists but the old main process lacks the IPC handler", async () => {
    const root = "C:\\repo";
    const indexProjectFiles = vi.fn().mockRejectedValue(
      new Error("No handler registered for 'fs:indexProjectFiles'"),
    );
    const readDirectory = vi.fn().mockResolvedValue([
      entry("chat.ts", `${root}\\chat.ts`),
    ]);
    vi.stubGlobal("window", {
      electronAPI: {
        indexProjectFiles,
        platform: "win32",
        readDirectory,
      },
    });

    await expect(getProjectFileIndex(root, filters)).resolves.toEqual([
      expect.objectContaining({ name: "chat.ts" }),
    ]);
    expect(indexProjectFiles).toHaveBeenCalledTimes(1);
    expect(readDirectory).toHaveBeenCalledTimes(1);
  });

  it("does not expire an in-flight scan and starts the TTL when it settles", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let release: ((entries: FileEntry[]) => void) | undefined;
    const indexProjectFiles = stubProjectIndex(() => new Promise<FileEntry[]>((resolve) => {
      release = resolve;
    }));

    const first = getProjectFileIndex("C:\\repo", filters);
    now.mockReturnValue(1_000 + PROJECT_FILE_INDEX_TTL_MS * 2);
    const second = getProjectFileIndex("C:\\repo", filters);
    expect(indexProjectFiles).toHaveBeenCalledTimes(1);

    release?.([entry("file.ts", "C:\\repo\\file.ts")]);
    await expect(first).resolves.toHaveLength(1);
    await expect(second).resolves.toHaveLength(1);
    await getProjectFileIndex("C:\\repo", filters);
    expect(indexProjectFiles).toHaveBeenCalledTimes(1);
  });

  it("returns stale data immediately while refreshing an expired index", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let releaseRefresh: ((entries: FileEntry[]) => void) | undefined;
    const indexProjectFiles = stubProjectIndex(async (_dirPath) => {
      if (indexProjectFiles.mock.calls.length === 1) {
        return [entry("old.ts", "C:\\repo\\old.ts")];
      }
      return new Promise<FileEntry[]>((resolve) => { releaseRefresh = resolve; });
    });

    await getProjectFileIndex("C:\\repo", filters);
    await queryProjectFileIndex({ projectPath: "C:\\repo", filters, query: "old" });
    now.mockReturnValue(1_000 + PROJECT_FILE_INDEX_TTL_MS);
    const [stale, concurrentStale] = await Promise.all([
      getProjectFileIndex("C:\\repo", filters),
      getProjectFileIndex("C:\\repo", filters),
    ]);
    expect(stale[0].name).toBe("old.ts");
    expect(concurrentStale).toBe(stale);
    expect(indexProjectFiles).toHaveBeenCalledTimes(2);

    releaseRefresh?.([entry("fresh.ts", "C:\\repo\\fresh.ts")]);
    await vi.waitFor(async () => {
      const refreshed = await getProjectFileIndex("C:\\repo", filters);
      expect(refreshed[0].name).toBe("fresh.ts");
    });
    await expect(queryProjectFileIndex({ projectPath: "C:\\repo", filters, query: "old" }))
      .resolves.toEqual([]);
    await expect(queryProjectFileIndex({ projectPath: "C:\\repo", filters, query: "fresh" }))
      .resolves.toEqual([expect.objectContaining({ name: "fresh.ts" })]);
  });

  it("keeps stale data and backs off when a background refresh fails", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const indexProjectFiles = stubProjectIndex(async () => {
      if (indexProjectFiles.mock.calls.length === 1) {
        return [entry("stable.ts", "C:\\repo\\stable.ts")];
      }
      throw new Error("scan failed");
    });

    await getProjectFileIndex("C:\\repo", filters);
    now.mockReturnValue(1_000 + PROJECT_FILE_INDEX_TTL_MS);
    const stale = await getProjectFileIndex("C:\\repo", filters);
    expect(stale[0].name).toBe("stable.ts");
    await vi.waitFor(() => expect(indexProjectFiles).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    const afterFailure = await getProjectFileIndex("C:\\repo", filters);
    expect(afterFailure[0].name).toBe("stable.ts");
    expect(indexProjectFiles).toHaveBeenCalledTimes(2);
  });

  it("supports ranked, empty, directory-inclusive, and file-only queries", async () => {
    stubProjectIndex(async () => [
      entry("chat", "C:\\repo\\chat", "folder"),
      entry("ChatPanel.tsx", "C:\\repo\\ChatPanel.tsx"),
      entry("chaxxxt.ts", "C:\\repo\\chaxxxt.ts"),
      entry("README.md", "C:\\repo\\README.md"),
    ]);

    const first = await queryProjectFileIndex({ projectPath: "C:\\repo", filters, limit: 2 });
    const second = await queryProjectFileIndex({ projectPath: "C:\\repo", filters, query: "   ", limit: 2 });
    expect(second).toBe(first);
    expect(first.map((item) => item.name)).toEqual(["chat", "ChatPanel.tsx"]);

    const withDirectories = await queryProjectFileIndex({
      projectPath: "C:\\repo",
      filters,
      query: "chat",
    });
    expect(withDirectories[0]).toMatchObject({ name: "chat", isDirectory: true });

    const filesOnly = await queryProjectFileIndex({
      projectPath: "C:\\repo",
      filters,
      query: "chat",
      includeDirectories: false,
    });
    expect(filesOnly.map((item) => item.name)).toEqual(["ChatPanel.tsx", "chaxxxt.ts"]);
  });

  it("cancels obsolete queries before ranking a newly settled index", async () => {
    let release: ((entries: FileEntry[]) => void) | undefined;
    stubProjectIndex(() => new Promise<FileEntry[]>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const results = queryProjectFileIndex({
      projectPath: "C:\\repo",
      filters,
      query: "chat",
      signal: controller.signal,
    });

    controller.abort();
    release?.([entry("chat.ts", "C:\\repo\\chat.ts")]);
    await expect(results).resolves.toEqual([]);
  });

  it("does not start an index scan for an already-aborted query", async () => {
    const indexProjectFiles = stubProjectIndex(async () => []);
    const controller = new AbortController();
    controller.abort();

    await expect(queryProjectFileIndex({
      projectPath: "C:\\repo",
      filters,
      query: "chat",
      signal: controller.signal,
    })).resolves.toEqual([]);
    expect(indexProjectFiles).not.toHaveBeenCalled();
  });

  it("clears a failed initial scan so the next query can retry", async () => {
    const indexProjectFiles = stubProjectIndex(async () => {
      if (indexProjectFiles.mock.calls.length === 1) throw new Error("scan failed");
      return [entry("retry.ts", "C:\\repo\\retry.ts")];
    });

    await expect(getProjectFileIndex("C:\\repo", filters)).rejects.toThrow("scan failed");
    await expect(getProjectFileIndex("C:\\repo", filters)).resolves.toEqual([
      expect.objectContaining({ name: "retry.ts" }),
    ]);
    expect(indexProjectFiles).toHaveBeenCalledTimes(2);
  });

  it("invalidates one filter key, every key for a project, or the full cache", async () => {
    const indexProjectFiles = stubProjectIndex(async (dirPath) => [
      entry("file.ts", `${dirPath}\\file.ts`),
    ]);
    const otherFilters = { ...filters, excludeFiles: ["secret.txt"] };

    await getProjectFileIndex("C:\\repo", filters);
    await getProjectFileIndex("C:\\repo", otherFilters);
    await getProjectFileIndex("C:\\other", filters);
    expect(indexProjectFiles).toHaveBeenCalledTimes(3);

    invalidateProjectFileIndex("C:\\repo", filters);
    await getProjectFileIndex("C:\\repo", filters);
    await getProjectFileIndex("C:\\repo", otherFilters);
    expect(indexProjectFiles).toHaveBeenCalledTimes(4);

    invalidateProjectFileIndex("C:\\repo");
    await getProjectFileIndex("C:\\repo", otherFilters);
    await getProjectFileIndex("C:\\other", filters);
    expect(indexProjectFiles).toHaveBeenCalledTimes(5);

    invalidateProjectFileIndex();
    await getProjectFileIndex("C:\\other", filters);
    expect(indexProjectFiles).toHaveBeenCalledTimes(6);
  });
});
