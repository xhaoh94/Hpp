import { join } from "path";
import { describe, expect, it } from "vitest";
import type { FileFilterConfig } from "../../shared/file-filters";
import { collectProjectFileIndex } from "./project-file-indexer";

const filters: FileFilterConfig = {
  excludeFolders: ["node_modules"],
  excludeExtensions: [".log"],
  excludeFiles: [".env"],
};

const directoryEntry = (name: string, directory = false) => ({
  name,
  isDirectory: () => directory,
});

describe("project file indexer", () => {
  it("filters entries and stops reading below the configured depth", async () => {
    const root = "C:\\repo";
    const src = join(root, "src");
    const deep = join(src, "deep");
    const ignored = join(root, "node_modules");
    const listings = new Map([
      [root, [
        directoryEntry("node_modules", true),
        directoryEntry("src", true),
        directoryEntry(".env"),
        directoryEntry("root.ts"),
      ]],
      [src, [
        directoryEntry("deep", true),
        directoryEntry("debug.log"),
        directoryEntry("view.ts"),
      ]],
      [deep, [directoryEntry("leaf.ts")]],
    ]);
    const reads: string[] = [];

    const result = await collectProjectFileIndex(root, filters, {
      maxDepth: 1,
      readDirectory: async (dirPath) => {
        reads.push(dirPath);
        return listings.get(dirPath) ?? [];
      },
    });

    expect(result.map((entry) => entry.name)).toEqual([
      "src",
      "root.ts",
      "deep",
      "view.ts",
    ]);
    expect(reads).toEqual([root, src]);
    expect(reads).not.toContain(ignored);
  });

  it("bounds concurrent directory reads", async () => {
    const root = "C:\\repo";
    const childNames = Array.from({ length: 12 }, (_, index) => `folder-${index}`);
    let activeReads = 0;
    let maximumActiveReads = 0;

    const result = await collectProjectFileIndex(root, filters, {
      concurrency: 4,
      readDirectory: async (dirPath) => {
        if (dirPath === root) return childNames.map((name) => directoryEntry(name, true));
        activeReads += 1;
        maximumActiveReads = Math.max(maximumActiveReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeReads -= 1;
        return [directoryEntry("index.ts")];
      },
    });

    expect(maximumActiveReads).toBe(4);
    expect(result.filter((entry) => entry.name === "index.ts")).toHaveLength(12);
  });

  it("rejects root read failures instead of caching an empty project", async () => {
    await expect(collectProjectFileIndex("C:\\repo", filters, {
      readDirectory: async () => { throw new Error("temporarily unavailable"); },
    })).rejects.toThrow("temporarily unavailable");
  });
});
