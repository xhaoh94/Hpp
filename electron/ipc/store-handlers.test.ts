import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: { getPath: () => electronState.userDataDir },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      electronState.handlers.set(channel, handler);
    }),
  },
}));

describe("store handlers", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "hpp-store-"));
    electronState.userDataDir = tempRoot;
    electronState.handlers.clear();
    vi.resetModules();
    const { registerStoreHandlers } = await import("./store-handlers");
    registerStoreHandlers();
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("persists allowed application keys", async () => {
    const save = electronState.handlers.get("store:save")!;
    const load = electronState.handlers.get("store:load")!;

    await expect(save({}, "settings", { theme: "dark" })).resolves.toEqual({ success: true });
    await expect(load({}, "settings")).resolves.toEqual({ theme: "dark" });
  });

  it("rejects path traversal keys", async () => {
    const save = electronState.handlers.get("store:save")!;
    const load = electronState.handlers.get("store:load")!;

    await expect(save({}, "../escaped", { unsafe: true })).resolves.toMatchObject({ success: false });
    await expect(load({}, "../escaped")).resolves.toBeNull();
    await expect(readFile(join(tempRoot, "escaped.json"), "utf8")).rejects.toThrow();
  });
});
