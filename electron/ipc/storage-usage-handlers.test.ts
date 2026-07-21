import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: { getPath: () => electronState.userDataDir },
  session: { defaultSession: { clearCache: vi.fn(async () => undefined) } },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      electronState.handlers.set(channel, handler);
    }),
  },
}));

describe("storage usage", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hpp-storage-"));
    electronState.userDataDir = root;
    electronState.handlers.clear();
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const addFile = async (relativePath: string, size: number) => {
    const filePath = join(root, relativePath);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, "x".repeat(size));
  };

  it("measures all Hpp data and groups it without reading file contents", async () => {
    await Promise.all([
      addFile("hpp-data/sessionMessages.json", 10),
      addFile("hpp-data/projects.json", 5),
      addFile("hpp-data/currentModel.json", 4),
      addFile("hpp-data/settings.json", 5),
      addFile("hpp-data/agent-plugins/demo/plugin.mjs", 7),
      addFile("hpp-data/pi-sdk-runtime/node_modules/pi/index.js", 8),
      addFile("hpp-data/agent-runtimes/codex/index.js", 12),
      addFile("Cache/data/cache.bin", 9),
      addFile("Local Storage/leveldb/data", 11),
      addFile("logs/app.log", 13),
    ]);
    const { collectDiskUsage } = await import("./storage-usage-handlers");
    const result = await collectDiskUsage(root);

    expect(result.totalSizeBytes).toBe(84);
    expect(result.totalFileCount).toBe(10);
    expect(Object.fromEntries(result.categories.map((category) => [category.id, category.sizeBytes]))).toEqual({
      conversations: 19,
      configuration: 5,
      agentPlugins: 7,
      agentRuntimes: 20,
      browserCache: 9,
      browserStorage: 11,
      other: 13,
    });
  });

  it("registers a read-only usage handler for the app data directory", async () => {
    const { registerStorageUsageHandlers } = await import("./storage-usage-handlers");
    registerStorageUsageHandlers();
    await addFile("hpp-data/sessionMessages.json", 4);

    await expect(electronState.handlers.get("storage:getUsage")!()).resolves.toMatchObject({
      totalSizeBytes: 4,
      totalFileCount: 1,
      dataPath: root,
    });
  });

  it("clears rebuildable browser caches and stale Hpp temporary data", async () => {
    const now = Date.parse("2026-07-21T12:00:00.000Z");
    await Promise.all([
      addFile("hpp-data/projects.json", 5),
      addFile("hpp-data/old-write.tmp", 4),
      addFile("hpp-data/current-write.tmp", 3),
      addFile("Cache/data/cache.bin", 9),
      addFile("hpp-data/agent-runtimes/codex/index.js", 12),
    ]);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "hpp-storage-os-"));
    const imageDir = join(temporaryRoot, "hpp-codex-images-old");
    await mkdir(imageDir, { recursive: true });
    await writeFile(join(imageDir, "image.png"), "x".repeat(6));
    const oldTime = new Date(now - 2 * 24 * 60 * 60 * 1000);
    const recentTime = new Date(now - 10 * 60 * 1000);
    await Promise.all([
      utimes(join(root, "hpp-data", "old-write.tmp"), oldTime, oldTime),
      utimes(join(root, "hpp-data", "current-write.tmp"), recentTime, recentTime),
      utimes(imageDir, oldTime, oldTime),
    ]);
    const clearBrowserCache = vi.fn(async () => undefined);
    const { cleanupDiskData } = await import("./storage-usage-handlers");

    const result = await cleanupDiskData(root, { clearBrowserCache, temporaryRoot, now });

    expect(clearBrowserCache).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ reclaimedBytes: 31, removedFileCount: 4 });
    expect(result.stats.totalSizeBytes).toBe(8);
    await expect(access(join(root, "Cache"))).rejects.toThrow();
    await expect(access(join(root, "hpp-data", "old-write.tmp"))).rejects.toThrow();
    await expect(access(imageDir)).rejects.toThrow();
    await expect(access(join(root, "hpp-data", "agent-runtimes"))).rejects.toThrow();
    await expect(access(join(root, "hpp-data", "current-write.tmp"))).resolves.toBeUndefined();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("removes runtimes left by uninstalled plugins and preserves installed plugin runtimes", async () => {
    await Promise.all([
      addFile("hpp-data/claude-agent-sdk-runtime/node_modules/sdk/index.js", 10),
      addFile("hpp-data/pi-sdk-runtime/node_modules/sdk/index.js", 8),
      addFile("hpp-data/agent-plugins/pi/hpp-agent-plugin.json", 1),
    ]);
    const { cleanupDiskData } = await import("./storage-usage-handlers");

    const result = await cleanupDiskData(root);

    expect(result.reclaimedBytes).toBe(10);
    expect(result.removedFileCount).toBe(1);
    expect(result.stats.totalSizeBytes).toBe(9);
    await expect(access(join(root, "hpp-data", "claude-agent-sdk-runtime"))).rejects.toThrow();
    await expect(access(join(root, "hpp-data", "pi-sdk-runtime"))).resolves.toBeUndefined();
  });
});
