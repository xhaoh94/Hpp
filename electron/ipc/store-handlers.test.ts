import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
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
  let closeStoreDatabases = () => {};

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "hpp-store-"));
    electronState.userDataDir = tempRoot;
    electronState.handlers.clear();
    vi.resetModules();
    const storeModule = await import("./store-handlers");
    closeStoreDatabases = storeModule.closeStoreDatabases;
    storeModule.registerStoreHandlers();
  });

  afterEach(async () => {
    closeStoreDatabases();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("persists allowed application keys", async () => {
    const save = electronState.handlers.get("store:save")!;
    const load = electronState.handlers.get("store:load")!;

    await expect(save({}, "settings", { theme: "dark" })).resolves.toEqual({ success: true });
    await expect(load({}, "settings")).resolves.toEqual({ theme: "dark" });

    await expect(save({}, "editor", { mode: true, tabs: [], activeKey: null })).resolves.toEqual({ success: true });
    await expect(load({}, "editor")).resolves.toEqual({ mode: true, tabs: [], activeKey: null });
  });

  it("rejects path traversal keys", async () => {
    const save = electronState.handlers.get("store:save")!;
    const load = electronState.handlers.get("store:load")!;

    await expect(save({}, "../escaped", { unsafe: true })).resolves.toMatchObject({ success: false });
    await expect(load({}, "../escaped")).resolves.toBeNull();
    await expect(readFile(join(tempRoot, "escaped.json"), "utf8")).rejects.toThrow();
  });

  it("stores each session message snapshot in SQLite", async () => {
    const save = electronState.handlers.get("store:saveSessionMessages")!;
    const load = electronState.handlers.get("store:loadSessionMessages")!;
    const loadPage = electronState.handlers.get("store:loadSessionMessagesPage")!;

    await expect(save({}, "first", { replace: true, upserts: [
      { message: { id: "first-message", content: "kept" }, sequence: 0 },
      { message: { id: "second-message", content: "second" }, sequence: 1 },
      { message: { id: "third-message", content: "third" }, sequence: 2 },
    ] })).resolves.toEqual({ success: true });
    expect(load({}, "first")).toEqual([
      { id: "first-message", content: "kept" },
      { id: "second-message", content: "second" },
      { id: "third-message", content: "third" },
    ]);
    expect(loadPage({}, "first", undefined, 2)).toEqual({
      messages: [
        { id: "second-message", content: "second" },
        { id: "third-message", content: "third" },
      ],
      hasMore: true,
      nextBefore: 1,
      firstSequence: 1,
    });
    expect(loadPage({}, "first", 1, 2)).toEqual({
      messages: [{ id: "first-message", content: "kept" }],
      hasMore: false,
      nextBefore: null,
      firstSequence: 0,
    });
    await expect(save({}, "first", { upserts: [{ message: { id: "first-message", content: "updated" }, sequence: 0 }] })).resolves.toEqual({ success: true });
    expect(load({}, "first")[0]).toEqual({ id: "first-message", content: "updated" });
  });

  it("returns lightweight first-user summaries without loading full histories", async () => {
    const save = electronState.handlers.get("store:saveSessionMessages")!;
    const summaries = electronState.handlers.get("store:loadSessionMessageSummaries")!;

    await save({}, "summary-session", { replace: true, upserts: [
      { message: { id: "system", role: "system", content: "system", timestamp: 1 }, sequence: 0 },
      { message: { id: "user", role: "user", content: "请求摘要", timestamp: 2 }, sequence: 1 },
      { message: { id: "assistant", role: "assistant", content: "回复", timestamp: 3 }, sequence: 2 },
    ] });

    expect(summaries({}, ["summary-session", "missing-session"])).toEqual({
      "summary-session": { id: "user", role: "user", content: "请求摘要", timestamp: 2 },
    });
  });

  it("skips uiGenerated user messages when picking the session summary", async () => {
    const save = electronState.handlers.get("store:saveSessionMessages")!;
    const summaries = electronState.handlers.get("store:loadSessionMessageSummaries")!;

    await save({}, "injected-session", { replace: true, upserts: [
      { message: { id: "injected", role: "user", uiGenerated: true, content: "系统注入的上下文", timestamp: 1 }, sequence: 0 },
      { message: { id: "real", role: "user", content: "真正的首条请求", timestamp: 2 }, sequence: 1 },
      { message: { id: "assistant", role: "assistant", content: "回复", timestamp: 3 }, sequence: 2 },
    ] });

    expect(summaries({}, ["injected-session"])).toEqual({
      "injected-session": { id: "real", role: "user", content: "真正的首条请求", timestamp: 2 },
    });
  });

  it("loads the backup when the primary file is corrupt", async () => {
    const save = electronState.handlers.get("store:save")!;
    const load = electronState.handlers.get("store:load")!;
    const filePath = join(tempRoot, "hpp-data", "projects.json");

    await save({}, "projects", { projects: [{ id: "first" }] });
    await save({}, "projects", { projects: [{ id: "second" }] });
    await writeFile(filePath, "{broken", "utf8");

    await expect(load({}, "projects")).resolves.toEqual({ projects: [{ id: "first" }] });
  });

  it("purges deleted sessions and projects from SQLite and JSON stores", async () => {
    const save = electronState.handlers.get("store:save")!;
    const saveMessages = electronState.handlers.get("store:saveSessionMessages")!;
    const loadMessages = electronState.handlers.get("store:loadSessionMessages")!;
    const purge = electronState.handlers.get("store:purgeSessions")!;
    await saveMessages({}, "kept", { replace: true, upserts: [{ message: { id: "kept-message", content: "keep" }, sequence: 0 }] });
    await saveMessages({}, "removed", { replace: true, upserts: [{ message: { id: "removed-message", content: "private snapshot", composerDraft: { text: "private" } }, sequence: 0 }] });
    await saveMessages({}, "project-session", { replace: true, upserts: [{ message: { id: "project-message", content: "project private" }, sequence: 0 }] });
    const projects = {
      projects: [
        { id: "kept-project", sessions: [{ id: "kept" }, { id: "removed" }] },
        { id: "removed-project", sessions: [{ id: "project-session" }] },
      ],
      activeProjectId: "removed-project",
      activeSessionId: "removed",
    };
    const models = {
      modelVersion: 5,
      models: { kept: { id: "keep" }, removed: { id: "private" } },
      thinkingLevels: { kept: "medium", removed: "high" },
    };
    for (const [key, value] of [["projects", projects], ["currentModel", models]] as const) {
      await save({}, key, value);
      await save({}, key, value);
    }

    await expect(purge({}, {
      sessionIds: ["removed", "project-session"],
      projectIds: ["removed-project"],
    })).resolves.toEqual({ success: true });

    expect(loadMessages({}, "kept")).toEqual([{ id: "kept-message", content: "keep" }]);
    expect(loadMessages({}, "removed")).toBeNull();
    expect(loadMessages({}, "project-session")).toBeNull();
    for (const suffix of ["", ".bak"]) {
      const storedProjects = JSON.parse(await readFile(join(tempRoot, "hpp-data", `projects.json${suffix}`), "utf8"));
      const storedModels = JSON.parse(await readFile(join(tempRoot, "hpp-data", `currentModel.json${suffix}`), "utf8"));
      expect(storedProjects).toMatchObject({
        projects: [{ id: "kept-project", sessions: [{ id: "kept" }] }],
        activeProjectId: null,
        activeSessionId: null,
      });
      expect(storedModels.models).toEqual({ kept: { id: "keep" } });
      expect(storedModels.thinkingLevels).toEqual({ kept: "medium" });
    }
  });

  it("removes orphaned per-session data using the current catalog", async () => {
    const save = electronState.handlers.get("store:save")!;
    const saveMessages = electronState.handlers.get("store:saveSessionMessages")!;
    const loadMessages = electronState.handlers.get("store:loadSessionMessages")!;
    const purge = electronState.handlers.get("store:purgeSessions")!;
    await saveMessages({}, "kept", { replace: true, upserts: [] });
    await saveMessages({}, "orphan", { replace: true, upserts: [{ message: { id: "orphan-message", content: "old" }, sequence: 0 }] });
    await save({}, "currentModel", { models: { kept: {}, orphan: {} }, thinkingLevels: { orphan: "high" } });

    await purge({}, { validSessionIds: ["kept"], validProjectIds: [] });

    expect(loadMessages({}, "kept")).toEqual([]);
    expect(loadMessages({}, "orphan")).toBeNull();
    const storedModels = JSON.parse(await readFile(join(tempRoot, "hpp-data", "currentModel.json"), "utf8"));
    expect(storedModels.models).toEqual({ kept: {} });
    expect(storedModels.thinkingLevels).toEqual({});
  });

  it("imports the legacy sessionMessages.json once, then archives it", async () => {
    const legacyDir = join(tempRoot, "hpp-data");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "sessionMessages.json"), JSON.stringify({
      sessionMessages: {
        legacy: [
          { id: "legacy-1", role: "user", content: "旧消息", timestamp: 1 },
          { id: "legacy-2", role: "assistant", content: "旧回复", timestamp: 2 },
          // 缺 id：导进去渲染层也会丢掉，所以不该占库
          { role: "user", content: "脏数据", timestamp: 3 },
        ],
        empty: [],
      },
    }));

    const load = electronState.handlers.get("store:loadSessionMessages")!;
    expect(load({}, "legacy")).toEqual([
      { id: "legacy-1", role: "user", content: "旧消息", timestamp: 1 },
      { id: "legacy-2", role: "assistant", content: "旧回复", timestamp: 2 },
    ]);
    expect(load({}, "empty")).toBeNull();
    await expect(access(join(legacyDir, "sessionMessages.json"))).rejects.toThrow();
  });

  it("imports only the sessions SQLite does not already have", async () => {
    const saveMessages = electronState.handlers.get("store:saveSessionMessages")!;
    const load = electronState.handlers.get("store:loadSessionMessages")!;
    await saveMessages({}, "existing", {
      replace: true,
      upserts: [{ message: { id: "sqlite-message", role: "user", content: "sqlite wins", timestamp: 1 }, sequence: 0 }],
    });
    // 关掉再重开，让一次性导入逻辑重新跑
    closeStoreDatabases();
    await writeFile(join(tempRoot, "hpp-data", "sessionMessages.json"), JSON.stringify({
      sessionMessages: {
        existing: [{ id: "legacy-message", role: "user", content: "stale", timestamp: 1 }],
        fresh: [{ id: "legacy-fresh", role: "assistant", content: "imported", timestamp: 2 }],
      },
    }));

    expect(load({}, "existing")).toEqual([
      { id: "sqlite-message", role: "user", content: "sqlite wins", timestamp: 1 },
    ]);
    expect(load({}, "fresh")).toEqual([
      { id: "legacy-fresh", role: "assistant", content: "imported", timestamp: 2 },
    ]);
  });

  it("reclaims the database file after deleting a large session", async () => {
    const saveMessages = electronState.handlers.get("store:saveSessionMessages")!;
    const loadMessages = electronState.handlers.get("store:loadSessionMessages")!;
    const purge = electronState.handlers.get("store:purgeSessions")!;
    const dbPath = join(tempRoot, "hpp-data", "session-messages.sqlite");
    const filler = "x".repeat(4000);
    await saveMessages({}, "big", {
      replace: true,
      upserts: Array.from({ length: 240 }, (_, index) => ({
        message: { id: `message-${index}`, role: "assistant", content: filler, timestamp: index + 1 },
        sequence: index,
      })),
    });
    const beforeSize = (await stat(dbPath)).size;

    await purge({}, { sessionIds: ["big"], projectIds: [] });

    const afterSize = (await stat(dbPath)).size;
    expect(loadMessages({}, "big")).toBeNull();
    expect(beforeSize).toBeGreaterThan(500_000);
    expect(afterSize).toBeLessThan(beforeSize);
  });
});
