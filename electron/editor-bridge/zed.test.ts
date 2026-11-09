import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  // getAppPath 指向仓库根：bin/hpp-send.cjs 必须真实存在，写入才允许继续。
  app: { getPath: () => process.cwd(), getAppPath: () => process.cwd(), isPackaged: false },
}));

import { getZedKeymapPath, getZedTasksPath, installZedTasks } from "./zed";

describe("写入 Zed 配置", () => {
  beforeEach(() => {
    const appData = mkdtempSync(join(tmpdir(), "zed-cfg-"));
    process.env.APPDATA = appData;
    process.env.XDG_CONFIG_HOME = appData;
  });

  it("保留用户已有任务，并备份原文件", async () => {
    const tasksPath = getZedTasksPath();
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeFileSync(tasksPath, `[
      // 用户自己的任务
      { "label": "cargo test", "command": "cargo test" },
    ]`, "utf8");

    const result = await installZedTasks();
    expect(result.success).toBe(true);

    const written = JSON.parse(readFileSync(tasksPath, "utf8")) as Array<{ label: string }>;
    expect(written.map((task) => task.label)).toEqual([
      "cargo test",
      "Hpp: 发送选中代码",
      "Hpp: 发送当前文件",
    ]);

    const dir = join(tasksPath, "..");
    const backups = readdirSync(dir).filter((name) => name.includes(".bak-"));
    expect(backups).toHaveLength(1);
  });

  it("重复写入不会产生重复任务", async () => {
    await installZedTasks();
    await installZedTasks();
    const written = JSON.parse(readFileSync(getZedTasksPath(), "utf8")) as Array<{ label: string }>;
    expect(written.filter((task) => task.label.startsWith("Hpp: "))).toHaveLength(2);
  });

  it("已有 keymap 时不动它，只回传片段", async () => {
    const keymapPath = getZedKeymapPath();
    mkdirSync(join(keymapPath, ".."), { recursive: true });
    const mine = '[{ "context": "Editor", "bindings": { "alt-x": "editor::Copy" } }]';
    writeFileSync(keymapPath, mine, "utf8");

    const result = await installZedTasks();
    expect(result.success).toBe(true);
    expect(result.keymapSnippet).toContain("task::Spawn");
    expect(readFileSync(keymapPath, "utf8")).toBe(mine);
  });

  it("没有 keymap 时直接生成", async () => {
    const result = await installZedTasks();
    expect(result.keymapSnippet).toBeUndefined();
    expect(existsSync(getZedKeymapPath())).toBe(true);
  });
});
